import type { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ChatAttachmentUpload } from "./api";

/** A completed Gadget response that should be delivered back to the chat gateway. */
export type GadgetResponse = {
  /** Text produced by the completed agent turn. */
  text: string;
  /** Same-origin path to the workspace chat that produced the response. */
  chatPath: string;
};

/** RPC target provided by the chat gateway for the backend's eventual response. */
export interface ChatGatewayRpcTarget extends RpcTarget {
  /**
   * Deliver the completed Gadget response. Implementations must be idempotent because delivery is
   * at-least-once when response target acknowledgements fail.
   */
  onGadgetResponse(response: GadgetResponse): Promise<void>;
}

/** Bytes and metadata for an attachment submitted through an external message gateway. */
export type ExternalMessageAttachment = ChatAttachmentUpload;

type SubmitExternalMessageBase = {
  /** Selects the workspace to create or reuse within the binding-owned source. */
  gadgetKey: string;
  /** Selects the chat to create or reuse within the binding-owned source. */
  chatKey: string;
  /** Deduplicates the originating message within the binding-owned source. */
  messageKey: string;
  /** Names the workspace if it must be created. */
  gadgetTitle: string;
  /** User text sent to Gadgets; it may be empty when attachments are present. */
  prompt: string;
  /** Files submitted with the external message. */
  attachments?: ExternalMessageAttachment[];
  /** Persistent target invoked when the Gadget response is ready. */
  chatGatewayRpcTarget: RpcStub<ChatGatewayRpcTarget>;
};

/** External message submission accepted by the backend gateway. */
export type SubmitExternalMessageInput = SubmitExternalMessageBase & (
  | {
      /** Selects explicit compatibility routing through a gateway-trusted email address. */
      identityMode: "trustedEmail";
      /** Verified account email trusted from the configured gateway binding. */
      callerEmail: string;
    }
  | {
      /** Selects routing through a pre-linked external identity. */
      identityMode: "linkedExternalSubject";
      /** Stable subject identifier issued by the binding-owned external source. */
      externalSubject: string;
    }
);

/** Binding-owned properties that constrain external identity routing. */
export type ExternalMessageGatewayProps = {
  /** Stable namespace for external workspace, chat, message, and identity keys. */
  source: string;
  /** Identity authority accepted from callers of this binding. */
  identityMode: "trustedEmail" | "linkedExternalSubject";
};

/** Submission result returned by the backend gateway. */
export type SubmitExternalMessageResult =
  | {
      /** Indicates that the message was committed or had already been committed. */
      accepted: true;
      /** Same-origin path to the workspace chat that received the message. */
      chatPath: string;
    }
  | {
      /** Indicates that the message was rejected before chat submission. */
      accepted: false;
      /** User-facing explanation of an actionable submission rejection. */
      message: string;
    };

/** Service binding RPC interface used by chat gateway workers. */
export interface ExternalMessageGateway {
  /** Submit an external chat message for Gadget routing and execution. */
  submitExternalMessage(input: SubmitExternalMessageInput): Promise<SubmitExternalMessageResult>;
}
