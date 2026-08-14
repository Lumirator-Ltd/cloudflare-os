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

function randomInternalUserId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes.toHex();
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
