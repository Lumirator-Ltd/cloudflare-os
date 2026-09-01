import type { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
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

/** Restart-safe Worker entrypoint provided for an eventual external-message response. */
export interface ChatGatewayEntrypoint extends WorkerEntrypoint {
  /** Durably accepts an at-least-once completed Gadget response. */
  onGadgetResponse(response: GadgetResponse): Promise<void>;
}

/** Persistent callback capability accepted from either legacy targets or Worker entrypoints. */
export type ChatGatewayCallback =
  | RpcStub<ChatGatewayRpcTarget>
  | Fetcher<ChatGatewayEntrypoint>;

/** Bytes and metadata for an attachment submitted through an external message gateway. */
export type ExternalMessageAttachment = ChatAttachmentUpload;

/** External message submission accepted by the trusted-email backend gateway. */
export type SubmitExternalMessageInput = {
  /** Verified account email trusted from the configured gateway binding. */
  callerEmail: string;
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
  chatGatewayRpcTarget: ChatGatewayCallback;
};

/** Binding-owned properties that constrain external message routing. */
export type ExternalMessageGatewayProps = {
  /** Stable namespace for external workspace, chat, and message keys. */
  source: string;
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

/** Service binding RPC interface used by trusted-email gateway workers. */
export interface ExternalMessageGateway {
  /** Submit an external chat message for Gadget routing and execution. */
  submitExternalMessage(input: SubmitExternalMessageInput): Promise<SubmitExternalMessageResult>;
}
