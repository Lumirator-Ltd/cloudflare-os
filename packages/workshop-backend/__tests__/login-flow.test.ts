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

describe("Gatekeeper login completion", () => {
  it("revokes the session and unlinks Cloudflare when authority changes during linking", async () => {
    let current = activeIdentity(identity.identityVersion);
    const sessions = new Set<string>();
    const connectedAccounts = new Set<number>();
    const pending = {
      deliver: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      resolveEmailIdentity: vi.fn().mockResolvedValue(identity),
      getIdentity: vi.fn(async () => current),
    };
    const user = {
      createGatekeeperSession: vi.fn(async () => {
        sessions.add("secret-token");
        return "secret-token";
      }),
      revokeGatekeeperSession: vi.fn(async (token: string) => {
        sessions.delete(token);
      }),
      linkConnectedAccountFromLogin: vi.fn(async () => {
        connectedAccounts.add(7);
        current = activeIdentity(identity.identityVersion + 1);
        return 7;
      }),
      disconnectAccount: vi.fn(async (accountId: number) => {
        connectedAccounts.delete(accountId);
      }),
    };
    const ctx = {
      props: { pendingId: "pending-id", vendorId: "cloudflare" },
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
    const env = {
      BLUEPRINTS: { get: vi.fn().mockResolvedValue(null) },
    };
    const callback = new LoginConnectCallbackImpl(
      ctx as unknown as ExecutionContext<{ pendingId: string; vendorId: string }>,
      env as unknown as Cloudflare.Env,
    );
    const account = {
      getAuthenticatedEmail: vi.fn().mockResolvedValue(identity.canonicalVerifiedEmail),
      describe: vi.fn().mockResolvedValue({
        displayName: "Cloudflare account",
        uniqueName: identity.canonicalVerifiedEmail,
      }),
      revoke: vi.fn().mockResolvedValue(undefined),
    };

    await callback.complete(account as unknown as Fetcher<GatekeeperUser>);

    expect(pending.deliver).not.toHaveBeenCalled();
    expect(pending.fail).toHaveBeenCalledExactlyOnceWith("Sign-in failed. Please try again.");
    expect(user.revokeGatekeeperSession).toHaveBeenCalledExactlyOnceWith("secret-token");
    expect(user.disconnectAccount).toHaveBeenCalledExactlyOnceWith(7);
    expect(sessions).toEqual(new Set());
    expect(connectedAccounts).toEqual(new Set());
  });
});
