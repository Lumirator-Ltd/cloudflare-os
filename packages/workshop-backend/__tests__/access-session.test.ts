import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerifiedCfAccessIdentity } from "../src/access.js";
import type { IdentityState } from "../src/identity-registry.js";
import { PublicApiImpl } from "../src/server.js";

const INTERNAL_USER_ID = "stable-access-user";
const ACCESS_ISSUER = "https://team.cloudflareaccess.test";
const ACCESS_AUDIENCE = "workshop-audience";

function accessIdentity(expiresAt: number, email = "member@example.com")
    : VerifiedCfAccessIdentity {
  return {
    subject: "access-subject-1",
    email,
    expiresAt: new Date(expiresAt),
    issuer: ACCESS_ISSUER,
    audience: ACCESS_AUDIENCE,
  };
}

function setup(expiresAt: number, email = "member@example.com") {
  const abortController = new AbortController();
  let graphAborted = false;
  const abortSession = vi.fn((reason: Error) => {
    graphAborted = true;
    abortController.abort(reason);
  });
  const userId = { name: INTERNAL_USER_ID } as DurableObjectId;
  const resolution = {
    internalUserId: INTERNAL_USER_ID,
    canonicalVerifiedEmail: email.trim().toLowerCase(),
    identityVersion: 2,
    status: "active" as const,
  };
  const currentIdentity: IdentityState = resolution;
  const user = {
    whoami: vi.fn(async () => {
      if (graphAborted) throw new Error("capability graph aborted");
      return { type: "user" as const, id: INTERNAL_USER_ID, name: "Member" };
    }),
  };
  const registry = {
    findInternalUserIdByVerifiedEmail: vi.fn(async () => INTERNAL_USER_ID),
    resolveAccessIdentity: vi.fn(async () => resolution),
    registerIdentitySession: vi.fn(async () => undefined),
    unregisterIdentitySession: vi.fn(async () => undefined),
    getIdentity: vi.fn(async () => currentIdentity),
  };
  const ctx = {
    exports: {
      UserDurableObject: {
        idFromName: vi.fn(() => userId),
        get: vi.fn(() => user),
      },
      IdentityRegistry: { getByName: vi.fn(() => registry) },
      OverseerDurableObject: {},
      AdminSettings: { getByName: vi.fn(() => ({})) },
    },
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
  const env = {
    ADMINS: [email.trim().toLowerCase()],
    BLUEPRINTS: { get: vi.fn(async () => null) },
  } as unknown as Cloudflare.Env;
  const publicApi = new PublicApiImpl(
    ctx,
    env,
    abortSession,
    abortController.signal,
    vi.fn() as never,
    accessIdentity(expiresAt, email),
  );
  return { abortController, abortSession, publicApi, registry };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Cloudflare Access RPC session deadline", () => {
  it("aborts the whole graph exactly at the verified Access expiry without arming another deadline",
      async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { abortSession, publicApi, registry } = setup(now + 2_000);

    const deadlineTimerCount = vi.getTimerCount();
    const api = await publicApi.authenticateFromCfAccess();
    expect(registry.resolveAccessIdentity).toHaveBeenCalledExactlyOnceWith(
      ACCESS_ISSUER,
      ACCESS_AUDIENCE,
      "access-subject-1",
      "member@example.com",
      true,
    );
    expect(vi.getTimerCount()).toBe(deadlineTimerCount);

    await vi.advanceTimersByTimeAsync(1_999);
    await expect(api.whoami()).resolves.toMatchObject({ id: INTERNAL_USER_ID });
    expect(abortSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(abortSession).toHaveBeenCalledOnce();
    await expect(api.whoami()).rejects.toThrow("capability graph aborted");
  });

  it("safely re-arms an Access deadline beyond the maximum JavaScript timeout", async () => {
    const now = Date.UTC(2026, 0, 1);
    const maximumTimeout = 0x7fffffff;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { abortSession } = setup(now + maximumTimeout + 1_000);

    await vi.advanceTimersByTimeAsync(maximumTimeout);
    expect(abortSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(abortSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("disposes the one Access deadline timer when the socket aborts early", async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { abortController, abortSession, publicApi } = setup(now + 60_000);

    expect(vi.getTimerCount()).toBe(1);
    abortController.abort(new Error("socket closed early"));
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(abortSession).not.toHaveBeenCalled();
    publicApi[Symbol.dispose]();
  });

  it("cannot authenticate when construction is delayed past the verified expiry", async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { abortSession, publicApi, registry } = setup(now - 1);

    await expect(publicApi.authenticateFromCfAccess()).rejects.toThrow(/expired/i);
    expect(abortSession).toHaveBeenCalledOnce();
    expect(registry.resolveAccessIdentity).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the moved canonical Access email for the deployment admin allowlist", async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const movedEmail = "member+moved@example.com";
    const { publicApi } = setup(now + 60_000, movedEmail);

    const api = await publicApi.authenticateFromCfAccess();
    await expect(api.amIAdmin()).resolves.toBe(true);
  });
});
