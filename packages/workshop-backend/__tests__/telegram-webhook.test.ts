import { describe, expect, it, vi } from "vitest";
import { handleTelegramWebhook } from "../src/telegram/webhook.js";

const env = {
  TELEGRAM_BOT_TOKEN: "123:token",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
} as Cloudflare.Env;

function request(body: BodyInit | null = JSON.stringify({ update_id: 1, message: {} }), init: RequestInit = {}) {
  return new Request("https://workshop.example/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "webhook-secret",
    },
    body,
    ...init,
  });
}

function channel() {
  return { enqueueUpdate: vi.fn().mockResolvedValue(undefined) };
}

describe("handleTelegramWebhook", () => {
  it("fails closed with an indistinguishable 404 for method, config, or authentication failures", async () => {
    expect((await handleTelegramWebhook(request(null, { method: "GET" }), env, channel())).status).toBe(404);
    expect((await handleTelegramWebhook(request(), { ...env, TELEGRAM_BOT_TOKEN: undefined }, channel())).status).toBe(404);
    expect((await handleTelegramWebhook(request(undefined, {
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
    }), env, channel())).status).toBe(404);
  });

  it("rejects Content-Length above 256 KiB before reading", async () => {
    const target = channel();
    const response = await handleTelegramWebhook(request("{}", {
      headers: {
        "x-telegram-bot-api-secret-token": "webhook-secret",
        "content-length": String(256 * 1024 + 1),
      },
    }), env, target);
    expect(response.status).toBe(413);
    expect(target.enqueueUpdate).not.toHaveBeenCalled();
  });

  it("rejects streaming bodies above 256 KiB before JSON parsing", async () => {
    const target = channel();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200 * 1024));
        controller.enqueue(new Uint8Array(60 * 1024));
        controller.close();
      },
    });
    const response = await handleTelegramWebhook(request(body), env, target);
    expect(response.status).toBe(413);
    expect(target.enqueueUpdate).not.toHaveBeenCalled();
  });

  it("returns 200 only after the durable enqueue resolves", async () => {
    const enqueued = Promise.withResolvers<void>();
    const target = { enqueueUpdate: vi.fn(() => enqueued.promise) };
    const pending = handleTelegramWebhook(request(JSON.stringify({ update_id: 88, message: {} })), env, target);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    enqueued.resolve();
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(target.enqueueUpdate).toHaveBeenCalledExactlyOnceWith({ update_id: 88, message: {} });
  });

  it("rejects malformed JSON without enqueueing", async () => {
    const target = channel();
    expect((await handleTelegramWebhook(request("{"), env, target)).status).toBe(400);
    expect(target.enqueueUpdate).not.toHaveBeenCalled();
  });
});
