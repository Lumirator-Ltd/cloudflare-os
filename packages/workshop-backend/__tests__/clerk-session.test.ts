import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityResolution } from "../src/identity-registry.js";
import type { VerifiedClerkIdentity } from "../src/clerk-auth.js";
import { createClerkSession } from "../src/clerk-session.js";

const SUBJECT = "user_clerk_a";
const USER_ID = "internal-user-a";

function identity(expiresAt: number, overrides: Partial<VerifiedClerkIdentity> = {})
    : VerifiedClerkIdentity {
  return {
    subject: SUBJECT,
    email: "alice@example.com",
    expiresAt: new Date(expiresAt),
    ...overrides,
  };
}

function resolution(overrides: Partial<IdentityResolution> = {}): IdentityResolution {
  return {
    internalUserId: USER_ID,
    canonicalVerifiedEmail: "alice@example.com",
    identityVersion: 1,
    status: "active",
    ...overrides,
  };
}

type SetupOptions = {
  now?: number;
  expiresAt?: number;
  verify?: (token: string) => Promise<VerifiedClerkIdentity>;
  resolve?: (
    subject: string,
    email: string,
    signupsEnabled: boolean,
  ) => Promise<IdentityResolution>;
  unregister?: (subscriberId: string, internalUserId: string) => Promise<void>;
};

async function setup(options: SetupOptions = {}) {
  const now = options.now ?? Date.UTC(2026, 0, 1);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const abortSession = vi.fn();
  const unregister = vi.fn(options.unregister ?? (async () => {}));
  const registrations: Array<{
    subscriberId: string;
    identity: IdentityResolution;
    invalidate: () => void;
  }> = [];
  const register = vi.fn(async (
    subscriberId: string,
    current: IdentityResolution,
    invalidate: () => void,
  ) => {
    registrations.push({ subscriberId, identity: current, invalidate });
  });
  const expiresAt = options.expiresAt ?? now + 60_000;
  const result = await createClerkSession({
    initialIdentity: identity(expiresAt),
    initialResolution: resolution(),
    signupsEnabled: true,
    abortSession,
    verify: options.verify ?? (async () => identity(now + 120_000)),
    resolve: options.resolve ?? (async () => resolution()),
    register,
    unregister,
  });
  return { now, abortSession, unregister, registrations, register, result };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Clerk RPC session deadlines", () => {
  it("aborts the whole socket at the exact verified expiry", async () => {
    const { now, abortSession } = await setup({ expiresAt: Date.UTC(2026, 0, 1) + 2_000 });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(abortSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now()).toBe(now + 2_000);
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("safely re-arms deadlines beyond the maximum JavaScript timeout", async () => {
    const now = Date.UTC(2026, 0, 1);
    const maximumTimeout = 0x7fffffff;
    const { abortSession } = await setup({
      now,
      expiresAt: now + maximumTimeout + 1_000,
    });

    await vi.advanceTimersByTimeAsync(maximumTimeout);
    expect(abortSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(abortSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("replaces the old deadline only after a successful verified refresh", async () => {
    const now = Date.UTC(2026, 0, 1);
    const replacementExpiry = now + 10_000;
    const { abortSession, result } = await setup({
      now,
      expiresAt: now + 2_000,
      verify: async () => identity(replacementExpiry),
    });

    await expect(result.control.refresh("replacement-token"))
      .resolves.toEqual(new Date(replacementExpiry));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(abortSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("rejects a registry move after a lost broadcast and aborts the initiating session", async () => {
    const now = Date.UTC(2026, 0, 1);
    const moved = resolution({
      canonicalVerifiedEmail: "alice+moved@example.com",
      identityVersion: 2,
    });
    const resolve = vi.fn(async () => moved);
    const { abortSession, registrations, result } = await setup({
      now,
      verify: async () => identity(now + 120_000, { email: moved.canonicalVerifiedEmail }),
      resolve,
    });

    // This models the causal split allowed by the platform: a registry restart loses the ephemeral
    // callback, so descendants remain usable under the accepted v1 deadline until refresh observes
    // the durable v2 record. The separate real capability-graph test proves hard expiry breaks them.
    await expect(result.control.refresh("moved-email-token")).rejects.toThrow("identity changed");
    expect(resolve).toHaveBeenCalledWith(SUBJECT, moved.canonicalVerifiedEmail, true);
    expect(registrations).toHaveLength(1);
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("fails closed when a second refresh finishes before an in-flight refresh", async () => {
    const now = Date.UTC(2026, 0, 1);
    const firstVerification = Promise.withResolvers<VerifiedClerkIdentity>();
    const verify = vi.fn(async (token: string) => token === "first"
      ? await firstVerification.promise
      : identity(now + 20_000));
    const { abortSession, result } = await setup({ now, verify });

    const first = result.control.refresh("first");
    const second = result.control.refresh("second");
    await expect(second).rejects.toThrow(/refresh.*progress/i);
    expect(verify).toHaveBeenCalledOnce();
    expect(abortSession).toHaveBeenCalledOnce();

    firstVerification.resolve(identity(now + 10_000));
    await expect(first).rejects.toThrow(/closed/i);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it.each([
    ["different Clerk subject", identity(Date.UTC(2026, 0, 1) + 120_000, { subject: "user_clerk_b" }), resolution()],
    ["different internal user", identity(Date.UTC(2026, 0, 1) + 120_000), resolution({ internalUserId: "internal-user-b" })],
    ["unexpected identity version", identity(Date.UTC(2026, 0, 1) + 120_000), resolution({ identityVersion: 2 })],
  ])("aborts immediately when refresh resolves a %s", async (_name, refreshed, resolved) => {
    const { abortSession, result } = await setup({
      verify: async () => refreshed,
      resolve: async () => resolved,
    });

    await expect(result.control.refresh("invalid-replacement")).rejects.toThrow();
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("fails closed if the current deadline fires while refresh is awaiting registry resolution",
      async () => {
    const now = Date.UTC(2026, 0, 1);
    let finishResolution!: (value: IdentityResolution) => void;
    const pendingResolution = new Promise<IdentityResolution>(resolve => {
      finishResolution = resolve;
    });
    const { abortSession, result } = await setup({
      now,
      expiresAt: now + 1_000,
      verify: async () => identity(now + 120_000),
      resolve: async () => pendingResolution,
    });

    const refresh = result.control.refresh("slow-replacement");
    await vi.advanceTimersByTimeAsync(1_000);
    finishResolution(resolution());
    await expect(refresh).rejects.toThrow(/expired|closed/i);
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("aborts immediately on any refresh verification error", async () => {
    const { abortSession, result } = await setup({
      verify: async () => { throw new Error("verification failed"); },
    });

    await expect(result.control.refresh("bad-token")).rejects.toThrow("verification failed");
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("logout aborts the whole socket before it can resolve", async () => {
    const { abortSession, result } = await setup();

    await result.control.logout();
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("dropping only the session-control target does not cancel the socket deadline", async () => {
    const now = Date.UTC(2026, 0, 1);
    const { abortSession, result, unregister } = await setup({ now, expiresAt: now + 1_000 });

    result.control[Symbol.dispose]();
    expect(unregister).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("cleans up its timer and registry subscriber when the socket is disposed", async () => {
    const { abortSession, registrations, result, unregister } = await setup();

    await result.dispose();
    expect(unregister).toHaveBeenCalledWith(registrations[0].subscriberId, USER_ID);
    await vi.runAllTimersAsync();
    expect(abortSession).not.toHaveBeenCalled();
  });

  it("logs and retries registry unregister after an abort-time RPC failure", async () => {
    const unregister = vi.fn()
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const { result } = await setup({ unregister });
      await result.control.logout().catch(() => {});
      await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
      await expect(result.dispose()).resolves.toBeUndefined();
      expect(unregister).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.flat()).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "clerk.session.unregister.failed" }),
      ]));
    } finally {
      warn.mockRestore();
    }
  });

  it("aborts eagerly when the registry invalidates the live identity", async () => {
    const { abortSession, registrations } = await setup();

    registrations[0].invalidate();
    expect(abortSession).toHaveBeenCalledOnce();
  });
});
