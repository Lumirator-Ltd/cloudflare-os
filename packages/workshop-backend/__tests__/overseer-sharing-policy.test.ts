import { describe, expect, it, vi } from "vitest";
import * as overseerModule from "../src/overseer.js";
import type { ActionRecord } from "../src/overseer.js";
import type {
  AffectedCollaborator,
  AiChatAuthorInfo,
  CollaboratorInfo,
} from "@gadgets/workshop-shared/api";
import { makeMockStorage } from "./mock-storage.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

type SharingPolicyOverseer = {
  storage: {
    prohibitAllSharing: { get(): boolean; put(value: boolean): void };
  };
  ctx: {
    storage: {
      sync(): Promise<void>;
      transactionSync<T>(callback: () => T): T;
      kv: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
    };
    waitUntil(promise: Promise<unknown>): void;
    abort(reason: string): void;
  };
  users: {
    idFromName(name: string): unknown;
    get(id: unknown): { whoamiIfExists(): Promise<AiChatAuthorInfo | null> };
  };
  joinPresence(
    profileId: string,
    profile: AiChatAuthorInfo,
    role: "build" | "use",
  ): () => void;
  joinOutputsFanout(userId: string): () => void;
  getGatekeeperFacet(gatekeeperId: number): { applyAction(action: number): Promise<void> };
  getSharingManager(): Promise<any>;
  tearDownLostObservers(affected: AffectedCollaborator[]): Promise<void>;
  refreshAffectedCollaboratorListings(affected: AffectedCollaborator[]): Promise<void>;
  scheduleRevocationRestart(): Promise<void>;
  runSharingRevocation(
    prepareMutation: () => (() => AffectedCollaborator[])
      | Promise<() => AffectedCollaborator[]>,
    cleanup: (affected: AffectedCollaborator[]) => Promise<void>,
  ): Promise<AffectedCollaborator[]>;
  applyPendingAction(
    record: ActionRecord & { type: "action" },
    resolvedBy: AiChatAuthorInfo,
    autoApproved: boolean,
  ): Promise<void>;
  authorizeObservation(
    gatekeeperId: number,
    description: { title: string; description: string; prohibitAllSharing?: boolean },
    caller: { from: "hook" },
  ): Promise<void>;
};

type SharingPolicyClient = {
  addCollaborator(
    username: string,
    role: "build" | "use",
    note?: string,
  ): Promise<CollaboratorInfo | null>;
  removeCollaborator(
    profileId: string,
    keepUsers: string[],
  ): Promise<AffectedCollaborator[]>;
  createShareLink(
    role: "build" | "use",
    note?: string,
  ): Promise<{ key: string; linkId: string }>;
  newShareLinkKey(linkId: string): Promise<{ key: string }>;
  revokeShareLink(
    linkId: string,
    keepUsers: string[],
  ): Promise<AffectedCollaborator[]>;
};

const RESOLVER: AiChatAuthorInfo = { type: "user", id: "owner", name: "Owner" };

function pendingAction(): ActionRecord & { type: "action" } {
  return {
    id: 1,
    gatekeeperId: 1,
    caller: { from: "agent", chatId: 1 },
    createdAt: new Date(),
    state: "pending",
    type: "action",
    action: 7,
    description: {
      title: "Apply change",
      description: "Apply a pending change.",
      implementsRevert: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

function overseer(hasAnyShares: boolean): SharingPolicyOverseer {
  const OverseerImpl = Reflect.get(overseerModule, "OverseerImpl");
  expect(OverseerImpl).toBeTypeOf("function");
  const target = Reflect.construct(OverseerImpl, [{
    id: { toString: () => "workspace-id" },
    storage: makeMockStorage(),
    exports: { UserDurableObject: {} },
  }, {}]) as SharingPolicyOverseer;
  target.getSharingManager = async () => ({ hasAnyShares: () => hasAnyShares });
  return target;
}

function ownerClient(target: SharingPolicyOverseer): SharingPolicyClient {
  const OverseerClientInterface = Reflect.get(overseerModule, "OverseerClientInterface");
  expect(OverseerClientInterface).toBeTypeOf("function");
  target.joinPresence = () => () => undefined;
  target.joinOutputsFanout = () => () => undefined;
  const notifyClosed = Object.assign(() => undefined, {
    dup() { return notifyClosed; },
    [Symbol.dispose]() {},
  });
  return Reflect.construct(OverseerClientInterface, [
    target,
    "owner",
    "owner-user-id",
    true,
    notifyClosed,
    Promise.resolve(),
  ]) as SharingPolicyClient;
}

function sensitiveObservation(target: SharingPolicyOverseer): Promise<void> {
  return target.authorizeObservation(1, {
    title: "Read account-wide GitHub data",
    description: "Read data that is private to the connected account.",
    prohibitAllSharing: true,
  }, { from: "hook" });
}

function affectedCollaborator(): AffectedCollaborator[] {
  return [{
    profile: { type: "user", id: "collaborator", name: "Collaborator" },
    oldRole: "build",
    newRole: null,
  }];
}

describe("Overseer prohibitAllSharing observation policy", () => {
  it("rejects the observation before lockdown when the workspace is already shared", async () => {
    const target = overseer(true);

    await expect(target.authorizeObservation(1, {
      title: "Read account-wide GitHub data",
      description: "Read data that is private to the connected account.",
      prohibitAllSharing: true,
    }, { from: "hook" })).rejects.toThrow("workspace is shared");
    expect(target.storage.prohibitAllSharing.get()).toBe(false);
  });

  it("locks down an unshared workspace before recording the observation", async () => {
    const target = overseer(false);

    await expect(target.authorizeObservation(1, {
      title: "Read account-wide GitHub data",
      description: "Read data that is private to the connected account.",
      prohibitAllSharing: true,
    }, { from: "hook" })).resolves.toBeUndefined();
    expect(target.storage.prohibitAllSharing.get()).toBe(true);
  });

  it.each([false, true])(
    "rejects %s-auto-approved action application after lockdown",
    async autoApproved => {
      const target = overseer(false);
      const applyAction = vi.fn(async () => undefined);
      target.getGatekeeperFacet = () => ({ applyAction });
      target.storage.prohibitAllSharing.put(true);

      await expect(target.applyPendingAction(pendingAction(), RESOLVER, autoApproved))
        .rejects.toThrow("prohibited from performing actions");
      expect(applyAction).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "preserves %s-auto-approved action application without lockdown",
    async autoApproved => {
      const target = overseer(false);
      const applyAction = vi.fn(async () => undefined);
      target.getGatekeeperFacet = () => ({ applyAction });

      const record = pendingAction();
      await expect(target.applyPendingAction(record, RESOLVER, autoApproved))
        .resolves.toBeUndefined();
      expect(applyAction).toHaveBeenCalledWith(7);
      expect(record).toMatchObject({ state: "approved", autoApproved, resolvedBy: RESOLVER });
    },
  );

  it("rejects a sensitive observation while an action application is in flight", async () => {
    const target = overseer(false);
    const applyGate = deferred<void>();
    target.getGatekeeperFacet = () => ({
      applyAction: async () => await applyGate.promise,
    });

    const applying = target.applyPendingAction(pendingAction(), RESOLVER, false);
    await expect(target.authorizeObservation(1, {
      title: "Read account-wide GitHub data",
      description: "Read data that is private to the connected account.",
      prohibitAllSharing: true,
    }, { from: "hook" })).rejects.toThrow("action is being applied");
    expect(target.storage.prohibitAllSharing.get()).toBe(false);

    applyGate.resolve();
    await applying;
  });

  it("releases a failed action application so a later sensitive observation can lock down", async () => {
    const target = overseer(false);
    target.getGatekeeperFacet = () => ({
      applyAction: async () => { throw new Error("apply failed"); },
    });

    await expect(target.applyPendingAction(pendingAction(), RESOLVER, false))
      .rejects.toThrow("apply failed");
    await expect(sensitiveObservation(target)).resolves.toBeUndefined();
    expect(target.storage.prohibitAllSharing.get()).toBe(true);
  });

  it("releases a failed lockdown lookup so a later sharing mutation can proceed", async () => {
    const target = overseer(false);
    target.getSharingManager = async () => { throw new Error("sharing lookup failed"); };

    await expect(sensitiveObservation(target)).rejects.toThrow("sharing lookup failed");

    const createShareLink = vi.fn(async () => ({ key: "secret", linkId: "link" }));
    target.getSharingManager = async () => ({ createShareLink, hasAnyShares: () => true });
    await expect(ownerClient(target).createShareLink("build"))
      .resolves.toEqual({ key: "secret", linkId: "link" });
    expect(createShareLink).toHaveBeenCalledOnce();
  });

  it("rejects action application during a deferred sharing-lockdown transition", async () => {
    const target = overseer(false);
    const sharingGate = deferred<boolean>();
    const applyAction = vi.fn(async () => undefined);
    target.getGatekeeperFacet = () => ({ applyAction });
    target.getSharingManager = async () => {
      const hasAnyShares = await sharingGate.promise;
      return { hasAnyShares: () => hasAnyShares };
    };

    const lockingDown = target.authorizeObservation(1, {
      title: "Read account-wide GitHub data",
      description: "Read data that is private to the connected account.",
      prohibitAllSharing: true,
    }, { from: "hook" });

    await expect(target.applyPendingAction(pendingAction(), RESOLVER, true))
      .rejects.toThrow("prohibited from performing actions");
    expect(applyAction).not.toHaveBeenCalled();

    sharingGate.resolve(false);
    await expect(lockingDown).resolves.toBeUndefined();
    expect(target.storage.prohibitAllSharing.get()).toBe(true);
  });
});

describe("Overseer sharing transition concurrency", () => {
  it("lets createShareLink finish when it starts before a sensitive observation", async () => {
    const target = overseer(false);
    const createGate = deferred<{ key: string; linkId: string }>();
    const createShareLink = vi.fn(() => createGate.promise);
    target.getSharingManager = async () => ({ createShareLink, hasAnyShares: () => true });

    const sharing = ownerClient(target).createShareLink("build");

    await expect(sensitiveObservation(target)).rejects.toThrow("sharing access is being granted");
    expect(target.storage.prohibitAllSharing.get()).toBe(false);

    createGate.resolve({ key: "secret", linkId: "link" });
    await expect(sharing).resolves.toEqual({ key: "secret", linkId: "link" });
    expect(createShareLink).toHaveBeenCalledOnce();
  });

  it("creates no share link when sensitive-observation lockdown starts first", async () => {
    const target = overseer(false);
    const lockdownGate = deferred<boolean>();
    const createShareLink = vi.fn(async () => ({ key: "secret", linkId: "link" }));
    target.getSharingManager = async () => {
      const hasShares = await lockdownGate.promise;
      return { createShareLink, hasAnyShares: () => hasShares };
    };

    const observing = sensitiveObservation(target);
    const sharing = ownerClient(target).createShareLink("build");
    const sharingRejected = expect(sharing).rejects.toThrow("workspace cannot be shared");
    expect(createShareLink).not.toHaveBeenCalled();

    lockdownGate.resolve(false);
    await expect(observing).resolves.toBeUndefined();
    await sharingRejected;
    expect(createShareLink).not.toHaveBeenCalled();
    expect(target.storage.prohibitAllSharing.get()).toBe(true);
  });

  it("mints no new share-link key when sensitive-observation lockdown starts first", async () => {
    const target = overseer(false);
    const lockdownGate = deferred<boolean>();
    const newShareLinkKey = vi.fn(async () => ({ key: "secret" }));
    target.getSharingManager = async () => {
      const hasShares = await lockdownGate.promise;
      return { newShareLinkKey, hasAnyShares: () => hasShares };
    };

    const observing = sensitiveObservation(target);
    const sharing = ownerClient(target).newShareLinkKey("link");
    const sharingRejected = expect(sharing).rejects.toThrow("workspace cannot be shared");

    lockdownGate.resolve(false);
    await expect(observing).resolves.toBeUndefined();
    await sharingRejected;
    expect(newShareLinkKey).not.toHaveBeenCalled();
  });

  it("registers share-key redemption before its first manager lookup", async () => {
    const target = overseer(false);
    const managerGate = deferred<any>();
    const redeemStarted = deferred<void>();
    const stopAfterRedeem = new Error("stop after redeem");
    Object.assign(target, {
      ownerId: "owner-user-id",
      ensureAmbientCapsules: async () => undefined,
      markOutputsDirty: () => undefined,
      users: {
        idFromString: (id: string) => id,
        get: () => ({ whoami: async () => (
          { type: "user", id: "collaborator", name: "Collaborator" } as AiChatAuthorInfo
        ) }),
      },
    });
    target.getSharingManager = async () => await managerGate.promise;
    const durable = {
      impl: target,
      ctx: { id: { toString: () => "workspace-id" } },
    };

    const opening = Reflect.apply(overseerModule.OverseerDurableObject.prototype.open, durable, [
      "collaborator-user-id",
      "collaborator",
      {},
      "share-key",
    ]) as Promise<unknown>;
    const openingRejected = expect(opening).rejects.toBe(stopAfterRedeem);
    await Promise.resolve();

    const observing = sensitiveObservation(target);
    managerGate.resolve({
      hasAnyShares: () => true,
      redeemShareKey: async () => {
        redeemStarted.resolve();
        throw stopAfterRedeem;
      },
    });

    await expect(observing).rejects.toThrow("sharing access is being granted");
    await redeemStarted.promise;
    await openingRejected;
    expect(target.storage.prohibitAllSharing.get()).toBe(false);
  });

  it("redeems no share key when sensitive-observation lockdown starts first", async () => {
    const target = overseer(false);
    const lockdownGate = deferred<boolean>();
    const redeemShareKey = vi.fn(async () => undefined);
    Object.assign(target, {
      ownerId: "owner-user-id",
      ensureAmbientCapsules: async () => undefined,
      markOutputsDirty: () => undefined,
      users: {
        idFromString: (id: string) => id,
        get: () => ({ whoami: async () => (
          { type: "user", id: "collaborator", name: "Collaborator" } as AiChatAuthorInfo
        ) }),
      },
    });
    target.getSharingManager = async () => {
      const hasShares = await lockdownGate.promise;
      return { redeemShareKey, hasAnyShares: () => hasShares };
    };
    const durable = {
      impl: target,
      ctx: { id: { toString: () => "workspace-id" } },
    };

    const observing = sensitiveObservation(target);
    const opening = Reflect.apply(overseerModule.OverseerDurableObject.prototype.open, durable, [
      "collaborator-user-id",
      "collaborator",
      {},
      "share-key",
    ]) as Promise<unknown>;
    const openingRejected = expect(opening).rejects.toThrow("workspace cannot be shared");

    lockdownGate.resolve(false);
    await expect(observing).resolves.toBeUndefined();
    await openingRejected;
    expect(redeemShareKey).not.toHaveBeenCalled();
  });

  it("clears a failed access-granting sharing mutation", async () => {
    const target = overseer(false);
    const started = deferred<void>();
    const createGate = deferred<{ key: string; linkId: string }>();
    target.getSharingManager = async () => ({
      createShareLink: () => {
        started.resolve();
        return createGate.promise;
      },
      hasAnyShares: () => false,
    });

    const sharing = ownerClient(target).createShareLink("build");
    const sharingRejected = expect(sharing).rejects.toThrow("creation failed");
    await started.promise;
    createGate.reject(new Error("creation failed"));
    await sharingRejected;

    await expect(sensitiveObservation(target)).resolves.toBeUndefined();
    expect(target.storage.prohibitAllSharing.get()).toBe(true);
  });

  it("lets addCollaborator finish when it starts before a sensitive observation", async () => {
    const target = overseer(false);
    const profileGate = deferred<AiChatAuthorInfo | null>();
    const addCollaborator = vi.fn(() => ({
      profile: { type: "user", id: "collaborator", name: "Collaborator" },
      role: "build" as const,
      addedBy: [],
    }));
    target.users = {
      idFromName: name => name,
      get: () => ({ whoamiIfExists: () => profileGate.promise }),
    };
    target.getSharingManager = async () => ({ addCollaborator, hasAnyShares: () => true });

    const sharing = ownerClient(target).addCollaborator("collaborator", "build");

    await expect(sensitiveObservation(target)).rejects.toThrow("sharing access is being granted");
    expect(target.storage.prohibitAllSharing.get()).toBe(false);

    profileGate.resolve({ type: "user", id: "collaborator", name: "Collaborator" });
    await expect(sharing).resolves.toMatchObject({ role: "build" });
    expect(addCollaborator).toHaveBeenCalledOnce();
  });

  it("adds no collaborator when sensitive-observation lockdown starts first", async () => {
    const target = overseer(false);
    const lockdownGate = deferred<boolean>();
    const whoamiIfExists = vi.fn(async () => (
      { type: "user", id: "collaborator", name: "Collaborator" } as AiChatAuthorInfo
    ));
    const addCollaborator = vi.fn();
    target.users = {
      idFromName: name => name,
      get: () => ({ whoamiIfExists }),
    };
    target.getSharingManager = async () => {
      const hasShares = await lockdownGate.promise;
      return { addCollaborator, hasAnyShares: () => hasShares };
    };

    const observing = sensitiveObservation(target);
    const sharing = ownerClient(target).addCollaborator("collaborator", "build");
    const sharingRejected = expect(sharing).rejects.toThrow("workspace cannot be shared");
    expect(addCollaborator).not.toHaveBeenCalled();

    lockdownGate.resolve(false);
    await expect(observing).resolves.toBeUndefined();
    await sharingRejected;
    expect(whoamiIfExists).not.toHaveBeenCalled();
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(target.storage.prohibitAllSharing.get()).toBe(true);
  });

  it.each([false, true])(
    "rejects %s-auto-approved action application while revocation is active",
    async autoApproved => {
      const target = overseer(false);
      const revocationGate = deferred<AffectedCollaborator[]>();
      const applyAction = vi.fn(async () => undefined);
      target.getGatekeeperFacet = () => ({ applyAction });

      const revoking = target.runSharingRevocation(
        async () => {
          const affected = await revocationGate.promise;
          return () => affected;
        },
        async () => undefined,
      );
      await expect(target.applyPendingAction(pendingAction(), RESOLVER, autoApproved))
        .rejects.toThrow("sharing access is being revoked");
      expect(applyAction).not.toHaveBeenCalled();

      revocationGate.resolve([]);
      await expect(revoking).resolves.toEqual([]);
    },
  );

  it.each([false, true])(
    "rejects sharing revocation while a %s-auto-approved action is active",
    async autoApproved => {
      const target = overseer(false);
      const applyGate = deferred<void>();
      const mutation = vi.fn(() => () => affectedCollaborator());
      target.getGatekeeperFacet = () => ({ applyAction: () => applyGate.promise });

      const applying = target.applyPendingAction(pendingAction(), RESOLVER, autoApproved);
      await expect(target.runSharingRevocation(mutation, async () => undefined))
        .rejects.toThrow("action is being applied");
      expect(mutation).not.toHaveBeenCalled();

      applyGate.resolve();
      await expect(applying).resolves.toBeUndefined();
    },
  );

  it("changes no graph reachability when revocation starts during lockdown", async () => {
    const target = overseer(false);
    const lockdownGate = deferred<boolean>();
    const removeCollaborator = vi.fn(() => affectedCollaborator());
    const revokeShareLink = vi.fn(() => affectedCollaborator());
    target.getSharingManager = async () => {
      const hasShares = await lockdownGate.promise;
      return { removeCollaborator, revokeShareLink, hasAnyShares: () => hasShares };
    };
    const client = ownerClient(target);

    const observing = sensitiveObservation(target);
    await expect(client.removeCollaborator("collaborator", []))
      .rejects.toThrow("workspace cannot be shared");
    await expect(client.revokeShareLink("link", []))
      .rejects.toThrow("workspace cannot be shared");
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(revokeShareLink).not.toHaveBeenCalled();

    lockdownGate.resolve(false);
    await expect(observing).resolves.toBeUndefined();
  });

  it("blocks sensitive observations after collaborator graph removal until restart", async () => {
    const target = overseer(false);
    const removed = deferred<void>();
    const cleanup = deferred<void>();
    const removeCollaborator = vi.fn(() => {
      removed.resolve();
      return affectedCollaborator();
    });
    target.getSharingManager = async () => ({ removeCollaborator, hasAnyShares: () => false });
    target.tearDownLostObservers = async () => await cleanup.promise;
    target.refreshAffectedCollaboratorListings = async () => undefined;
    target.scheduleRevocationRestart = vi.fn(async () => undefined);

    const revoking = ownerClient(target).removeCollaborator("collaborator", []);
    await removed.promise;

    await expect(sensitiveObservation(target)).rejects.toThrow("sharing access is being revoked");
    expect(target.storage.prohibitAllSharing.get()).toBe(false);

    cleanup.resolve();
    await expect(revoking).resolves.toEqual(affectedCollaborator());
    expect(target.scheduleRevocationRestart).toHaveBeenCalledOnce();
    await expect(sensitiveObservation(target)).rejects.toThrow("sharing access is being revoked");
  });

  it("blocks sensitive observations after share-link graph removal until restart", async () => {
    const target = overseer(false);
    const revoked = deferred<void>();
    const cleanup = deferred<void>();
    const revokeShareLink = vi.fn(() => {
      revoked.resolve();
      return affectedCollaborator();
    });
    target.getSharingManager = async () => ({ revokeShareLink, hasAnyShares: () => false });
    target.tearDownLostObservers = async () => await cleanup.promise;
    target.refreshAffectedCollaboratorListings = async () => undefined;
    target.scheduleRevocationRestart = vi.fn(async () => undefined);

    const revoking = ownerClient(target).revokeShareLink("link", []);
    await revoked.promise;

    await expect(sensitiveObservation(target)).rejects.toThrow("sharing access is being revoked");
    expect(target.storage.prohibitAllSharing.get()).toBe(false);

    cleanup.resolve();
    await expect(revoking).resolves.toEqual(affectedCollaborator());
    expect(target.scheduleRevocationRestart).toHaveBeenCalledOnce();
    await expect(sensitiveObservation(target)).rejects.toThrow("sharing access is being revoked");
  });

  it("remains fail-closed and schedules restart when revocation cleanup fails", async () => {
    const target = overseer(false);
    target.getSharingManager = async () => ({
      removeCollaborator: () => affectedCollaborator(),
      hasAnyShares: () => false,
    });
    target.tearDownLostObservers = async () => {
      throw new Error("cleanup failed");
    };
    target.refreshAffectedCollaboratorListings = vi.fn(async () => undefined);
    target.scheduleRevocationRestart = vi.fn(async () => undefined);

    await expect(ownerClient(target).removeCollaborator("collaborator", []))
      .rejects.toThrow("cleanup failed");
    expect(target.scheduleRevocationRestart).toHaveBeenCalledOnce();
    await expect(sensitiveObservation(target)).rejects.toThrow("sharing access is being revoked");
  });

  it("rolls back a partial graph mutation before releasing a failed revocation", async () => {
    const target = overseer(false);
    const cleanup = vi.fn(async () => undefined);

    await expect(target.runSharingRevocation(
      () => () => {
        target.ctx.storage.kv.put("sharing/partial-revocation", true);
        throw new Error("revocation failed after write");
      },
      cleanup,
    )).rejects.toThrow("revocation failed after write");
    expect(target.ctx.storage.kv.get("sharing/partial-revocation")).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    await expect(sensitiveObservation(target)).resolves.toBeUndefined();
    expect(target.storage.prohibitAllSharing.get()).toBe(true);
  });

  it("ends a no-effect revocation transition without scheduling restart", async () => {
    const target = overseer(false);
    target.getSharingManager = async () => ({
      removeCollaborator: () => [],
      hasAnyShares: () => false,
    });
    target.tearDownLostObservers = vi.fn(async () => undefined);
    target.refreshAffectedCollaboratorListings = vi.fn(async () => undefined);
    target.scheduleRevocationRestart = vi.fn(async () => undefined);

    await expect(ownerClient(target).removeCollaborator("collaborator", [])).resolves.toEqual([]);
    expect(target.scheduleRevocationRestart).not.toHaveBeenCalled();
    await expect(sensitiveObservation(target)).resolves.toBeUndefined();
    expect(target.storage.prohibitAllSharing.get()).toBe(true);
  });
});

describe("Overseer revocation restart lifecycle", () => {
  it("waits for durable storage and registers a delayed abort before resolving", async () => {
    const target = overseer(false);
    const sync = vi.fn(async () => undefined);
    const abort = vi.fn();
    const background: Promise<unknown>[] = [];
    target.ctx.storage.sync = sync;
    target.ctx.abort = abort;
    target.ctx.waitUntil = vi.fn(promise => { background.push(promise); });

    await expect(target.scheduleRevocationRestart()).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledOnce();
    expect(target.ctx.waitUntil).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();

    await Promise.allSettled(background);
    expect(abort).toHaveBeenCalledWith(
      "Gadget restarted to revoke access for a removed collaborator.",
    );
  });

  it("rejects on durability failure and still registers a fail-closed abort", async () => {
    const target = overseer(false);
    const syncError = new Error("sync failed");
    const abort = vi.fn();
    const background: Promise<unknown>[] = [];
    target.ctx.storage.sync = vi.fn(async () => { throw syncError; });
    target.ctx.abort = abort;
    target.ctx.waitUntil = vi.fn(promise => { background.push(promise); });

    await expect(target.scheduleRevocationRestart()).rejects.toBe(syncError);
    expect(target.ctx.waitUntil).toHaveBeenCalledOnce();
    await Promise.allSettled(background);
    expect(abort).toHaveBeenCalledWith(
      "Gadget restarted to revoke access for a removed collaborator.",
    );
  });
});
