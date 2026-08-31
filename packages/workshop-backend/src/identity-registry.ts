import { collection, createTypedStorage } from "@gadgets/typed-storage";
import { DurableObject, type RpcStub } from "cloudflare:workers";
import type { UserDurableObject } from "./user.js";
import { createWorkshopLogger } from "./observability.js";

const logger = createWorkshopLogger("workshop.identity.registry");

/** The authorization state of an internal Workshop identity. */
export type IdentityStatus = "active" | "collisionLocked";

/** Stable identity information returned only after its User Durable Object is initialized. */
export type IdentityResolution = {
  internalUserId: string;
  canonicalVerifiedEmail: string;
  identityVersion: number;
  status: "active";
  /** Whether this resolution durably created the internal identity. */
  created: boolean;
};

/** Current registry state for an internal Workshop identity. */
export type IdentityState = {
  internalUserId: string;
  canonicalVerifiedEmail: string | null;
  identityVersion: number;
  status: IdentityStatus;
};

type IdentityRecord = IdentityState & {
  subjectKeys: string[];
};

type EmailClaimRecord = {
  canonicalVerifiedEmail: string;
  internalUserId: string;
};

type ExternalLinkRecord = {
  externalKey: string;
  internalSourceKey: string;
  source: string;
  externalSubject: string;
  internalUserId: string;
};

type ExternalLinkTokenRecord = {
  internalSourceKey: string;
  digest: string;
  source: string;
  internalUserId: string;
  identityVersion: number;
  expiresAt: number;
};

type IdentitySessionInvalidator = () => Promise<void>;

function makeIdentityRegistryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      identities: collection<IdentityRecord>()({
        primaryKey: "internalUserId",
        uniqueIndexes: {
          byEmail: (record: IdentityRecord) => record.canonicalVerifiedEmail,
          bySubject: (record: IdentityRecord) => record.subjectKeys,
        },
      }),
      emailClaims: collection<EmailClaimRecord>()({
        primaryKey: "canonicalVerifiedEmail",
      }),
      externalLinks: collection<ExternalLinkRecord>()({
        primaryKey: "externalKey",
        uniqueIndexes: {
          byInternalSource: (record: ExternalLinkRecord) => record.internalSourceKey,
        },
      }),
      externalLinkTokens: collection<ExternalLinkTokenRecord>()({
        primaryKey: "internalSourceKey",
        uniqueIndexes: {
          byDigest: (record: ExternalLinkTokenRecord) => record.digest,
          byExpiry: (record: ExternalLinkTokenRecord) =>
            externalLinkTokenExpiryKey(record.expiresAt, record.digest),
        },
      }),
    },
    singletons: {
      emailClaimsBackfilled: false,
    },
  });
}

type IdentityRegistryStorage = ReturnType<typeof makeIdentityRegistryStorage>;

const SIGNUPS_DISABLED = "New sign-ups are currently disabled on this deployment.";
const COLLISION_LOCKED = "Identity collision requires deployment operator assistance.";
const EXPLICIT_LINK_REQUIRED =
  "Identity ownership requires explicit linking or deployment operator resolution.";
const SETUP_FAILED = "Identity setup failed.";
const EXTERNAL_LINK_INVALID = "External identity link is invalid.";
const EXTERNAL_LINK_TOKEN_TTL_MS = 10 * 60_000;
const EXPIRED_TOKEN_CLEANUP_LIMIT = 100;

/** Canonicalizes a server-verified email using only trim and lowercase operations. */
export function canonicalizeVerifiedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function clerkSubjectKey(subject: string): string {
  return JSON.stringify(["clerk", subject]);
}

function accessSubjectKey(issuer: string, audience: string, subject: string): string {
  return JSON.stringify(["access", issuer, audience, subject]);
}

function gatekeeperSubjectKey(vendorId: string, subject: string): string {
  return JSON.stringify(["gatekeeper", vendorId, subject]);
}

function randomInternalUserId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes.toHex();
}

function externalKey(source: string, externalSubject: string): string {
  return JSON.stringify([source, externalSubject]);
}

function internalSourceKey(internalUserId: string, source: string): string {
  return JSON.stringify([internalUserId, source]);
}

function externalLinkTokenExpiryKey(expiresAt: number, digest: string): string {
  return `${expiresAt.toString().padStart(16, "0")}:${digest}`;
}

function randomExternalLinkToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes.toBase64({ alphabet: "base64url" }).replace(/=+$/, "");
}

async function digestExternalLinkToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
}

function activeResolution(record: IdentityRecord, created: boolean): IdentityResolution {
  if (record.status !== "active" || record.canonicalVerifiedEmail === null) {
    throw new Error(COLLISION_LOCKED);
  }
  return {
    internalUserId: record.internalUserId,
    canonicalVerifiedEmail: record.canonicalVerifiedEmail,
    identityVersion: record.identityVersion,
    status: record.status,
    created,
  };
}

/**
 * Singleton authority for external-identity mappings.
 *
 * This Durable Object must always be addressed with `getByName("")`. Local index changes are
 * synchronous transactions; User Durable Object initialization follows after commit and is retried
 * by the next resolution if the cross-object call fails.
 */
export class IdentityRegistry extends DurableObject<Cloudflare.Env> {
  private storage: IdentityRegistryStorage;
  private users: DurableObjectNamespace<UserDurableObject>;
  private identitySessions = new Map<string, Map<string, RpcStub<IdentitySessionInvalidator>>>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeIdentityRegistryStorage(ctx.storage);
    this.users = ctx.exports.UserDurableObject;
    this.storage.transaction(() => {
      if (this.storage.emailClaimsBackfilled.get()) return;
      this.#backfillCurrentEmailClaims();
      this.storage.emailClaimsBackfilled.put(true);
    });
  }

  /** Resolves a verified Clerk subject and primary email to an initialized active identity. */
  async resolveClerkIdentity(
    subject: string,
    verifiedEmail: string,
    signupsEnabled: boolean,
  ): Promise<IdentityResolution> {
    return await this.#resolveSubjectIdentity(
      clerkSubjectKey(subject), verifiedEmail, signupsEnabled,
    );
  }

  /**
   * Resolves a verified Access subject scoped to its trusted issuer and audience.
   *
   * An unseen subject fails closed if its email is claimed by any existing identity.
   */
  async resolveAccessIdentity(
    issuer: string,
    audience: string,
    subject: string,
    verifiedEmail: string,
    signupsEnabled: boolean,
  ): Promise<IdentityResolution> {
    return await this.#resolveSubjectIdentity(
      accessSubjectKey(issuer, audience, subject), verifiedEmail, signupsEnabled,
    );
  }

  /**
   * Resolves a verified Gatekeeper subject scoped to its vendor and current verified email.
   *
   * An unseen subject fails closed when the email is current or historical authority of any
   * identity. Existing subjects retain their internal user ID across email changes.
   */
  async resolveGatekeeperIdentity(
    vendorId: string,
    subject: string,
    verifiedEmail: string,
    signupsEnabled: boolean,
  ): Promise<IdentityResolution> {
    return await this.#resolveSubjectIdentity(
      gatekeeperSubjectKey(vendorId, subject), verifiedEmail, signupsEnabled,
    );
  }

  /** Registers an ephemeral abort callback after validating the identity's exact active version. */
  registerIdentitySession(
    internalUserId: string,
    identityVersion: number,
    subscriberId: string,
    subscriber: RpcStub<IdentitySessionInvalidator>,
  ): void {
    const current = this.storage.identities.get(internalUserId);
    if (current?.status !== "active" || current.identityVersion !== identityVersion ||
        current.canonicalVerifiedEmail === null) {
      throw new Error(COLLISION_LOCKED);
    }

    const ownedSubscriber = subscriber.dup();
    let sessions = this.identitySessions.get(internalUserId);
    if (!sessions) {
      sessions = new Map();
      this.identitySessions.set(internalUserId, sessions);
    }
    sessions.get(subscriberId)?.[Symbol.dispose]();
    sessions.set(subscriberId, ownedSubscriber);
    // The owning PublicApi unregisters on socket disposal. Native Workers RPC does not expose an
    // onRpcBroken intrinsic here; calling that name would incorrectly invoke an application method.
  }

  /** Unregisters one live registry-backed session callback; missing registrations are harmless. */
  unregisterIdentitySession(internalUserId: string, subscriberId: string): void {
    const sessions = this.identitySessions.get(internalUserId);
    const subscriber = sessions?.get(subscriberId);
    if (!subscriber) return;
    sessions!.delete(subscriberId);
    if (sessions!.size === 0) this.identitySessions.delete(internalUserId);
    subscriber[Symbol.dispose]();
  }

  /** Resolves a legacy email-only Gatekeeper identity at its current, non-historical email. */
  async resolveEmailIdentity(
    verifiedEmail: string,
    signupsEnabled: boolean,
  ): Promise<IdentityResolution> {
    const email = canonicalizeVerifiedEmail(verifiedEmail);
    const result = this.storage.transaction((): { record: IdentityRecord; created: boolean } => {
      const existing = this.storage.identities.byEmail.get(email);
      if (existing) {
        if (existing.status !== "active") throw new Error(COLLISION_LOCKED);
        return { record: existing, created: false };
      }

      if (this.storage.emailClaims.get(email)) throw new Error(EXPLICIT_LINK_REQUIRED);
      if (!signupsEnabled) throw new Error(SIGNUPS_DISABLED);
      const created: IdentityRecord = {
        internalUserId: randomInternalUserId(),
        canonicalVerifiedEmail: email,
        identityVersion: 1,
        status: "active",
        subjectKeys: [],
      };
      this.storage.identities.put(created);
      this.#claimEmail(email, created.internalUserId);
      return { record: created, created: true };
    });

    return await this.#initialize(result.record, result.created);
  }

  /**
   * Finds an existing active internal user ID by verified email without creating an identity.
   *
   * This is a backend-only discovery boundary for sharing. It returns no capability and does not
   * initialize, reactivate, or otherwise mutate an identity.
   */
  findInternalUserIdByVerifiedEmail(verifiedEmail: string): string | null {
    const record = this.storage.identities.byEmail.get(canonicalizeVerifiedEmail(verifiedEmail));
    return record?.status === "active" ? record.internalUserId : null;
  }

  /** Reads current identity state by opaque internal user ID for lease/version validation. */
  getIdentity(internalUserId: string): IdentityState | null {
    const record = this.storage.identities.get(internalUserId);
    if (!record) return null;
    return {
      internalUserId: record.internalUserId,
      canonicalVerifiedEmail: record.canonicalVerifiedEmail,
      identityVersion: record.identityVersion,
      status: record.status,
    };
  }

  /** Creates a short-lived, single-use token for linking one external identity source. */
  async startExternalLink(
    internalUserId: string,
    identityVersion: number,
    source: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomExternalLinkToken();
    const digest = await digestExternalLinkToken(token);
    const expiresAt = new Date(Date.now() + EXTERNAL_LINK_TOKEN_TTL_MS);
    this.storage.transaction(() => {
      this.#cleanupExpiredExternalLinkTokens(Date.now());
      this.#assertActiveIdentity(internalUserId, identityVersion);
      this.storage.externalLinkTokens.put({
        internalSourceKey: internalSourceKey(internalUserId, source),
        digest,
        source,
        internalUserId,
        identityVersion,
        expiresAt: expiresAt.getTime(),
      });
    });
    return { token, expiresAt };
  }

  /** Completes a link and returns the active stable internal user ID that owns it. */
  async completeExternalLink(
    source: string,
    token: string,
    externalSubject: string,
  ): Promise<string> {
    const digest = await digestExternalLinkToken(token);
    const result = this.storage.transaction((): string | null => {
      const now = Date.now();
      this.#cleanupExpiredExternalLinkTokens(now);
      const pending = this.storage.externalLinkTokens.byDigest.get(digest);
      if (!pending || pending.source !== source || pending.expiresAt <= now) return null;
      const latest = this.storage.externalLinkTokens.get(pending.internalSourceKey);
      if (latest?.digest !== digest) return null;
      this.storage.externalLinkTokens.delete(pending.internalSourceKey);

      const identity = this.storage.identities.get(pending.internalUserId);
      if (identity?.status !== "active" ||
          identity.canonicalVerifiedEmail === null ||
          identity.identityVersion !== pending.identityVersion) {
        return null;
      }

      const targetKey = externalKey(source, externalSubject);
      const target = this.storage.externalLinks.get(targetKey);
      if (target && target.internalUserId !== pending.internalUserId) return null;

      const previous = this.storage.externalLinks.byInternalSource.get(
        pending.internalSourceKey,
      );
      if (previous && previous.externalKey !== targetKey) {
        this.storage.externalLinks.delete(previous.externalKey);
      }
      this.storage.externalLinks.put({
        externalKey: targetKey,
        internalSourceKey: pending.internalSourceKey,
        source,
        externalSubject,
        internalUserId: pending.internalUserId,
      });
      return pending.internalUserId;
    });
    if (result === null) throw new Error(EXTERNAL_LINK_INVALID);
    return result;
  }

  /** Returns only whether the active identity has an external link for this source. */
  getExternalLinkStatus(
    internalUserId: string,
    identityVersion: number,
    source: string,
  ): { connected: boolean } {
    return this.storage.transaction(() => {
      this.#cleanupExpiredExternalLinkTokens(Date.now());
      this.#assertActiveIdentity(internalUserId, identityVersion);
      return {
        connected: this.storage.externalLinks.byInternalSource.get(
          internalSourceKey(internalUserId, source),
        ) !== undefined,
      };
    });
  }

  /** Removes a source mapping and every pending token for the exact active identity version. */
  unlinkExternalIdentity(
    internalUserId: string,
    identityVersion: number,
    source: string,
  ): void {
    this.storage.transaction(() => {
      this.#cleanupExpiredExternalLinkTokens(Date.now());
      this.#assertActiveIdentity(internalUserId, identityVersion);
      const key = internalSourceKey(internalUserId, source);
      const current = this.storage.externalLinks.byInternalSource.get(key);
      if (current) this.storage.externalLinks.delete(current.externalKey);
      this.storage.externalLinkTokens.delete(key);
    });
  }

  /** Finds the active stable internal user ID linked to a source subject, without minting authority. */
  findInternalUserIdByExternalSubject(source: string, subject: string): string | null {
    const link = this.storage.externalLinks.get(externalKey(source, subject));
    if (!link) return null;
    const identity = this.storage.identities.get(link.internalUserId);
    return identity?.status === "active" && identity.canonicalVerifiedEmail !== null
      ? identity.internalUserId
      : null;
  }

  async #resolveSubjectIdentity(
      subjectKey: string,
      verifiedEmail: string,
      signupsEnabled: boolean): Promise<IdentityResolution> {
    const email = canonicalizeVerifiedEmail(verifiedEmail);
    const result = this.storage.transaction((): {
      record: IdentityRecord; changed: boolean; created: boolean;
    } => {
      const subjectIdentity = this.storage.identities.bySubject.get(subjectKey);
      if (subjectIdentity) {
        if (subjectIdentity.status !== "active") throw new Error(COLLISION_LOCKED);
        if (subjectIdentity.canonicalVerifiedEmail === email) {
          return { record: subjectIdentity, changed: false, created: false };
        }

        const claim = this.storage.emailClaims.get(email);
        if (claim && claim.internalUserId !== subjectIdentity.internalUserId) {
          const locked: IdentityRecord = {
            ...subjectIdentity,
            canonicalVerifiedEmail: null,
            identityVersion: subjectIdentity.identityVersion + 1,
            status: "collisionLocked",
          };
          this.storage.identities.put(locked);
          return { record: locked, changed: true, created: false };
        }

        this.#claimEmail(email, subjectIdentity.internalUserId);
        const moved: IdentityRecord = {
          ...subjectIdentity,
          canonicalVerifiedEmail: email,
          identityVersion: subjectIdentity.identityVersion + 1,
        };
        this.storage.identities.put(moved);
        return { record: moved, changed: true, created: false };
      }

      if (this.storage.emailClaims.get(email)) throw new Error(EXPLICIT_LINK_REQUIRED);
      if (!signupsEnabled) throw new Error(SIGNUPS_DISABLED);
      const created: IdentityRecord = {
        internalUserId: randomInternalUserId(),
        canonicalVerifiedEmail: email,
        identityVersion: 1,
        status: "active",
        subjectKeys: [subjectKey],
      };
      this.storage.identities.put(created);
      this.#claimEmail(email, created.internalUserId);
      return { record: created, changed: false, created: true };
    });

    if (result.changed) this.#invalidateIdentitySessions(result.record.internalUserId);
    return await this.#initialize(result.record, result.created);
  }

  #assertActiveIdentity(internalUserId: string, identityVersion: number): IdentityRecord {
    const identity = this.storage.identities.get(internalUserId);
    if (identity?.status !== "active" ||
        identity.canonicalVerifiedEmail === null ||
        identity.identityVersion !== identityVersion) {
      throw new Error(COLLISION_LOCKED);
    }
    return identity;
  }

  #cleanupExpiredExternalLinkTokens(now: number): void {
    const expired = [...this.storage.externalLinkTokens.byExpiry.list({
      end: externalLinkTokenExpiryKey(now + 1, ""),
      limit: EXPIRED_TOKEN_CLEANUP_LIMIT,
    })];
    for (const token of expired) {
      if (token.expiresAt <= now) {
        this.storage.externalLinkTokens.delete(token.internalSourceKey);
      }
    }
  }

  #claimEmail(canonicalVerifiedEmail: string, internalUserId: string): void {
    const existing = this.storage.emailClaims.get(canonicalVerifiedEmail);
    if (existing) {
      if (existing.internalUserId !== internalUserId) throw new Error(COLLISION_LOCKED);
      return;
    }
    this.storage.emailClaims.put({ canonicalVerifiedEmail, internalUserId });
  }

  #backfillCurrentEmailClaims(): void {
    const identities = [...this.storage.identities.list()];
    for (const identity of identities) {
      if (identity.canonicalVerifiedEmail !== null) {
        this.#claimEmail(identity.canonicalVerifiedEmail, identity.internalUserId);
      }
    }
  }

  #invalidateIdentitySessions(internalUserId: string): void {
    const sessions = this.identitySessions.get(internalUserId);
    if (!sessions) return;
    for (const [subscriberId, subscriber] of sessions) {
      void this.#invalidateIdentitySession(internalUserId, subscriberId, subscriber);
    }
  }

  async #invalidateIdentitySession(
      internalUserId: string,
      subscriberId: string,
      subscriber: RpcStub<IdentitySessionInvalidator>): Promise<void> {
    try {
      await subscriber();
    } catch (error) {
      logger.warn("failed to invalidate identity session callback", {
        event: "identity.session.invalidate.failed", failureCount: 1, error,
      });
    } finally {
      this.#removeIdentitySession(internalUserId, subscriberId, subscriber);
    }
  }

  #removeIdentitySession(
      internalUserId: string,
      subscriberId: string,
      expected?: RpcStub<IdentitySessionInvalidator>): void {
    const sessions = this.identitySessions.get(internalUserId);
    const subscriber = sessions?.get(subscriberId);
    if (!subscriber || (expected && subscriber !== expected)) return;
    sessions!.delete(subscriberId);
    if (sessions!.size === 0) this.identitySessions.delete(internalUserId);
    subscriber[Symbol.dispose]();
  }

  async #initialize(record: IdentityRecord, created: boolean): Promise<IdentityResolution> {
    const resolution = activeResolution(record, created);
    const id = this.users.idFromName(resolution.internalUserId);
    try {
      await this.users.get(id).initializeIdentity(
        resolution.internalUserId,
        resolution.canonicalVerifiedEmail,
        resolution.identityVersion,
      );
    } catch {
      throw new Error(SETUP_FAILED);
    }

    const current = this.storage.identities.get(resolution.internalUserId);
    if (current?.status !== "active" ||
        current.internalUserId !== resolution.internalUserId ||
        current.canonicalVerifiedEmail !== resolution.canonicalVerifiedEmail ||
        current.identityVersion !== resolution.identityVersion) {
      throw new Error(COLLISION_LOCKED);
    }
    return activeResolution(current, created);
  }
}
