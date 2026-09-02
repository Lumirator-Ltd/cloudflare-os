import { describe, expect, it } from "vitest";
import { TelegramLinkStore } from "../src/telegram/link-store.js";
import { makeMockStorage } from "./mock-storage.js";

const TEN_MINUTES = 10 * 60_000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 3, 1, 12);

function entries(storage: DurableObjectStorage): [string, unknown][] {
  return [...storage.kv.list()];
}

function primaryRecordCount(storage: DurableObjectStorage, collection: string): number {
  const prefix = `${collection}:`;
  return entries(storage).filter(([key]) =>
    key.startsWith(prefix) && !key.slice(prefix.length).includes("."),
  ).length;
}

describe("TelegramLinkStore", () => {
  it("creates random ten-minute tokens while persisting only their SHA-256 digest", async () => {
    const storage = makeMockStorage();
    const store = new TelegramLinkStore(storage);
    const first = await store.start("user-do-01", NOW);
    const second = await store.start("user-do-02", NOW);
    const firstDigest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(first.token),
    )).toHex();
    const serialized = JSON.stringify(entries(storage));

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(first.token);
    expect(first.expiresAt).toEqual(new Date(NOW + TEN_MINUTES));
    expect(serialized).toContain(firstDigest);
    expect(serialized).not.toContain(first.token);
    expect(serialized).toContain("user-do-01");
    expect(serialized).not.toMatch(/email|profile|registry/i);
  });

  it("keeps only the latest pending token for each Workshop user", async () => {
    const store = new TelegramLinkStore(makeMockStorage());
    const first = await store.start("user-do-latest", NOW);
    const second = await store.start("user-do-latest", NOW + 1);

    await expect(store.complete(first.token, "1001", "update-old", NOW + 2)).resolves.toBeNull();
    await expect(store.complete(second.token, "1001", "update-new", NOW + 2))
      .resolves.toBe("user-do-latest");
  });

  it("expires pending tokens after ten minutes", async () => {
    const store = new TelegramLinkStore(makeMockStorage());
    const started = await store.start("user-do-expired", NOW);

    await expect(store.complete(started.token, "1002", "update-expired", NOW + TEN_MINUTES))
      .resolves.toBeNull();
    expect(store.status("user-do-expired", NOW + TEN_MINUTES)).toEqual({ connected: false });
  });

  it("maintains a one-to-one bidirectional user and Telegram subject mapping", async () => {
    const store = new TelegramLinkStore(makeMockStorage());
    const first = await store.start("user-do-one", NOW);
    expect(await store.complete(first.token, "2001", "update-1", NOW + 1)).toBe("user-do-one");

    const replacement = await store.start("user-do-one", NOW + 2);
    expect(await store.complete(replacement.token, "2002", "update-2", NOW + 3))
      .toBe("user-do-one");
    expect(store.findUserDurableObjectId("2001")).toBeNull();
    expect(store.findUserDurableObjectId("2002")).toBe("user-do-one");
    expect(store.status("user-do-one", NOW + 3)).toEqual({ connected: true });

    const collision = await store.start("user-do-two", NOW + 4);
    expect(await store.complete(collision.token, "2002", "update-3", NOW + 5)).toBeNull();
    expect(store.findUserDurableObjectId("2002")).toBe("user-do-one");
    expect(store.status("user-do-two", NOW + 5)).toEqual({ connected: false });
  });

  it("consumes a token atomically so concurrent completion has exactly one owner", async () => {
    const store = new TelegramLinkStore(makeMockStorage());
    const started = await store.start("user-do-race", NOW);

    const results = await Promise.all([
      store.complete(started.token, "3001", "update-race-a", NOW + 1),
      store.complete(started.token, "3001", "update-race-b", NOW + 1),
    ]);

    expect(results.filter(result => result === "user-do-race")).toHaveLength(1);
    expect(results.filter(result => result === null)).toHaveLength(1);
    await expect(store.complete(started.token, "3001", "update-race-c", NOW + 2))
      .resolves.toBeNull();
  });

  it("replays only an exact token, subject, and operation receipt", async () => {
    const store = new TelegramLinkStore(makeMockStorage());
    const started = await store.start("user-do-retry", NOW);

    expect(await store.complete(started.token, "4001", "update-retry", NOW + 1))
      .toBe("user-do-retry");
    expect(await store.complete(started.token, "4001", "update-retry", NOW + 2))
      .toBe("user-do-retry");
    expect(await store.complete(started.token, "4002", "update-retry", NOW + 2)).toBeNull();
    const otherToken = `${started.token[0] === "A" ? "B" : "A"}${started.token.slice(1)}`;
    expect(await store.complete(otherToken, "4001", "update-retry", NOW + 2)).toBeNull();
    expect(await store.complete(started.token, "4001", "different-update", NOW + 2)).toBeNull();
  });

  it("expires idempotency receipts after 24 hours", async () => {
    const store = new TelegramLinkStore(makeMockStorage());
    const started = await store.start("user-do-receipt", NOW);
    expect(await store.complete(started.token, "5001", "update-receipt", NOW + 1))
      .toBe("user-do-receipt");

    expect(await store.complete(
      started.token,
      "5001",
      "update-receipt",
      NOW + 1 + TWENTY_FOUR_HOURS,
    )).toBeNull();
  });

  it("allows an operation key to be reused after its receipt expires despite cleanup backlog", async () => {
    const store = new TelegramLinkStore(makeMockStorage());
    const original = await store.start("user-do-original-receipt", NOW);
    expect(await store.complete(original.token, "5002", "update-reusable", NOW + 1))
      .toBe("user-do-original-receipt");
    for (let index = 0; index < 201; index++) {
      await store.start(`user-do-receipt-backlog-${index}`, NOW);
    }
    const receiptExpiry = NOW + 1 + TWENTY_FOUR_HOURS;
    const replacement = await store.start("user-do-reused-receipt", receiptExpiry - 5 * 60_000);

    expect(await store.complete(replacement.token, "5003", "update-reusable", receiptExpiry))
      .toBe("user-do-reused-receipt");
  });

  it("unlink removes both the active link and the latest pending token", async () => {
    const store = new TelegramLinkStore(makeMockStorage());
    const linked = await store.start("user-do-unlink", NOW);
    expect(await store.complete(linked.token, "6001", "update-link", NOW + 1))
      .toBe("user-do-unlink");
    const pending = await store.start("user-do-unlink", NOW + 2);

    store.unlink("user-do-unlink", NOW + 3);

    expect(store.status("user-do-unlink", NOW + 3)).toEqual({ connected: false });
    expect(store.findUserDurableObjectId("6001")).toBeNull();
    expect(await store.complete(pending.token, "6002", "update-after-unlink", NOW + 4))
      .toBeNull();
  });

  it("cleans at most 100 expired records per call and reports the earliest remaining deadline", async () => {
    const storage = makeMockStorage();
    const store = new TelegramLinkStore(storage);
    for (let index = 0; index < 101; index++) {
      await store.start(`user-do-cleanup-${index}`, NOW);
    }

    expect(primaryRecordCount(storage, "telegramLinkTokens")).toBe(101);
    expect(store.nextAlarmAt()).toBe(NOW + TEN_MINUTES);

    expect(store.cleanup(NOW + TEN_MINUTES, 1_000)).toEqual({
      nextAlarmAt: NOW + TEN_MINUTES,
    });
    expect(primaryRecordCount(storage, "telegramLinkTokens")).toBe(1);

    expect(store.cleanup(NOW + TEN_MINUTES)).toEqual({ nextAlarmAt: null });
    expect(primaryRecordCount(storage, "telegramLinkTokens")).toBe(0);
    expect(store.nextAlarmAt()).toBeNull();
  });

  it("shares the cleanup bound across token and receipt records and honors smaller limits", async () => {
    const storage = makeMockStorage();
    const store = new TelegramLinkStore(storage);
    const completed = await store.start("user-do-cleanup-receipt", NOW);
    expect(await store.complete(
      completed.token,
      "7001",
      "update-cleanup-receipt",
      NOW + 1,
    )).toBe("user-do-cleanup-receipt");
    await store.start("user-do-cleanup-token", NOW + 2);
    const cleanupAt = NOW + 1 + TWENTY_FOUR_HOURS;

    expect(store.cleanup(cleanupAt, 1)).toEqual({ nextAlarmAt: cleanupAt });
    expect(
      primaryRecordCount(storage, "telegramLinkTokens") +
      primaryRecordCount(storage, "telegramLinkReceipts"),
    ).toBe(1);
    expect(store.cleanup(cleanupAt, 1)).toEqual({ nextAlarmAt: null });
  });

  it("fails closed for malformed tokens without mutating links", async () => {
    const store = new TelegramLinkStore(makeMockStorage());
    const malformed = [
      "",
      "short",
      "a".repeat(44),
      `${"a".repeat(42)}!`,
      null as unknown as string,
    ];

    for (const token of malformed) {
      await expect(store.complete(token, "8001", "update-malformed", NOW)).resolves.toBeNull();
    }
    expect(store.findUserDurableObjectId("8001")).toBeNull();
  });

  it("reports the earliest token or receipt deadline for shared alarm scheduling", async () => {
    const store = new TelegramLinkStore(makeMockStorage());
    expect(store.nextAlarmAt()).toBeNull();

    const first = await store.start("user-do-alarm-first", NOW);
    await store.start("user-do-alarm-second", NOW + 100);
    expect(store.nextAlarmAt()).toBe(NOW + TEN_MINUTES);

    expect(await store.complete(first.token, "9001", "update-alarm", NOW + 1))
      .toBe("user-do-alarm-first");
    expect(store.nextAlarmAt()).toBe(NOW + TEN_MINUTES + 100);
  });
});
