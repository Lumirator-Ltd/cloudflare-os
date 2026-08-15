import { describe, expect, it, vi } from "vitest";
import type { IdentityState } from "../src/identity-registry.js";
import {
  CURRENT_IDENTITY_AUTHORITY_REQUIRED,
  GATEKEEPER_SESSION_WATCHDOG_INTERVAL_MS,
  IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS,
  assertCurrentIdentityAuthority,
  mintCurrentIdentitySessionToken,
  startGatekeeperSessionWatchdog,
  startIdentityAuthorityWatchdog,
  type VerifiedAuthorityContext,
} from "../src/identity-authority.js";

const internalUserId = "stable-user-id";
const authority: VerifiedAuthorityContext = {
  canonicalVerifiedEmail: "admin@example.com",
  identityVersion: 3,
};

function reader(state: IdentityState | null) {
  return { getIdentity: vi.fn().mockResolvedValue(state) };
}

function activeState(overrides: Partial<IdentityState> = {}): IdentityState {
  return {
    internalUserId,
    canonicalVerifiedEmail: authority.canonicalVerifiedEmail,
    identityVersion: authority.identityVersion,
    status: "active",
    ...overrides,
  };
}

describe("current registry identity authority", () => {
  it("accepts only the exact active identity version and canonical email", async () => {
    await expect(assertCurrentIdentityAuthority(
      reader(activeState()), internalUserId, authority,
    )).resolves.toBeUndefined();

    for (const state of [
      null,
      activeState({ identityVersion: authority.identityVersion + 1 }),
      activeState({ canonicalVerifiedEmail: "moved@example.com" }),
      activeState({ canonicalVerifiedEmail: null, status: "collisionLocked" }),
    ]) {
      await expect(assertCurrentIdentityAuthority(reader(state), internalUserId, authority))
        .rejects.toThrow(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
    }
  });

  it("turns registry read failures into a bounded generic authorization error", async () => {
    const registry = { getIdentity: vi.fn().mockRejectedValue(new Error("private registry detail")) };

    const rejection = assertCurrentIdentityAuthority(registry, internalUserId, authority);
    await expect(rejection).rejects.toThrow(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
    await expect(rejection).rejects.not.toThrow("private registry detail");
  });
});

describe("privileged authority watchdog", () => {
  it("bounds stale authority after a live registry callback is lost", async () => {
    vi.useFakeTimers();
    try {
      let current = activeState();
      const registry = { getIdentity: vi.fn(async () => current) };
      const abort = vi.fn();
      const watchdog = startIdentityAuthorityWatchdog(
        () => assertCurrentIdentityAuthority(registry, internalUserId, authority), abort);

      const pollInterval = IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS / 2;
      await vi.advanceTimersByTimeAsync(pollInterval - 1);
      expect(registry.getIdentity).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(registry.getIdentity).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();

      // Model a registry restart dropping its ephemeral subscriber, followed by a durable version
      // change that only the privileged watchdog can now observe.
      current = activeState({ identityVersion: authority.identityVersion + 1 });
      await vi.advanceTimersByTimeAsync(pollInterval);
      expect(registry.getIdentity).toHaveBeenCalledTimes(2);
      expect(abort).toHaveBeenCalledOnce();
      expect(abort.mock.calls[0][0]).toEqual(
        expect.objectContaining({ message: CURRENT_IDENTITY_AUTHORITY_REQUIRED }),
      );

      watchdog.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts at the absolute deadline when an authority check never settles", async () => {
    vi.useFakeTimers();
    try {
      const assertCurrent = vi.fn(() => new Promise<void>(() => {}));
      const abort = vi.fn();
      startIdentityAuthorityWatchdog(assertCurrent, abort);

      const pollInterval = IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS / 2;
      await vi.advanceTimersByTimeAsync(pollInterval);
      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(pollInterval - 1);
      expect(abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(abort).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: CURRENT_IDENTITY_AUTHORITY_REQUIRED }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      "identity",
      IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS,
      startIdentityAuthorityWatchdog,
    ],
    [
      "Gatekeeper token",
      GATEKEEPER_SESSION_WATCHDOG_INTERVAL_MS,
      startGatekeeperSessionWatchdog,
    ],
  ])("counts a delayed successful %s check against the next hard deadline",
      async (_name, intervalMs, startWatchdog) => {
    vi.useFakeTimers();
    try {
      const firstCheck = Promise.withResolvers<void>();
      const assertCurrent = vi.fn()
        .mockImplementationOnce(() => firstCheck.promise)
        .mockImplementationOnce(() => new Promise<void>(() => {}));
      const abort = vi.fn();
      startWatchdog(assertCurrent, abort);

      await vi.advanceTimersByTimeAsync(intervalMs / 2);
      expect(assertCurrent).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(intervalMs / 2 - 1);
      firstCheck.resolve();
      await Promise.resolve();
      expect(abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(assertCurrent).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(intervalMs / 2 - 1);
      expect(abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(abort).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        message: expect.stringMatching(/authority|Gatekeeper session/i),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart after a timed-out check settles late", async () => {
    vi.useFakeTimers();
    try {
      const pending = Promise.withResolvers<void>();
      const assertCurrent = vi.fn(() => pending.promise);
      const abort = vi.fn();
      startIdentityAuthorityWatchdog(assertCurrent, abort);

      await vi.advanceTimersByTimeAsync(IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS / 2);
      expect(abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS / 2);
      expect(abort).toHaveBeenCalledOnce();
      pending.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS * 2);

      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears both polling and deadline timers when its owning socket is disposed", async () => {
    vi.useFakeTimers();
    try {
      const assertCurrent = vi.fn().mockResolvedValue(undefined);
      const abort = vi.fn();
      const watchdog = startIdentityAuthorityWatchdog(assertCurrent, abort);
      watchdog.dispose();

      await vi.advanceTimersByTimeAsync(IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS * 2);
      expect(assertCurrent).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposal during a pending check prevents its deadline and late resolution restarting it",
      async () => {
    vi.useFakeTimers();
    try {
      const pending = Promise.withResolvers<void>();
      let watchdog!: { dispose(): void };
      const assertCurrent = vi.fn(() => {
        watchdog.dispose();
        return pending.promise;
      });
      const abort = vi.fn();
      watchdog = startIdentityAuthorityWatchdog(assertCurrent, abort);

      await vi.advanceTimersByTimeAsync(IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS / 2);
      pending.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS * 2);

      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Gatekeeper session issuance", () => {
  it("revokes and never returns a token when authority changes during minting", async () => {
    const minted = Promise.withResolvers<void>();
    const continueCheck = Promise.withResolvers<void>();
    let current = activeState();
    const revoke = vi.fn().mockResolvedValue(undefined);

    const result = mintCurrentIdentitySessionToken({
      mint: async () => {
        minted.resolve();
        return "secret-token";
      },
      revoke,
      assertCurrent: async () => {
        await continueCheck.promise;
        await assertCurrentIdentityAuthority(reader(current), internalUserId, authority);
      },
    });

    await minted.promise;
    current = activeState({ identityVersion: authority.identityVersion + 1 });
    continueCheck.resolve();

    await expect(result).rejects.toThrow(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("secret-token");
  });
});
