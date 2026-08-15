import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerifiedCfAccessIdentity } from "../src/access.js";
import type { IdentityState } from "../src/identity-registry.js";
import { GATEKEEPER_SESSION_WATCHDOG_INTERVAL_MS } from "../src/identity-authority.js";
import { PublicApiImpl } from "../src/server.js";
import type { RegistrySessionAuthentication } from "../src/user.js";

const INTERNAL_USER_ID = "gatekeeper-session-user";
const TOKEN = "secret-token";
const CURRENT_GATEKEEPER_SESSION_REQUIRED = "Current Gatekeeper session is no longer valid.";
const AUTHENTICATION: RegistrySessionAuthentication = {
  kind: "gatekeeper",
  provider: "test",
  subject: "stable-provider-subject",
  canonicalVerifiedEmail: "member@example.com",
  identityVersion: 3,
  expiresAt: new Date(Date.UTC(2026, 0, 1) + 120_000),
};

function setup(options: {
  authenticate?: () => Promise<RegistrySessionAuthentication | null>;
  assertGatekeeperSession?: () => Promise<void>;
  accessIdentity?: VerifiedCfAccessIdentity;
} = {}) {
  const abortController = new AbortController();
  let graphAborted = false;
  const abortSession = vi.fn((reason: Error) => {
    graphAborted = true;
    abortController.abort(reason);
  });
  const userId = { name: INTERNAL_USER_ID } as DurableObjectId;
  const user = {
    authenticate: vi.fn(options.authenticate ?? (async () => AUTHENTICATION)),
    registerGatekeeperSession: vi.fn().mockResolvedValue(undefined),
    unregisterGatekeeperSession: vi.fn().mockResolvedValue(undefined),
    assertGatekeeperSession: vi.fn(
      options.assertGatekeeperSession ?? (async () => undefined),
    ),
    revokeGatekeeperSession: vi.fn().mockResolvedValue(undefined),
    whoami: vi.fn(async () => {
      if (graphAborted) throw new Error("capability graph aborted");
      return { type: "user" as const, id: INTERNAL_USER_ID, name: "Member" };
    }),
  };
  const currentIdentity: IdentityState = {
    internalUserId: INTERNAL_USER_ID,
    canonicalVerifiedEmail: AUTHENTICATION.canonicalVerifiedEmail,
    identityVersion: AUTHENTICATION.identityVersion,
    status: "active",
  };
  const registry = {
    getIdentity: vi.fn(async () => currentIdentity),
    registerIdentitySession: vi.fn().mockResolvedValue(undefined),
    unregisterIdentitySession: vi.fn().mockResolvedValue(undefined),
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
  const publicApi = new PublicApiImpl(
    ctx,
    { ADMINS: [] } as unknown as Cloudflare.Env,
    abortSession,
    abortController.signal,
    vi.fn() as never,
    options.accessIdentity,
  );
  return { abortSession, ctx, publicApi, registry, user };
}

afterEach(() => {
  vi.useRealTimers();
});

function logout(publicApi: PublicApiImpl): Promise<void> {
  return Promise.resolve().then(() => publicApi.logoutGatekeeperSession());
}

describe("PublicApi Gatekeeper session ownership", () => {
  it("logs out only the Gatekeeper bearer authenticated on this socket and is idempotent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const { abortSession, publicApi, user } = setup();

    await expect(logout(publicApi)).rejects.toThrow(/authenticated.*Gatekeeper|Gatekeeper.*authenticated/i);
    await publicApi.authenticate(`${INTERNAL_USER_ID}:${TOKEN}`);
    const revocation = Promise.withResolvers<void>();
    user.revokeGatekeeperSession.mockImplementation(() => revocation.promise);

    const first = logout(publicApi);
    const duplicate = logout(publicApi);
    await Promise.resolve();
    expect(abortSession).not.toHaveBeenCalled();
    revocation.resolve();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined]);
    await expect(logout(publicApi)).resolves.toBeUndefined();
    expect(user.revokeGatekeeperSession).toHaveBeenCalledExactlyOnceWith(
      TOKEN, expect.any(String),
    );
    expect(abortSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(abortSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: CURRENT_GATEKEEPER_SESSION_REQUIRED }),
    );
  });

  it("rejects logout failures before durable deletion without acknowledging or aborting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const { abortSession, publicApi, user } = setup();
    await publicApi.authenticate(`${INTERNAL_USER_ID}:${TOKEN}`);
    user.revokeGatekeeperSession.mockRejectedValueOnce(new Error("durable delete failed"));

    await expect(logout(publicApi)).rejects.toThrow("durable delete failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(abortSession).not.toHaveBeenCalled();

    user.revokeGatekeeperSession.mockResolvedValueOnce(undefined);
    await expect(logout(publicApi)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(user.revokeGatekeeperSession).toHaveBeenCalledTimes(2);
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("fails closed for concurrent, duplicate, and mixed-provider authentication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const pending = Promise.withResolvers<RegistrySessionAuthentication | null>();
    const { publicApi, user } = setup({ authenticate: () => pending.promise });

    const first = publicApi.authenticate(`${INTERNAL_USER_ID}:${TOKEN}`);
    expect(user.authenticate).toHaveBeenCalledOnce();
    await expect(publicApi.authenticate(`${INTERNAL_USER_ID}:${TOKEN}`))
      .rejects.toThrow(/already authenticating|already authenticated/i);
    await expect(publicApi.authenticateWithClerk("clerk-token"))
      .rejects.toThrow(/Gatekeeper/i);

    pending.resolve(AUTHENTICATION);
    await first;
    await expect(publicApi.authenticate(`${INTERNAL_USER_ID}:${TOKEN}`))
      .rejects.toThrow(/already .*authenticated/i);
    await expect(publicApi.authenticateFromCfAccess()).rejects.toThrow(/Gatekeeper/i);
  });

  it("rejects Gatekeeper authentication on a Cloudflare Access socket", async () => {
    const now = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const accessIdentity: VerifiedCfAccessIdentity = {
      issuer: "https://access.test",
      audience: "audience",
      subject: "access-subject",
      email: "member@example.com",
      expiresAt: new Date(now + 60_000),
    };
    const { publicApi, user } = setup({ accessIdentity });

    await expect(publicApi.authenticate(`${INTERNAL_USER_ID}:${TOKEN}`))
      .rejects.toThrow(/Access/i);
    expect(user.authenticate).not.toHaveBeenCalled();
  });
});

describe("Gatekeeper durable-token watchdog", () => {
  it("aborts after subscriber loss when the exact durable token is revoked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    let revoked = false;
    const { abortSession, publicApi, user } = setup({
      assertGatekeeperSession: async () => {
        if (revoked) throw new Error("revoked");
      },
    });
    await publicApi.authenticate(`${INTERNAL_USER_ID}:${TOKEN}`);

    revoked = true;
    await vi.advanceTimersByTimeAsync(GATEKEEPER_SESSION_WATCHDOG_INTERVAL_MS / 2);

    expect(user.assertGatekeeperSession).toHaveBeenCalledWith(TOKEN, AUTHENTICATION);
    expect(abortSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: CURRENT_GATEKEEPER_SESSION_REQUIRED }),
    );
  });

  it("aborts at the absolute deadline when the durable-token check hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const { abortSession, publicApi, user } = setup({
      assertGatekeeperSession: () => new Promise<void>(() => {}),
    });
    await publicApi.authenticate(`${INTERNAL_USER_ID}:${TOKEN}`);

    await vi.advanceTimersByTimeAsync(GATEKEEPER_SESSION_WATCHDOG_INTERVAL_MS / 2);
    expect(user.assertGatekeeperSession).toHaveBeenCalledOnce();
    expect(abortSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GATEKEEPER_SESSION_WATCHDOG_INTERVAL_MS / 2);

    expect(abortSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: CURRENT_GATEKEEPER_SESSION_REQUIRED }),
    );
  });

  it("unregisters through waitUntil on socket disposal without revoking the token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const { ctx, publicApi, registry, user } = setup();
    await publicApi.authenticate(`${INTERNAL_USER_ID}:${TOKEN}`);

    publicApi[Symbol.dispose]();
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await expect(vi.mocked(ctx.waitUntil).mock.calls[0][0]).resolves.toBeUndefined();

    expect(user.unregisterGatekeeperSession).toHaveBeenCalledExactlyOnceWith(
      TOKEN, expect.any(String),
    );
    expect(registry.unregisterIdentitySession).toHaveBeenCalledOnce();
    expect(user.revokeGatekeeperSession).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
