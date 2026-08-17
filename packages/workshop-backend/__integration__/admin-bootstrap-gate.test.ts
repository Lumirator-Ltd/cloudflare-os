import { env, exports, RpcStub, RpcTarget } from "cloudflare:workers";
import { abortAllDurableObjects, createExecutionContext, reset } from "cloudflare:test";
import type {
  ChatGatewayRpcTarget,
  SubmitExternalMessageInput,
  SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InitialAdminConfigV1 } from "../src/admin-bootstrap.js";
import { initialAdminConfigDigest, toAdminConfigPatch } from "../src/admin-bootstrap.js";
import {
  assertAdminBootstrap,
  resetAdminBootstrapCacheForTest,
} from "../src/admin-bootstrap-gate.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/admin-config.js";
import { ExternalMessageGateway } from "../src/external-message-gateway.js";
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

function bootstrapEnv(config?: InitialAdminConfigV1): BootstrapEnv {
  const requestEnv = Object.create(env) as BootstrapEnv;
  if (config) {
    Object.defineProperty(requestEnv, "INITIAL_ADMIN_CONFIG", {value: config});
  }
  return requestEnv;
}

function request(
    config?: InitialAdminConfigV1,
    path = "/api/client-errors",
    ctx = createExecutionContext()): Promise<Response> {
  return server.fetch(
    new Request(`https://workshop.invalid${path}`),
    bootstrapEnv(config),
    ctx,
  );
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

function bootstrapContext(
    ensureInitialAdminConfig: (initial: InitialAdminConfigV1) => Promise<void>): ExecutionContext {
  const ctx = createExecutionContext();
  const bootstrapExports = {
    AdminSettings: {
      getByName: () => ({ensureInitialAdminConfig}),
    },
  };
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "exports") return bootstrapExports;
      return Reflect.get(target, property, target);
    },
  });
}

class TestChatGateway extends RpcTarget implements ChatGatewayRpcTarget {
  async onGadgetResponse(): Promise<void> {}
}

const EXTERNAL_MESSAGE: SubmitExternalMessageInput = {
  callerEmail: "private-caller@example.com",
  gadgetKey: "gadget-key",
  chatKey: "chat-key",
  messageKey: "message-key",
  gadgetTitle: "Private Gadget",
  prompt: "private prompt",
  chatGatewayRpcTarget: new RpcStub(new TestChatGateway()),
};

const ACCEPTED: SubmitExternalMessageResult = {
  accepted: true,
  chatPath: "/gadgets/gadget-key/chats/chat-key",
};

type GatewayExports = {
  AdminSettings?: {
    getByName(name: string): {
      ensureInitialAdminConfig(initial: InitialAdminConfigV1): Promise<void>;
    };
  };
  OverseerDurableObject: {
    getByName(name: string): {
      receiveExternalMessage(input: unknown): Promise<SubmitExternalMessageResult>;
    };
  };
};

function externalMessageGateway(
    workerExports: GatewayExports,
    config?: InitialAdminConfigV1): ExternalMessageGateway {
  const ctx = createExecutionContext();
  const gatewayContext = new Proxy(ctx, {
    get(target, property) {
      if (property === "props") return {source: "test-source"};
      if (property === "exports") return workerExports;
      return Reflect.get(target, property, target);
    },
  });
  const gatewayEnv = Object.create(env) as BootstrapEnv;
  if (config) {
    Object.defineProperty(gatewayEnv, "INITIAL_ADMIN_CONFIG", {value: config});
  }
  return new ExternalMessageGateway(gatewayContext, gatewayEnv);
}

beforeEach(() => {
  resetAdminBootstrapCacheForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await abortAllDurableObjects();
});

describe("assertAdminBootstrap memoization", () => {
  it("memoizes successful initialization across sequential configured calls", async () => {
    const ensureInitialAdminConfig = vi.fn(async () => {});
    const configuredEnv = bootstrapEnv(INITIAL_CONFIG);

    await assertAdminBootstrap(configuredEnv, bootstrapContext(ensureInitialAdminConfig));
    await assertAdminBootstrap(configuredEnv, bootstrapContext(ensureInitialAdminConfig));

    expect(ensureInitialAdminConfig).toHaveBeenCalledOnce();
    expect(ensureInitialAdminConfig).toHaveBeenCalledWith(INITIAL_CONFIG);
  });

  it("shares one in-flight initialization across concurrent configured calls", async () => {
    let finishInitialization!: () => void;
    const initialization = new Promise<void>(resolve => {
      finishInitialization = resolve;
    });
    const ensureInitialAdminConfig = vi.fn(() => initialization);
    const configuredEnv = bootstrapEnv(INITIAL_CONFIG);
    const settled = vi.fn();

    const first = assertAdminBootstrap(
      configuredEnv,
      bootstrapContext(ensureInitialAdminConfig),
    ).finally(() => settled("first"));
    const second = assertAdminBootstrap(
      configuredEnv,
      bootstrapContext(ensureInitialAdminConfig),
    ).finally(() => settled("second"));

    await vi.waitFor(() => expect(ensureInitialAdminConfig).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    finishInitialization();
    await Promise.all([first, second]);

    expect(ensureInitialAdminConfig).toHaveBeenCalledOnce();
    expect(ensureInitialAdminConfig).toHaveBeenCalledWith(INITIAL_CONFIG);
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it("retries initialization after a failed configured call", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ensureInitialAdminConfig = vi.fn()
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockResolvedValueOnce(undefined);
    const configuredEnv = bootstrapEnv(INITIAL_CONFIG);

    await expect(assertAdminBootstrap(
      configuredEnv,
      bootstrapContext(ensureInitialAdminConfig),
    )).rejects.toThrow("Deployment initialization pending.");
    await expect(assertAdminBootstrap(
      configuredEnv,
      bootstrapContext(ensureInitialAdminConfig),
    )).resolves.toBeUndefined();

    expect(ensureInitialAdminConfig).toHaveBeenCalledTimes(2);
    expect(ensureInitialAdminConfig).toHaveBeenNthCalledWith(1, INITIAL_CONFIG);
    expect(ensureInitialAdminConfig).toHaveBeenNthCalledWith(2, INITIAL_CONFIG);
    expect(error).toHaveBeenCalledOnce();
  });
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

describe("ExternalMessageGateway admin bootstrap gate", () => {
  it("preserves dispatch when the binding is absent", async () => {
    const receiveExternalMessage = vi.fn(async () => ACCEPTED);
    const getByName = vi.fn(() => ({receiveExternalMessage}));
    const gateway = externalMessageGateway({
      OverseerDurableObject: {getByName},
    });

    await expect(gateway.submitExternalMessage(EXTERNAL_MESSAGE)).resolves.toEqual(ACCEPTED);

    expect(getByName).toHaveBeenCalledWith("test-source:gadget-key");
    expect(receiveExternalMessage).toHaveBeenCalledOnce();
  });

  it("awaits valid initialization before downstream dispatch", async () => {
    let finishInitialization!: () => void;
    const initialization = new Promise<void>(resolve => {
      finishInitialization = resolve;
    });
    const ensureInitialAdminConfig = vi.fn(() => initialization);
    const receiveExternalMessage = vi.fn(async () => ACCEPTED);
    const getOverseerByName = vi.fn(() => ({receiveExternalMessage}));
    const gateway = externalMessageGateway({
      AdminSettings: {
        getByName: () => ({ensureInitialAdminConfig}),
      },
      OverseerDurableObject: {getByName: getOverseerByName},
    }, INITIAL_CONFIG);

    const submission = gateway.submitExternalMessage(EXTERNAL_MESSAGE);
    await vi.waitFor(() => expect(ensureInitialAdminConfig).toHaveBeenCalledWith(INITIAL_CONFIG));
    expect(getOverseerByName).not.toHaveBeenCalled();
    expect(receiveExternalMessage).not.toHaveBeenCalled();

    finishInitialization();
    await expect(submission).resolves.toEqual(ACCEPTED);
    expect(receiveExternalMessage).toHaveBeenCalledOnce();
  });

  it("rejects with a sanitized maintenance error without downstream dispatch", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ensureInitialAdminConfig = vi.fn(async () => {
      throw new Error("secret initialization details");
    });
    const getOverseerByName = vi.fn(() => ({
      receiveExternalMessage: vi.fn(async () => ACCEPTED),
    }));
    const gateway = externalMessageGateway({
      AdminSettings: {
        getByName: () => ({ensureInitialAdminConfig}),
      },
      OverseerDurableObject: {getByName: getOverseerByName},
    }, FAILING_CONFIG);

    const rejection = await gateway.submitExternalMessage(EXTERNAL_MESSAGE).catch(reason => reason);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Deployment initialization pending.");
    expect(getOverseerByName).not.toHaveBeenCalled();

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
    expect(logged).not.toContain(EXTERNAL_MESSAGE.callerEmail);
    expect(logged).not.toContain(EXTERNAL_MESSAGE.prompt);
    expect(logged).not.toContain("secret initialization details");
  });
});
