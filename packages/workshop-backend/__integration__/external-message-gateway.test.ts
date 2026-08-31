import { runInDurableObject } from "cloudflare:test";
import { exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import type {
  ChatGatewayRpcTarget,
  ExternalMessageGateway as ExternalMessageGatewayContract,
} from "@gadgets/workshop-shared/external-message-gateway";
import { describe, expect, it } from "vitest";

const SOURCE = "telegram";

class TestChatGatewayTarget extends RpcTarget implements ChatGatewayRpcTarget {
  async onGadgetResponse(): Promise<void> {}
}

async function gateway(identityMode: "trustedEmail" | "linkedExternalSubject") {
  return await exports.ExternalMessageGateway({
    props: { source: SOURCE, identityMode } as never,
  }) as unknown as ExternalMessageGatewayContract;
}

function baseInput() {
  return {
    gadgetKey: crypto.randomUUID(),
    chatKey: crypto.randomUUID(),
    messageKey: crypto.randomUUID(),
    gadgetTitle: "Telegram workspace",
    prompt: "hello",
  };
}

async function linkedAccount(externalSubject: string) {
  const registry = exports.IdentityRegistry.getByName("");
  const email = `${crypto.randomUUID()}@example.com`;
  const identity = await registry.resolveEmailIdentity(email, true);
  const link = await registry.startExternalLink(
    identity.internalUserId,
    identity.identityVersion,
    SOURCE,
  );
  await registry.completeExternalLink(SOURCE, link.token, externalSubject);
  const user = exports.UserDurableObject.getByName(identity.internalUserId);
  return { email, identity, user };
}

async function addTestModel(
  user: DurableObjectStub<import("../src/user.js").UserDurableObject>,
) {
  await user.addModel(
    { type: "agent", id: `model-${crypto.randomUUID()}`, name: "Test model" },
    {
      provider: "openai",
      model: "gpt-test",
      apiToken: "test-token",
      apiUrl: "https://model.invalid/v1",
    },
  );
}

describe("ExternalMessageGateway identity routing", () => {
  it("routes a linked external subject as its stable internal user", async () => {
    const externalSubject = `telegram-${crypto.randomUUID()}`;
    const account = await linkedAccount(externalSubject);
    await addTestModel(account.user);
    const input = baseInput();
    const workspace = exports.OverseerDurableObject.getByName(`${SOURCE}:${input.gadgetKey}`);
    await runInDurableObject(workspace, (instance) => {
      const mutable = instance as unknown as { impl: { newChat(): Promise<number> } };
      mutable.impl.newChat = async () => 7;
    });
    const linkedGateway = await gateway("linkedExternalSubject");
    using responseTarget = new NativeRpcStub<ChatGatewayRpcTarget>(new TestChatGatewayTarget());

    const result = await linkedGateway.submitExternalMessage({
      ...input,
      identityMode: "linkedExternalSubject",
      externalSubject,
      chatGatewayRpcTarget: responseTarget,
    } as never);

    expect(result).toEqual({
      accepted: true,
      chatPath: `/workspace/${workspace.id.toString()}?chat=7`,
    });
    await runInDurableObject(workspace, (instance) => {
      const inspected = instance as unknown as { impl: { ownerId?: string } };
      expect(inspected.impl.ownerId).toBe(account.identity.internalUserId);
    });
  });

  it("keeps trusted email as an explicit compatibility mode", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const identity = await exports.IdentityRegistry.getByName("")
      .resolveEmailIdentity(email, true);
    const input = baseInput();
    const workspace = exports.OverseerDurableObject.getByName(`${SOURCE}:${input.gadgetKey}`);
    using responseTarget = new NativeRpcStub<ChatGatewayRpcTarget>(new TestChatGatewayTarget());

    const result = await (await gateway("trustedEmail")).submitExternalMessage({
      ...input,
      identityMode: "trustedEmail",
      callerEmail: email,
      chatGatewayRpcTarget: responseTarget,
    } as never);

    expect(result).toMatchObject({ accepted: false });
    if (!result.accepted) expect(result.message).toContain("AI model");
    await runInDurableObject(workspace, (instance) => {
      const inspected = instance as unknown as { impl: { ownerId?: string } };
      expect(inspected.impl.ownerId).toBe(identity.internalUserId);
    });
  });

  it("revalidates a linked internal identity before authorizing the workspace", async () => {
    const registry = exports.IdentityRegistry.getByName("");
    const subject = `clerk-${crypto.randomUUID()}`;
    const identity = await registry.resolveClerkIdentity(
      subject,
      `${crypto.randomUUID()}@example.com`,
      true,
    );
    const link = await registry.startExternalLink(
      identity.internalUserId,
      identity.identityVersion,
      SOURCE,
    );
    await registry.completeExternalLink(SOURCE, link.token, `telegram-${crypto.randomUUID()}`);
    const claimedEmail = `${crypto.randomUUID()}@example.com`;
    await registry.resolveEmailIdentity(claimedEmail, true);
    await runInDurableObject(registry, async (instance) => {
      await expect(instance.resolveClerkIdentity(subject, claimedEmail, true)).rejects.toThrow();
    });

    const workspace = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.newUniqueId(),
    );
    using responseTarget = new NativeRpcStub<ChatGatewayRpcTarget>(new TestChatGatewayTarget());
    const result = await workspace.receiveExternalMessage({
      identityMode: "internalUserId",
      internalUserId: identity.internalUserId,
      externalChatKey: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      prompt: "hello",
      chatGatewayRpcTarget: responseTarget,
      title: "Locked identity workspace",
    });

    expect(result).toMatchObject({ accepted: false });
    await runInDurableObject(workspace, (instance) => {
      const inspected = instance as unknown as { impl: { ownerId?: string } };
      expect(inspected.impl.ownerId).toBeUndefined();
    });
  });

  it("rejects an unlinked subject without discovering an account", async () => {
    const externalSubject = `unlinked-${crypto.randomUUID()}`;
    using responseTarget = new NativeRpcStub<ChatGatewayRpcTarget>(new TestChatGatewayTarget());

    const result = await (await gateway("linkedExternalSubject")).submitExternalMessage({
      ...baseInput(),
      identityMode: "linkedExternalSubject",
      externalSubject,
      chatGatewayRpcTarget: responseTarget,
    } as never);

    expect(result).toMatchObject({ accepted: false });
    await expect(exports.UserDurableObject.getByName(externalSubject).whoamiIfExists())
      .resolves.toBeNull();
  });

  it.each([
    {
      bindingMode: "linkedExternalSubject" as const,
      identity: { identityMode: "trustedEmail", callerEmail: "caller@example.com" },
    },
    {
      bindingMode: "linkedExternalSubject" as const,
      identity: {
        identityMode: "linkedExternalSubject",
        externalSubject: "telegram-user",
        callerEmail: "caller@example.com",
      },
    },
    {
      bindingMode: "trustedEmail" as const,
      identity: { identityMode: "linkedExternalSubject", externalSubject: "telegram-user" },
    },
  ])("rejects $bindingMode binding mode mixed with $identity.identityMode input", async ({
    bindingMode,
    identity,
  }) => {
    const input = baseInput();
    using responseTarget = new NativeRpcStub<ChatGatewayRpcTarget>(new TestChatGatewayTarget());

    const externalGateway = await gateway(bindingMode);
    await expect(externalGateway.submitExternalMessage({
      ...input,
      ...identity,
      chatGatewayRpcTarget: responseTarget,
    } as never)).resolves.toMatchObject({ accepted: false });

    const workspace = exports.OverseerDurableObject.getByName(`${SOURCE}:${input.gadgetKey}`);
    await runInDurableObject(workspace, (instance) => {
      const inspected = instance as unknown as { impl: { ownerId?: string } };
      expect(inspected.impl.ownerId).toBeUndefined();
    });
  });
});

describe("external response delivery", () => {
  it("includes the backend-computed chat path in the callback", async () => {
    const workspace = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.newUniqueId(),
    );

    const delivered = await runInDurableObject(workspace, async (instance) => {
      let response: { text: string; chatPath?: string } | undefined;
      class CapturingTarget extends RpcTarget implements ChatGatewayRpcTarget {
        async onGadgetResponse(value: { text: string; chatPath?: string }): Promise<void> {
          response = value;
        }
      }
      const target = new NativeRpcStub<ChatGatewayRpcTarget>(new CapturingTarget());
      const record = {
        idempotencyKey: crypto.randomUUID(),
        chatId: 23,
        promptSequence: 1,
        createdAt: Date.now(),
        status: "ready" as const,
        chatGatewayRpcTarget: target,
        responseText: "done",
      };
      const internal = instance as unknown as {
        impl: {
          storage: {
            gadgetResponseDeliveries: {
              readyByIdempotencyKey: { list(): Iterable<typeof record> };
              put(value: unknown): void;
            };
          };
          deliverReadyExternalMessageResponses(): Promise<void>;
        };
      };
      let ready = [record];
      internal.impl.storage.gadgetResponseDeliveries.readyByIdempotencyKey.list = () => ready;
      internal.impl.storage.gadgetResponseDeliveries.put = () => {
        ready = [];
      };
      await internal.impl.deliverReadyExternalMessageResponses();
      return response;
    });

    expect(delivered).toEqual({
      text: "done",
      chatPath: `/workspace/${workspace.id.toString()}?chat=23`,
    });
  });
});

describe("external message attachments", () => {
  it("passes a staged photo and caller prompt into normal external chat submission", async () => {
    const account = await linkedAccount(`telegram-photo-route-${crypto.randomUUID()}`);
    await addTestModel(account.user);
    const workspace = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.newUniqueId(),
    );

    const routed = await runInDurableObject(workspace, async (instance) => {
      let submittedPrompt: string | undefined;
      let submittedAttachments: Array<{ id: string }> | undefined;
      const internal = instance as unknown as {
        impl: {
          newChat(...args: unknown[]): Promise<number>;
          storage: {
            chatAttachmentContent: { list(): Iterable<unknown> };
          };
        };
        receiveExternalMessage(input: unknown): Promise<{ accepted: boolean; chatPath?: string }>;
      };
      internal.impl.newChat = async (...args: unknown[]) => {
        submittedPrompt = args[2] as string;
        submittedAttachments = args[4] as Array<{ id: string }> | undefined;
        return 7;
      };
      using responseTarget = new NativeRpcStub<ChatGatewayRpcTarget>(
        new TestChatGatewayTarget(),
      );
      const result = await internal.receiveExternalMessage({
        identityMode: "internalUserId",
        internalUserId: account.identity.internalUserId,
        externalChatKey: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        prompt: "Describe this photo",
        attachments: [{
          mimeType: "image/png",
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          name: "photo.png",
        }],
        chatGatewayRpcTarget: responseTarget,
        title: "Photo workspace",
      });
      return {
        result,
        submittedPrompt,
        submittedAttachments,
        stagedCount: [...internal.impl.storage.chatAttachmentContent.list()].length,
      };
    });

    expect(routed.result).toMatchObject({ accepted: true });
    expect(routed.submittedPrompt).toBe("Describe this photo");
    expect(routed.submittedAttachments).toHaveLength(1);
    expect(routed.stagedCount).toBe(0);
  });

  it.each([
    {
      label: "an invalid image signature",
      attachment: {
        mimeType: "image/png",
        content: new Uint8Array([0xff, 0xd8, 0xff]),
        name: "photo.png",
      },
      message: "does not match",
    },
    {
      label: "an oversized image",
      attachment: (() => {
        const content = new Uint8Array(1024 * 1024 + 1);
        content.set([0x89, 0x50, 0x4e, 0x47]);
        return { mimeType: "image/png", content, name: "photo.png" };
      })(),
      message: "too large",
    },
  ])("rejects $label before normal chat submission", async ({ attachment, message }) => {
    const account = await linkedAccount(`telegram-invalid-photo-${crypto.randomUUID()}`);
    await addTestModel(account.user);
    const workspace = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.newUniqueId(),
    );

    await expect(runInDurableObject(workspace, async (instance) => {
      const internal = instance as unknown as {
        impl: { newChat(...args: unknown[]): Promise<number> };
        receiveExternalMessage(input: unknown): Promise<unknown>;
      };
      internal.impl.newChat = async () => {
        throw new Error("normal chat submission must not run");
      };
      using responseTarget = new NativeRpcStub<ChatGatewayRpcTarget>(
        new TestChatGatewayTarget(),
      );
      return await internal.receiveExternalMessage({
        identityMode: "internalUserId",
        internalUserId: account.identity.internalUserId,
        externalChatKey: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        prompt: "Describe this photo",
        attachments: [attachment],
        chatGatewayRpcTarget: responseTarget,
        title: "Invalid photo workspace",
      });
    })).rejects.toThrow(message);
  });

  it("keeps a duplicate external message to one turn and removes its staged retry", async () => {
    const account = await linkedAccount(`telegram-duplicate-${crypto.randomUUID()}`);
    const workspace = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.newUniqueId(),
    );
    using initialTarget = new NativeRpcStub<ChatGatewayRpcTarget>(new TestChatGatewayTarget());
    await workspace.receiveExternalMessage({
      identityMode: "internalUserId",
      internalUserId: account.identity.internalUserId,
      externalChatKey: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      prompt: "initialize",
      chatGatewayRpcTarget: initialTarget,
      title: "Duplicate workspace",
    });
    await addTestModel(account.user);
    const context = await account.user.getExternalMessageChatContext(null);
    const externalChatKey = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();

    const counts = await runInDurableObject(workspace, async (instance) => {
      const internal = instance as unknown as {
        impl: {
          startAgent(): void;
          newChat(
            user: typeof account.user,
            userContext: typeof context,
            prompt: string,
          ): Promise<number>;
          storage: {
            externalChats: { put(value: { externalChatKey: string; chatId: number }): void };
            gadgetResponseDeliveries: { put(value: unknown): void };
            chats: { list(): Iterable<unknown> };
            chatAttachmentContent: { list(): Iterable<unknown> };
          };
        };
        receiveExternalMessage(input: unknown): Promise<unknown>;
      };
      internal.impl.startAgent = () => {};
      const chatId = await internal.impl.newChat(account.user, context, "original");
      internal.impl.storage.externalChats.put({ externalChatKey, chatId });
      internal.impl.storage.gadgetResponseDeliveries.put({
        idempotencyKey,
        chatId,
        promptSequence: 1,
        createdAt: Date.now(),
        status: "delivered",
        deliveredAt: Date.now(),
      });
      using responseTarget = new NativeRpcStub<ChatGatewayRpcTarget>(
        new TestChatGatewayTarget(),
      );
      await internal.receiveExternalMessage({
        identityMode: "internalUserId",
        internalUserId: account.identity.internalUserId,
        externalChatKey,
        idempotencyKey,
        prompt: "duplicate",
        attachments: [{
          mimeType: "image/png",
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        }],
        chatGatewayRpcTarget: responseTarget,
        title: "Duplicate workspace",
      });
      const messages = [...internal.impl.storage.chats.list()] as Array<{
        type: string;
        author: { type: string };
      }>;
      return {
        userMessages: messages.filter(message =>
          message.type === "message" && message.author.type === "user").length,
        stagedAttachments: [...internal.impl.storage.chatAttachmentContent.list()].length,
      };
    });

    expect(counts).toEqual({ userMessages: 1, stagedAttachments: 0 });
  });

  it("stages and commits an image through the normal chat path", async () => {
    const externalSubject = `telegram-photo-${crypto.randomUUID()}`;
    const account = await linkedAccount(externalSubject);
    await addTestModel(account.user);
    const workspace = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.newUniqueId(),
    );
    const context = await account.user.getExternalMessageChatContext(null);
    const committed = await runInDurableObject(workspace, async (instance) => {
      const mutable = instance as unknown as {
        impl: {
          startAgent(): void;
          stageChatAttachment(
            attachment: { mimeType: string; content: Uint8Array; name?: string },
            provider: "openai",
          ): { id: string };
          newChat(
            user: typeof account.user,
            context: Awaited<ReturnType<typeof account.user.getExternalMessageChatContext>>,
            prompt: string,
            capsules: undefined,
            attachments: Array<{ id: string }>,
          ): Promise<number>;
        };
      };
      mutable.impl.startAgent = () => {};
      const handle = mutable.impl.stageChatAttachment({
        mimeType: "image/png",
        content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        name: "photo.png",
      }, "openai");
      await mutable.impl.newChat(
        account.user,
        context,
        "Describe this photo",
        undefined,
        [handle],
      );

      const inspected = instance as unknown as {
        impl: {
          storage: {
            chats: { list(): Iterable<unknown> };
            chatAttachmentContent: { get(id: string): unknown };
          };
        };
      };
      const messages = [...inspected.impl.storage.chats.list()] as Array<{
        type: string;
        author: { type: string };
        attachments?: Array<{ id: string; mimeType: string; name?: string }>;
      }>;
      const message = messages.find(entry =>
        entry.type === "message" && entry.author.type === "user");
      const attachment = message?.attachments?.[0];
      return {
        attachment,
        content: attachment
          ? inspected.impl.storage.chatAttachmentContent.get(attachment.id)
          : undefined,
      };
    });
    expect(committed.attachment).toMatchObject({
      mimeType: "image/png",
      name: "photo.png",
    });
    expect(committed.content).toMatchObject({ state: { type: "committed" } });
  });
});
