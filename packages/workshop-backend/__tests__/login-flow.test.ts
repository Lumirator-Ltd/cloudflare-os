import { describe, expect, it, vi } from "vitest";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow.js";

function callbackContext(vendorId: string, user: object, pending: object) {
  return {
    props: { pendingId: "pending-id", vendorId },
    exports: {
      PendingLogin: {
        idFromString: vi.fn().mockReturnValue("pending-id"),
        get: vi.fn().mockReturnValue(pending),
      },
      UserDurableObject: {
        idFromName: vi.fn((email: string) => email),
        get: vi.fn().mockReturnValue(user),
      },
    },
    waitUntil: vi.fn(),
  };
}

function callback(vendorId: string, user: object, pending: object): {
  callback: LoginConnectCallbackImpl;
  ctx: ReturnType<typeof callbackContext>;
} {
  const ctx = callbackContext(vendorId, user, pending);
  const env = { BLUEPRINTS: { get: vi.fn().mockResolvedValue(null) } };
  return {
    callback: new LoginConnectCallbackImpl(
      ctx as unknown as ExecutionContext<{ pendingId: string; vendorId: string }>,
      env as unknown as Cloudflare.Env,
    ),
    ctx,
  };
}

function gatekeeperAccount(email: string | null) {
  return { getAuthenticatedEmail: vi.fn().mockResolvedValue(email) };
}

function pendingLogin() {
  return {
    deliver: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Gatekeeper login completion", () => {
  it("uses only the authenticated email and delivers an email-keyed session", async () => {
    const email = "Person@Example.com";
    const pending = pendingLogin();
    const user = {
      loginOrCreateViaGatekeeper: vi.fn().mockResolvedValue("secret-token"),
      linkConnectedAccountFromLogin: vi.fn(),
    };
    const account = gatekeeperAccount(email);
    const { callback: login, ctx } = callback("github", user, pending);

    await login.complete(account as unknown as Fetcher<GatekeeperUser>);

    expect(account.getAuthenticatedEmail).toHaveBeenCalledOnce();
    expect(ctx.exports.UserDurableObject.idFromName).toHaveBeenCalledExactlyOnceWith(email);
    expect(user.loginOrCreateViaGatekeeper).toHaveBeenCalledExactlyOnceWith(email, true);
    expect(user.linkConnectedAccountFromLogin).not.toHaveBeenCalled();
    expect(pending.deliver).toHaveBeenCalledExactlyOnceWith(`${email}:secret-token`);
    expect(pending.fail).not.toHaveBeenCalled();
  });

  it("persists the Cloudflare billing account before delivering the session", async () => {
    const email = "billing@example.com";
    const expiresAt = new Date("2026-04-01T00:00:00Z");
    const pending = pendingLogin();
    const user = {
      loginOrCreateViaGatekeeper: vi.fn().mockResolvedValue("secret-token"),
      linkConnectedAccountFromLogin: vi.fn().mockResolvedValue(undefined),
    };
    const account = gatekeeperAccount(email);
    const { callback: login } = callback("cloudflare", user, pending);

    await login.complete(account as unknown as Fetcher<GatekeeperUser>, expiresAt);

    expect(user.linkConnectedAccountFromLogin).toHaveBeenCalledExactlyOnceWith(
      account, "cloudflare", expiresAt,
    );
    expect(user.linkConnectedAccountFromLogin.mock.invocationCallOrder[0])
      .toBeLessThan(pending.deliver.mock.invocationCallOrder[0]);
    expect(pending.deliver).toHaveBeenCalledExactlyOnceWith(`${email}:secret-token`);
  });

  it("fails when the Gatekeeper account has no authenticated email", async () => {
    const pending = pendingLogin();
    const user = {
      loginOrCreateViaGatekeeper: vi.fn(),
      linkConnectedAccountFromLogin: vi.fn(),
    };
    const account = gatekeeperAccount(null);
    const { callback: login, ctx } = callback("github", user, pending);

    await login.complete(account as unknown as Fetcher<GatekeeperUser>);

    expect(account.getAuthenticatedEmail).toHaveBeenCalledOnce();
    expect(ctx.exports.UserDurableObject.idFromName).not.toHaveBeenCalled();
    expect(user.loginOrCreateViaGatekeeper).not.toHaveBeenCalled();
    expect(pending.deliver).not.toHaveBeenCalled();
    expect(pending.fail).toHaveBeenCalledExactlyOnceWith(
      "This account has no verified email, so it can't be used to sign in.",
    );
  });

  it("honors disabled signups without blocking an existing user", async () => {
    const email = "existing@example.com";
    const pending = pendingLogin();
    const user = {
      loginOrCreateViaGatekeeper: vi.fn().mockResolvedValue(null),
      linkConnectedAccountFromLogin: vi.fn(),
    };
    const account = gatekeeperAccount(email);
    const { callback: login } = callback("github", user, pending);
    const env = Reflect.get(login, "env") as Cloudflare.Env;
    env.BLUEPRINTS = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ signupsEnabled: false })),
    } as never;

    await login.complete(account as unknown as Fetcher<GatekeeperUser>);

    expect(user.loginOrCreateViaGatekeeper).toHaveBeenCalledExactlyOnceWith(email, false);
    expect(pending.fail).toHaveBeenCalledExactlyOnceWith(
      "New sign-ups are currently disabled on this deployment.",
    );
  });
});
