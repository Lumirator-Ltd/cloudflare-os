import { describe, expect, it, vi } from "vitest";
import { TelegramUpdateStore } from "../src/telegram/channel.js";
import type { NormalizedTelegramUpdate } from "../src/telegram/types.js";
import { makeMockStorage } from "./mock-storage.js";

const update: NormalizedTelegramUpdate = {
  kind: "message",
  updateId: "500",
  userId: "7",
  chatId: "7",
  workspaceKey: "dm:7",
  chatKey: "root",
  prompt: "hello",
  title: "Telegram chat",
};

function storageText(storage: DurableObjectStorage): string {
  return JSON.stringify([...storage.kv.list()]);
}

describe("TelegramUpdateStore", () => {
  it("durably ignores duplicates while accepting out-of-order update IDs", () => {
    const store = new TelegramUpdateStore(makeMockStorage());
    expect(store.enqueue(update)).toBe(true);
    expect(store.enqueue({ ...update, prompt: "duplicate" })).toBe(false);
    expect(store.enqueue({ ...update, updateId: "499" })).toBe(true);
    expect(store.get("500")).toMatchObject({ status: "queued", update: { prompt: "hello" } });
    expect(store.get("499")).toMatchObject({ status: "queued" });
  });

  it("stores callback text and chatPath before returning responseReady", () => {
    const store = new TelegramUpdateStore(makeMockStorage());
    store.enqueue(update);
    store.setPlaceholder("500", 91);
    store.markSubmitted("500");

    store.storeResponse("500", { text: "answer", chatPath: "/workspace/a?chat=2" });
    store.markSubmitted("500");

    expect(store.get("500")).toMatchObject({
      status: "responseReady",
      placeholderMessageId: 91,
      response: { text: "answer", chatPath: "/workspace/a?chat=2" },
    });
  });

  it("redacts delivered and terminal payloads into minimal tombstones", () => {
    const storage = makeMockStorage();
    const store = new TelegramUpdateStore(storage);
    store.enqueue({ ...update, prompt: "sensitive prompt" });
    store.setPlaceholder("500", 91);
    store.storeResponse("500", { text: "sensitive response", chatPath: "/sensitive" });
    store.markDelivered("500");

    store.enqueue({ ...update, updateId: "501", prompt: "other sensitive prompt" });
    store.markTerminal("501");
    store.markIgnored("502");

    const serialized = storageText(storage);
    expect(serialized).not.toContain("sensitive prompt");
    expect(serialized).not.toContain("sensitive response");
    expect(serialized).not.toContain("other sensitive prompt");
    expect(store.get("500")).toBeUndefined();
    expect(store.get("501")).toBeUndefined();
    expect(store.enqueue(update)).toBe(false);
    expect(store.enqueue({ ...update, updateId: "501" })).toBe(false);
    expect(store.enqueue({ ...update, updateId: "502" })).toBe(false);
  });

  it("expires tombstones after the 24-hour dedupe horizon", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));
    try {
      const storage = makeMockStorage();
      const store = new TelegramUpdateStore(storage);
      store.enqueue(update);
      store.markDelivered("500");
      expect(store.enqueue(update)).toBe(false);

      vi.advanceTimersByTime(24 * 60 * 60_000 + 1);

      expect(store.enqueue(update)).toBe(true);
      expect(storageText(storage)).not.toContain("telegram:tombstone:expiry:");
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims current work without scanning completed tombstones", () => {
    const storage = makeMockStorage();
    const store = new TelegramUpdateStore(storage);
    for (let index = 0; index < 2_000; index++) {
      const updateId = String(10_000 + index);
      store.enqueue({ ...update, updateId, prompt: `history-${index}` });
      store.markDelivered(updateId);
    }
    store.enqueue(update);
    const list = vi.spyOn(storage.kv, "list");

    expect(store.claimNext()).toMatchObject({ update: { updateId: "500" } });

    expect(list.mock.calls.length).toBeGreaterThan(0);
    expect(list.mock.calls.every(([options]) =>
      (options as DurableObjectListOptions | undefined)?.prefix === "telegram:pending:due:"
    )).toBe(true);
  });

  it("resets interrupted processing without resubmitting submitted turns", () => {
    const store = new TelegramUpdateStore(makeMockStorage());
    store.enqueue(update);
    expect(store.claimNext()).toMatchObject({ status: "processing" });
    expect(store.claimNext()).toMatchObject({ status: "processing", update: { updateId: "500" } });
    store.markSubmitted("500");
    expect(store.claimNext()).toBeNull();
  });
});
