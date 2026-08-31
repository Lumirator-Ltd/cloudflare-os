import { describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";
import * as overseerModule from "../src/overseer.js";
import type { ActionRecord } from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner", name: "Owner" };
const COLLABORATOR: AiChatAuthorInfo = {
  type: "user",
  id: "collaborator",
  name: "Collaborator",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

function ownerOnlyClassResult() {
  return {
    class: {},
    vendorId: "example",
    typeUrlPattern: "https://example.com/*",
    workspaceAccess: "owner-only" as const,
  };
}

function pendingAction(id: number, gatekeeperId = 1): ActionRecord & { type: "action" } {
  return {
    id,
    gatekeeperId,
    caller: { from: "agent", chatId: 1 },
    createdAt: new Date(),
    state: "pending",
    type: "action",
    action: id,
    description: {
      title: `Action ${id}`,
      description: "Change the remote resource.",
      implementsRevert: false,
      actionKind: { tag: "edit", label: "Edits" },
      autoApprovable: true,
    },
  };
}

function makeOverseer(options: {
  hasAnyShares?: boolean;
  facetError?: Error;
  describe?: () => Promise<{
    title: string;
    url: string;
    snippet: string;
    suggestedBindingName: string;
    tsType: string;
  }>;
} = {}) {
  const OverseerImpl = Reflect.get(overseerModule, "OverseerImpl");
  expect(OverseerImpl).toBeTypeOf("function");

  const background: Promise<unknown>[] = [];
  const target = Reflect.construct(OverseerImpl, [{
    id: { toString: () => "workspace-id" },
    storage: makeMockStorage(),
    exports: { UserDurableObject: {} },
    facets: { delete: vi.fn() },
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
      void promise.catch(() => undefined);
    },
    abort: vi.fn(),
  }, { WORKERS_AI: { name: "ai" } }]) as any;

  const describeResource = options.describe ?? (async () => ({
    title: "Private account",
    url: "https://example.com/account",
    snippet: "Private account data",
    suggestedBindingName: "PRIVATE_ACCOUNT",
    tsType: "PrivateAccount",
  }));
  const facet = {
    describe: vi.fn(describeResource),
    applyAction: vi.fn(async () => undefined),
    rejectAction: vi.fn(async () => undefined),
    getAutoApprovableActions: vi.fn(async () => [{ tag: "edit", label: "Edits" }]),
  };
  const sharing = {
    hasAnyShares: () => options.hasAnyShares ?? false,
    createShareLink: vi.fn(async () => ({ key: "secret", linkId: "link" })),
    newShareLinkKey: vi.fn(async () => ({ key: "secret-2" })),
    addCollaborator: vi.fn(() => ({
      profile: COLLABORATOR,
      role: "build" as const,
      addedBy: [],
    })),
    redeemShareKey: vi.fn(async () => undefined),
    getEffectiveRole: vi.fn(() => "build" as const),
  };
  const users = {
    idFromString: (id: string) => id,
    idFromName: (name: string) => name,
    get: (id: string) => ({
      id: { toString: () => id },
      getGatekeeperClassFor: vi.fn(async () => ownerOnlyClassResult()),
      whoami: vi.fn(async () => id === "owner-user-id" ? OWNER : COLLABORATOR),
      whoamiIfExists: vi.fn(async () => COLLABORATOR),
    }),
  };

  target.ownerId = "owner-user-id";
  target.ownerProfileId = OWNER.id;
  target.users = users;
  target.getSharingManager = vi.fn(async () => sharing);
  target.getGatekeeperFacet = vi.fn(() => {
    if (options.facetError) throw options.facetError;
    return facet;
  });
  target.joinPresence = () => () => undefined;
  target.joinOutputsFanout = () => () => undefined;
  target.recordGadgetAnalytics = vi.fn();
  target.ensureAmbientCapsules = vi.fn(async () => undefined);
  target.markOutputsDirty = vi.fn();

  return { target, facet, sharing, users, background };
}

function client(target: any, isOwner: boolean) {
  const OverseerClientInterface = Reflect.get(overseerModule, "OverseerClientInterface");
  expect(OverseerClientInterface).toBeTypeOf("function");
  const notifyClosed = Object.assign(() => undefined, {
    dup() { return notifyClosed; },
    [Symbol.dispose]() {},
  });
  return Reflect.construct(OverseerClientInterface, [
    target,
    isOwner ? OWNER.id : COLLABORATOR.id,
    isOwner ? "owner-user-id" : "collaborator-user-id",
    isOwner,
    notifyClosed,
    Promise.resolve(),
  ]) as any;
}

function putOwnerOnlyGatekeeper(target: any, id = 1) {
  target.storage.gatekeepers.put({
    id,
    class: {},
    ownerOnly: true,
    creationSpec: {
      type: "gatekeeper",
      vendorId: "example",
      resourceUrl: "https://example.com/account",
      typeUrlPattern: "https://example.com/*",
    },
  });
}

describe("owner-only gatekeeper policy propagation", () => {
  it("propagates workspace access from the connected account's resolved resource", async () => {
    const account = {
      async getGatekeeperClassFor() {
        return {
          class: {},
          resource: {
            urlPattern: "https://example.com/*",
            title: "Private account",
            description: "Private account data",
            workspaceAccess: "owner-only" as const,
          },
        };
      },
    };
    const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      env: { BLUEPRINTS: { get: async () => null } },
      storage: {
        connectedAccounts: {
          get: (id: number) => id === 7
            ? { id, account, vendorId: "example", description: {} }
            : undefined,
        },
      },
    });

    await expect(user.getGatekeeperClassFor(7, "https://example.com/account"))
      .resolves.toMatchObject({ workspaceAccess: "owner-only" });
  });
});

describe("owner-only gatekeeper creation and sharing", () => {
  it("stores the internal policy separately from blueprint creation metadata", async () => {
    const { target } = makeOverseer();

    const gatekeeper = await client(target, true)
      .newGatekeeper(7, "https://example.com/account");
    const id = await gatekeeper.getId();
    const record = target.storage.gatekeepers.get(id);

    expect(record).toMatchObject({ ownerOnly: true });
    expect(record.creationSpec).toEqual({
      type: "gatekeeper",
      vendorId: "example",
      resourceUrl: "https://example.com/account",
      typeUrlPattern: "https://example.com/*",
    });
  });

  it("rejects a collaborator creator even if they still hold a build client", async () => {
    const { target, facet } = makeOverseer();

    await expect(client(target, false).newGatekeeper(7, "https://example.com/account"))
      .rejects.toThrow("Only the workspace owner");
    expect(facet.describe).not.toHaveBeenCalled();
    expect([...target.storage.gatekeepers.list()]).toEqual([]);
  });

  it("rejects creation when the workspace already has active shares", async () => {
    const { target, facet } = makeOverseer({ hasAnyShares: true });

    await expect(client(target, true).newGatekeeper(7, "https://example.com/account"))
      .rejects.toThrow("private workspace");
    expect(facet.describe).not.toHaveBeenCalled();
    expect([...target.storage.gatekeepers.list()]).toEqual([]);
  });

  it("rejects creation while a sharing grant transition is active", async () => {
    const { target } = makeOverseer();
    const sharingGate = deferred<void>();
    const sharingMutation = target.runAccessGrantingSharingMutation(
      async () => await sharingGate.promise,
    );

    await expect(client(target, true).newGatekeeper(7, "https://example.com/account"))
      .rejects.toThrow("sharing access is being granted");

    sharingGate.resolve();
    await sharingMutation;
  });

  it("keeps the workspace private after an owner-only connection is removed", async () => {
    const describeStarted = deferred<void>();
    const describeGate = deferred<{
      title: string;
      url: string;
      snippet: string;
      suggestedBindingName: string;
      tsType: string;
    }>();
    const { target, sharing } = makeOverseer({
      describe: async () => {
        describeStarted.resolve();
        return await describeGate.promise;
      },
    });
    const owner = client(target, true);
    const creating = owner.newGatekeeper(7, "https://example.com/account");
    await describeStarted.promise;

    await expect(owner.addCollaborator("collaborator", "build"))
      .rejects.toThrow("private workspace");
    await expect(owner.createShareLink("build")).rejects.toThrow("private workspace");
    await expect(owner.newShareLinkKey("link")).rejects.toThrow("private workspace");
    expect(sharing.addCollaborator).not.toHaveBeenCalled();
    expect(sharing.createShareLink).not.toHaveBeenCalled();
    expect(sharing.newShareLinkKey).not.toHaveBeenCalled();

    describeGate.resolve({
      title: "Private account",
      url: "https://example.com/account",
      snippet: "Private account data",
      suggestedBindingName: "PRIVATE_ACCOUNT",
      tsType: "PrivateAccount",
    });
    const gatekeeper = await creating;

    await expect(owner.getMetadata()).resolves.toMatchObject({ sharingProhibited: true });
    await expect(owner.createShareLink("build")).rejects.toThrow("private workspace");
    await gatekeeper.remove();
    await expect(owner.createShareLink("build")).rejects.toThrow("private workspace");
    expect(sharing.createShareLink).not.toHaveBeenCalled();
    expect(target.storage.ownerOnlyWorkspace.get()).toBe(true);
  });

  it("unwinds a failed describe so later sharing is allowed", async () => {
    const { target } = makeOverseer({
      describe: async () => { throw new Error("describe failed"); },
    });
    const owner = client(target, true);

    await expect(owner.newGatekeeper(7, "https://example.com/account"))
      .rejects.toThrow("describe failed");
    expect([...target.storage.gatekeepers.list()]).toEqual([]);
    await expect(owner.createShareLink("build"))
      .resolves.toEqual({ key: "secret", linkId: "link" });
  });

  it("unwinds a failed facet add so later sharing is allowed", async () => {
    const { target } = makeOverseer({ facetError: new Error("facet add failed") });
    const owner = client(target, true);

    await expect(owner.newGatekeeper(7, "https://example.com/account"))
      .rejects.toThrow("facet add failed");
    expect([...target.storage.gatekeepers.list()]).toEqual([]);
    await expect(owner.createShareLink("build"))
      .resolves.toEqual({ key: "secret", linkId: "link" });
  });

  it("rejects share-key redemption and every non-owner open", async () => {
    const { target, sharing } = makeOverseer();
    putOwnerOnlyGatekeeper(target);
    const durable = {
      impl: target,
      ctx: { id: { toString: () => "workspace-id" } },
    };

    await expect(Reflect.apply(
      overseerModule.OverseerDurableObject.prototype.open,
      durable,
      ["collaborator-user-id", COLLABORATOR.id, {}, "share-key"],
    )).rejects.toThrow("access");
    expect(sharing.redeemShareKey).not.toHaveBeenCalled();
  });

  it("does not apply owner-only policy to web fetch for the owner", () => {
    const { target } = makeOverseer();
    putOwnerOnlyGatekeeper(target);

    expect(target.getWebFetchEnv()).toMatchObject({ ai: { name: "ai" } });
  });
});

describe("owner-only action resolution", () => {
  it("rejects stale collaborator approval and rejection clients", async () => {
    const { target, facet } = makeOverseer();
    putOwnerOnlyGatekeeper(target);
    target.storage.actions.put(pendingAction(1));
    target.storage.actions.put(pendingAction(2));
    const collaborator = client(target, false);

    await expect(collaborator.approveAction(1)).rejects.toThrow("Only the workspace owner");
    await expect(collaborator.rejectAction(2)).rejects.toThrow("Only the workspace owner");
    expect(facet.applyAction).not.toHaveBeenCalled();
    expect(facet.rejectAction).not.toHaveBeenCalled();
  });

  it("allows the owner to approve and reject manually", async () => {
    const { target, facet } = makeOverseer();
    putOwnerOnlyGatekeeper(target);
    target.storage.actions.put(pendingAction(1));
    target.storage.actions.put(pendingAction(2));
    const owner = client(target, true);

    await expect(owner.approveAction(1)).resolves.toBeUndefined();
    await expect(owner.rejectAction(2)).resolves.toBeUndefined();
    expect(facet.applyAction).toHaveBeenCalledWith(1);
    expect(facet.rejectAction).toHaveBeenCalledWith(2);
    expect(target.storage.actions.get(1)).toMatchObject({
      state: "approved",
      autoApproved: false,
      resolvedBy: OWNER,
    });
    expect(target.storage.actions.get(2)).toMatchObject({
      state: "rejected",
      resolvedBy: OWNER,
    });
  });

  it("rejects auto-approval application and drains for owner-only gatekeepers", async () => {
    const { target, facet } = makeOverseer();
    putOwnerOnlyGatekeeper(target);
    const action = pendingAction(1);

    await expect(target.applyPendingAction(action, OWNER, true))
      .rejects.toThrow("owner-only");
    await expect(target.drainAutoApprovals(1)).rejects.toThrow("owner-only");
    expect(facet.applyAction).not.toHaveBeenCalled();
  });

  it("rejects auto-approval rules and omits owner-only gatekeepers from the catalog", async () => {
    const { target, facet } = makeOverseer();
    putOwnerOnlyGatekeeper(target);
    target.storage.gadgets.put({
      id: 2,
      title: "App",
      created: new Date(),
      bindingName: "APP",
      bindings: { PRIVATE: { target: 1 } },
    });
    const owner = client(target, true);

    await expect(owner.setAutoApprovedActionKind(1, { tag: "edit", label: "Edits" }))
      .rejects.toThrow("owner-only");
    await expect(owner.listPreApprovableActions()).resolves.toEqual([]);
    expect(facet.getAutoApprovableActions).not.toHaveBeenCalled();
  });

  it("does not apply a stale auto-approval rule to a new owner-only action", async () => {
    const { target, background } = makeOverseer();
    putOwnerOnlyGatekeeper(target);
    target.storage.autoApproveTags.put({
      gatekeeperId: 1,
      actionKind: { tag: "edit", label: "Edits" },
      enabledBy: OWNER,
    });

    await target.submitAction(1, 7, pendingAction(1).description, {
      from: "agent",
      chatId: 1,
    });

    expect(target.storage.actions.get(0)).toMatchObject({ state: "pending" });
    expect(background).toEqual([]);
  });
});
