import { describe, expect, it, vi } from "vitest";
import type { AdminSettings } from "../src/admin-settings.js";
import { PublicApiImpl } from "../src/server.js";

const ADMIN_NAME = "Admin@Example.com";

function harness(admins: unknown = [ADMIN_NAME]) {
  const profile = { type: "user" as const, id: ADMIN_NAME, name: "Admin profile" };
  const userId = { name: ADMIN_NAME } as DurableObjectId;
  const user = {
    authenticateFromCfAccess: vi.fn(async () => false),
    whoami: vi.fn(async () => profile),
    setOwnDisplayName: vi.fn(async (name: string) => { profile.name = name; }),
  };
  const settings = { signupsEnabled: true };
  const admin = {
    getSettings: vi.fn(async () => settings),
  } as unknown as DurableObjectStub<AdminSettings>;
  const registryGet = vi.fn(() => { throw new Error("IdentityRegistry must not authorize admins"); });
  const ctx = {
    exports: {
      UserDurableObject: {
        idFromName: vi.fn((name: string) => {
          expect(name).toBe(ADMIN_NAME);
          return userId;
        }),
        get: vi.fn(() => user),
      },
      IdentityRegistry: { getByName: registryGet },
      OverseerDurableObject: {},
      AdminSettings: { getByName: vi.fn(() => admin) },
    },
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
  const env = {
    ADMINS: admins,
    BLUEPRINTS: { get: vi.fn(async () => null) },
  } as unknown as Cloudflare.Env;
  const publicApi = new PublicApiImpl(
    ctx,
    env,
    vi.fn(),
    new AbortController().signal,
    vi.fn() as never,
    { email: ADMIN_NAME },
  );
  return { admin, env, publicApi, registryGet, user };
}

async function authenticated(admins: unknown = [ADMIN_NAME]) {
  const result = harness(admins);
  return { ...result, api: await result.publicApi.authenticateFromCfAccess() };
}

describe("upstream admin matching", () => {
  it("uses exact case-sensitive ADMINS membership without trimming or canonicalization", async () => {
    await expect((await authenticated([ADMIN_NAME])).api.amIAdmin()).resolves.toBe(true);
    await expect((await authenticated([ADMIN_NAME.toLowerCase()])).api.amIAdmin())
      .resolves.toBe(false);
    await expect((await authenticated([` ${ADMIN_NAME} `])).api.amIAdmin())
      .resolves.toBe(false);
  });

  it("parses ADMINS JSON string arrays", async () => {
    await expect((await authenticated(JSON.stringify([ADMIN_NAME]))).api.amIAdmin())
      .resolves.toBe(true);
  });

  it("does not consult IdentityRegistry or the mutable user profile", async () => {
    const { api, registryGet, user } = await authenticated([ADMIN_NAME]);

    await api.setOwnDisplayName("not-an-admin@example.com");
    await expect(api.amIAdmin()).resolves.toBe(true);
    expect(user.whoami).not.toHaveBeenCalled();
    expect(registryGet).not.toHaveBeenCalled();
  });

  it("rejects non-array ADMINS without exposing its value", async () => {
    const marker = "private-admin-config-marker";
    const { api } = await authenticated(JSON.stringify({ marker }));

    const error = await api.amIAdmin().catch(value => value);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("ADMINS must be configured as an array of usernames.");
    expect(error.message).not.toContain(marker);
  });

  it("retains minted AdminApi authority without registry or allowlist revalidation", async () => {
    const { admin, api, env, registryGet } = await authenticated([ADMIN_NAME]);
    const retained = await api.getAdminApi();
    expect(retained).not.toBeNull();

    env.ADMINS = [];
    await expect(retained!.getSettings()).resolves.toEqual({ signupsEnabled: true });
    expect(admin.getSettings).toHaveBeenCalledExactlyOnceWith(ADMIN_NAME);
    expect(registryGet).not.toHaveBeenCalled();
  });
});
