import { collection, createTypedStorage } from "@gadgets/typed-storage";
import { DurableObject } from "cloudflare:workers";
import type { UserDurableObject } from "./user.js";

/** The authorization state of an internal Workshop identity. */
export type IdentityStatus = "active" | "collisionLocked";

/** Stable identity information returned only after its User Durable Object is initialized. */
export type IdentityResolution = {
  internalUserId: string;
  canonicalVerifiedEmail: string;
  identityVersion: number;
  status: "active";
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
    },
  });
}

type IdentityRegistryStorage = ReturnType<typeof makeIdentityRegistryStorage>;

const SIGNUPS_DISABLED = "New sign-ups are currently disabled on this deployment.";
const COLLISION_LOCKED = "Identity collision requires deployment operator assistance.";
const SETUP_FAILED = "Identity setup failed.";

/** Canonicalizes a server-verified email using only trim and lowercase operations. */
export function canonicalizeVerifiedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function clerkSubjectKey(subject: string): string {
  return JSON.stringify(["clerk", subject]);
}

function randomInternalUserId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes.toHex();
}

function activeResolution(record: IdentityRecord): IdentityResolution {
  if (record.status !== "active" || record.canonicalVerifiedEmail === null) {
    throw new Error(COLLISION_LOCKED);
  }
  return {
    internalUserId: record.internalUserId,
    canonicalVerifiedEmail: record.canonicalVerifiedEmail,
    identityVersion: record.identityVersion,
    status: record.status,
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

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeIdentityRegistryStorage(ctx.storage);
    this.users = ctx.exports.UserDurableObject;
  }

  /** Resolves a verified Clerk subject and primary email to an initialized active identity. */
  async resolveClerkIdentity(
    subject: string,
    verifiedEmail: string,
    signupsEnabled: boolean,
  ): Promise<IdentityResolution> {
    const email = canonicalizeVerifiedEmail(verifiedEmail);
    const subjectKey = clerkSubjectKey(subject);
    const record = this.storage.transaction(() => {
      const subjectIdentity = this.storage.identities.bySubject.get(subjectKey);
      if (subjectIdentity) {
        if (subjectIdentity.status !== "active") throw new Error(COLLISION_LOCKED);
        if (subjectIdentity.canonicalVerifiedEmail === email) return subjectIdentity;

        const emailIdentity = this.storage.identities.byEmail.get(email);
        if (emailIdentity && emailIdentity.internalUserId !== subjectIdentity.internalUserId) {
          const locked: IdentityRecord = {
            ...subjectIdentity,
            canonicalVerifiedEmail: null,
            identityVersion: subjectIdentity.identityVersion + 1,
            status: "collisionLocked",
          };
          this.storage.identities.put(locked);
          return locked;
        }

        const moved: IdentityRecord = {
          ...subjectIdentity,
          canonicalVerifiedEmail: email,
          identityVersion: subjectIdentity.identityVersion + 1,
        };
        this.storage.identities.put(moved);
        return moved;
      }

      const emailIdentity = this.storage.identities.byEmail.get(email);
      if (emailIdentity) {
        if (emailIdentity.status !== "active") throw new Error(COLLISION_LOCKED);
        const bound: IdentityRecord = {
          ...emailIdentity,
          subjectKeys: [...emailIdentity.subjectKeys, subjectKey],
        };
        this.storage.identities.put(bound);
        return bound;
      }

      if (!signupsEnabled) throw new Error(SIGNUPS_DISABLED);
      const created: IdentityRecord = {
        internalUserId: randomInternalUserId(),
        canonicalVerifiedEmail: email,
        identityVersion: 1,
        status: "active",
        subjectKeys: [subjectKey],
      };
      this.storage.identities.put(created);
      return created;
    });

    return await this.#initialize(record);
  }

  /** Resolves a Gatekeeper or Access verified email to an initialized active identity. */
  async resolveEmailIdentity(
    verifiedEmail: string,
    signupsEnabled: boolean,
  ): Promise<IdentityResolution> {
    const email = canonicalizeVerifiedEmail(verifiedEmail);
    const record = this.storage.transaction(() => {
      const existing = this.storage.identities.byEmail.get(email);
      if (existing) {
        if (existing.status !== "active") throw new Error(COLLISION_LOCKED);
        return existing;
      }

      if (!signupsEnabled) throw new Error(SIGNUPS_DISABLED);
      const created: IdentityRecord = {
        internalUserId: randomInternalUserId(),
        canonicalVerifiedEmail: email,
        identityVersion: 1,
        status: "active",
        subjectKeys: [],
      };
      this.storage.identities.put(created);
      return created;
    });

    return await this.#initialize(record);
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

  async #initialize(record: IdentityRecord): Promise<IdentityResolution> {
    const resolution = activeResolution(record);
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
    return activeResolution(current);
  }
}
