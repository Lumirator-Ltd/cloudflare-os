export type TelegramBotIdentity = {
  id: number;
  username: string;
};

export type NormalizedTelegramMessage = {
  kind: "message";
  updateId: string;
  userId: string;
  chatId: string;
  workspaceKey: string;
  chatKey: string;
  prompt: string;
  title: "Telegram chat" | "Telegram group";
  threadId?: number;
  photo?: { fileId: string };
};

export type NormalizedTelegramLink = {
  kind: "link";
  updateId: string;
  userId: string;
  chatId: string;
  token: string;
};

export type NormalizedTelegramUpdate = NormalizedTelegramMessage | NormalizedTelegramLink;

export type TelegramStoredResponse = {
  text: string;
  chatPath: string;
};

export type TelegramUpdateStatus =
  | "queued"
  | "processing"
  | "placeholder"
  | "submitted"
  | "responseReady"
  | "delivered"
  | "terminal";

export type TelegramUpdateRecord = {
  status: TelegramUpdateStatus;
  update: NormalizedTelegramUpdate;
  placeholderMessageId?: number;
  response?: TelegramStoredResponse;
  linkResult?: string;
  nextAttemptAt?: number;
};
