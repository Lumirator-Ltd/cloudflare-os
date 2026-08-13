import { env, runInDurableObject } from "cloudflare:test";
import { exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcStub as CapnWebRpcStub, RpcTarget } from "capnweb";
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  PresenceParticipant,
  PresenceSubscriber,
  PublicApi,
} from "@gadgets/workshop-shared/api";
import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { ChatGatewayRpcTarget } from "@gadgets/workshop-shared/external-message-gateway";
import { describe, expect, it, vi } from "vitest";
import type { UserDurableObject } from "../src/user.js";

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

async function connect(): Promise<CapnWebRpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Expected WebSocket RPC response, got ${response.status}.`);
  }
  response.webSocket.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket);
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
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = tokenBytes.toBase64();
  const tokenId = new Uint8Array(await crypto.subtle.digest("SHA-256", tokenBytes)).toHex();
  await runInDurableObject(user, (instance: UserDurableObject) => {
    const mutable = instance as unknown as {
      storage: { sessions: { put(value: { tokenId: string; created: Date }): void } };
    };
    mutable.storage.sessions.put({ tokenId, created: new Date() });
  });
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
  it("uses the internal ID for profiles, avatars, chat authors, and analytics", async () => {
    const sentAnalytics: Array<Record<string, unknown>> = [];
    (env as Cloudflare.Env).PRODUCT_ANALYTICS = {
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

    const added = await ownerWorkspace.addCollaborator(collaborator.email, "build");
    expect(added?.profile.id).toBe(collaborator.internalUserId);
    expect(added?.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: owner.internalUserId }),
    ]);

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

  it("uses stable IDs for presence and collaborator output indexes", async () => {
    const owner = await registryUser("presence-owner");
    const collaborator = await registryUser("presence-collaborator");
    const workspaceId = exports.OverseerDurableObject.newUniqueId();
    await owner.user.newGadget(workspaceId.toString(), "Stable identity workspace");
    const workspaceDo = exports.OverseerDurableObject.get(workspaceId);
    using ownerWorkspace = await workspaceDo.open(
      owner.identity.internalUserId,
      owner.identity.internalUserId,
      new NativeRpcStub<() => void>(() => {}),
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

    using _collaboratorWorkspace = await workspaceDo.open(
      collaborator.identity.internalUserId,
      collaborator.identity.internalUserId,
      new NativeRpcStub<() => void>(() => {}),
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
      using workspace = await workspaceDo.open(
        owner.identity.internalUserId,
        owner.identity.internalUserId,
        new NativeRpcStub<() => void>(() => {}),
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
