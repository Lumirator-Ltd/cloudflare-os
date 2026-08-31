export type TelegramBotIdentity = {
  id: number;
  username: string;
};

export type TelegramStartUpdate = {
  updateId: string;
  userId: string;
  chatId: string;
  token: string;
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
  rejection?: "photoTooLarge";
};

export type NormalizedTelegramUpdate = NormalizedTelegramMessage;

export type TelegramStoredResponse = {
  text: string;
  chatPath: string;
};

export type TelegramUpdateStatus =
  | "queued"
  | "processing"
  | "placeholder"
  | "submitted"
  | "responseReady";

export type TelegramUpdateRecord = {
  status: TelegramUpdateStatus;
  update: NormalizedTelegramUpdate;
  placeholderMessageId?: number;
  response?: TelegramStoredResponse;
  nextAttemptAt?: number;
  dueKey?: string;
};
