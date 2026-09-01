import type {
  ChatGatewayCallback,
  SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";
import type { ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "./overseer.js";
import type { UserDurableObject } from "./user.js";

export type ExternalMessageRouteInput = {
  gadgetKey: string;
  externalChatKey: string;
  idempotencyKey: string;
  prompt: string;
  attachments?: ChatAttachmentUpload[];
  chatGatewayRpcTarget: ChatGatewayCallback;
  title: string;
};

type ResolvedUser = DurableObjectId | DurableObjectStub<UserDurableObject>;

export async function routeExternalMessage(
  overseers: DurableObjectNamespace<OverseerDurableObject>,
  user: ResolvedUser,
  input: ExternalMessageRouteInput,
): Promise<SubmitExternalMessageResult> {
  const userId = "id" in user ? user.id : user;
  return await overseers.getByName(input.gadgetKey).receiveExternalMessage(
    userId.toString(),
    {
      externalChatKey: input.externalChatKey,
      idempotencyKey: input.idempotencyKey,
      prompt: input.prompt,
      attachments: input.attachments,
      chatGatewayRpcTarget: input.chatGatewayRpcTarget,
      title: input.title,
    },
  );
}
