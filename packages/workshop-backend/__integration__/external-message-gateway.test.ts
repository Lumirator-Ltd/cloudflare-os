import { runInDurableObject } from "cloudflare:test";
import { exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import type {
  ChatGatewayRpcTarget,
  ExternalMessageGateway as ExternalMessageGatewayContract,
  ExternalMessageGatewayProps,
  SubmitExternalMessageInput,
} from "@gadgets/workshop-shared/external-message-gateway";
import { describe, expect, it } from "vitest";
import sharedGatewaySource from "../../workshop-shared/src/external-message-gateway.ts?raw";

const SOURCE = "trusted-email";

async function establishedCallerFixture(callerEmail: string) {
  const props = {
    source: SOURCE,
    identityMode: "trustedEmail",
  } satisfies ExternalMessageGatewayProps;
  const input = {
    identityMode: "trustedEmail",
    callerEmail,
    gadgetKey: crypto.randomUUID(),
    chatKey: crypto.randomUUID(),
    messageKey: crypto.randomUUID(),
    gadgetTitle: "Email workspace",
    prompt: "hello",
    chatGatewayRpcTarget: await exports.TelegramResponseTarget({
      props: { updateId: crypto.randomUUID() },
    }),
  } satisfies SubmitExternalMessageInput;
  return { props, input };
}

async function gateway(props: ExternalMessageGatewayProps) {
  return (await exports.ExternalMessageGateway({ props: props as never })) as unknown as
    ExternalMessageGatewayContract;
}

async function account(email = `${crypto.randomUUID()}@example.com`) {
  const user = exports.UserDurableObject.getByName(email);
  await user.createAccount(email, "Member", new Uint8Array([1, 2, 3]));
  return { email, user, userId: user.id.toString() };
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

describe("ExternalMessageGateway trusted-email routing", () => {
  it("keeps the established trusted-email discriminant without internal routing fields", () => {
    expect(sharedGatewaySource).toMatch(/identityMode:\s*"trustedEmail"/);
    expect(sharedGatewaySource).not.toMatch(
      /linkedExternalSubject|externalSubject|internalUserId|userDurableObjectId|UserDurableObjectId/,
    );
  });

  it("resolves the caller email to the canonical User Durable Object ID", async () => {
    const caller = await account();
    await addTestModel(caller.user);
    const { props, input } = await establishedCallerFixture(caller.email);
    const workspace = exports.OverseerDurableObject.getByName(`${SOURCE}:${input.gadgetKey}`);
    await runInDurableObject(workspace, (instance) => {
      const mutable = instance as unknown as { impl: { newChat(): Promise<number> } };
      mutable.impl.newChat = async () => 7;
    });

    const result = await (await gateway(props)).submitExternalMessage(input);

    expect(result).toEqual({
      accepted: true,
      chatPath: `/workspace/${workspace.id.toString()}?chat=7`,
    });
    await runInDurableObject(workspace, (instance) => {
      const inspected = instance as unknown as { impl: { ownerId?: string } };
      expect(inspected.impl.ownerId).toBe(caller.userId);
    });
  });

  it("persists a durable response target through normal chat submission", async () => {
    const caller = await account();
    await addTestModel(caller.user);
    const { props, input } = await establishedCallerFixture(caller.email);
    const workspace = exports.OverseerDurableObject.getByName(`${SOURCE}:${input.gadgetKey}`);
    await runInDurableObject(workspace, (instance) => {
      const mutable = instance as unknown as { impl: { startAgent(): void } };
      mutable.impl.startAgent = () => {};
    });

    await expect((await gateway(props)).submitExternalMessage(input))
      .resolves.toMatchObject({ accepted: true });

    await runInDurableObject(workspace, (instance) => {
      const internal = instance as unknown as {
        impl: {
          storage: { gadgetResponseDeliveries: { list(): Iterable<unknown> } };
        };
      };
      expect([...internal.impl.storage.gadgetResponseDeliveries.list()]).toHaveLength(1);
    });
  });

  it("preserves attachments and the backend-computed chat path", async () => {
    const caller = await account();
    await addTestModel(caller.user);
    const { props, input } = await establishedCallerFixture(caller.email);
    const workspace = exports.OverseerDurableObject.getByName(`${SOURCE}:${input.gadgetKey}`);

    let submittedPrompt: string | undefined;
    let submittedAttachments: Array<{ id: string }> | undefined;
    await runInDurableObject(workspace, async (instance) => {
      const internal = instance as unknown as {
        impl: { newChat(...args: unknown[]): Promise<number> };
      };
      internal.impl.newChat = async (...args: unknown[]) => {
        submittedPrompt = args[2] as string;
        submittedAttachments = args[4] as Array<{ id: string }> | undefined;
        return 9;
      };
    });

    const result = await (await gateway(props)).submitExternalMessage({
      ...input,
      prompt: "Describe this photo",
      attachments: [{
        mimeType: "image/png",
        content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        name: "photo.png",
      }],
    });

    expect(result).toEqual({
      accepted: true,
      chatPath: `/workspace/${workspace.id.toString()}?chat=9`,
    });
    expect(submittedPrompt).toBe("Describe this photo");
    expect(submittedAttachments).toHaveLength(1);
    await runInDurableObject(workspace, async (instance) => {
      const internal = instance as unknown as {
        impl: { storage: { chatAttachmentContent: { list(): Iterable<unknown> } } };
      };
      expect([...internal.impl.storage.chatAttachmentContent.list()]).toHaveLength(0);
    });
  });
});

describe("external response delivery", () => {
  it("keeps durable callbacks and includes the backend-computed chat path", async () => {
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
