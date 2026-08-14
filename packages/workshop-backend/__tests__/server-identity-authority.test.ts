import { describe, expect, it, vi } from "vitest";
import type { IdentityState } from "../src/identity-registry.js";
import {
  CURRENT_IDENTITY_AUTHORITY_REQUIRED,
  IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS,
} from "../src/identity-authority.js";
import { PublicApiImpl } from "../src/server.js";

const internalUserId = "stable-non-admin-user";
const authority = {
  canonicalVerifiedEmail: "member@example.com",
  identityVersion: 4,
};

function currentIdentity(overrides: Partial<IdentityState> = {}): IdentityState {
  return {
    internalUserId,
    ...authority,
    status: "active",
    ...overrides,
  };
}

describe("registry-backed Gatekeeper graph authority", () => {
  it("starts one watchdog at authentication and bounds authority after subscriber loss", async () => {
    vi.useFakeTimers();
    let current = currentIdentity();
    let graphAborted = false;
    let invalidationSubscriber: (() => Promise<void>) | undefined;
    const userId = { name: internalUserId } as DurableObjectId;
    const user = {
      id: userId,
      authenticate: vi.fn().mockResolvedValue({ kind: "gatekeeper", provider: "test", ...authority }),
      revokeGatekeeperSession: vi.fn().mockResolvedValue(undefined),
      whoami: vi.fn(async () => {
        if (graphAborted) throw new Error("capability graph aborted");
        return { type: "user" as const, id: internalUserId, name: "Member" };
      }),
    };
    const registry = {
      getIdentity: vi.fn(async () => current),
      registerIdentitySession: vi.fn(async (
        _id: string,
        _version: number,
        _subscriberId: string,
        subscriber: () => Promise<void>,
      ) => { invalidationSubscriber = subscriber; }),
      unregisterIdentitySession: vi.fn().mockResolvedValue(undefined),
    };
    const abortController = new AbortController();
    const abortSession = vi.fn((reason: Error) => {
      graphAborted = true;
      abortController.abort(reason);
    });
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
    const env = { ADMINS: [] as string[] } as unknown as Cloudflare.Env;
    const publicApi = new PublicApiImpl(
      ctx,
      env,
      abortSession,
      abortController.signal,
      vi.fn() as never,
    );

    try {
      const timersBeforeAuthentication = vi.getTimerCount();
      const api = await publicApi.authenticate(`${internalUserId}:secret-token`);
      expect(invalidationSubscriber).toEqual(expect.any(Function));
      expect(vi.getTimerCount()).toBe(timersBeforeAuthentication + 2);

      // Model a registry restart dropping its ephemeral callback without changing durable state.
      invalidationSubscriber = undefined;
      const pollInterval = IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS / 2;
      for (let tick = 0; tick < 2; tick++) {
        await vi.advanceTimersByTimeAsync(pollInterval);
        await expect(api.whoami()).resolves.toMatchObject({ id: internalUserId });
        expect(abortSession).not.toHaveBeenCalled();
      }

      const timersBeforeAdminCheck = vi.getTimerCount();
      env.ADMINS = [authority.canonicalVerifiedEmail];
      await expect(api.getAdminApi()).resolves.not.toBeNull();
      expect(vi.getTimerCount()).toBe(timersBeforeAdminCheck);

      current = currentIdentity({
        canonicalVerifiedEmail: "member+moved@example.com",
        identityVersion: authority.identityVersion + 1,
      });
      await vi.advanceTimersByTimeAsync(pollInterval);

      expect(abortSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: CURRENT_IDENTITY_AUTHORITY_REQUIRED }),
      );
      await expect(api.whoami()).rejects.toThrow("capability graph aborted");
    } finally {
      publicApi[Symbol.dispose]();
      vi.useRealTimers();
    }
  });
});
