import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerifiedCfAccessIdentity } from "../src/access.js";
import type { IdentityState } from "../src/identity-registry.js";
import { PublicApiImpl } from "../src/server.js";

const clerkMocks = vi.hoisted(() => ({
  dispose: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));
const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../src/clerk-session.js", () => ({
  createClerkSession: vi.fn(async () => ({
    control: {},
    dispose: clerkMocks.dispose,
  })),
}));
vi.mock("../src/observability.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/observability.js")>(),
  createWorkshopLogger: () => loggerMocks,
}));

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
    created: false,
  };
  const currentIdentity: IdentityState = {
    internalUserId: resolution.internalUserId,
    canonicalVerifiedEmail: resolution.canonicalVerifiedEmail,
    identityVersion: resolution.identityVersion,
    status: resolution.status,
  };
  const user = {
    whoami: vi.fn(async () => {
      if (graphAborted) throw new Error("capability graph aborted");
      return { type: "user" as const, id: INTERNAL_USER_ID, name: "Member" };
    }),
  };
  const registry = {
    findInternalUserIdByVerifiedEmail: vi.fn(async () => INTERNAL_USER_ID),
    resolveAccessIdentity: vi.fn(async () => resolution),
    resolveClerkIdentity: vi.fn(async () => resolution),
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
  const verifyClerk = vi.fn();
  const publicApi = new PublicApiImpl(
    ctx,
    env,
    abortSession,
    abortController.signal,
    verifyClerk as never,
    accessIdentity(expiresAt, email),
  );
  return { abortController, abortSession, ctx, env, publicApi, registry, verifyClerk };
}

afterEach(() => {
  clerkMocks.dispose.mockReset().mockResolvedValue(undefined);
  loggerMocks.warn.mockReset();
  vi.useRealTimers();
});

describe("PublicApi asynchronous cleanup", () => {
  it("tracks Clerk disposal and every identity unregister exactly once", async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { ctx, publicApi, registry, verifyClerk } = setup(now + 60_000);
    const clerkCleanup = Promise.withResolvers<void>();
    const registryCleanups = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    clerkMocks.dispose.mockImplementation(() => clerkCleanup.promise);
    registry.unregisterIdentitySession
      .mockImplementationOnce(() => registryCleanups[0].promise)
      .mockImplementationOnce(() => registryCleanups[1].promise);
    verifyClerk.mockResolvedValue({
      subject: "user_clerk",
      email: "member@example.com",
      expiresAt: new Date(now + 60_000),
    });

    await publicApi.authenticateFromCfAccess();
    await publicApi.authenticateFromCfAccess();
    await publicApi.authenticateWithClerk("signed-token");
    publicApi[Symbol.dispose]();
    publicApi[Symbol.dispose]();

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(clerkMocks.dispose).toHaveBeenCalledOnce();
    expect(registry.unregisterIdentitySession).toHaveBeenCalledTimes(2);
    expect(registry.unregisterIdentitySession.mock.calls).toEqual([
      [INTERNAL_USER_ID, expect.any(String)],
      [INTERNAL_USER_ID, expect.any(String)],
    ]);
    expect(registry.unregisterIdentitySession.mock.calls[0][1])
      .not.toBe(registry.unregisterIdentitySession.mock.calls[1][1]);

    clerkCleanup.resolve();
    for (const cleanup of registryCleanups) cleanup.resolve();
    await vi.mocked(ctx.waitUntil).mock.calls[0][0];
  });

  it("logs cleanup rejections without rejecting the tracked work", async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { ctx, publicApi, registry } = setup(now + 60_000);
    registry.unregisterIdentitySession.mockRejectedValueOnce(new Error("registry unavailable"));
    await publicApi.authenticateFromCfAccess();

    expect(() => publicApi[Symbol.dispose]()).not.toThrow();
    await expect(vi.mocked(ctx.waitUntil).mock.calls[0][0]).resolves.toBeUndefined();
    expect(loggerMocks.warn).toHaveBeenCalledWith("failed to dispose identity session", {
      event: "identity.session.dispose.failed",
      error: expect.objectContaining({ message: "registry unavailable" }),
    });
  });
});

describe("Cloudflare Access RPC session deadline", () => {
  it("aborts the whole graph at Access expiry alongside one authority watchdog", async () => {
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
    expect(registry.findInternalUserIdByVerifiedEmail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(deadlineTimerCount + 2);

    await vi.advanceTimersByTimeAsync(1_999);
    await expect(api.whoami()).resolves.toMatchObject({ id: INTERNAL_USER_ID });
    expect(abortSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(abortSession).toHaveBeenCalledOnce();
    await expect(api.whoami()).rejects.toThrow("capability graph aborted");
  });

  it("does not report account creation for an existing Access subject email move", async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { env, publicApi } = setup(now + 60_000, "member+moved@example.com");
    const analytics = { send: vi.fn().mockResolvedValue(undefined) };
    env.PRODUCT_ANALYTICS = analytics as never;

    await publicApi.authenticateFromCfAccess();

    const events = analytics.send.mock.calls.flatMap(([records]) => records);
    expect(events).toEqual([
      expect.objectContaining({
        event_name: "user_authenticated",
        user_id: INTERNAL_USER_ID,
      }),
    ]);
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

  it("rechecks expiry after delayed registry registration and returns no capability", async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { abortSession, publicApi, registry } = setup(now + 1_000);
    const registration = Promise.withResolvers<void>();
    registry.registerIdentitySession.mockImplementation(async () => registration.promise);

    const authentication = publicApi.authenticateFromCfAccess();
    await vi.waitFor(() => expect(registry.registerIdentitySession).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    registration.resolve();

    await expect(authentication).rejects.toThrow(/expired|closed/i);
    expect(abortSession).toHaveBeenCalledOnce();
    expect(registry.unregisterIdentitySession).toHaveBeenCalledOnce();
  });

  it("starts one exact-authority watchdog for repeated Access authentication", async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { publicApi } = setup(now + 120_000);

    await publicApi.authenticateFromCfAccess();
    const firstGraphTimerCount = vi.getTimerCount();
    await publicApi.authenticateFromCfAccess();

    expect(vi.getTimerCount()).toBe(firstGraphTimerCount);
  });

  it("aborts retained Access authority when the registry version changes after callback loss",
      async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { abortSession, publicApi, registry } = setup(now + 120_000);
    await publicApi.authenticateFromCfAccess();
    registry.getIdentity.mockResolvedValue({
      internalUserId: INTERNAL_USER_ID,
      canonicalVerifiedEmail: "member+moved@example.com",
      identityVersion: 3,
      status: "active",
    });

    await vi.advanceTimersByTimeAsync(15_000);

    expect(abortSession).toHaveBeenCalledOnce();
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

  it("records Clerk account creation only from the registry created result", async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { env, publicApi, registry, verifyClerk } = setup(now + 60_000);
    const analytics = { send: vi.fn().mockResolvedValue(undefined) };
    env.PRODUCT_ANALYTICS = analytics as never;
    registry.resolveClerkIdentity.mockResolvedValue({
      internalUserId: INTERNAL_USER_ID,
      canonicalVerifiedEmail: "member@example.com",
      identityVersion: 2,
      status: "active",
      created: true,
    });
    verifyClerk.mockResolvedValue({
      subject: "user_clerk",
      email: "member@example.com",
      expiresAt: new Date(now + 60_000),
    });

    await publicApi.authenticateWithClerk("signed-token");

    expect(analytics.send).toHaveBeenCalledWith([
      expect.objectContaining({
        event_name: "account_created",
        user_id: INTERNAL_USER_ID,
        properties: { source: "clerk" },
      }),
    ]);
  });
});
