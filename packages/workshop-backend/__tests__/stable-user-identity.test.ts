import { describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import type { JWTPayload } from "jose";
import { PublicApiImpl } from "../src/server.js";
import { UserDurableObject } from "../src/user.js";
import { FORMAT_BLUEPRINTS } from "../src/generated/format-blueprints.js";

const EMAIL = "owner@example.com";
const USER_DO_ID = "a".repeat(64);
const WORKSPACE_ID = "b".repeat(64);
const NEW_WORKSPACE_ID = "c".repeat(64);

function publicApi(
    ctx: ExecutionContext,
    env: Cloudflare.Env,
    accessPayload?: JWTPayload,
): PublicApiImpl {
  return new PublicApiImpl(ctx, env, vi.fn(), accessPayload);
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
    const ctx = {
      exports: {
        UserDurableObject: users,
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
  });

  it("round-trips pre-registry and new workspace routes through the canonical User DO ID", async () => {
    const profile = { type: "user", id: EMAIL, name: "Owner" } as const;
    const seededWorkspace = {
      id: WORKSPACE_ID,
      title: "Pre-registry workspace",
      created: new Date("2026-01-01T00:00:00Z"),
      lastActive: new Date("2026-01-02T00:00:00Z"),
    };
    const setTitle = vi.fn();
    const workspace = { setTitle };
    const open = vi.fn().mockResolvedValue(workspace);
    const newGadget = vi.fn();
    const user = {
      authenticateFromCfAccess: vi.fn(),
      whoami: vi.fn().mockResolvedValue(profile),
      listGadgets: vi.fn().mockResolvedValue([seededWorkspace]),
      newGadget,
    };
    const emailUserId = {
      name: EMAIL,
      toString: () => USER_DO_ID,
    } as DurableObjectId;
    const users = {
      idFromName: vi.fn().mockReturnValue(emailUserId),
      get: vi.fn().mockReturnValue(user),
    };
    const overseers = {
      idFromString: vi.fn((id: string) => id),
      newUniqueId: vi.fn(() => ({ toString: () => NEW_WORKSPACE_ID })),
      get: vi.fn(() => ({ open })),
    };
    const ctx = {
      exports: {
        UserDurableObject: users,
        OverseerDurableObject: overseers,
        AdminSettings: { getByName: vi.fn().mockReturnValue({}) },
      },
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;

    const api = await publicApi(ctx, baseEnv(), accessIdentity(EMAIL))
      .authenticateFromCfAccess();

    await expect(api.listGadgets()).resolves.toEqual([seededWorkspace]);
    const existing = await api.openGadget(WORKSPACE_ID);
    await existing.setTitle("Edited pre-registry workspace");
    await api.newGadget();

    expect(setTitle).toHaveBeenCalledExactlyOnceWith("Edited pre-registry workspace");
    expect(newGadget).toHaveBeenCalledExactlyOnceWith(NEW_WORKSPACE_ID, "Untitled Workspace");
    expect(open).toHaveBeenNthCalledWith(
      1,
      USER_DO_ID,
      EMAIL,
      expect.any(Function),
      undefined,
      undefined,
    );
    expect(open).toHaveBeenNthCalledWith(
      2,
      USER_DO_ID,
      EMAIL,
      expect.any(Function),
      undefined,
      undefined,
    );
    expect(await api.whoami()).toEqual(profile);
  });

  it("persists imported blueprint ownership as the canonical User DO ID", async () => {
    const blueprintWrites = new Map<string, string>();
    const user = {
      authenticateFromCfAccess: vi.fn(),
      importBlueprint: vi.fn(),
    };
    const emailUserId = {
      name: EMAIL,
      toString: () => USER_DO_ID,
    } as DurableObjectId;
    const ctx = {
      exports: {
        UserDurableObject: {
          idFromName: vi.fn().mockReturnValue(emailUserId),
          get: vi.fn().mockReturnValue(user),
        },
        OverseerDurableObject: {},
        AdminSettings: { getByName: vi.fn().mockReturnValue({}) },
      },
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;
    const env = baseEnv({
      BLUEPRINTS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn(async (key: string, value: string) => blueprintWrites.set(key, value)),
        delete: vi.fn(),
      },
      BLUEPRINT_CONTENT: {
        put: vi.fn(async (_key: string, value: ReadableStream<Uint8Array>) => {
          await new Response(value).arrayBuffer();
        }),
        delete: vi.fn(),
      },
    });
    const api = await publicApi(ctx, env, accessIdentity(EMAIL)).authenticateFromCfAccess();
    const archive = new Response(
      Uint8Array.fromBase64(FORMAT_BLUEPRINTS[0].archive) as BufferSource,
    ).body!;

    const blueprintId = await api.importBlueprint(archive);

    expect(JSON.parse(blueprintWrites.get(blueprintId)!)).toMatchObject({ ownerId: USER_DO_ID });
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

describe("persisted User DO route references", () => {
  it("passes the canonical User DO ID through the Gatekeeper callback route", async () => {
    let callbackProps: { userId: string; accountId: number; vendorId: string } | undefined;
    const user = Object.assign(Object.create(UserDurableObject.prototype), {
      ctx: {
        id: { name: EMAIL, toString: () => USER_DO_ID },
        exports: {
          GatekeeperConnectCallbackImpl: ({ props }: any) => {
            callbackProps = props;
            return {};
          },
        },
      },
      env: baseEnv(),
      vendors: new Map([["provider", {
        describe: vi.fn().mockResolvedValue({ configuration: { configured: true } }),
        connectAccount: vi.fn().mockResolvedValue({ url: "https://provider.example/connect" }),
      }]]),
      storage: {
        nextAccountId: { get: vi.fn(() => 7), put: vi.fn() },
        languagePreference: { get: vi.fn(() => "auto") },
      },
    }) as UserDurableObject;

    await user.connectAccount("provider");

    expect(callbackProps).toEqual({ userId: USER_DO_ID, accountId: 7, vendorId: "provider" });
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
