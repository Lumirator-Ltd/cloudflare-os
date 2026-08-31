import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ChatGatewayEntrypoint,
  GadgetResponse,
} from "@gadgets/workshop-shared/external-message-gateway";
import {
  TelegramApiError,
  TelegramBotApi,
  TelegramInputError,
  formatTelegramResponse,
} from "./api.js";
import {
  parseTelegramStartUpdate,
  parseTelegramUpdate,
  telegramUpdateId,
} from "./parser.js";
import type {
  NormalizedTelegramUpdate,
  TelegramBotIdentity,
  TelegramStartUpdate,
  TelegramStoredResponse,
  TelegramUpdateRecord,
  TelegramUpdateStatus,
} from "./types.js";
import { createWorkshopLogger } from "../observability.js";

const logger = createWorkshopLogger("workshop.telegram.channel");
const PENDING_RECORD_PREFIX = "telegram:pending:record:";
const PENDING_DUE_PREFIX = "telegram:pending:due:";
const TOMBSTONE_PREFIX = "telegram:tombstone:update:";
const TOMBSTONE_EXPIRY_PREFIX = "telegram:tombstone:expiry:";
const BOT_IDENTITY_KEY = "telegram:bot-identity";
const BOT_IDENTITY_TTL_MS = 24 * 60 * 60_000;
const TOMBSTONE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_RETRY_MS = 5_000;
const CLEANUP_BATCH_SIZE = 100;
const DRAIN_BATCH_SIZE = 100;
const INPUT_REJECTION = "Please send a JPEG photo no larger than 1 MB.";

type CachedBotIdentity = TelegramBotIdentity & { refreshedAt: number };
type TelegramResponseTargetProps = { updateId: string };
type Tombstone = { expiresAt: number };
type DueIndex = { updateId: string; dueAt: number };

function padded(value: string | number): string {
  return String(value).padStart(20, "0");
}

function pendingRecordKey(updateId: string): string {
  return `${PENDING_RECORD_PREFIX}${padded(updateId)}`;
}

function pendingDueKey(updateId: string, dueAt: number): string {
  return `${PENDING_DUE_PREFIX}${padded(dueAt)}:${padded(updateId)}`;
}

function tombstoneKey(updateId: string): string {
  return `${TOMBSTONE_PREFIX}${padded(updateId)}`;
}

function tombstoneExpiryKey(updateId: string, expiresAt: number): string {
  return `${TOMBSTONE_EXPIRY_PREFIX}${padded(expiresAt)}:${padded(updateId)}`;
}

export class TelegramUpdateStore {
  constructor(private storage: DurableObjectStorage) {}

  enqueue(update: NormalizedTelegramUpdate): boolean {
    const now = Date.now();
    this.cleanupExpiredTombstones(now);
    if (this.storage.kv.get(pendingRecordKey(update.updateId)) || this.#hasTombstone(update.updateId, now)) {
      return false;
    }
    this.#putDue({ status: "queued", update }, now);
    return true;
  }

  get(updateId: string): TelegramUpdateRecord | undefined {
    return this.storage.kv.get<TelegramUpdateRecord>(pendingRecordKey(updateId));
  }

  isDuplicate(updateId: string, now = Date.now()): boolean {
    this.cleanupExpiredTombstones(now);
    return this.storage.kv.get(pendingRecordKey(updateId)) !== undefined || this.#hasTombstone(updateId, now);
  }

  claimNext(now = Date.now()): TelegramUpdateRecord | null {
    const found = this.#findDue(["queued", "processing", "placeholder"], now);
    if (!found) return null;
    const processing = {
      ...found,
      status: "processing" as const,
      nextAttemptAt: undefined,
    };
    this.storage.kv.put(pendingRecordKey(found.update.updateId), processing);
    return processing;
  }

  nextResponse(now = Date.now()): TelegramUpdateRecord | null {
    return this.#findDue(["responseReady"], now);
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
    this.#update(updateId, record => {
      if (record.status === "responseReady") return record;
      this.#deleteDue(record);
      return { ...record, status: "submitted", nextAttemptAt: undefined, dueKey: undefined };
    });
  }

  storeResponse(updateId: string, response: TelegramStoredResponse): void {
    const record = this.get(updateId);
    if (!record) return;
    this.#putDue({
      ...record,
      status: "responseReady",
      response,
      nextAttemptAt: undefined,
    }, Date.now());
  }

  retry(updateId: string, nextAttemptAt: number): void {
    const record = this.get(updateId);
    if (!record) return;
    this.#putDue({ ...record, nextAttemptAt }, nextAttemptAt);
  }

  markDelivered(updateId: string): void {
    this.#finalize(updateId);
  }

  markTerminal(updateId: string): void {
    this.#finalize(updateId);
  }

  markIgnored(updateId: string): void {
    if (this.get(updateId) || this.#hasTombstone(updateId, Date.now())) return;
    this.#putTombstone(updateId, Date.now() + TOMBSTONE_TTL_MS);
  }

  cleanupExpiredTombstones(now = Date.now()): number {
    const entries = [...this.storage.kv.list<DueIndex>({
      prefix: TOMBSTONE_EXPIRY_PREFIX,
      end: `${TOMBSTONE_EXPIRY_PREFIX}${padded(now + 1)}`,
      limit: CLEANUP_BATCH_SIZE,
    })];
    for (const [key, entry] of entries) {
      this.storage.kv.delete(key);
      const current = this.storage.kv.get<Tombstone>(tombstoneKey(entry.updateId));
      if (current?.expiresAt === entry.dueAt && current.expiresAt <= now) {
        this.storage.kv.delete(tombstoneKey(entry.updateId));
      }
    }
    return entries.length;
  }

  nextAlarmAt(): number | null {
    const due = [...this.storage.kv.list<DueIndex>({ prefix: PENDING_DUE_PREFIX, limit: 1 })][0]?.[1].dueAt;
    const expiry = [...this.storage.kv.list<DueIndex>({ prefix: TOMBSTONE_EXPIRY_PREFIX, limit: 1 })][0]?.[1].dueAt;
    if (due === undefined) return expiry ?? null;
    if (expiry === undefined) return due;
    return Math.min(due, expiry);
  }

  #findDue(statuses: TelegramUpdateStatus[], now: number): TelegramUpdateRecord | null {
    const entries = [...this.storage.kv.list<DueIndex>({
      prefix: PENDING_DUE_PREFIX,
      end: `${PENDING_DUE_PREFIX}${padded(now + 1)}`,
      limit: CLEANUP_BATCH_SIZE,
    })];
    for (const [key, entry] of entries) {
      const record = this.get(entry.updateId);
      if (!record || record.dueKey !== key) {
        this.storage.kv.delete(key);
        continue;
      }
      if (statuses.includes(record.status)) return record;
    }
    return null;
  }

  #putDue(record: TelegramUpdateRecord, dueAt: number): void {
    this.#deleteDue(record);
    const dueKey = pendingDueKey(record.update.updateId, dueAt);
    this.storage.kv.put(pendingRecordKey(record.update.updateId), { ...record, dueKey });
    this.storage.kv.put(dueKey, { updateId: record.update.updateId, dueAt } satisfies DueIndex);
  }

  #deleteDue(record: TelegramUpdateRecord): void {
    if (record.dueKey) this.storage.kv.delete(record.dueKey);
  }

  #finalize(updateId: string): void {
    const record = this.get(updateId);
    if (!record) return;
    this.#deleteDue(record);
    this.storage.kv.delete(pendingRecordKey(updateId));
    this.#putTombstone(updateId, Date.now() + TOMBSTONE_TTL_MS);
  }

  #putTombstone(updateId: string, expiresAt: number): void {
    const key = tombstoneKey(updateId);
    const previous = this.storage.kv.get<Tombstone>(key);
    if (previous) this.storage.kv.delete(tombstoneExpiryKey(updateId, previous.expiresAt));
    this.storage.kv.put(key, { expiresAt } satisfies Tombstone);
    this.storage.kv.put(
      tombstoneExpiryKey(updateId, expiresAt),
      { updateId, dueAt: expiresAt } satisfies DueIndex,
    );
  }

  #hasTombstone(updateId: string, now: number): boolean {
    const key = tombstoneKey(updateId);
    const tombstone = this.storage.kv.get<Tombstone>(key);
    if (!tombstone) return false;
    if (tombstone.expiresAt > now) return true;
    this.storage.kv.delete(key);
    this.storage.kv.delete(tombstoneExpiryKey(updateId, tombstone.expiresAt));
    return false;
  }

  #update(updateId: string, transform: (record: TelegramUpdateRecord) => TelegramUpdateRecord): void {
    const key = pendingRecordKey(updateId);
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
    const start = parseTelegramStartUpdate(rawUpdate);
    if (start) {
      await this.#completeStart(start);
      return;
    }

    const bot = await this.getBotIdentity();
    const update = parseTelegramUpdate(rawUpdate, bot);
    if (!update) {
      const updateId = telegramUpdateId(rawUpdate);
      if (updateId) {
        this.#store.markIgnored(updateId);
        await this.#scheduleAlarm();
      }
      return;
    }
    const inserted = this.#store.enqueue(update);
    if (!inserted && !this.#store.get(update.updateId)) return;
    await this.ctx.storage.setAlarm(Date.now());
    this.ctx.waitUntil(this.#drain());
  }

  async receiveResponse(updateId: string, response: GadgetResponse): Promise<void> {
    this.#store.storeResponse(updateId, { text: response.text, chatPath: response.chatPath });
    await this.ctx.storage.setAlarm(Date.now());
    this.ctx.waitUntil(this.#drain());
  }

  async alarm(): Promise<void> {
    this.#store.cleanupExpiredTombstones();
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

  async #completeStart(update: TelegramStartUpdate): Promise<void> {
    if (this.#store.isDuplicate(update.updateId)) return;
    const result = await this.ctx.exports.IdentityRegistry.getByName("").completeExternalLink(
      "telegram",
      update.token,
      update.userId,
      update.updateId,
    );
    const text = result === null
      ? "This Telegram link is invalid or expired."
      : "Telegram connected.";
    await this.#api().sendMessage(update.chatId, text);
    this.#store.markIgnored(update.updateId);
    await this.#scheduleAlarm();
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    let processed = 0;
    try {
      while (processed < DRAIN_BATCH_SIZE) {
        const response = this.#store.nextResponse();
        if (response) {
          processed++;
          if (!(await this.#deliver(response))) break;
          continue;
        }
        const record = this.#store.claimNext();
        if (!record) break;
        processed++;
        if (!(await this.#process(record))) break;
      }
    } finally {
      this.#draining = false;
      if (processed === DRAIN_BATCH_SIZE) await this.ctx.storage.setAlarm(Date.now());
      else await this.#scheduleAlarm();
    }
  }

  async #process(record: TelegramUpdateRecord): Promise<boolean> {
    try {
      if (record.update.rejection) return await this.#rejectInput(record);

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
      if (error instanceof TelegramInputError) {
        return await this.#rejectInput(this.#store.get(record.update.updateId) ?? record);
      }
      return this.#handleFailure(record.update.updateId, error);
    }
  }

  async #rejectInput(record: TelegramUpdateRecord): Promise<boolean> {
    try {
      if (record.placeholderMessageId === undefined) {
        await this.#api().sendMessage(record.update.chatId, INPUT_REJECTION, record.update.threadId);
      } else {
        await this.#api().editMessage(record.update.chatId, record.placeholderMessageId, INPUT_REJECTION);
      }
      this.#store.markTerminal(record.update.updateId);
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

  async #scheduleAlarm(): Promise<void> {
    const next = this.#store.nextAlarmAt();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
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
