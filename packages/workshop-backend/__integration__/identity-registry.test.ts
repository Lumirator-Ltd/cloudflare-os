import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { IdentityRegistry } from "../src/identity-registry.js";
import type { UserDurableObject } from "../src/user.js";

function unique(value: string): string {
  return `${value}-${crypto.randomUUID()}@example.com`;
}

function registry() {
  return exports.IdentityRegistry.getByName("");
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
    });
    expect(result.internalUserId).not.toContain(email);
    expect(await registry().resolveEmailIdentity(email, false)).toEqual(result);
  });

  it("looks up Clerk subjects first and converges new subjects by verified email", async () => {
    const email = unique("converge");
    const emailIdentity = await registry().resolveEmailIdentity(`  ${email.toUpperCase()}  `, true);
    const clerkIdentity = await registry().resolveClerkIdentity("clerk-converge", email, false);

    expect(clerkIdentity).toEqual(emailIdentity);

    const movedEmail = unique("moved-by-subject");
    const moved = await registry().resolveClerkIdentity("clerk-converge", movedEmail, false);
    expect(moved.internalUserId).toBe(emailIdentity.internalUserId);
    expect(moved.canonicalVerifiedEmail).toBe(movedEmail);
    expect(moved.identityVersion).toBe(2);
  });

  it("resolves Gatekeeper and Access identities by canonical verified email only", async () => {
    const email = unique("email-only");
    const gatekeeper = await registry().resolveEmailIdentity(` ${email.toUpperCase()} `, true);
    const access = await registry().resolveEmailIdentity(email, false);

    expect(access).toEqual(gatekeeper);
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
    expect(clerkState).toEqual(clerkIdentity);
    expect(emailOnlyState).toEqual(emailOnlyIdentity);

    await abortAllDurableObjects();

    const movedClerkIdentity = await registry()
      .resolveClerkIdentity(subject, movedClerkEmail, false);
    expect(movedClerkIdentity).toEqual({
      ...clerkIdentity,
      canonicalVerifiedEmail: movedClerkEmail,
      identityVersion: clerkIdentity.identityVersion + 1,
    });
    expect(await registry().resolveEmailIdentity(emailOnlyEmail, false))
      .toEqual(emailOnlyIdentity);
    expect(await registry().getIdentity(clerkIdentity.internalUserId))
      .toEqual(movedClerkIdentity);
    expect(await registry().getIdentity(emailOnlyIdentity.internalUserId)).toEqual(emailOnlyState);
  });

  it("denies an unknown identity when signups are disabled but allows an existing identity", async () => {
    const existingEmail = unique("existing");
    const existing = await registry().resolveEmailIdentity(existingEmail, true);

    await expectRegistryRejection(
      instance => instance.resolveEmailIdentity(unique("unknown"), false),
      "New sign-ups are currently disabled on this deployment.",
    );
    await expect(registry().resolveEmailIdentity(existingEmail, false)).resolves.toEqual(existing);
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
      "New sign-ups are currently disabled on this deployment.",
    );
    expect(await registry().resolveEmailIdentity(occupiedEmail, false)).toEqual(other);
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

  it("moves a Clerk identity email, removes the old alias, and increments its version", async () => {
    const oldEmail = unique("old-alias");
    const newEmail = unique("new-alias");
    const first = await registry().resolveClerkIdentity("clerk-email-move", oldEmail, true);
    const moved = await registry().resolveClerkIdentity("clerk-email-move", newEmail, false);

    expect(moved).toEqual({
      ...first,
      canonicalVerifiedEmail: newEmail,
      identityVersion: first.identityVersion + 1,
    });
    await expectRegistryRejection(
      instance => instance.resolveEmailIdentity(oldEmail, false),
      "New sign-ups are currently disabled on this deployment.",
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
      "New sign-ups are currently disabled on this deployment.",
    );
    expect(await registry().resolveEmailIdentity(occupiedEmail, false)).toEqual(other);
  });
});
