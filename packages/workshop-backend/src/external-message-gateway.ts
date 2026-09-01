import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  type ExternalMessageGateway as ExternalMessageGatewayContract,
  type ExternalMessageGatewayProps,
  type SubmitExternalMessageInput,
  type SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";
import { assertAdminBootstrap } from "./admin-bootstrap-gate.js";
import { routeExternalMessage } from "./external-message-routing.js";

@validateRpc()
export class ExternalMessageGateway extends WorkerEntrypoint<Cloudflare.Env, ExternalMessageGatewayProps> implements ExternalMessageGatewayContract {
  async submitExternalMessage(input: SubmitExternalMessageInput): Promise<SubmitExternalMessageResult> {
    await assertAdminBootstrap(this.env, this.ctx);

    const { source } = this.ctx.props;
    if (!source) throw new Error("ExternalMessageGateway source prop is required.");

    const externalKeys = {
      gadget: `${source}:${input.gadgetKey}`,
      chat: `${source}:${input.chatKey}`,
      message: `${source}:${input.messageKey}`,
    };
    const userId = this.ctx.exports.UserDurableObject.idFromName(input.callerEmail);

    return await routeExternalMessage(
      this.ctx.exports.OverseerDurableObject,
      userId,
      {
        gadgetKey: externalKeys.gadget,
        externalChatKey: externalKeys.chat,
        idempotencyKey: externalKeys.message,
        prompt: input.prompt,
        attachments: input.attachments,
        chatGatewayRpcTarget: input.chatGatewayRpcTarget,
        title: input.gadgetTitle,
      },
    );
  }
}
