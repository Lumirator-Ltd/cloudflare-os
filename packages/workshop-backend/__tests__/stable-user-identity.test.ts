import { describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import type { JWTPayload } from "jose";
import { PublicApiImpl } from "../src/server.js";
import { UserDurableObject } from "../src/user.js";

const EMAIL = "owner@example.com";

function publicApi(
    ctx: ExecutionContext,
    env: Cloudflare.Env,
    accessPayload?: JWTPayload,
): PublicApiImpl {
  return new PublicApiImpl(
    ctx,
    env,
    vi.fn(),
    new AbortController().signal,
    vi.fn() as never,
    accessPayload as never,
  );
}

function accessIdentity(email: string): JWTPayload {
  return {
    subject: "access-subject",
    email,
    expiresAt: new Date(Date.now() + 60_000),
    issuer: "https://team.cloudflareaccess.com",
    audience: "workshop-audience",
  };
}

function baseEnv(overrides: Record<string, unknown> = {}): Cloudflare.Env {
  return {
    BLUEPRINTS: { get: vi.fn().mockResolvedValue(null) },
    ...overrides,
  } as unknown as Cloudflare.Env;
}

describe("email-keyed user identity", () => {
  it("returns existing customized Access profile and model state from the exact email-keyed user", async () => {
    const profile = { type: "user", id: EMAIL, name: "Customized Owner" } as const;
    const models: AiChatAuthorInfo[] = [{
      type: "agent",
      id: "custom-provider:model",
      name: "Custom Provider Model",
    }];
    const profileStore = {
      get: vi.fn(() => profile),
      put: vi.fn(),
    };
    const user = Object.assign(Object.create(UserDurableObject.prototype), {
      env: baseEnv(),
      storage: {
        created: { get: vi.fn(() => true), put: vi.fn() },
        profile: profileStore,
        aiModels: {
          list: vi.fn(() => models.map(model => ({
            profile: model,
            config: { provider: "custom-provider", apiKey: "not-used" },
          }))),
        },
      },
    }) as UserDurableObject;
    const authenticateFromCfAccess = vi.spyOn(user, "authenticateFromCfAccess");
    const emailUserId = { name: EMAIL, toString: () => "email-user-id" } as DurableObjectId;
    const users = {
      idFromName: vi.fn((name: string) => {
        if (name !== EMAIL) throw new Error(`unexpected UserDurableObject name: ${name}`);
        return emailUserId;
      }),
      get: vi.fn((id: DurableObjectId) => {
        if (id !== emailUserId) throw new Error("unexpected UserDurableObject id");
        return user;
      }),
    };
    const registry = {
      getByName: vi.fn(() => {
        throw new Error("IdentityRegistry must not be used for Access authentication");
      }),
    };
    const ctx = {
      exports: {
        UserDurableObject: users,
        IdentityRegistry: registry,
        OverseerDurableObject: {},
        AdminSettings: { getByName: vi.fn().mockReturnValue({}) },
      },
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;

    const api = await publicApi(ctx, baseEnv(), accessIdentity(EMAIL))
      .authenticateFromCfAccess();

    await expect(api.whoami()).resolves.toEqual(profile);
    await expect(api.listModels()).resolves.toEqual(models);
    expect(users.idFromName).toHaveBeenCalledExactlyOnceWith(EMAIL);
    expect(authenticateFromCfAccess).toHaveBeenCalledExactlyOnceWith(EMAIL, true);
    expect(profileStore.put).not.toHaveBeenCalled();
    expect(registry.getByName).not.toHaveBeenCalled();
  });

  it("keeps username/password login keyed by the normalized username", async () => {
    const user = { login: vi.fn().mockResolvedValue("password-secret") };
    const userId = { name: "mixed_user", toString: () => "password-user-id" } as DurableObjectId;
    const users = {
      idFromName: vi.fn().mockReturnValue(userId),
      get: vi.fn().mockReturnValue(user),
    };
    const ctx = {
      exports: { UserDurableObject: users },
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;

    await expect(publicApi(ctx, baseEnv()).login("Mixed_User", new Uint8Array([1])))
      .resolves.toBe("mixed_user:password-secret");

    expect(users.idFromName).toHaveBeenCalledExactlyOnceWith("mixed_user");
  });
});

describe("Gatekeeper login scopes", () => {
  it.each([
    ["cloudflare", { scopes: "full", resourceUrlPatterns: [] }],
    ["github", { scopes: "auth" }],
  ] as const)("uses the upstream options for %s", async (vendorId, expectedOptions) => {
    const connectAccount = vi.fn().mockResolvedValue({ url: "https://provider.example/login" });
    const vendor = {
      describe: vi.fn().mockResolvedValue({
        displayName: vendorId,
        url: "https://provider.example",
        providesAuth: true,
        configuration: { configured: true },
      }),
      connectAccount,
    } as unknown as Service<GatekeeperVendor>;
    const pendingId = { toString: () => "pending-id" };
    const ctx = {
      exports: {
        UserDurableObject: {},
        PendingLogin: {
          newUniqueId: vi.fn().mockReturnValue(pendingId),
          get: vi.fn().mockReturnValue({ awaitResult: vi.fn() }),
        },
        LoginConnectCallbackImpl: vi.fn().mockReturnValue({}),
      },
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;
    const env = baseEnv({
      AUTH_GATEKEEPERS: vendorId,
      [`GATEKEEPER_${vendorId.toUpperCase()}`]: vendor,
    });

    const result = await publicApi(ctx, env).startGatekeeperLogin(vendorId);

    expect(result.url).toBe("https://provider.example/login");
    expect(connectAccount).toHaveBeenCalledExactlyOnceWith(expect.anything(), expectedOptions);
  });
});
