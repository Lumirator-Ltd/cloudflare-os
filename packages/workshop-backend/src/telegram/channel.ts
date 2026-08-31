import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ChatGatewayEntrypoint,
  GadgetResponse,
} from "@gadgets/workshop-shared/external-message-gateway";
import { TelegramApiError, TelegramBotApi, formatTelegramResponse } from "./api.js";
import { parseTelegramUpdate } from "./parser.js";
import type {
  NormalizedTelegramUpdate,
  TelegramBotIdentity,
  TelegramStoredResponse,
  TelegramUpdateRecord,
} from "./types.js";
import { createWorkshopLogger } from "../observability.js";

const logger = createWorkshopLogger("workshop.telegram.channel");
const UPDATE_PREFIX = "telegram:update:";
const BOT_IDENTITY_KEY = "telegram:bot-identity";
const BOT_IDENTITY_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_RETRY_MS = 5_000;

type CachedBotIdentity = TelegramBotIdentity & { refreshedAt: number };
type TelegramResponseTargetProps = { updateId: string };

function updateKey(updateId: string): string {
  return `${UPDATE_PREFIX}${updateId.padStart(20, "0")}`;
}

export class TelegramUpdateStore {
  constructor(private storage: DurableObjectStorage) {}

  enqueue(update: NormalizedTelegramUpdate): boolean {
    const key = updateKey(update.updateId);
    if (this.storage.kv.get(key)) return false;
    this.storage.kv.put(key, { status: "queued", update } satisfies TelegramUpdateRecord);
    return true;
  }

  get(updateId: string): TelegramUpdateRecord | undefined {
    return this.storage.kv.get<TelegramUpdateRecord>(updateKey(updateId));
  }

  claimNext(now = Date.now()): TelegramUpdateRecord | null {
    for (const [key, record] of this.storage.kv.list<TelegramUpdateRecord>({ prefix: UPDATE_PREFIX })) {
      if ((record.status === "queued" || record.status === "processing" || record.status === "placeholder") &&
          (record.nextAttemptAt === undefined || record.nextAttemptAt <= now)) {
        const processing = { ...record, status: "processing" as const, nextAttemptAt: undefined };
        this.storage.kv.put(key, processing);
        return processing;
      }
    }
    return null;
  }

  nextResponse(now = Date.now()): TelegramUpdateRecord | null {
    for (const [, record] of this.storage.kv.list<TelegramUpdateRecord>({ prefix: UPDATE_PREFIX })) {
      if (record.status === "responseReady" &&
          (record.nextAttemptAt === undefined || record.nextAttemptAt <= now)) return record;
    }
    return null;
  }

  setPlaceholder(updateId: string, messageId: number): void {
    this.#update(updateId, record => ({
      ...record,
      status: "placeholder",
      placeholderMessageId: messageId,
      nextAttemptAt: undefined,
    }));
  }

  markSubmitted(updateId: string): void {
    this.#update(updateId, record => record.status === "responseReady" || record.status === "delivered"
      ? record
      : { ...record, status: "submitted", nextAttemptAt: undefined });
  }

  setLinkResult(updateId: string, linkResult: string): void {
    this.#update(updateId, record => ({
      ...record,
      status: "processing",
      linkResult,
      update: record.update.kind === "link" ? { ...record.update, token: "" } : record.update,
    }));
  }

  storeResponse(updateId: string, response: TelegramStoredResponse): void {
    this.#update(updateId, record => ({
      ...record,
      status: "responseReady",
      response,
      nextAttemptAt: undefined,
    }));
  }

  retry(updateId: string, nextAttemptAt: number): void {
    this.#update(updateId, record => ({ ...record, nextAttemptAt }));
  }

  markDelivered(updateId: string): void {
    this.#update(updateId, record => ({ ...record, status: "delivered", nextAttemptAt: undefined }));
  }

  markTerminal(updateId: string): void {
    this.#update(updateId, record => ({ ...record, status: "terminal", nextAttemptAt: undefined }));
  }

  nextAttemptAt(): number | null {
    let next: number | null = null;
    for (const [, record] of this.storage.kv.list<TelegramUpdateRecord>({ prefix: UPDATE_PREFIX })) {
      if (record.status === "queued" || record.status === "processing" || record.status === "placeholder" ||
          record.status === "responseReady") {
        const candidate = record.nextAttemptAt ?? Date.now();
        next = next === null ? candidate : Math.min(next, candidate);
      }
    }
    return next;
  }

  #update(updateId: string, transform: (record: TelegramUpdateRecord) => TelegramUpdateRecord): void {
    const key = updateKey(updateId);
    const record = this.storage.kv.get<TelegramUpdateRecord>(key);
    if (!record) return;
    this.storage.kv.put(key, transform(record));
  }
}

export class TelegramChannel extends DurableObject<Cloudflare.Env> {
  readonly #store: TelegramUpdateStore;
  #draining = false;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = new TelegramUpdateStore(ctx.storage);
  }

  async enqueueUpdate(rawUpdate: unknown): Promise<void> {
    const bot = await this.getBotIdentity();
    const update = parseTelegramUpdate(rawUpdate, bot);
    if (!update || !this.#store.enqueue(update)) return;
    this.ctx.storage.setAlarm(Date.now());
    this.ctx.waitUntil(this.#drain());
  }

  receiveResponse(updateId: string, response: GadgetResponse): void {
    this.#store.storeResponse(updateId, { text: response.text, chatPath: response.chatPath });
    this.ctx.storage.setAlarm(Date.now());
    this.ctx.waitUntil(this.#drain());
  }

  async alarm(): Promise<void> {
    await this.#drain();
  }

  async getBotIdentity(): Promise<TelegramBotIdentity> {
    const cached = this.ctx.storage.kv.get<CachedBotIdentity>(BOT_IDENTITY_KEY);
    if (cached && cached.refreshedAt > Date.now() - BOT_IDENTITY_TTL_MS) {
      return { id: cached.id, username: cached.username };
    }
    const api = this.#api();
    const identity = await api.getMe();
    this.ctx.storage.kv.put(BOT_IDENTITY_KEY, { ...identity, refreshedAt: Date.now() });
    return identity;
  }

  #api(): TelegramBotApi {
    if (!this.env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram is not configured.");
    return new TelegramBotApi(this.env.TELEGRAM_BOT_TOKEN);
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (true) {
        const response = this.#store.nextResponse();
        if (response) {
          if (!(await this.#deliver(response))) break;
          continue;
        }
        const record = this.#store.claimNext();
        if (!record) break;
        if (!(await this.#process(record))) break;
      }
    } finally {
      this.#draining = false;
      const next = this.#store.nextAttemptAt();
      if (next === null) this.ctx.storage.deleteAlarm();
      else this.ctx.storage.setAlarm(next);
    }
  }

  async #process(record: TelegramUpdateRecord): Promise<boolean> {
    try {
      if (record.update.kind === "link") {
        let text = record.linkResult;
        if (!text) {
          text = "Telegram connected.";
          try {
            await this.ctx.exports.IdentityRegistry.getByName("").completeExternalLink(
              "telegram",
              record.update.token,
              record.update.userId,
            );
          } catch {
            text = "This Telegram link is invalid or expired.";
          }
          this.#store.setLinkResult(record.update.updateId, text);
        }
        await this.#api().sendMessage(record.update.chatId, text);
        this.#store.markDelivered(record.update.updateId);
        return true;
      }

      let placeholderMessageId = record.placeholderMessageId;
      if (placeholderMessageId === undefined) {
        placeholderMessageId = await this.#api().sendMessage(
          record.update.chatId,
          "Thinking…",
          record.update.threadId,
        );
        this.#store.setPlaceholder(record.update.updateId, placeholderMessageId);
      }

      const attachments = record.update.photo
        ? [{
            mimeType: "image/jpeg",
            name: "telegram-photo.jpg",
            content: await this.#api().downloadPhoto(record.update.photo.fileId),
          }]
        : undefined;
      const responseTarget = this.ctx.exports.TelegramResponseTarget({
        props: { updateId: record.update.updateId },
      });
      const gateway = this.ctx.exports.ExternalMessageGateway({
        props: { source: "telegram", identityMode: "linkedExternalSubject" },
      });
      const result = await gateway.submitExternalMessage({
        identityMode: "linkedExternalSubject",
        externalSubject: record.update.userId,
        gadgetKey: record.update.workspaceKey,
        chatKey: record.update.chatKey,
        messageKey: record.update.updateId,
        gadgetTitle: record.update.title,
        prompt: record.update.prompt,
        attachments,
        chatGatewayRpcTarget: responseTarget,
      });
      if (result.accepted) {
        this.#store.markSubmitted(record.update.updateId);
      } else {
        this.#store.storeResponse(record.update.updateId, { text: result.message, chatPath: "" });
      }
      return true;
    } catch (error) {
      return this.#handleFailure(record.update.updateId, error);
    }
  }

  async #deliver(record: TelegramUpdateRecord): Promise<boolean> {
    if (!record.response || record.placeholderMessageId === undefined || !this.env.PUBLIC_BASE_URL) {
      this.#store.markTerminal(record.update.updateId);
      return true;
    }
    try {
      const absolutePath = record.response.chatPath
        ? `${this.env.PUBLIC_BASE_URL.replace(/\/$/, "")}${record.response.chatPath}`
        : this.env.PUBLIC_BASE_URL.replace(/\/$/, "");
      await this.#api().editMessage(
        record.update.chatId,
        record.placeholderMessageId,
        formatTelegramResponse(record.response.text, absolutePath),
      );
      this.#store.markDelivered(record.update.updateId);
      return true;
    } catch (error) {
      return this.#handleFailure(record.update.updateId, error);
    }
  }

  #handleFailure(updateId: string, error: unknown): boolean {
    if (error instanceof TelegramApiError && !error.retryable) {
      this.#store.markTerminal(updateId);
      return true;
    }
    const delay = error instanceof TelegramApiError
      ? error.retryAfterMs ?? DEFAULT_RETRY_MS
      : DEFAULT_RETRY_MS;
    this.#store.retry(updateId, Date.now() + delay);
    logger.warn("Telegram update processing will retry", {
      event: "telegram.update.retry",
      error: error instanceof TelegramApiError ? error : new Error("Telegram update processing failed."),
    });
    return false;
  }
}

export class TelegramResponseTarget extends WorkerEntrypoint<Cloudflare.Env, TelegramResponseTargetProps>
    implements ChatGatewayEntrypoint {
  async onGadgetResponse(response: GadgetResponse): Promise<void> {
    await this.ctx.exports.TelegramChannel.getByName("").receiveResponse(
      this.ctx.props.updateId,
      response,
    );
  }
}
