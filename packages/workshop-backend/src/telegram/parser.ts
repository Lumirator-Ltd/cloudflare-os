import type {
  NormalizedTelegramMessage,
  NormalizedTelegramUpdate,
  TelegramBotIdentity,
} from "./types.js";

const MAX_PHOTO_BYTES = 1024 * 1024;

type JsonObject = Record<string, unknown>;
type Entity = { type: string; offset: number; length: number };

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function validBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function parseEntities(value: unknown, text: string): Entity[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result: Entity[] = [];
  for (const candidate of value) {
    const entity = object(candidate);
    const offset = integer(entity?.offset);
    const length = integer(entity?.length);
    if (!entity || typeof entity.type !== "string" || offset === null || length === null ||
        offset < 0 || length <= 0 || offset + length > text.length ||
        !validBoundary(text, offset) || !validBoundary(text, offset + length)) {
      return null;
    }
    result.push({ type: entity.type, offset, length });
  }
  return result;
}

function commandAtStart(text: string, entities: Entity[]): string | null {
  const command = entities.find(entity => entity.type === "bot_command" && entity.offset === 0);
  return command ? text.slice(0, command.length) : null;
}

function ownCommand(command: string, name: string, username: string): boolean {
  const normalized = command.toLowerCase();
  return normalized === `/${name}` || normalized === `/${name}@${username.toLowerCase()}`;
}

function stripRange(text: string, offset: number, length: number): string {
  return `${text.slice(0, offset)}${text.slice(offset + length)}`.trim();
}

function selectedPhoto(value: unknown): { fileId: string } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const candidates: Array<{ fileId: string; size?: number; area: number }> = [];
  for (const item of value) {
    const photo = object(item);
    if (!photo || typeof photo.file_id !== "string" || photo.file_id.length === 0) continue;
    const size = integer(photo.file_size) ?? undefined;
    if (size !== undefined && (size < 0 || size > MAX_PHOTO_BYTES)) continue;
    const width = integer(photo.width) ?? 0;
    const height = integer(photo.height) ?? 0;
    candidates.push({ fileId: photo.file_id, size, area: width * height });
  }
  const declared = candidates.filter(candidate => candidate.size !== undefined);
  const pool = declared.length > 0 ? declared : candidates;
  pool.sort((left, right) => (right.size ?? right.area) - (left.size ?? left.area));
  return pool[0] ? { fileId: pool[0].fileId } : null;
}

function parseGroupActivation(
  text: string,
  entities: Entity[],
  message: JsonObject,
  bot: TelegramBotIdentity,
): string | null {
  const command = commandAtStart(text, entities);
  if (command) {
    if (!ownCommand(command, "ask", bot.username)) return null;
    return text.slice(command.length).trim();
  }

  const expectedMention = `@${bot.username}`.toLowerCase();
  const mention = entities.find(entity =>
    entity.type === "mention" && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === expectedMention);
  if (mention) return stripRange(text, mention.offset, mention.length);

  const reply = object(message.reply_to_message);
  const replyFrom = object(reply?.from);
  return integer(replyFrom?.id) === bot.id ? text.trim() : null;
}

export function parseTelegramUpdate(
  value: unknown,
  bot: TelegramBotIdentity,
): NormalizedTelegramUpdate | null {
  const update = object(value);
  const updateId = integer(update?.update_id);
  const message = object(update?.message);
  if (!update || updateId === null || updateId < 0 || !message ||
      update.edited_message !== undefined || update.channel_post !== undefined ||
      update.edited_channel_post !== undefined || update.business_message !== undefined ||
      update.edited_business_message !== undefined) return null;

  const from = object(message.from);
  const chat = object(message.chat);
  const userId = integer(from?.id);
  const chatId = integer(chat?.id);
  if (!from || !chat || userId === null || userId <= 0 || chatId === null || chatId === 0 || from.is_bot === true ||
      message.sender_chat !== undefined || typeof chat.type !== "string") return null;
  if (message.media_group_id !== undefined || [
    "animation", "audio", "contact", "dice", "document", "game", "location", "poll",
    "sticker", "venue", "video", "video_note", "voice",
  ].some(field => message[field] !== undefined)) return null;

  const text = typeof message.text === "string"
    ? message.text
    : typeof message.caption === "string" ? message.caption : "";
  const entities = parseEntities(
    typeof message.text === "string" ? message.entities : message.caption_entities,
    text,
  );
  if (!entities) return null;

  const isPrivate = chat.type === "private";
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  if (!isPrivate && !isGroup) return null;

  const command = commandAtStart(text, entities);
  if (isPrivate && chatId === userId && command?.toLowerCase() === "/start") {
    const token = text.slice(command.length).trim();
    if (/^[A-Za-z0-9_-]+$/.test(token)) {
      return { kind: "link", updateId: String(updateId), userId: String(userId), chatId: String(chatId), token };
    }
    return null;
  }
  if (isPrivate && command?.toLowerCase().startsWith("/start@")) return null;
  if (isGroup && command && ownCommand(command, "start", bot.username)) return null;

  const photo = selectedPhoto(message.photo);
  if (message.photo !== undefined && !photo) return null;
  let prompt = text.trim();
  if (isGroup) {
    const activated = parseGroupActivation(text, entities, message, bot);
    if (activated === null) return null;
    prompt = activated;
  }
  if (!prompt && photo) prompt = "Please analyze this image.";
  if (!prompt && !photo) return null;

  const threadId = integer(message.message_thread_id) ?? undefined;
  const result: NormalizedTelegramMessage = {
    kind: "message",
    updateId: String(updateId),
    userId: String(userId),
    chatId: String(chatId),
    workspaceKey: isPrivate ? `dm:${userId}` : `group:${chatId}`,
    chatKey: threadId === undefined ? "root" : `topic:${threadId}`,
    prompt,
    title: isPrivate ? "Telegram chat" : "Telegram group",
  };
  if (threadId !== undefined) result.threadId = threadId;
  if (photo) result.photo = photo;
  return result;
}
