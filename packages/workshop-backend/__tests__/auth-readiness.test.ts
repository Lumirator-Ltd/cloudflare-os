import { describe, expect, it, vi } from "vitest";
import type { GatekeeperVendor, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { PublicApiImpl } from "../src/server.js";
import {
  getAuthVendors,
  getServerConfig,
  isPasswordAuthAvailable,
} from "../src/deployment-config.js";

function authVendor(
  description: Partial<VendorDescription> = {},
  connect: () => void = () => {},
): Service<GatekeeperVendor> {
  return {
    async describe() {
      return {
        displayName: "GitHub",
        url: "https://github.com",
        providesAuth: true,
        ...description,
      };
    },
    async connectAccount() {
      connect();
      return { url: "https://github.com/login/oauth" };
    },
  } as Service<GatekeeperVendor>;
}

function environment(vendor?: Service<GatekeeperVendor>): Cloudflare.Env {
  return {
    AUTH_GATEKEEPERS: "github",
    ...(vendor ? { GATEKEEPER_GITHUB: vendor } : {}),
    BLUEPRINTS: { get: async () => null },
  } as unknown as Cloudflare.Env;
}

function publicApi(env: Cloudflare.Env) {
  const pending = { awaitResult: vi.fn() };
  const ctx = {
    exports: {
      UserDurableObject: {},
      PendingLogin: {
        newUniqueId: vi.fn(() => ({ toString: () => "pending" })),
        get: vi.fn(() => pending),
      },
      LoginConnectCallbackImpl: vi.fn(() => ({})),
    },
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
  return { api: new PublicApiImpl(ctx, env, vi.fn()), ctx };
}

describe("upstream authentication policy", () => {
  it("does not expose connector readiness in sign-in discovery", async () => {
    const env = environment(authVendor({ configuration: { configured: false } }));

    await expect(getAuthVendors(env)).resolves.toEqual([{
      vendorId: "github",
      displayName: "GitHub",
      logo: undefined,
      color: undefined,
    }]);
    await expect(getServerConfig(env)).resolves.toMatchObject({
      authVendors: [{ vendorId: "github", displayName: "GitHub" }],
    });
    expect((await getServerConfig(env)).authVendors[0]).not.toHaveProperty("configured");
  });

  it.each([
    ["is unbound", undefined],
    ["is unconfigured", authVendor({ configuration: { configured: false } })],
    ["fails describe", {
      describe: vi.fn(async () => { throw new Error("vendor unavailable"); }),
    } as unknown as Service<GatekeeperVendor>],
  ])("suppresses password fallback when a listed vendor %s", async (_case, vendor) => {
    const env = environment(vendor);
    env.DISABLE_PASSWORD_AUTH = "true";

    await expect(isPasswordAuthAvailable(env)).resolves.toBe(false);
    await expect(getServerConfig(env)).resolves.toMatchObject({ passwordAuthEnabled: false });
  });

  it("starts an allowlisted auth vendor without applying connector readiness", async () => {
    const connect = vi.fn();
    const env = environment(authVendor({ configuration: { configured: false } }, connect));
    const { api, ctx } = publicApi(env);

    await expect(api.startGatekeeperLogin("github")).resolves.toMatchObject({
      url: "https://github.com/login/oauth",
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(ctx.exports.PendingLogin.newUniqueId).toHaveBeenCalledOnce();
  });

  it("still requires the auth allowlist, binding, and providesAuth declaration", async () => {
    const notAllowlisted = environment(authVendor());
    notAllowlisted.AUTH_GATEKEEPERS = "google";
    await expect(publicApi(notAllowlisted).api.startGatekeeperLogin("github"))
      .rejects.toThrow('Sign-in via "github" is not enabled');

    await expect(publicApi(environment()).api.startGatekeeperLogin("github"))
      .rejects.toThrow("No such auth gatekeeper: github");

    const noAuth = environment(authVendor({ providesAuth: false }));
    await expect(publicApi(noAuth).api.startGatekeeperLogin("github"))
      .rejects.toThrow('"github" does not provide authentication');
  });
});
