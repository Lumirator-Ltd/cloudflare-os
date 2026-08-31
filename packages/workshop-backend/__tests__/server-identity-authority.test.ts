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

type TelegramApiHarness = {
  publicApi: PublicApiImpl;
  api: Awaited<ReturnType<PublicApiImpl["authenticate"]>>;
  registry: {
    getIdentity: ReturnType<typeof vi.fn>;
    registerIdentitySession: ReturnType<typeof vi.fn>;
    unregisterIdentitySession: ReturnType<typeof vi.fn>;
    getExternalLinkStatus: ReturnType<typeof vi.fn>;
    startExternalLink: ReturnType<typeof vi.fn>;
    unlinkExternalIdentity: ReturnType<typeof vi.fn>;
  };
  getBotIdentity: ReturnType<typeof vi.fn>;
  setIdentity(identity: IdentityState | null): void;
};

async function makeTelegramApi(legacy = false): Promise<TelegramApiHarness> {
  let identity: IdentityState | null = legacy ? null : currentIdentity();
  const userId = { name: internalUserId } as DurableObjectId;
  const user = {
    authenticate: vi.fn().mockResolvedValue(legacy ? null : {
      kind: "gatekeeper",
      provider: "test",
      subject: "stable-provider-subject",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      ...authority,
    }),
    registerGatekeeperSession: vi.fn().mockResolvedValue(undefined),
    unregisterGatekeeperSession: vi.fn().mockResolvedValue(undefined),
    assertGatekeeperSession: vi.fn().mockResolvedValue(undefined),
    revokeGatekeeperSession: vi.fn().mockResolvedValue(undefined),
  };
  const registry = {
    getIdentity: vi.fn(async () => identity),
    registerIdentitySession: vi.fn().mockResolvedValue(undefined),
    unregisterIdentitySession: vi.fn().mockResolvedValue(undefined),
    getExternalLinkStatus: vi.fn().mockResolvedValue({
      connected: true,
      externalSubject: "must-not-cross-public-api",
    }),
    startExternalLink: vi.fn().mockResolvedValue({
      token: "telegram-link-token",
      expiresAt: new Date("2026-04-01T12:10:00Z"),
    }),
    unlinkExternalIdentity: vi.fn().mockResolvedValue(undefined),
  };
  const getBotIdentity = vi.fn().mockResolvedValue({ id: 42, username: "verified_bot" });
  const abortController = new AbortController();
  const ctx = {
    exports: {
      UserDurableObject: {
        idFromName: vi.fn(() => userId),
        get: vi.fn(() => user),
      },
      IdentityRegistry: { getByName: vi.fn(() => registry) },
      TelegramChannel: { getByName: vi.fn(() => ({ getBotIdentity })) },
      OverseerDurableObject: {},
      AdminSettings: { getByName: vi.fn(() => ({})) },
    },
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
  const publicApi = new PublicApiImpl(
    ctx,
    { ADMINS: [] } as unknown as Cloudflare.Env,
    reason => abortController.abort(reason),
    abortController.signal,
    vi.fn() as never,
  );
  const api = await publicApi.authenticate(`${internalUserId}:secret-token`);
  return {
    publicApi,
    api,
    registry,
    getBotIdentity,
    setIdentity(next) { identity = next; },
  };
}

describe("Telegram link authority", () => {
  it("uses only the stable caller and literal Telegram source", async () => {
    const harness = await makeTelegramApi();
    try {
      await expect(harness.api.getTelegramLinkStatus()).resolves.toEqual({ connected: true });
      await expect(harness.api.startTelegramLink()).resolves.toEqual({
        url: "https://t.me/verified_bot?start=telegram-link-token",
        expiresAt: new Date("2026-04-01T12:10:00Z"),
      });
      await expect(harness.api.unlinkTelegram()).resolves.toBeUndefined();

      expect(harness.registry.getExternalLinkStatus).toHaveBeenCalledExactlyOnceWith(
        internalUserId,
        authority.identityVersion,
        "telegram",
      );
      expect(harness.getBotIdentity).toHaveBeenCalledOnce();
      expect(harness.registry.startExternalLink).toHaveBeenCalledExactlyOnceWith(
        internalUserId,
        authority.identityVersion,
        "telegram",
      );
      expect(harness.registry.unlinkExternalIdentity).toHaveBeenCalledExactlyOnceWith(
        internalUserId,
        authority.identityVersion,
        "telegram",
      );
    } finally {
      harness.publicApi[Symbol.dispose]();
    }
  });

  it("does not mint a link token when verified bot discovery fails", async () => {
    const harness = await makeTelegramApi();
    harness.getBotIdentity.mockRejectedValueOnce(new Error("Telegram unavailable"));
    try {
      await expect(harness.api.startTelegramLink()).rejects.toThrow("Telegram unavailable");
      expect(harness.registry.startExternalLink).not.toHaveBeenCalled();
    } finally {
      harness.publicApi[Symbol.dispose]();
    }
  });

  it("rejects all operations after registry authority becomes stale", async () => {
    const harness = await makeTelegramApi();
    harness.setIdentity(currentIdentity({ identityVersion: authority.identityVersion + 1 }));
    try {
      await expect(harness.api.getTelegramLinkStatus())
        .rejects.toThrow(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
      await expect(harness.api.startTelegramLink())
        .rejects.toThrow(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
      await expect(harness.api.unlinkTelegram())
        .rejects.toThrow(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
      expect(harness.registry.getExternalLinkStatus).not.toHaveBeenCalled();
      expect(harness.registry.startExternalLink).not.toHaveBeenCalled();
      expect(harness.registry.unlinkExternalIdentity).not.toHaveBeenCalled();
    } finally {
      harness.publicApi[Symbol.dispose]();
    }
  });

  it("rejects legacy sessions without stable registry authority", async () => {
    const harness = await makeTelegramApi(true);
    try {
      await expect(harness.api.getTelegramLinkStatus())
        .rejects.toThrow(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
      await expect(harness.api.startTelegramLink())
        .rejects.toThrow(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
      await expect(harness.api.unlinkTelegram())
        .rejects.toThrow(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
      expect(harness.registry.getExternalLinkStatus).not.toHaveBeenCalled();
      expect(harness.registry.startExternalLink).not.toHaveBeenCalled();
      expect(harness.registry.unlinkExternalIdentity).not.toHaveBeenCalled();
    } finally {
      harness.publicApi[Symbol.dispose]();
    }
  });
});

describe("registry-backed Gatekeeper graph authority", () => {
  it("starts one watchdog at authentication and bounds authority after subscriber loss", async () => {
    vi.useFakeTimers();
    let current = currentIdentity();
    let graphAborted = false;
    let invalidationSubscriber: (() => Promise<void>) | undefined;
    const userId = { name: internalUserId } as DurableObjectId;
    const user = {
      id: userId,
      authenticate: vi.fn().mockResolvedValue({
        kind: "gatekeeper",
        provider: "test",
        subject: "stable-provider-subject",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        ...authority,
      }),
      registerGatekeeperSession: vi.fn().mockResolvedValue(undefined),
      unregisterGatekeeperSession: vi.fn().mockResolvedValue(undefined),
      assertGatekeeperSession: vi.fn().mockResolvedValue(undefined),
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
      expect(vi.getTimerCount()).toBe(timersBeforeAuthentication + 5);

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

  it("aborts the retained capability graph at the local session absolute expiry", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1_000);
    let graphAborted = false;
    const userId = { name: internalUserId } as DurableObjectId;
    const user = {
      authenticate: vi.fn().mockResolvedValue({
        kind: "gatekeeper", provider: "test", subject: "stable-provider-subject",
        expiresAt, ...authority,
      }),
      registerGatekeeperSession: vi.fn().mockResolvedValue(undefined),
      unregisterGatekeeperSession: vi.fn().mockResolvedValue(undefined),
      assertGatekeeperSession: vi.fn().mockResolvedValue(undefined),
      revokeGatekeeperSession: vi.fn().mockResolvedValue(undefined),
      whoami: vi.fn(async () => {
        if (graphAborted) throw new Error("capability graph aborted");
        return { type: "user" as const, id: internalUserId, name: "Member" };
      }),
    };
    const registry = {
      getIdentity: vi.fn().mockResolvedValue(currentIdentity()),
      registerIdentitySession: vi.fn().mockResolvedValue(undefined),
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
    const publicApi = new PublicApiImpl(
      ctx, { ADMINS: [] } as unknown as Cloudflare.Env, abortSession,
      abortController.signal, vi.fn() as never,
    );

    try {
      const api = await publicApi.authenticate(`${internalUserId}:secret-token`);
      await expect(api.whoami()).resolves.toMatchObject({ id: internalUserId });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(abortSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: expect.stringMatching(/gatekeeper session expired/i) }),
      );
      await expect(api.whoami()).rejects.toThrow("capability graph aborted");
    } finally {
      publicApi[Symbol.dispose]();
      vi.useRealTimers();
    }
  });

  it("returns no capability when authentication finishes after the local session expiry", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1_000);
    const authentication = Promise.withResolvers<{
      kind: "gatekeeper";
      provider: string;
      subject: string;
      expiresAt: Date;
      canonicalVerifiedEmail: string;
      identityVersion: number;
    }>();
    const userId = { name: internalUserId } as DurableObjectId;
    const user = {
      authenticate: vi.fn(() => authentication.promise),
      revokeGatekeeperSession: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      getIdentity: vi.fn().mockResolvedValue(currentIdentity()),
      registerIdentitySession: vi.fn().mockResolvedValue(undefined),
      unregisterIdentitySession: vi.fn().mockResolvedValue(undefined),
    };
    const abortController = new AbortController();
    const abortSession = vi.fn((reason: Error) => abortController.abort(reason));
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
      ctx, { ADMINS: [] } as unknown as Cloudflare.Env, abortSession,
      abortController.signal, vi.fn() as never,
    );

    try {
      const pending = publicApi.authenticate(`${internalUserId}:secret-token`);
      await vi.advanceTimersByTimeAsync(1_000);
      authentication.resolve({
        kind: "gatekeeper", provider: "test", subject: "stable-provider-subject",
        expiresAt, ...authority,
      });

      await expect(pending).rejects.toThrow(/gatekeeper session expired/i);
      expect(registry.registerIdentitySession).not.toHaveBeenCalled();
      expect(abortSession).toHaveBeenCalledOnce();
    } finally {
      publicApi[Symbol.dispose]();
      vi.useRealTimers();
    }
  });
});
