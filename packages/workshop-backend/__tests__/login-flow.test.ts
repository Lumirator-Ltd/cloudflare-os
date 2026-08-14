import { describe, expect, it, vi } from "vitest";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow.js";
import type { IdentityState } from "../src/identity-registry.js";

const identity = {
  internalUserId: "stable-user-id",
  canonicalVerifiedEmail: "person@example.com",
  identityVersion: 1,
  status: "active" as const,
  created: false,
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
    waitUntil: vi.fn(),
  };
}

function callback(
  vendorId: string,
  registry: object,
  user: object,
  pending: object,
  productAnalytics?: object,
): LoginConnectCallbackImpl {
  const ctx = callbackContext(vendorId, registry, user, pending);
  const env = {
    BLUEPRINTS: { get: vi.fn().mockResolvedValue(null) },
    PRODUCT_ANALYTICS: productAnalytics,
  };
  return new LoginConnectCallbackImpl(
    ctx as unknown as ExecutionContext<{ pendingId: string; vendorId: string }>,
    env as unknown as Cloudflare.Env,
  );
}

function gatekeeperAccount(revoke = vi.fn().mockResolvedValue(undefined)) {
  return {
    getAuthenticationIdentity: vi.fn().mockResolvedValue({
      subject: "stable-provider-subject",
      verifiedEmail: identity.canonicalVerifiedEmail,
    }),
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
      resolveGatekeeperIdentity: vi.fn().mockResolvedValue(identity),
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

    expect(registry.resolveGatekeeperIdentity).toHaveBeenCalledExactlyOnceWith(
      "cloudflare", "stable-provider-subject", identity.canonicalVerifiedEmail, true,
    );
    expect(user.createGatekeeperSession).toHaveBeenCalledExactlyOnceWith(
      identity, "cloudflare", "stable-provider-subject", undefined,
    );
    expect(account.getAuthenticatedEmail).not.toHaveBeenCalled();
    expect(user.putConnectedAccount).not.toHaveBeenCalled();
    expect(user.markCredentialsExpired).not.toHaveBeenCalled();
    expect(user.markCredentialsRestored).not.toHaveBeenCalled();
    expect(registry.getIdentity).toHaveBeenCalledExactlyOnceWith(identity.internalUserId);
    expect(pending.deliver).toHaveBeenCalledExactlyOnceWith("stable-user-id:secret-token");
    expect(pending.fail).not.toHaveBeenCalled();
  });

  it("records account creation only when the registry reports a new Gatekeeper identity", async () => {
    const pending = {
      deliver: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      resolveGatekeeperIdentity: vi.fn().mockResolvedValue({ ...identity, created: true }),
      getIdentity: vi.fn().mockResolvedValue(activeIdentity(identity.identityVersion)),
    };
    const user = {
      createGatekeeperSession: vi.fn().mockResolvedValue("secret-token"),
      revokeGatekeeperSession: vi.fn().mockResolvedValue(undefined),
    };
    const analytics = { send: vi.fn().mockResolvedValue(undefined) };

    await callback("cloudflare", registry, user, pending, analytics).complete(
      gatekeeperAccount() as unknown as Fetcher<GatekeeperUser>,
    );

    expect(analytics.send).toHaveBeenCalledWith([
      expect.objectContaining({
        event_name: "account_created",
        user_id: identity.internalUserId,
        properties: { source: "gatekeeper" },
      }),
    ]);
  });

  it("returns the bounded explicit-link requirement for a claimed email", async () => {
    const pending = {
      deliver: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      resolveGatekeeperIdentity: vi.fn().mockRejectedValue(new Error(
        "Identity ownership requires explicit linking or deployment operator resolution.",
      )),
      getIdentity: vi.fn(),
    };
    const user = {
      createGatekeeperSession: vi.fn(),
      revokeGatekeeperSession: vi.fn(),
    };

    await callback("cloudflare", registry, user, pending).complete(
      gatekeeperAccount() as unknown as Fetcher<GatekeeperUser>,
    );

    expect(pending.deliver).not.toHaveBeenCalled();
    expect(user.createGatekeeperSession).not.toHaveBeenCalled();
    expect(pending.fail).toHaveBeenCalledExactlyOnceWith(
      "Identity ownership requires explicit linking or deployment operator resolution.",
    );
  });

  it.each([
    ["missing method", {}],
    ["method failure", {
      getAuthenticationIdentity: vi.fn().mockRejectedValue(new Error("provider detail")),
    }],
    ["null identity", { getAuthenticationIdentity: vi.fn().mockResolvedValue(null) }],
    ["blank subject", {
      getAuthenticationIdentity: vi.fn().mockResolvedValue({
        subject: "   ", verifiedEmail: identity.canonicalVerifiedEmail,
      }),
    }],
    ["blank email", {
      getAuthenticationIdentity: vi.fn().mockResolvedValue({
        subject: "stable-provider-subject", verifiedEmail: "  ",
      }),
    }],
  ])("fails closed for %s without falling back to legacy email", async (_label, methods) => {
    const pending = {
      deliver: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      resolveGatekeeperIdentity: vi.fn(),
      getIdentity: vi.fn(),
    };
    const user = {
      createGatekeeperSession: vi.fn(),
      revokeGatekeeperSession: vi.fn(),
    };
    const legacyEmail = vi.fn().mockResolvedValue(identity.canonicalVerifiedEmail);
    const account = { ...methods, getAuthenticatedEmail: legacyEmail };

    await callback("custom-auth", registry, user, pending).complete(
      account as unknown as Fetcher<GatekeeperUser>,
    );

    expect(legacyEmail).not.toHaveBeenCalled();
    expect(registry.resolveGatekeeperIdentity).not.toHaveBeenCalled();
    expect(user.createGatekeeperSession).not.toHaveBeenCalled();
    expect(pending.deliver).not.toHaveBeenCalled();
    expect(pending.fail).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/sign-in failed/i));
  });
});
