import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  type ExternalMessageGateway as ExternalMessageGatewayContract,
  type ExternalMessageGatewayProps,
  type SubmitExternalMessageInput,
  type SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";

@validateRpc()
export class ExternalMessageGateway extends WorkerEntrypoint<Cloudflare.Env, ExternalMessageGatewayProps> implements ExternalMessageGatewayContract {
  async submitExternalMessage(input: SubmitExternalMessageInput): Promise<SubmitExternalMessageResult> {
    let { source, identityMode } = this.ctx.props;
    if (!source) throw new Error("ExternalMessageGateway source prop is required.");
    if (identityMode !== "trustedEmail" && identityMode !== "linkedExternalSubject") {
      throw new Error("ExternalMessageGateway identityMode prop is required.");
    }
    if (input.identityMode !== identityMode) {
      return { accepted: false, message: "External message identity mode is not allowed." };
    }

    let identity: { identityMode: "trustedEmail"; callerEmail: string } |
      { identityMode: "internalUserId"; internalUserId: string };
    if (input.identityMode === "linkedExternalSubject") {
      if ("callerEmail" in input) {
        return { accepted: false, message: "Linked external subjects cannot include callerEmail." };
      }
      let internalUserId = await this.ctx.exports.IdentityRegistry.getByName("")
        .findInternalUserIdByExternalSubject(source, input.externalSubject);
      if (!internalUserId) {
        return { accepted: false, message: "Please link your account to continue." };
      }
      identity = { identityMode: "internalUserId", internalUserId };
    } else {
      if ("externalSubject" in input) {
        return { accepted: false, message: "Trusted email submissions cannot include an external subject." };
      }
      identity = { identityMode: "trustedEmail", callerEmail: input.callerEmail };
    }

    let externalKeys = {
      gadget: `${source}:${input.gadgetKey}`,
      chat: `${source}:${input.chatKey}`,
      message: `${source}:${input.messageKey}`,
    };
    let overseer = this.ctx.exports.OverseerDurableObject.getByName(externalKeys.gadget);

    return await overseer.receiveExternalMessage({
      ...identity,
      externalChatKey: externalKeys.chat,
      idempotencyKey: externalKeys.message,
      prompt: input.prompt,
      attachments: input.attachments,
      chatGatewayRpcTarget: input.chatGatewayRpcTarget,
      title: input.gadgetTitle,
    });
  }
}
