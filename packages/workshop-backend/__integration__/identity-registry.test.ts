import { runInDurableObject } from "cloudflare:test";
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
          get(id: string): { initializeIdentity(id: string, email: string): Promise<void> };
        };
      };
      let attempts = 0;
      const routedIds: string[] = [];
      let stateDuringFirstInitialize: ReturnType<IdentityRegistry["getIdentity"]>;
      mutable.users = {
        idFromName: name => name,
        get: () => ({
          async initializeIdentity(internalUserId) {
            attempts++;
            routedIds.push(internalUserId);
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
          get(id: string): { initializeIdentity(id: string, email: string): Promise<void> };
        };
      };
      const originalUsers = mutable.users;
      const initializeStarted = Promise.withResolvers<void>();
      const releaseInitialize = Promise.withResolvers<void>();
      mutable.users = {
        idFromName: name => name,
        get: () => ({
          async initializeIdentity() {
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

  it("initializes a User idempotently without replacing its customized display name", async () => {
    const internalUserId = crypto.randomUUID().replaceAll("-", "");
    const user = exports.UserDurableObject.getByName(internalUserId);
    const firstEmail = unique("profile-first");
    const nextEmail = unique("profile-next");

    await user.initializeIdentity(internalUserId, firstEmail);
    expect(await user.whoami()).toEqual({
      type: "user",
      id: internalUserId,
      name: firstEmail.split("@")[0],
    });
    expect(await user.hasPasswordLogin()).toBe(false);

    await user.setOwnDisplayName("Customized");
    await user.initializeIdentity(internalUserId, nextEmail);
    expect(await user.whoami()).toEqual({ type: "user", id: internalUserId, name: "Customized" });

    await runInDurableObject(user, (instance: UserDurableObject) => {
      const inspected = instance as unknown as {
        storage: { verifiedEmail: { get(): string | null } };
      };
      expect(inspected.storage.verifiedEmail.get()).toBe(nextEmail);
    });
    await runInDurableObject(user, async (instance: UserDurableObject) => {
      await expect(Promise.resolve().then(() =>
        instance.initializeIdentity(`${internalUserId}-other`, nextEmail)))
        .rejects.toThrow("Internal user identity does not match this User Durable Object.");
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
