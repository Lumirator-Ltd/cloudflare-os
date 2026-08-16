import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, createExecutionContext, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InitialAdminConfigV1 } from "../src/admin-bootstrap.js";
import { initialAdminConfigDigest, toAdminConfigPatch } from "../src/admin-bootstrap.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/admin-config.js";
import server from "../src/server.js";

const INITIAL_CONFIG = {
  tenantId: "tenant-immutable-id",
  schemaVersion: 1,
  config: {
    siteName: "Acme OS",
    accentColor: "#4f46e5",
    contextGatekeeper: "optional",
    customGatekeeper: "disabled",
  },
} as const satisfies InitialAdminConfigV1;

const CONCURRENT_CONFIG = {
  ...INITIAL_CONFIG,
  tenantId: "concurrent-tenant-id",
  config: {...INITIAL_CONFIG.config, siteName: "Concurrent OS"},
} as const satisfies InitialAdminConfigV1;

const FAILING_CONFIG = {
  ...INITIAL_CONFIG,
  tenantId: "private-tenant-admin@example.com",
  config: {...INITIAL_CONFIG.config, siteName: "Private Brand"},
} as const satisfies InitialAdminConfigV1;

type BootstrapEnv = Cloudflare.Env & {
  INITIAL_ADMIN_CONFIG?: InitialAdminConfigV1;
};

function request(
    config?: InitialAdminConfigV1,
    path = "/api/client-errors",
    ctx = createExecutionContext()): Promise<Response> {
  const requestEnv = Object.assign(Object.create(env), {
    ...(config && {INITIAL_ADMIN_CONFIG: config}),
  }) as BootstrapEnv;
  return server.fetch(new Request(`https://workshop.invalid${path}`), requestEnv, ctx);
}

function failingBootstrapContext(): ExecutionContext {
  const ctx = createExecutionContext();
  const bootstrapFailure = {
    AdminSettings: {
      getByName: () => ({
        ensureInitialAdminConfig: async () => {
          throw new Error("secret initialization details");
        },
      }),
    },
  };
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "exports") return bootstrapFailure;
      return Reflect.get(target, property, target);
    },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await abortAllDurableObjects();
});

describe("Workshop admin bootstrap gate", () => {
  it("preserves normal routing when the binding is absent", async () => {
    const response = await request();

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.text()).toBe("Method Not Allowed");
  });

  it("awaits a valid binding before normal routing", async () => {
    const response = await request(INITIAL_CONFIG);

    expect(response.status).toBe(405);
    expect(await exports.AdminSettings.getByName("").getAdminConfig()).toEqual({
      ...DEFAULT_ADMIN_CONFIG,
      ...toAdminConfigPatch(INITIAL_CONFIG),
    });
  });

  it("returns a sanitized maintenance response when initialization fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await request(FAILING_CONFIG, "/missing", failingBootstrapContext());

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("Deployment initialization pending.\n");

    const digestPrefix = (await initialAdminConfigDigest(FAILING_CONFIG)).slice(0, 12);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      component: "workshop.server.bootstrap",
      event: "admin.bootstrap.failed",
      errorCode: "ADMIN_BOOTSTRAP_FAILED",
      digestPrefix,
    }));
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(FAILING_CONFIG.tenantId);
    expect(logged).not.toContain(FAILING_CONFIG.config.siteName);
    expect(logged).not.toContain("secret initialization details");
  });

  it("does not run an API handler after initialization fails", async () => {
    const response = await request(
      FAILING_CONFIG,
      "/api/client-errors",
      failingBootstrapContext(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.has("allow")).toBe(false);
    expect(await response.text()).toBe("Deployment initialization pending.\n");
  });

  it("keeps concurrent first requests on the same initialized state", async () => {
    const responses = await Promise.all([
      request(CONCURRENT_CONFIG),
      request(CONCURRENT_CONFIG),
    ]);

    expect(responses.map(response => response.status)).toEqual([405, 405]);
    expect(await exports.AdminSettings.getByName("").getAdminConfig()).toEqual({
      ...DEFAULT_ADMIN_CONFIG,
      ...toAdminConfigPatch(CONCURRENT_CONFIG),
    });
  });
});
