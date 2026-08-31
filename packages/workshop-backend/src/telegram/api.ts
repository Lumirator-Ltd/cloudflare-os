import type { TelegramBotIdentity } from "./types.js";

export const MAX_TELEGRAM_PHOTO_BYTES = 1024 * 1024;
const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;
const MAX_RETRY_AFTER_MS = 60_000;
const API_ORIGIN = "https://api.telegram.org";

type TelegramApiDependencies = {
  fetch?: typeof fetch;
};

type TelegramEnvelope = {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
  description?: unknown;
  parameters?: unknown;
};

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function boundedBytes(response: Response, limit: number, errorMessage: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new TelegramApiError(errorMessage, false);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new TelegramApiError(errorMessage, false);
      chunks.push(value);
    }
  } finally {
    if (total > limit) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function formatTelegramResponse(text: string, absoluteChatUrl: string): string {
  const suffix = `\n\n${absoluteChatUrl}`;
  const available = Math.max(0, MAX_TELEGRAM_MESSAGE_LENGTH - suffix.length);
  const body = text.length > available
    ? `${text.slice(0, Math.max(0, available - 1))}…`
    : text;
  return `${body}${suffix}`.slice(-MAX_TELEGRAM_MESSAGE_LENGTH);
}

export class TelegramBotApi {
  readonly #fetch: typeof fetch;

  constructor(readonly token: string, dependencies: TelegramApiDependencies = {}) {
    this.#fetch = dependencies.fetch ?? fetch;
  }

  async getMe(): Promise<TelegramBotIdentity> {
    const result = object(await this.#call("getMe", {}));
    if (!result || !Number.isSafeInteger(result.id) || (result.id as number) <= 0 ||
        typeof result.username !== "string" ||
        result.is_bot !== true || !/^[A-Za-z0-9_]{5,32}$/.test(result.username)) {
      throw new Error("Telegram bot identity was invalid.");
    }
    return { id: result.id as number, username: result.username };
  }

  async sendMessage(chatId: string, text: string, threadId?: number): Promise<number> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (threadId !== undefined) body.message_thread_id = threadId;
    const result = object(await this.#call("sendMessage", body));
    if (!result || !Number.isSafeInteger(result.message_id)) {
      throw new Error("Telegram send result was invalid.");
    }
    return result.message_id as number;
  }

  async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
    await this.#call("editMessageText", { chat_id: chatId, message_id: messageId, text }, true);
  }

  async downloadPhoto(fileId: string): Promise<Uint8Array> {
    const metadata = object(await this.#call("getFile", { file_id: fileId }));
    const path = metadata?.file_path;
    if (typeof path !== "string" || path.startsWith("/") || path.includes("..") ||
        !/^[A-Za-z0-9_./-]+$/.test(path)) {
      throw new TelegramApiError("Telegram file metadata was invalid.", false);
    }
    let response: Response;
    try {
      response = await this.#fetch(`${API_ORIGIN}/file/bot${this.token}/${path}`);
    } catch {
      throw new TelegramApiError("Telegram file download failed.", true);
    }
    if (!response.ok) {
      throw new TelegramApiError("Telegram file download failed.", response.status >= 500);
    }
    return await boundedBytes(
      response,
      MAX_TELEGRAM_PHOTO_BYTES,
      "Telegram photo exceeds the size limit.",
    );
  }

  async #call(method: string, body: Record<string, unknown>, allowNotModified = false): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${API_ORIGIN}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TelegramApiError("Telegram Bot API request failed.", true);
    }

    let envelope: TelegramEnvelope = {};
    try {
      envelope = await response.json() as TelegramEnvelope;
    } catch {
      if (response.ok) throw new Error("Telegram Bot API response was invalid.");
    }
    if (response.ok && envelope.ok === true) return envelope.result;
    if (allowNotModified && response.status === 400 &&
        typeof envelope.description === "string" && /message is not modified/i.test(envelope.description)) {
      return undefined;
    }

    const status = response.ok && typeof envelope.error_code === "number"
      ? envelope.error_code
      : response.status;
    const parameters = object(envelope.parameters);
    const retryAfter = typeof parameters?.retry_after === "number" && Number.isFinite(parameters.retry_after)
      ? Math.max(0, Math.min(MAX_RETRY_AFTER_MS, parameters.retry_after * 1000))
      : undefined;
    throw new TelegramApiError(
      "Telegram Bot API request failed.",
      status === 429 || status >= 500,
      status === 429 ? retryAfter : undefined,
    );
  }
}
