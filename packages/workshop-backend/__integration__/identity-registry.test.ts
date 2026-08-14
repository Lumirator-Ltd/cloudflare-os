import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { IdentityRegistry, IdentityResolution } from "../src/identity-registry.js";
import type { UserDurableObject } from "../src/user.js";

function unique(value: string): string {
  return `${value}-${crypto.randomUUID()}@example.com`;
}

function registry() {
  return exports.IdentityRegistry.getByName("");
}

function stateOf({ created: _created, ...state }: IdentityResolution) {
  return state;
}

async function expectRegistryRejection(
  invoke: (instance: IdentityRegistry) => Promise<unknown>,
  message: string,
): Promise<void> {
  await runInDurableObject(registry(), async (instance: IdentityRegistry) => {
    await expect(invoke(instance)).rejects.toThrow(message);
  });
}

describe("IdentityRegistry", () => {
  it("creates a random opaque stable internal user with active versioned identity state", async () => {
    const email = unique("first");
    const result = await registry().resolveEmailIdentity(email, true);

    expect(result).toEqual({
      internalUserId: expect.stringMatching(/^[0-9a-f]{64}$/),
      canonicalVerifiedEmail: email,
      identityVersion: 1,
      status: "active",
      created: true,
    });
    expect(result.internalUserId).not.toContain(email);
    expect(await registry().resolveEmailIdentity(email, false)).toEqual({
      ...result,
      created: false,
    });
  });

  it("rejects unseen stable subjects at a claimed current email without mutating identity state",
      async () => {
    const email = unique("claimed-current");
    const owner = await registry().resolveClerkIdentity("clerk-current-owner", email, true);
    const before = await registry().getIdentity(owner.internalUserId);
    const beforeSubjectKeys = await runInDurableObject(
      registry(),
      (instance: IdentityRegistry) => {
        const mutable = instance as unknown as {
          storage: { identities: { get(id: string): { subjectKeys: string[] } | undefined } };
        };
        return mutable.storage.identities.get(owner.internalUserId)?.subjectKeys;
      },
    );

    const linkRequired =
      "Identity ownership requires explicit linking or deployment operator resolution.";
    await expectRegistryRejection(
      instance => instance.resolveClerkIdentity("clerk-unseen", email, true), linkRequired);
    await expectRegistryRejection(
      instance => instance.resolveAccessIdentity(
        "https://first.cloudflareaccess.test", "audience", "access-unseen", email, true),
      linkRequired,
    );
    await expectRegistryRejection(
      instance => instance.resolveAccessIdentity(
        "https://other.cloudflareaccess.test", "other-audience", "access-unseen", email, false),
      linkRequired,
    );

    expect(await registry().getIdentity(owner.internalUserId)).toEqual(before);
    await runInDurableObject(registry(), (instance: IdentityRegistry) => {
      const mutable = instance as unknown as {
        storage: { identities: { get(id: string): { subjectKeys: string[] } | undefined } };
      };
      expect(mutable.storage.identities.get(owner.internalUserId)?.subjectKeys)
        .toEqual(beforeSubjectKeys);
    });
    await expect(registry().resolveClerkIdentity("clerk-current-owner", email, false))
      .resolves.toEqual({ ...owner, created: false });
  });

  it("retains email history across moves and restart, and allows only the owning subject to return",
      async () => {
    const subject = `clerk-history-${crypto.randomUUID()}`;
    const oldEmail = unique("history-old");
    const newEmail = unique("history-new");
    const initial = await registry().resolveClerkIdentity(subject, oldEmail, true);
    const moved = await registry().resolveClerkIdentity(subject, newEmail, false);

    expect(moved).toEqual({
      ...initial,
      canonicalVerifiedEmail: newEmail,
      identityVersion: initial.identityVersion + 1,
      created: false,
    });
    const linkRequired =
      "Identity ownership requires explicit linking or deployment operator resolution.";
    await expectRegistryRejection(
      instance => instance.resolveEmailIdentity(oldEmail, true), linkRequired);
    await expectRegistryRejection(
      instance => instance.resolveAccessIdentity(
        "https://history.cloudflareaccess.test", "history-audience", "new-subject", oldEmail, true),
      linkRequired,
    );

    await abortAllDurableObjects();

    const returned = await registry().resolveClerkIdentity(subject, oldEmail, false);
    expect(returned).toEqual({
      ...initial,
      identityVersion: moved.identityVersion + 1,
      created: false,
    });
  });

  it("resolves legacy Gatekeeper identities only at their current canonical verified email",
      async () => {
    const email = unique("email-only");
    const gatekeeper = await registry().resolveEmailIdentity(` ${email.toUpperCase()} `, true);
    const current = await registry().resolveEmailIdentity(email, false);

    expect(current).toEqual({ ...gatekeeper, created: false });
  });

  it("backfills claims for persisted pre-claim identities before resolving a new subject",
      async () => {
    const email = unique("legacy-fixture");
    const owner = await registry().resolveClerkIdentity("legacy-fixture-owner", email, true);

    await runInDurableObject(registry(), (instance: IdentityRegistry) => {
      const mutable = instance as unknown as {
        storage: {
          emailClaims: { delete(email: string): boolean };
          emailClaimsBackfilled: { put(value: boolean): void };
        };
      };
      expect(mutable.storage.emailClaims.delete(email)).toBe(true);
      mutable.storage.emailClaimsBackfilled.put(false);
    });
    await abortAllDurableObjects();

    await expectRegistryRejection(
      instance => instance.resolveAccessIdentity(
        "https://migration.cloudflareaccess.test", "migration-audience", "unseen", email, true),
      "Identity ownership requires explicit linking or deployment operator resolution.",
    );
    await expect(registry().resolveClerkIdentity("legacy-fixture-owner", email, false))
      .resolves.toEqual({ ...owner, created: false });
  });

  it("moves an Access subject email on the same identity and persists the subject index", async () => {
    const issuer = `https://${crypto.randomUUID()}.cloudflareaccess.test`;
    const audience = `audience-${crypto.randomUUID()}`;
    const subject = `access-subject-${crypto.randomUUID()}`;
    const oldEmail = unique("access-restart-old");
    const newEmail = unique("access-restart-new");
    const first = await registry().resolveAccessIdentity(
      issuer, audience, subject, oldEmail, true,
    );
    const moved = await registry().resolveAccessIdentity(
      issuer, audience, subject, newEmail, false,
    );

    expect(moved).toEqual({
      ...first,
      canonicalVerifiedEmail: newEmail,
      identityVersion: first.identityVersion + 1,
      created: false,
    });
    await expectRegistryRejection(
      instance => instance.resolveEmailIdentity(oldEmail, false),
      "Identity ownership requires explicit linking or deployment operator resolution.",
    );

    await abortAllDurableObjects();

    await expect(registry().resolveAccessIdentity(
      issuer, audience, subject, newEmail, false,
    )).resolves.toEqual({ ...moved, created: false });
  });

  it("scopes the same Access subject to its configured issuer and audience", async () => {
    const subject = `shared-access-subject-${crypto.randomUUID()}`;
    const first = await registry().resolveAccessIdentity(
      "https://first.cloudflareaccess.test", "first-audience", subject, unique("first-access"), true,
    );
    const differentIssuer = await registry().resolveAccessIdentity(
      "https://second.cloudflareaccess.test", "first-audience", subject,
      unique("second-access"), true,
    );
    const differentAudience = await registry().resolveAccessIdentity(
      "https://first.cloudflareaccess.test", "second-audience", subject,
      unique("third-access"), true,
    );

    expect(new Set([
      first.internalUserId,
      differentIssuer.internalUserId,
      differentAudience.internalUserId,
    ])).toHaveLength(3);
  });

  it("collision-locks an Access subject moved onto another identity's verified email", async () => {
    const issuer = "https://collision.cloudflareaccess.test";
    const audience = `collision-audience-${crypto.randomUUID()}`;
    const subject = `collision-access-subject-${crypto.randomUUID()}`;
    const oldEmail = unique("access-collision-old");
    const occupiedEmail = unique("access-collision-occupied");
    const affected = await registry().resolveAccessIdentity(
      issuer, audience, subject, oldEmail, true,
    );
    const other = await registry().resolveEmailIdentity(occupiedEmail, true);

    await expectRegistryRejection(
      instance => instance.resolveAccessIdentity(
        issuer, audience, subject, occupiedEmail, false,
      ),
      "Identity collision requires deployment operator assistance.",
    );

    expect(await registry().getIdentity(affected.internalUserId)).toEqual({
      internalUserId: affected.internalUserId,
      canonicalVerifiedEmail: null,
      identityVersion: affected.identityVersion + 1,
      status: "collisionLocked",
    });
    expect(await registry().resolveEmailIdentity(occupiedEmail, false))
      .toEqual({ ...other, created: false });
  });

  it("persists Clerk subject and email indexes across Durable Object restarts", async () => {
    const subject = `clerk-restart-${crypto.randomUUID()}`;
    const clerkEmail = unique("restart-clerk");
    const movedClerkEmail = unique("restart-clerk-moved");
    const emailOnlyEmail = unique("restart-email-only");
    const clerkIdentity = await registry().resolveClerkIdentity(subject, clerkEmail, true);
    const emailOnlyIdentity = await registry().resolveEmailIdentity(emailOnlyEmail, true);
    const clerkState = await registry().getIdentity(clerkIdentity.internalUserId);
    const emailOnlyState = await registry().getIdentity(emailOnlyIdentity.internalUserId);

    expect(clerkIdentity.internalUserId).not.toBe(emailOnlyIdentity.internalUserId);
    expect(clerkState).toEqual(stateOf(clerkIdentity));
    expect(emailOnlyState).toEqual(stateOf(emailOnlyIdentity));

    await abortAllDurableObjects();

    const movedClerkIdentity = await registry()
      .resolveClerkIdentity(subject, movedClerkEmail, false);
    expect(movedClerkIdentity).toEqual({
      ...clerkIdentity,
      canonicalVerifiedEmail: movedClerkEmail,
      identityVersion: clerkIdentity.identityVersion + 1,
      created: false,
    });
    expect(await registry().resolveEmailIdentity(emailOnlyEmail, false))
      .toEqual({ ...emailOnlyIdentity, created: false });
    expect(await registry().getIdentity(clerkIdentity.internalUserId))
      .toEqual(stateOf(movedClerkIdentity));
    expect(await registry().getIdentity(emailOnlyIdentity.internalUserId)).toEqual(emailOnlyState);
  });

  it("denies an unknown identity when signups are disabled but allows an existing identity", async () => {
    const existingEmail = unique("existing");
    const existing = await registry().resolveEmailIdentity(existingEmail, true);

    await expectRegistryRejection(
      instance => instance.resolveEmailIdentity(unique("unknown"), false),
      "New sign-ups are currently disabled on this deployment.",
    );
    await expect(registry().resolveEmailIdentity(existingEmail, false))
      .resolves.toEqual({ ...existing, created: false });
  });

  it("converges concurrent first resolutions on one internal user ID", async () => {
    const email = unique("concurrent");
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      registry().resolveClerkIdentity("clerk-concurrent", email, true)));

    expect(new Set(results.map(result => result.internalUserId))).toHaveLength(1);
    expect(results.every(result => result.identityVersion === 1)).toBe(true);
  });

  it("commits and retains the same mapping for an idempotent User initialization retry", async () => {
    const email = unique("retry");
    const stub = registry();

    await runInDurableObject(stub, async (instance: IdentityRegistry) => {
      const mutable = instance as unknown as {
        users: {
          idFromName(name: string): string;
          get(id: string): {
            initializeIdentity(id: string, email: string, identityVersion: number): Promise<void>;
          };
        };
      };
      const originalUsers = mutable.users;
      let attempts = 0;
      const routedIds: string[] = [];
      const routedVersions: number[] = [];
      let stateDuringFirstInitialize: ReturnType<IdentityRegistry["getIdentity"]>;
      mutable.users = {
        idFromName: name => name,
        get: () => ({
          async initializeIdentity(internalUserId, _verifiedEmail, identityVersion) {
            attempts++;
            routedIds.push(internalUserId);
            routedVersions.push(identityVersion);
            if (attempts === 1) {
              stateDuringFirstInitialize = instance.getIdentity(internalUserId);
              throw new Error("injected initialization failure");
            }
          },
        }),
      };

      try {
        await expect(instance.resolveEmailIdentity(email, true))
          .rejects.toThrow("Identity setup failed.");
        expect(stateDuringFirstInitialize!).toEqual({
          internalUserId: routedIds[0],
          canonicalVerifiedEmail: email,
          identityVersion: 1,
          status: "active",
        });

        const retried = await instance.resolveEmailIdentity(email, false);
        expect(routedIds).toEqual([retried.internalUserId, retried.internalUserId]);
        expect(routedVersions).toEqual([1, 1]);
        expect(instance.getIdentity(retried.internalUserId)).toEqual({
          internalUserId: retried.internalUserId,
          canonicalVerifiedEmail: email,
          identityVersion: 1,
          status: "active",
        });
        expect(attempts).toBe(2);
      } finally {
        mutable.users = originalUsers;
      }
    });
  });

  it("rejects a resolution collision-locked while User initialization is pending", async () => {
    const subject = `clerk-race-${crypto.randomUUID()}`;
    const oldEmail = unique("race-old");
    const occupiedEmail = unique("race-occupied");
    const affected = await registry().resolveClerkIdentity(subject, oldEmail, true);
    const other = await registry().resolveEmailIdentity(occupiedEmail, true);

    await runInDurableObject(registry(), async (instance: IdentityRegistry) => {
      const mutable = instance as unknown as {
        users: {
          idFromName(name: string): string;
          get(id: string): {
            initializeIdentity(id: string, email: string, identityVersion: number): Promise<void>;
          };
        };
      };
      const originalUsers = mutable.users;
      const initializeStarted = Promise.withResolvers<void>();
      const releaseInitialize = Promise.withResolvers<void>();
      mutable.users = {
        idFromName: name => name,
        get: () => ({
          async initializeIdentity(_internalUserId, _verifiedEmail, _identityVersion) {
            initializeStarted.resolve();
            await releaseInitialize.promise;
          },
        }),
      };

      try {
        const pendingResolution = instance.resolveClerkIdentity(subject, oldEmail, false);
        await initializeStarted.promise;

        await expect(instance.resolveClerkIdentity(subject, occupiedEmail, false))
          .rejects.toThrow("Identity collision requires deployment operator assistance.");
        releaseInitialize.resolve();

        await expect(pendingResolution)
          .rejects.toThrow("Identity collision requires deployment operator assistance.");
        expect(instance.getIdentity(affected.internalUserId)).toEqual({
          internalUserId: affected.internalUserId,
          canonicalVerifiedEmail: null,
          identityVersion: affected.identityVersion + 1,
          status: "collisionLocked",
        });
      } finally {
        releaseInitialize.resolve();
        mutable.users = originalUsers;
      }
    });

    await expectRegistryRejection(
      instance => instance.resolveEmailIdentity(oldEmail, false),
      "Identity ownership requires explicit linking or deployment operator resolution.",
    );
    expect(await registry().resolveEmailIdentity(occupiedEmail, false))
      .toEqual({ ...other, created: false });
  });

  it("applies newer User identity contact versions without replacing a customized name", async () => {
    const internalUserId = crypto.randomUUID().replaceAll("-", "");
    const user = exports.UserDurableObject.getByName(internalUserId);
    const firstEmail = unique("profile-first");
    const nextEmail = unique("profile-next");

    await user.initializeIdentity(internalUserId, firstEmail, 1);
    expect(await user.whoami()).toEqual({
      type: "user",
      id: internalUserId,
      name: firstEmail.split("@")[0],
    });
    expect(await user.hasPasswordLogin()).toBe(false);

    await user.setOwnDisplayName("Customized");
    await user.initializeIdentity(internalUserId, nextEmail, 2);
    expect(await user.whoami()).toEqual({ type: "user", id: internalUserId, name: "Customized" });

    await runInDurableObject(user, (instance: UserDurableObject) => {
      const inspected = instance as unknown as {
        storage: {
          identityAppliedVersion: { get(): number };
          verifiedEmail: { get(): string | null };
        };
      };
      expect(inspected.storage.verifiedEmail.get()).toBe(nextEmail);
      expect(inspected.storage.identityAppliedVersion.get()).toBe(2);
    });
    await runInDurableObject(user, async (instance: UserDurableObject) => {
      await expect(Promise.resolve().then(() =>
        instance.initializeIdentity(`${internalUserId}-other`, nextEmail, 2)))
        .rejects.toThrow("Internal user identity does not match this User Durable Object.");
    });
  });

  it("keeps newer User contact state when an older initialization arrives late", async () => {
    const internalUserId = crypto.randomUUID().replaceAll("-", "");
    const user = exports.UserDurableObject.getByName(internalUserId);
    const oldEmail = unique("delayed-v1");
    const currentEmail = unique("applied-v2");

    await user.initializeIdentity(internalUserId, currentEmail, 2);
    await user.initializeIdentity(internalUserId, oldEmail, 1);
    await user.initializeIdentity(internalUserId, currentEmail, 2);
    await runInDurableObject(user, async (instance: UserDurableObject) => {
      await expect(Promise.resolve().then(() =>
        instance.initializeIdentity(internalUserId, oldEmail, 2)))
        .rejects.toThrow("Identity version is already applied with a different verified email.");
    });

    expect(await user.whoami()).toEqual({
      type: "user",
      id: internalUserId,
      name: currentEmail.split("@")[0],
    });
    await runInDurableObject(user, (instance: UserDurableObject) => {
      const inspected = instance as unknown as {
        storage: {
          identityAppliedVersion: { get(): number };
          verifiedEmail: { get(): string | null };
        };
      };
      expect(inspected.storage.verifiedEmail.get()).toBe(currentEmail);
      expect(inspected.storage.identityAppliedVersion.get()).toBe(2);
    });
  });

  it("eagerly invalidates every registry-backed session when an identity email changes", async () => {
    const subject = `clerk-subscribers-${crypto.randomUUID()}`;
    const oldEmail = unique("subscriber-old");
    const newEmail = unique("subscriber-new");
    const initial = await registry().resolveClerkIdentity(subject, oldEmail, true);
    const invalidated: string[] = [];

    await runInDurableObject(registry(), async (instance: IdentityRegistry) => {
      type Subscriber = (() => Promise<void>) & {
        dup(): Subscriber;
        onRpcBroken(callback: () => void): void;
        [Symbol.dispose](): void;
      };
      const subscriber = (name: string): Subscriber => {
        const callback = async () => { invalidated.push(name); };
        return Object.assign(callback, {
          dup() { return callback as Subscriber; },
          onRpcBroken() {},
          [Symbol.dispose]() {},
        }) as Subscriber;
      };
      await instance.registerIdentitySession(
        initial.internalUserId, initial.identityVersion, "initiator", subscriber("initiator") as never);
      await instance.registerIdentitySession(
        initial.internalUserId, initial.identityVersion, "stale", subscriber("stale") as never);

      const moved = await instance.resolveClerkIdentity(subject, newEmail, false);
      expect(moved.identityVersion).toBe(initial.identityVersion + 1);
      await Promise.resolve();
      expect(invalidated).toEqual(["initiator", "stale"]);
    });
  });

  it("retains an invalidation callback until its invocation settles", async () => {
    const subject = `clerk-pending-subscriber-${crypto.randomUUID()}`;
    const initial = await registry().resolveClerkIdentity(
      subject, unique("pending-subscriber-old"), true);
    const release = Promise.withResolvers<void>();
    let disposed = 0;

    await runInDurableObject(registry(), async (instance: IdentityRegistry) => {
      const callback = Object.assign(async () => { await release.promise; }, {
        dup() { return callback; },
        onRpcBroken() {},
        [Symbol.dispose]() { disposed++; },
      });
      instance.registerIdentitySession(
        initial.internalUserId, initial.identityVersion, "pending", callback as never);

      await instance.resolveClerkIdentity(subject, unique("pending-subscriber-new"), false);
      instance.unregisterIdentitySession(initial.internalUserId, "pending");
      expect(disposed).toBe(1);
      release.resolve();
      await Promise.resolve();
      expect(disposed).toBe(1);
    });
  });

  it("does not invoke unsupported native onRpcBroken as an application callback", async () => {
    const subject = `clerk-native-subscriber-${crypto.randomUUID()}`;
    const initial = await registry().resolveClerkIdentity(
      subject, unique("native-subscriber-old"), true);
    let invalidations = 0;
    let disposed = 0;

    await runInDurableObject(registry(), async (instance: IdentityRegistry) => {
      const callback = Object.assign(async () => { invalidations++; }, {
        dup() { return callback; },
        [Symbol.dispose]() { disposed++; },
      });
      instance.registerIdentitySession(
        initial.internalUserId, initial.identityVersion, "native", callback as never);

      await instance.resolveClerkIdentity(subject, unique("native-subscriber-new"), false);
      await Promise.resolve();
      expect(invalidations).toBe(1);
      expect(disposed).toBe(1);
    });
  });

  it("cleans up and logs a bounded warning when invalidation RPC fails", async () => {
    const subject = `clerk-failing-subscriber-${crypto.randomUUID()}`;
    const initial = await registry().resolveClerkIdentity(
      subject, unique("failing-subscriber-old"), true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let disposed = 0;

    try {
      await runInDurableObject(registry(), async (instance: IdentityRegistry) => {
        const callback = Object.assign(async () => { throw new Error("callback failed"); }, {
          dup() { return callback; },
          onRpcBroken() {},
          [Symbol.dispose]() { disposed++; },
        });
        instance.registerIdentitySession(
          initial.internalUserId, initial.identityVersion, "failing", callback as never);

        await instance.resolveClerkIdentity(subject, unique("failing-subscriber-new"), false);
        await vi.waitFor(() => expect(disposed).toBe(1));
        expect(warn.mock.calls.flat()).toEqual(expect.arrayContaining([
          expect.objectContaining({ event: "identity.session.invalidate.failed" }),
        ]));
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not persist live identity subscribers across a registry restart", async () => {
    const subject = `clerk-lost-subscriber-${crypto.randomUUID()}`;
    const oldEmail = unique("lost-subscriber-old");
    const newEmail = unique("lost-subscriber-new");
    const initial = await registry().resolveClerkIdentity(subject, oldEmail, true);
    let invalidations = 0;

    await runInDurableObject(registry(), async (instance: IdentityRegistry) => {
      const callback = async () => { invalidations++; };
      const subscriber = Object.assign(callback, {
        dup() { return subscriber; },
        onRpcBroken() {},
        [Symbol.dispose]() {},
      });
      await instance.registerIdentitySession(
        initial.internalUserId, initial.identityVersion, "lost", subscriber as never);
    });
    await abortAllDurableObjects();
    await registry().resolveClerkIdentity(subject, newEmail, false);

    expect(invalidations).toBe(0);
  });

  it("moves a Clerk identity email, removes the old alias, and increments its version", async () => {
    const oldEmail = unique("old-alias");
    const newEmail = unique("new-alias");
    const first = await registry().resolveClerkIdentity("clerk-email-move", oldEmail, true);
    const moved = await registry().resolveClerkIdentity("clerk-email-move", newEmail, false);

    expect(moved).toEqual({
      ...first,
      canonicalVerifiedEmail: newEmail,
      identityVersion: first.identityVersion + 1,
      created: false,
    });
    await expectRegistryRejection(
      instance => instance.resolveEmailIdentity(oldEmail, false),
      "Identity ownership requires explicit linking or deployment operator resolution.",
    );
  });

  it("locks only the moved Clerk identity on an email collision and denies authentication", async () => {
    const oldEmail = unique("collision-old");
    const occupiedEmail = unique("collision-occupied");
    const affected = await registry().resolveClerkIdentity("clerk-collision", oldEmail, true);
    const other = await registry().resolveEmailIdentity(occupiedEmail, true);

    await expectRegistryRejection(
      instance => instance.resolveClerkIdentity("clerk-collision", occupiedEmail, false),
      "Identity collision requires deployment operator assistance.",
    );

    expect(await registry().getIdentity(affected.internalUserId)).toEqual({
      internalUserId: affected.internalUserId,
      canonicalVerifiedEmail: null,
      identityVersion: affected.identityVersion + 1,
      status: "collisionLocked",
    });
    await expectRegistryRejection(
      instance => instance.resolveClerkIdentity("clerk-collision", occupiedEmail, true),
      "Identity collision requires deployment operator assistance.",
    );
    await expectRegistryRejection(
      instance => instance.resolveEmailIdentity(oldEmail, false),
      "Identity ownership requires explicit linking or deployment operator resolution.",
    );
    expect(await registry().resolveEmailIdentity(occupiedEmail, false))
      .toEqual({ ...other, created: false });
  });
});
