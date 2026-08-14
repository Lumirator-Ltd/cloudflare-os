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
  it("keeps Cloudflare sign-in transient and delivers a version-bound session", async () => {
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
      putConnectedAccount: vi.fn(),
      markCredentialsExpired: vi.fn(),
      markCredentialsRestored: vi.fn(),
    };
    const account = gatekeeperAccount();

    await callback("cloudflare", registry, user, pending).complete(
      account as unknown as Fetcher<GatekeeperUser>,
    );

    expect(user.createGatekeeperSession).toHaveBeenCalledExactlyOnceWith(identity, "cloudflare");
    expect(user.putConnectedAccount).not.toHaveBeenCalled();
    expect(user.markCredentialsExpired).not.toHaveBeenCalled();
    expect(user.markCredentialsRestored).not.toHaveBeenCalled();
    expect(registry.getIdentity).toHaveBeenCalledExactlyOnceWith(identity.internalUserId);
    expect(pending.deliver).toHaveBeenCalledExactlyOnceWith("stable-user-id:secret-token");
    expect(pending.fail).not.toHaveBeenCalled();
  });
});
