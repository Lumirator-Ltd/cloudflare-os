import { describe, expect, it, vi } from "vitest";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow.js";
import type { IdentityState } from "../src/identity-registry.js";

const identity = {
  internalUserId: "stable-user-id",
  canonicalVerifiedEmail: "person@example.com",
  identityVersion: 1,
};

function activeIdentity(identityVersion: number): IdentityState {
  return {
    status: "active",
    internalUserId: identity.internalUserId,
    canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
    identityVersion,
  };
}

function callbackContext(vendorId: string, registry: object, user: object, pending: object) {
  return {
    props: { pendingId: "pending-id", vendorId },
    exports: {
      PendingLogin: {
        idFromString: vi.fn().mockReturnValue("pending-id"),
        get: vi.fn().mockReturnValue(pending),
      },
      IdentityRegistry: { getByName: vi.fn().mockReturnValue(registry) },
      UserDurableObject: {
        idFromName: vi.fn().mockReturnValue("user-id"),
        get: vi.fn().mockReturnValue(user),
      },
    },
  };
}

function callback(
  vendorId: string,
  registry: object,
  user: object,
  pending: object,
): LoginConnectCallbackImpl {
  const ctx = callbackContext(vendorId, registry, user, pending);
  const env = { BLUEPRINTS: { get: vi.fn().mockResolvedValue(null) } };
  return new LoginConnectCallbackImpl(
    ctx as unknown as ExecutionContext<{ pendingId: string; vendorId: string }>,
    env as unknown as Cloudflare.Env,
  );
}

function gatekeeperAccount(revoke = vi.fn().mockResolvedValue(undefined)) {
  return {
    getAuthenticatedEmail: vi.fn().mockResolvedValue(identity.canonicalVerifiedEmail),
    describe: vi.fn().mockResolvedValue({
      displayName: "Cloudflare account",
      uniqueName: identity.canonicalVerifiedEmail,
    }),
    revoke,
  };
}

describe("Gatekeeper login completion", () => {
  it("rolls back the exact Cloudflare link and does not deliver a stale session", async () => {
    let current = activeIdentity(identity.identityVersion);
    const sessions = new Set<string>();
    let connected = false;
    const pending = {
      deliver: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      resolveEmailIdentity: vi.fn().mockResolvedValue(identity),
      getIdentity: vi.fn(async () => current),
    };
    const link = { accountId: 7, mutationId: "login-mutation" };
    const user = {
      createGatekeeperSession: vi.fn(async () => {
        sessions.add("secret-token");
        return "secret-token";
      }),
      revokeGatekeeperSession: vi.fn(async (token: string) => {
        sessions.delete(token);
      }),
      linkConnectedAccountFromLogin: vi.fn(async () => {
        connected = true;
        current = activeIdentity(identity.identityVersion + 1);
        return link;
      }),
      commitConnectedAccountLogin: vi.fn(),
      rollbackConnectedAccountLogin: vi.fn(async () => {
        connected = false;
      }),
    };
    const account = gatekeeperAccount();

    await callback("cloudflare", registry, user, pending).complete(
      account as unknown as Fetcher<GatekeeperUser>,
    );

    expect(pending.deliver).not.toHaveBeenCalled();
    expect(pending.fail).toHaveBeenCalledExactlyOnceWith("Sign-in failed. Please try again.");
    expect(user.revokeGatekeeperSession).toHaveBeenCalledExactlyOnceWith("secret-token");
    expect(user.rollbackConnectedAccountLogin).toHaveBeenCalledExactlyOnceWith(link);
    expect(user.commitConnectedAccountLogin).not.toHaveBeenCalled();
    expect(sessions).toEqual(new Set());
    expect(connected).toBe(false);
  });

  it("fails the pending login after local rollback even when account revocation rejects", async () => {
    let current = activeIdentity(identity.identityVersion);
    let connected = false;
    const pending = {
      deliver: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      resolveEmailIdentity: vi.fn().mockResolvedValue(identity),
      getIdentity: vi.fn(async () => current),
    };
    const revoke = vi.fn().mockRejectedValue(new Error("revoke rejected"));
    const account = gatekeeperAccount(revoke);
    const link = { accountId: 3, mutationId: "rejecting-revoke" };
    const user = {
      createGatekeeperSession: vi.fn().mockResolvedValue("secret-token"),
      revokeGatekeeperSession: vi.fn().mockResolvedValue(undefined),
      linkConnectedAccountFromLogin: vi.fn(async () => {
        connected = true;
        current = activeIdentity(identity.identityVersion + 1);
        return link;
      }),
      commitConnectedAccountLogin: vi.fn(),
      rollbackConnectedAccountLogin: vi.fn(async () => {
        connected = false;
        void account.revoke().catch(() => {});
      }),
    };

    await callback("cloudflare", registry, user, pending).complete(
      account as unknown as Fetcher<GatekeeperUser>,
    );

    expect(connected).toBe(false);
    expect(pending.fail).toHaveBeenCalledExactlyOnceWith("Sign-in failed. Please try again.");
    expect(pending.deliver).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("keeps non-Cloudflare login behavior transient", async () => {
    const current = activeIdentity(identity.identityVersion);
    const pending = {
      deliver: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      resolveEmailIdentity: vi.fn().mockResolvedValue(identity),
      getIdentity: vi.fn().mockResolvedValue(current),
    };
    const user = {
      createGatekeeperSession: vi.fn().mockResolvedValue("secret-token"),
      revokeGatekeeperSession: vi.fn().mockResolvedValue(undefined),
      linkConnectedAccountFromLogin: vi.fn(),
      commitConnectedAccountLogin: vi.fn(),
      rollbackConnectedAccountLogin: vi.fn(),
    };
    const account = gatekeeperAccount();

    await callback("github", registry, user, pending).complete(
      account as unknown as Fetcher<GatekeeperUser>,
    );

    expect(pending.deliver).toHaveBeenCalledExactlyOnceWith("stable-user-id:secret-token");
    expect(pending.fail).not.toHaveBeenCalled();
    expect(user.linkConnectedAccountFromLogin).not.toHaveBeenCalled();
    expect(user.commitConnectedAccountLogin).not.toHaveBeenCalled();
    expect(user.rollbackConnectedAccountLogin).not.toHaveBeenCalled();
  });
});
