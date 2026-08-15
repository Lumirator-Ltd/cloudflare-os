import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import { exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcStub as CapnWebRpcStub, RpcTarget } from "capnweb";
import {
  GATEKEEPER_SESSION_LOGOUT_PATH,
  type AiChatAuthorInfo,
  type AuthenticatedApi,
  type PresenceParticipant,
  type PresenceSubscriber,
  type PublicApi,
} from "@gadgets/workshop-shared/api";
import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { ChatGatewayRpcTarget } from "@gadgets/workshop-shared/external-message-gateway";
import { describe, expect, it, vi } from "vitest";
import {
  GATEKEEPER_SESSION_MAX_AGE_MS,
  type UserDurableObject,
} from "../src/user.js";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

async function registryUser(prefix: string) {
  const email = uniqueEmail(prefix);
  const identity = await exports.IdentityRegistry.getByName("")
    .resolveEmailIdentity(email, true);
  return {
    email,
    identity,
    user: exports.UserDurableObject.getByName(identity.internalUserId),
  };
}

async function subjectRegistryUser(prefix: string) {
  const email = uniqueEmail(prefix);
  const subject = `subject-${crypto.randomUUID()}`;
  const identity = await exports.IdentityRegistry.getByName("")
    .resolveClerkIdentity(subject, email, true);
  return {
    email,
    subject,
    identity,
    user: exports.UserDurableObject.getByName(identity.internalUserId),
  };
}

const WORKSHOP_ORIGIN = "https://workshop.invalid";

async function connect(): Promise<CapnWebRpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request(`${WORKSHOP_ORIGIN}/api`, {
    headers: { Upgrade: "websocket" },
  }));
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Expected WebSocket RPC response, got ${response.status}.`);
  }
  response.webSocket.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket);
}

async function logoutGatekeeperSession(
    token: string, options: { origin?: string; contentType?: string; body?: string } = {},
): Promise<Response> {
  return await exports.default.fetch(new Request(
    `${WORKSHOP_ORIGIN}${GATEKEEPER_SESSION_LOGOUT_PATH}`,
    {
      method: "POST",
      headers: {
        Origin: options.origin ?? WORKSHOP_ORIGIN,
        "Content-Type": options.contentType ?? "application/json",
      },
      body: options.body ?? JSON.stringify({ token }),
    },
  ));
}

async function sessionTokenId(token: string): Promise<string> {
  const bytes = Uint8Array.fromBase64(token);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash).toHex();
}

async function storedSession(user: DurableObjectStub<UserDurableObject>, token: string) {
  const tokenId = await sessionTokenId(token);
  return await runInDurableObject(user, (instance: UserDurableObject) => {
    const mutable = instance as unknown as {
      storage: { sessions: { get(id: string): Record<string, unknown> | undefined } };
    };
    return mutable.storage.sessions.get(tokenId);
  });
}

async function registryAuthenticationError(
    publicApi: CapnWebRpcStub<PublicApi>, token: string): Promise<unknown> {
  try {
    using api = await publicApi.authenticate(token);
    await api.whoami();
    return null;
  } catch (error) {
    return error;
  }
}

async function authenticatedRegistryUser(prefix: string): Promise<{
  email: string;
  internalUserId: string;
  durableObjectId: string;
  user: DurableObjectStub<UserDurableObject>;
  publicApi: CapnWebRpcStub<PublicApi>;
  api: CapnWebRpcStub<AuthenticatedApi>;
}> {
  const { email, identity, user } = await registryUser(prefix);
  const token = await user.createGatekeeperSession({
    canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
    identityVersion: identity.identityVersion,
  }, "test", `test-subject-${prefix}`);
  const publicApi = await connect();
  const api = await publicApi.authenticate(`${identity.internalUserId}:${token}`);
  return {
    email,
    internalUserId: identity.internalUserId,
    durableObjectId: exports.UserDurableObject.idFromName(identity.internalUserId).toString(),
    user,
    publicApi,
    api,
  };
}

class TestChatGatewayTarget extends RpcTarget implements ChatGatewayRpcTarget {
  async onGadgetResponse(): Promise<void> {}
}

class TestPresenceSubscriber extends RpcTarget implements PresenceSubscriber {
  constructor(
    private initialized: PromiseWithResolvers<PresenceParticipant[]>,
    private added: PromiseWithResolvers<PresenceParticipant>,
  ) {
    super();
  }

  init(participants: PresenceParticipant[]): void {
    this.initialized.resolve(participants);
  }

  add(participant: PresenceParticipant): void {
    this.added.resolve(participant);
  }

  remove(): void {}
  onRpcBroken(): void {}
}

function blueprintMetadata(author: AiChatAuthorInfo) {
  const now = new Date();
  return {
    title: "Stable identity blueprint",
    description: "Identity regression fixture",
    author,
    created: now,
    version: 0,
    lastUpdated: now,
    bindings: {},
  };
}

describe("stable human application identities", () => {
  it("reuses a Gatekeeper token only while its exact registry identity version remains current",
      async () => {
    const { identity, subject, user } = await subjectRegistryUser("version-bound-token");
    const token = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", subject);

    {
      using publicApi = await connect();
      using api = await publicApi.authenticate(`${identity.internalUserId}:${token}`);
      await expect(api.whoami()).resolves.toMatchObject({ id: identity.internalUserId });
    }

    const registry = exports.IdentityRegistry.getByName("");
    await registry.resolveClerkIdentity(subject, uniqueEmail("version-bound-moved"), false);

    using stalePublicApi = await connect();
    expect(await registryAuthenticationError(
      stalePublicApi, `${identity.internalUserId}:${token}`,
    )).toEqual(expect.objectContaining({ message: expect.stringMatching(/identity authority/i) }));
  });

  it("revokes one Gatekeeper bearer across sibling sockets and isolates other tokens and users",
      async () => {
    const owner = await registryUser("logout-owner");
    const ownerToken = await owner.user.createGatekeeperSession({
      canonicalVerifiedEmail: owner.identity.canonicalVerifiedEmail,
      identityVersion: owner.identity.identityVersion,
    }, "test", "logout-owner-subject");
    const ownerOtherToken = await owner.user.createGatekeeperSession({
      canonicalVerifiedEmail: owner.identity.canonicalVerifiedEmail,
      identityVersion: owner.identity.identityVersion,
    }, "test", "logout-owner-subject");
    const other = await registryUser("logout-other");
    const otherToken = await other.user.createGatekeeperSession({
      canonicalVerifiedEmail: other.identity.canonicalVerifiedEmail,
      identityVersion: other.identity.identityVersion,
    }, "test", "logout-other-subject");

    using firstPublic = await connect();
    using firstApi = await firstPublic.authenticate(
      `${owner.identity.internalUserId}:${ownerToken}`,
    );
    using siblingPublic = await connect();
    using siblingApi = await siblingPublic.authenticate(
      `${owner.identity.internalUserId}:${ownerToken}`,
    );
    using ownerOtherPublic = await connect();
    using ownerOtherApi = await ownerOtherPublic.authenticate(
      `${owner.identity.internalUserId}:${ownerOtherToken}`,
    );
    using otherPublic = await connect();
    using otherApi = await otherPublic.authenticate(
      `${other.identity.internalUserId}:${otherToken}`,
    );

    const response = await logoutGatekeeperSession(
      `${owner.identity.internalUserId}:${ownerToken}`,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await storedSession(owner.user, ownerToken)).toBeUndefined();

    await runInDurableObject(owner.user, async (instance: UserDurableObject) => {
      await expect(instance.authenticate(ownerToken)).rejects.toThrow(/session token/i);
    });
    await expect(firstApi.whoami()).rejects.toThrow();
    await expect(siblingApi.whoami()).rejects.toThrow();

    const repeated = await logoutGatekeeperSession(
      `${owner.identity.internalUserId}:${ownerToken}`,
    );
    expect(repeated.status).toBe(204);
    expect(await repeated.text()).toBe("");
    await expect(ownerOtherApi.whoami()).resolves.toMatchObject({
      id: owner.identity.internalUserId,
    });
    await expect(otherApi.whoami()).resolves.toMatchObject({
      id: other.identity.internalUserId,
    });
  });

  it("rejects invalid Gatekeeper logout HTTP requests without reflecting the bearer", async () => {
    const owner = await registryUser("logout-validation");
    const token = await owner.user.createGatekeeperSession({
      canonicalVerifiedEmail: owner.identity.canonicalVerifiedEmail,
      identityVersion: owner.identity.identityVersion,
    }, "test", "logout-validation-subject");
    const bearer = `${owner.identity.internalUserId}:${token}`;
    const validBody = JSON.stringify({ token: bearer });

    const responses = [
      await exports.default.fetch(new Request(
        `${WORKSHOP_ORIGIN}${GATEKEEPER_SESSION_LOGOUT_PATH}`,
        { method: "GET", headers: { Origin: WORKSHOP_ORIGIN } },
      )),
      await logoutGatekeeperSession(bearer, { origin: "https://attacker.invalid" }),
      await logoutGatekeeperSession(bearer, { contentType: "text/plain" }),
      await logoutGatekeeperSession(bearer, { body: "x".repeat(300) }),
      await logoutGatekeeperSession(bearer, { body: "{" }),
      await logoutGatekeeperSession(bearer, {
        body: JSON.stringify({ token: bearer, userId: owner.identity.internalUserId }),
      }),
      await logoutGatekeeperSession(bearer, {
        body: JSON.stringify({ token: "malformed-bearer" }),
      }),
    ];

    expect(responses.map(response => response.status)).toEqual([
      405, 403, 415, 413, 400, 400, 400,
    ]);
    expect(responses[0].headers.get("Allow")).toBe("POST");
    for (const response of responses) {
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(await response.text()).not.toContain(token);
      expect(response.redirected).toBe(false);
    }

    await expect(owner.user.authenticate(token)).resolves.toBeDefined();
    expect(validBody.length).toBeLessThanOrEqual(256);
  });

  it("socket disposal unregisters without revoking its Gatekeeper bearer", async () => {
    const { identity, user } = await registryUser("socket-disposal-token");
    const token = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", "socket-disposal-subject");

    {
      using publicApi = await connect();
      using api = await publicApi.authenticate(`${identity.internalUserId}:${token}`);
      await expect(api.whoami()).resolves.toMatchObject({ id: identity.internalUserId });
    }

    using reconnectedPublic = await connect();
    using reconnectedApi = await reconnectedPublic.authenticate(
      `${identity.internalUserId}:${token}`,
    );
    await expect(reconnectedApi.whoami()).resolves.toMatchObject({ id: identity.internalUserId });
  });

  it("bounds Gatekeeper tokens to one hour or an earlier valid provider expiry", async () => {
    const { identity, user } = await registryUser("bounded-token");
    const startedAt = Date.now();
    const providerExpiry = new Date(startedAt + 10 * 60_000);
    const earlier = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", "stable-subject", providerExpiry);
    const fallback = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", "stable-subject");
    const staleProvider = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", "stable-subject", new Date(startedAt - 1));

    expect((await storedSession(user, earlier))?.expiresAt).toEqual(providerExpiry);
    for (const token of [fallback, staleProvider]) {
      const expiresAt = (await storedSession(user, token))?.expiresAt;
      expect(expiresAt).toBeInstanceOf(Date);
      expect((expiresAt as Date).getTime()).toBeGreaterThanOrEqual(
        startedAt + GATEKEEPER_SESSION_MAX_AGE_MS,
      );
      expect((expiresAt as Date).getTime()).toBeLessThanOrEqual(
        Date.now() + GATEKEEPER_SESSION_MAX_AGE_MS,
      );
    }
  });

  it("rejects and deletes expired or subjectless unbounded Gatekeeper records", async () => {
    const { identity, user } = await registryUser("closed-token-record");
    const expired = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", "stable-subject", new Date(Date.now() + 60_000));
    const expiredTokenId = await sessionTokenId(expired);
    const legacyBytes = crypto.getRandomValues(new Uint8Array(32));
    const legacy = legacyBytes.toBase64();
    const legacyTokenId = await sessionTokenId(legacy);

    await runInDurableObject(user, (instance: UserDurableObject) => {
      const mutable = instance as unknown as {
        storage: { sessions: { put(value: Record<string, unknown>): void } };
      };
      mutable.storage.sessions.put({
        tokenId: expiredTokenId,
        created: new Date(),
        kind: "gatekeeper",
        provider: "test",
        subject: "stable-subject",
        canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
        identityVersion: identity.identityVersion,
        expiresAt: new Date(Date.now() - 1),
      });
      mutable.storage.sessions.put({
        tokenId: legacyTokenId,
        created: new Date(),
        kind: "gatekeeper",
        provider: "test",
        canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
        identityVersion: identity.identityVersion,
      });
    });

    await runInDurableObject(user, async (instance: UserDurableObject) => {
      await expect(instance.authenticate(expired)).rejects.toThrow(/invalid session token/i);
      await expect(instance.authenticate(legacy)).rejects.toThrow(/invalid session token/i);
    });
    expect(await storedSession(user, expired)).toBeUndefined();
    expect(await storedSession(user, legacy)).toBeUndefined();
  });

  it("preserves the Gatekeeper token absolute expiry across a User DO restart", async () => {
    const { identity, user } = await registryUser("restart-token-expiry");
    const providerExpiry = new Date(Date.now() + 10 * 60_000);
    const token = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", "restart-subject", providerExpiry);

    await abortAllDurableObjects();
    const restartedUser = exports.UserDurableObject.getByName(identity.internalUserId);

    await expect(restartedUser.authenticate(token)).resolves.toMatchObject({
      kind: "gatekeeper",
      provider: "test",
      subject: "restart-subject",
      expiresAt: providerExpiry,
    });
  });

  it("durably revokes a Gatekeeper token before notifying and disposing every live subscriber",
      async () => {
    const { identity, user } = await registryUser("revoked-token-subscribers");
    const token = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", "revoked-token-subject");
    const authentication = await user.authenticate(token);
    if (!authentication) throw new Error("expected Gatekeeper session authority");
    const tokenId = await sessionTokenId(token);
    const release = Promise.withResolvers<void>();
    const invalidated: string[] = [];
    let disposed = 0;

    await runInDurableObject(user, async (instance: UserDurableObject) => {
      type Subscriber = (() => Promise<void>) & {
        dup(): Subscriber;
        [Symbol.dispose](): void;
      };
      const subscriber = (name: string): Subscriber => {
        const callback = Object.assign(async () => {
          invalidated.push(name);
          await release.promise;
        }, {
          dup() { return callback; },
          [Symbol.dispose]() { disposed++; },
        });
        return callback;
      };
      await instance.registerGatekeeperSession(
        token, authentication, "first", subscriber("first") as never,
      );
      await instance.registerGatekeeperSession(
        token, authentication, "second", subscriber("second") as never,
      );

      let revocationSettled = false;
      const revocation = instance.revokeGatekeeperSession(token)
        .then(() => { revocationSettled = true; });
      await vi.waitFor(() => expect(invalidated.toSorted()).toEqual(["first", "second"]));
      const inspected = instance as unknown as {
        storage: { sessions: { get(id: string): unknown } };
      };
      expect(inspected.storage.sessions.get(tokenId)).toBeUndefined();
      expect(revocationSettled).toBe(false);
      await expect(instance.registerGatekeeperSession(
        token, authentication, "late", subscriber("late") as never,
      )).rejects.toThrow(/session token/i);

      release.resolve();
      await revocation;
      expect(disposed).toBe(2);
    });

    await runInDurableObject(user, async (instance: UserDurableObject) => {
      await expect(instance.authenticate(token)).rejects.toThrow(/invalid session token/i);
    });
  });

  it("includes the caller while awaiting every invalidation after durable revocation",
      async () => {
    const { identity, user } = await registryUser("revoked-token-excluded-caller");
    const token = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", "revoked-token-excluded-caller-subject");
    const authentication = await user.authenticate(token);
    if (!authentication) throw new Error("expected Gatekeeper session authority");
    const tokenId = await sessionTokenId(token);
    const releaseSibling = Promise.withResolvers<void>();
    const invalidated: string[] = [];
    let disposed = 0;

    await runInDurableObject(user, async (instance: UserDurableObject) => {
      type Subscriber = (() => Promise<void>) & {
        dup(): Subscriber;
        [Symbol.dispose](): void;
      };
      const subscriber = (name: string, wait = false): Subscriber => {
        const callback = Object.assign(async () => {
          invalidated.push(name);
          if (wait) await releaseSibling.promise;
        }, {
          dup() { return callback; },
          [Symbol.dispose]() { disposed++; },
        });
        return callback;
      };
      await instance.registerGatekeeperSession(
        token, authentication, "caller", subscriber("caller") as never,
      );
      await instance.registerGatekeeperSession(
        token, authentication, "sibling", subscriber("sibling", true) as never,
      );

      let revocationSettled = false;
      const revocation = instance.revokeGatekeeperSession(token)
        .then(() => { revocationSettled = true; });
      await vi.waitFor(() => expect(invalidated).toEqual(["caller", "sibling"]));
      const inspected = instance as unknown as {
        storage: { sessions: { get(id: string): unknown } };
      };
      expect(inspected.storage.sessions.get(tokenId)).toBeUndefined();
      expect(revocationSettled).toBe(false);
      expect(disposed).toBe(1);

      releaseSibling.resolve();
      await revocation;
      expect(invalidated).toEqual(["caller", "sibling"]);
      expect(disposed).toBe(2);
    });
  });

  it("fails closed when token revocation wins a concurrent subscriber registration", async () => {
    const { identity, user } = await registryUser("revocation-registration-race");
    const token = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", "revocation-registration-race-subject");
    const authentication = await user.authenticate(token);
    if (!authentication) throw new Error("expected Gatekeeper session authority");
    let invalidations = 0;

    await runInDurableObject(user, async (instance: UserDurableObject) => {
      const callback = Object.assign(async () => { invalidations++; }, {
        dup() { return callback; },
        [Symbol.dispose]() {},
      });
      const revocation = instance.revokeGatekeeperSession(token);
      const registration = instance.registerGatekeeperSession(
        token, authentication, "racing", callback as never,
      );

      await revocation;
      await expect(registration).rejects.toThrow(/session token/i);
    });
    expect(invalidations).toBe(0);
  });

  it("rejects an old unversioned registry token instead of assigning current authority", async () => {
    const { identity, user } = await registryUser("unversioned-token");
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = tokenBytes.toBase64();
    const tokenId = new Uint8Array(await crypto.subtle.digest("SHA-256", tokenBytes)).toHex();
    await runInDurableObject(user, (instance: UserDurableObject) => {
      const mutable = instance as unknown as {
        storage: { sessions: { put(value: { tokenId: string; created: Date }): void } };
      };
      mutable.storage.sessions.put({ tokenId, created: new Date() });
    });

    using publicApi = await connect();
    expect(await registryAuthenticationError(
      publicApi, `${identity.internalUserId}:${token}`,
    )).toEqual(expect.objectContaining({ message: expect.stringMatching(/identity authority/i) }));
  });

  it("rejects a token whose version moves after its issuance check but before delivery", async () => {
    const { identity, subject, user } = await subjectRegistryUser("post-check-delivery");
    const token = await user.createGatekeeperSession({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
    }, "test", subject);
    const registry = exports.IdentityRegistry.getByName("");
    expect(await registry.getIdentity(identity.internalUserId)).toMatchObject({
      canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
      identityVersion: identity.identityVersion,
      status: "active",
    });

    const releaseDelivery = Promise.withResolvers<void>();
    const delivered = (async () => {
      await releaseDelivery.promise;
      return `${identity.internalUserId}:${token}`;
    })();
    await registry.resolveClerkIdentity(subject, uniqueEmail("post-check-moved"), false);
    releaseDelivery.resolve();

    using publicApi = await connect();
    expect(await registryAuthenticationError(publicApi, await delivered)).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/identity authority/i) }),
    );
    const tokenBytes = Uint8Array.fromBase64(token);
    const tokenId = new Uint8Array(await crypto.subtle.digest("SHA-256", tokenBytes)).toHex();
    await runInDurableObject(user, (instance: UserDurableObject) => {
      const mutable = instance as unknown as {
        storage: { sessions: { get(id: string): unknown } };
      };
      expect(mutable.storage.sessions.get(tokenId)).toBeUndefined();
    });
  });

  it("uses the internal ID for profiles, avatars, chat authors, and analytics", async () => {
    const sentAnalytics: Array<Record<string, unknown>> = [];
    const mutableEnv = env as Cloudflare.Env;
    const originalProductAnalytics = mutableEnv.PRODUCT_ANALYTICS;
    try {
      mutableEnv.PRODUCT_ANALYTICS = {
        async send(records: Array<Record<string, unknown>>) {
          sentAnalytics.push(...records);
        },
      } as Pipeline;

      const account = await authenticatedRegistryUser("application");
      using _publicApi = account.publicApi;
      using api = account.api;

      expect(await api.whoami()).toMatchObject({
        type: "user",
        id: account.internalUserId,
      });

      const avatar = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      await api.setAvatar(avatar);
      expect(await env.AVATARS.get(account.internalUserId, "arrayBuffer")).not.toBeNull();
      expect(await env.AVATARS.get(account.durableObjectId, "arrayBuffer")).toBeNull();

      using workspace = await api.newGadget();
      const chatId = await workspace.newChat("hello", null);
      const history = await workspace.getChatHistory(chatId);
      expect(history.messages).toHaveLength(1);
      expect(history.messages[0].author).toMatchObject({
        type: "user",
        id: account.internalUserId,
      });
      expect(history.messages[0].author.id).not.toBe(account.email);
      expect(history.messages[0].author.id).not.toBe(account.durableObjectId);

      await vi.waitFor(() => {
        expect(sentAnalytics.some(record => record.user_id === account.internalUserId)).toBe(true);
        expect(sentAnalytics.some(record => record.user_id === account.durableObjectId)).toBe(false);
      });
    } finally {
      mutableEnv.PRODUCT_ANALYTICS = originalProductAnalytics;
    }
  });

  it("passes the stable internal ID as Gatekeeper Workshop-user context", async () => {
    const { identity, user } = await registryUser("gatekeeper-context");
    let observedUserId: string | undefined;
    const resource: SupportedResource = {
      urlPattern: "https://example.com/*",
      title: "Example resource",
      description: "Test resource",
    };

    await runInDurableObject(user, async (instance: UserDurableObject) => {
      const mutable = instance as unknown as {
        vendors: Map<string, {
          describe(): Promise<{ displayName: string; url: string }>;
          getSupportedResources(options: { userId: string }): Promise<SupportedResource[]>;
        }>;
      };
      const originalVendors = mutable.vendors;
      mutable.vendors = new Map([["example", {
        async describe() {
          return { displayName: "Example", url: "https://example.com" };
        },
        async getSupportedResources(options) {
          observedUserId = options.userId;
          return [resource];
        },
      }]]);
      try {
        await instance.listGatekeeperVendors();
      } finally {
        mutable.vendors = originalVendors;
      }
    });

    expect(observedUserId).toBe(identity.internalUserId);
  });

  it("resolves sharing email discovery to IDs throughout the graph and cached indexes", async () => {
    const owner = await authenticatedRegistryUser("owner");
    const collaborator = await authenticatedRegistryUser("collaborator");
    const retained = await authenticatedRegistryUser("retained");
    using _ownerPublicApi = owner.publicApi;
    using ownerApi = owner.api;
    using _collaboratorPublicApi = collaborator.publicApi;
    using collaboratorApi = collaborator.api;
    using _retainedPublicApi = retained.publicApi;
    using _retainedApi = retained.api;
    using ownerWorkspace = await ownerApi.newGadget();
    const metadata = await ownerWorkspace.getMetadata();

    const mixedCaseEmail = `  ${collaborator.email.toUpperCase()}\t`;
    const added = await ownerWorkspace.addCollaborator(mixedCaseEmail, "build");
    expect(added?.profile.id).toBe(collaborator.internalUserId);
    expect(added?.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: owner.internalUserId }),
    ]);
    expect(await exports.IdentityRegistry.getByName("")
      .findInternalUserIdByVerifiedEmail(mixedCaseEmail)).toBe(collaborator.internalUserId);

    const { linkId } = await ownerWorkspace.createShareLink("use");
    const shareLink = (await ownerWorkspace.listShareLinks())
      .find(link => link.linkId === linkId);
    expect(shareLink?.createdBy.id).toBe(owner.internalUserId);

    using collaboratorWorkspace = await collaboratorApi.openGadget(metadata.id);
    const retainedInfo = await collaboratorWorkspace.addCollaborator(retained.email, "build");
    expect(retainedInfo?.profile.id).toBe(retained.internalUserId);
    expect((await ownerWorkspace.listCollaborators()).map(entry => entry.profile.id))
      .toContain(retained.internalUserId);

    await vi.waitFor(async () => {
      const shared = (await collaboratorApi.listGadgets())
        .find(gadget => gadget.id === metadata.id);
      expect(shared?.owner?.id).toBe(owner.internalUserId);
    });

    const missingEmail = uniqueEmail("missing");
    expect(await ownerWorkspace.addCollaborator(missingEmail, "use")).toBeNull();
    expect(await exports.IdentityRegistry.getByName("")
      .findInternalUserIdByVerifiedEmail(missingEmail)).toBeNull();

    // Removal is last because a real access change deliberately restarts every workspace session.
    const affected = await ownerWorkspace.removeCollaborator(
      collaborator.internalUserId,
      [retained.internalUserId],
    );
    expect(affected.map(entry => entry.profile.id)).toEqual([collaborator.internalUserId]);
  });

  it("does not accept a stable internal user ID as collaborator discovery input", async () => {
    const owner = await authenticatedRegistryUser("stable-id-owner");
    const collaborator = await authenticatedRegistryUser("stable-id-collaborator");
    using _ownerPublicApi = owner.publicApi;
    using ownerApi = owner.api;
    using _collaboratorPublicApi = collaborator.publicApi;
    using _collaboratorApi = collaborator.api;
    using ownerWorkspace = await ownerApi.newGadget();

    expect(await ownerWorkspace.addCollaborator(collaborator.internalUserId, "use")).toBeNull();
    expect(await ownerWorkspace.listCollaborators()).toEqual([]);
  });

  it("does not route arbitrary usernames or create identity mappings", async () => {
    const owner = await authenticatedRegistryUser("username-owner");
    using _ownerPublicApi = owner.publicApi;
    using ownerApi = owner.api;
    using ownerWorkspace = await ownerApi.newGadget();

    // A routable but registry-orphaned User DO proves arbitrary usernames are not used as a
    // fallback route when verified-email discovery fails.
    const arbitraryUsername = `legacy-${crypto.randomUUID()}`;
    const arbitraryUser = exports.UserDurableObject.getByName(arbitraryUsername);
    await arbitraryUser.initializeIdentity(arbitraryUsername, uniqueEmail("orphan"), 1);
    expect(await exports.IdentityRegistry.getByName("")
      .findInternalUserIdByVerifiedEmail(arbitraryUsername)).toBeNull();

    expect(await ownerWorkspace.addCollaborator(arbitraryUsername, "use")).toBeNull();
    expect(await ownerWorkspace.listCollaborators()).toEqual([]);
    expect(await exports.IdentityRegistry.getByName("")
      .findInternalUserIdByVerifiedEmail(arbitraryUsername)).toBeNull();
  });

  it("uses stable IDs for presence and collaborator output indexes", async () => {
    const owner = await registryUser("presence-owner");
    const collaborator = await registryUser("presence-collaborator");
    const workspaceId = exports.OverseerDurableObject.newUniqueId();
    await owner.user.newGadget(workspaceId.toString(), "Stable identity workspace");
    const workspaceDo = exports.OverseerDurableObject.get(workspaceId);
    using ownerOnBroken = new NativeRpcStub<() => void>(() => {});
    using ownerWorkspace = await workspaceDo.open(
      owner.identity.internalUserId,
      owner.identity.internalUserId,
      ownerOnBroken,
    );
    await ownerWorkspace.addCollaborator(collaborator.email, "build");

    const initialized = Promise.withResolvers<PresenceParticipant[]>();
    const added = Promise.withResolvers<PresenceParticipant>();
    using presenceSubscriber = new NativeRpcStub<PresenceSubscriber>(
      new TestPresenceSubscriber(initialized, added),
    );
    using _presenceSubscription = await ownerWorkspace.subscribeToPresence(presenceSubscriber);
    expect((await initialized.promise).map(participant => participant.user.id))
      .toContain(owner.identity.internalUserId);

    using collaboratorOnBroken = new NativeRpcStub<() => void>(() => {});
    using _collaboratorWorkspace = await workspaceDo.open(
      collaborator.identity.internalUserId,
      collaborator.identity.internalUserId,
      collaboratorOnBroken,
    );
    expect((await added.promise).user.id).toBe(collaborator.identity.internalUserId);

    using gadget = await ownerWorkspace.createGadget("Stable output");
    await gadget.getTitle();
    await vi.waitFor(async () => {
      const result = await collaborator.user.listOutputs();
      const output = result.outputs.find(entry => entry.workspaceId === workspaceId.toString());
      expect(output?.owner?.id).toBe(owner.identity.internalUserId);
    });
  });

  it("resolves trusted external-message email input before storing human references", async () => {
    const account = await registryUser("external-message");
    const workspace = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.newUniqueId(),
    );
    using responseTarget = new NativeRpcStub<ChatGatewayRpcTarget>(new TestChatGatewayTarget());

    const result = await workspace.receiveExternalMessage({
      callerEmail: account.email,
      externalChatKey: `chat-${crypto.randomUUID()}`,
      idempotencyKey: `message-${crypto.randomUUID()}`,
      prompt: "hello",
      chatGatewayRpcTarget: responseTarget,
      title: "External workspace",
    });
    expect(result).toMatchObject({ accepted: false });
    await runInDurableObject(workspace, (instance) => {
      const inspected = instance as unknown as { impl: { ownerId?: string } };
      expect(inspected.impl.ownerId).toBe(account.identity.internalUserId);
    });
  });

  it("uses the stable owner ID when backfilling output indexes", async () => {
    const owner = await registryUser("output-backfill-owner");
    const workspaceId = exports.OverseerDurableObject.newUniqueId();
    await owner.user.newGadget(workspaceId.toString(), "Backfill workspace");
    const workspaceDo = exports.OverseerDurableObject.get(workspaceId);
    {
      using onBroken = new NativeRpcStub<() => void>(() => {});
      using workspace = await workspaceDo.open(
        owner.identity.internalUserId,
        owner.identity.internalUserId,
        onBroken,
      );
      using gadget = await workspace.createGadget("Backfilled output");
      await gadget.getTitle();
      await owner.user.setGadgetLastActive(workspaceId.toString(), new Date(), undefined);
      await vi.waitFor(async () => {
        expect((await owner.user.listOutputs()).outputs).not.toHaveLength(0);
      });
    }

    await runInDurableObject(owner.user, (instance: UserDurableObject) => {
      const mutable = instance as unknown as {
        storage: {
          outputs: { byWorkspace: { delete(workspaceId: string): void } };
          outputsBackfilled: { put(value: boolean): void };
          outputsBackfillCursor: { put(value: string): void };
        };
      };
      mutable.storage.outputs.byWorkspace.delete(workspaceId.toString());
      mutable.storage.outputsBackfilled.put(false);
      mutable.storage.outputsBackfillCursor.put("");
    });

    const result = await owner.user.listOutputs();
    expect(result.outputs.map(output => output.workspaceId)).toContain(workspaceId.toString());
  });

  it("stores stable blueprint ownership while keeping model IDs unchanged", async () => {
    const account = await authenticatedRegistryUser("blueprint-owner");
    using _publicApi = account.publicApi;
    using api = account.api;
    const profile = await api.whoami();
    const blueprintId = `stable-blueprint-${crypto.randomUUID()}`;
    const metadata = blueprintMetadata(profile);
    await account.user.updateBlueprint(blueprintId, metadata, "workspace-id");
    await env.BLUEPRINTS.put(blueprintId, JSON.stringify({
      metadata,
      ownerId: account.internalUserId,
      gadgetId: "workspace-id",
    }));

    await expect(exports.AdminSettings.getByName("").isBlueprintFeatured(blueprintId))
      .resolves.toBe(false);
    await expect(account.user.deleteOwnedBlueprint(blueprintId)).resolves.toBeUndefined();
    expect(await env.BLUEPRINTS.get(blueprintId)).toBeNull();

    const model: AiChatAuthorInfo = { type: "agent", id: "model@example.com", name: "Model" };
    await account.user.addModel(model, {
      provider: "openai",
      model: "gpt-test",
      apiToken: "test-token",
    });
    expect(await account.user.listModels()).toContainEqual(model);
  });
});
