import { describe, expect, it } from "vitest";
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

  it("durably records link completion before Telegram delivery", () => {
    const store = new TelegramUpdateStore(makeMockStorage());
    store.enqueue({ kind: "link", updateId: "501", userId: "7", chatId: "7", token: "secret" });
    store.setLinkResult("501", "Telegram connected.");
    expect(store.get("501")).toMatchObject({
      status: "processing",
      linkResult: "Telegram connected.",
      update: { token: "" },
    });
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
