import { collection, createTypedStorage } from "@gadgets/typed-storage";

const LINK_TOKEN_TTL_MS = 10 * 60_000;
const RECEIPT_TTL_MS = 24 * 60 * 60_000;
const MAX_CLEANUP_RECORDS = 100;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type LinkTokenRecord = {
  userDurableObjectId: string;
  digest: string;
  expiresAt: number;
};

type LinkRecord = {
  telegramUserId: string;
  userDurableObjectId: string;
};

type CompletionReceipt = {
  operationKey: string;
  telegramUserId: string;
  tokenDigest: string;
  userDurableObjectId: string;
  expiresAt: number;
};

function expiryKey(expiresAt: number, key: string): string {
  return `${expiresAt.toString().padStart(16, "0")}:${key}`;
}

function makeStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      telegramLinkTokens: collection<LinkTokenRecord>()({
        primaryKey: "userDurableObjectId",
        uniqueIndexes: {
          byDigest: (record: LinkTokenRecord) => record.digest,
          byExpiry: (record: LinkTokenRecord) => expiryKey(record.expiresAt, record.digest),
        },
      }),
      telegramLinks: collection<LinkRecord>()({
        primaryKey: "telegramUserId",
        uniqueIndexes: {
          byUser: (record: LinkRecord) => record.userDurableObjectId,
        },
      }),
      telegramLinkReceipts: collection<CompletionReceipt>()({
        primaryKey: "operationKey",
        uniqueIndexes: {
          byExpiry: (record: CompletionReceipt) => expiryKey(
            record.expiresAt,
            record.operationKey,
          ),
        },
      }),
    },
  });
}

type LinkStorage = ReturnType<typeof makeStorage>;

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes.toBase64({ alphabet: "base64url" }).replace(/=+$/, "");
}

async function digestToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
}

export class TelegramLinkStore {
  readonly #storage: LinkStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = makeStorage(storage);
  }

  async start(
    userDurableObjectId: string,
    now = Date.now(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const digest = await digestToken(token);
    const expiresAt = now + LINK_TOKEN_TTL_MS;
    this.#storage.transaction(() => {
      this.#cleanup(now, MAX_CLEANUP_RECORDS);
      this.#storage.telegramLinkTokens.put({ userDurableObjectId, digest, expiresAt });
    });
    return { token, expiresAt: new Date(expiresAt) };
  }

  async complete(
    token: string,
    telegramUserId: string,
    operationKey: string,
    now = Date.now(),
  ): Promise<string | null> {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
    const tokenDigest = await digestToken(token);
    return this.#storage.transaction(() => {
      this.#cleanup(now, MAX_CLEANUP_RECORDS);
      const receipt = this.#storage.telegramLinkReceipts.get(operationKey);
      if (receipt) {
        if (receipt.expiresAt <= now) {
          this.#storage.telegramLinkReceipts.delete(operationKey);
        } else {
          return receipt.telegramUserId === telegramUserId &&
              receipt.tokenDigest === tokenDigest
            ? receipt.userDurableObjectId
            : null;
        }
      }

      const pending = this.#storage.telegramLinkTokens.byDigest.get(tokenDigest);
      if (!pending || pending.expiresAt <= now) return null;
      const latest = this.#storage.telegramLinkTokens.get(pending.userDurableObjectId);
      if (latest?.digest !== tokenDigest) return null;
      this.#storage.telegramLinkTokens.delete(pending.userDurableObjectId);

      const target = this.#storage.telegramLinks.get(telegramUserId);
      if (target && target.userDurableObjectId !== pending.userDurableObjectId) return null;
      const previous = this.#storage.telegramLinks.byUser.get(pending.userDurableObjectId);
      if (previous && previous.telegramUserId !== telegramUserId) {
        this.#storage.telegramLinks.delete(previous.telegramUserId);
      }
      this.#storage.telegramLinks.put({
        telegramUserId,
        userDurableObjectId: pending.userDurableObjectId,
      });
      this.#storage.telegramLinkReceipts.put({
        operationKey,
        telegramUserId,
        tokenDigest,
        userDurableObjectId: pending.userDurableObjectId,
        expiresAt: now + RECEIPT_TTL_MS,
      });
      return pending.userDurableObjectId;
    });
  }

  status(userDurableObjectId: string, now = Date.now()): { connected: boolean } {
    return this.#storage.transaction(() => {
      this.#cleanup(now, MAX_CLEANUP_RECORDS);
      return {
        connected: this.#storage.telegramLinks.byUser.get(userDurableObjectId) !== undefined,
      };
    });
  }

  unlink(userDurableObjectId: string, now = Date.now()): void {
    this.#storage.transaction(() => {
      this.#cleanup(now, MAX_CLEANUP_RECORDS);
      const link = this.#storage.telegramLinks.byUser.get(userDurableObjectId);
      if (link) this.#storage.telegramLinks.delete(link.telegramUserId);
      this.#storage.telegramLinkTokens.delete(userDurableObjectId);
    });
  }

  findUserDurableObjectId(telegramUserId: string): string | null {
    return this.#storage.telegramLinks.get(telegramUserId)?.userDurableObjectId ?? null;
  }

  cleanup(now = Date.now(), limit = MAX_CLEANUP_RECORDS): { nextAlarmAt: number | null } {
    return this.#storage.transaction(() => {
      this.#cleanup(now, Math.max(0, Math.min(MAX_CLEANUP_RECORDS, Math.floor(limit))));
      return { nextAlarmAt: this.#nextAlarmAt() };
    });
  }

  nextAlarmAt(): number | null {
    return this.#nextAlarmAt();
  }

  #cleanup(now: number, limit: number): void {
    for (let count = 0; count < limit; count++) {
      const token = this.#nextToken();
      const receipt = this.#nextReceipt();
      if ((!token || token.expiresAt > now) && (!receipt || receipt.expiresAt > now)) return;
      if (!receipt || (token && token.expiresAt <= receipt.expiresAt)) {
        this.#storage.telegramLinkTokens.delete(token!.userDurableObjectId);
      } else {
        this.#storage.telegramLinkReceipts.delete(receipt.operationKey);
      }
    }
  }

  #nextAlarmAt(): number | null {
    const tokenAt = this.#nextToken()?.expiresAt;
    const receiptAt = this.#nextReceipt()?.expiresAt;
    if (tokenAt === undefined) return receiptAt ?? null;
    if (receiptAt === undefined) return tokenAt;
    return Math.min(tokenAt, receiptAt);
  }

  #nextToken(): LinkTokenRecord | undefined {
    return [...this.#storage.telegramLinkTokens.byExpiry.list({ limit: 1 })][0];
  }

  #nextReceipt(): CompletionReceipt | undefined {
    return [...this.#storage.telegramLinkReceipts.byExpiry.list({ limit: 1 })][0];
  }
}
