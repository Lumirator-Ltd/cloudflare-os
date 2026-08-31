import { describe, expect, it, vi } from "vitest";
import {
  MAX_TELEGRAM_PHOTO_BYTES,
  TelegramApiError,
  TelegramBotApi,
  formatTelegramResponse,
} from "../src/telegram/api.js";

const TOKEN = "123456:super-secret-token";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function streamBytes(size: number): Response {
  const chunks = [new Uint8Array(Math.ceil(size / 2)), new Uint8Array(Math.floor(size / 2))];
  return new Response(new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }));
}

describe("TelegramBotApi", () => {
  it("runtime-validates getMe and uses only the fixed Bot API origin", async () => {
    const calls: string[] = [];
    const api = new TelegramBotApi(TOKEN, {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return json({ ok: true, result: { id: 42, is_bot: true, username: "Verified_Bot" } });
      }),
    });

    await expect(api.getMe()).resolves.toEqual({ id: 42, username: "Verified_Bot" });
    expect(calls).toEqual([`https://api.telegram.org/bot${TOKEN}/getMe`]);
  });

  it("rejects malformed getMe identities", async () => {
    const api = new TelegramBotApi(TOKEN, {
      fetch: vi.fn().mockResolvedValue(json({
        ok: true,
        result: { id: -1, is_bot: true, username: "Verified_Bot" },
      })),
    });
    await expect(api.getMe()).rejects.toThrow("Telegram bot identity was invalid");
  });

  it("downloads getFile results from the fixed file origin and rejects unsafe paths", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/getFile")) return json({ ok: true, result: { file_path: "photos/file_1.jpg" } });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]));
    });
    const api = new TelegramBotApi(TOKEN, { fetch });

    await expect(api.downloadPhoto("photo-id")).resolves.toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(calls[1]).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`);

    fetch.mockResolvedValueOnce(json({ ok: true, result: { file_path: "../escape" } }));
    await expect(api.downloadPhoto("photo-id")).rejects.toThrow("Telegram file metadata was invalid");
  });

  it("rejects a downloaded file without a JPEG signature", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, result: { file_path: "photos/not-jpeg.jpg" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
    const api = new TelegramBotApi(TOKEN, { fetch });

    await expect(api.downloadPhoto("photo-id")).rejects.toMatchObject({
      message: "Telegram photo is not a valid JPEG.",
      retryable: false,
    });
  });

  it("hard-caps streamed photos even without a Content-Length header", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, result: { file_path: "photos/large.jpg" } }))
      .mockResolvedValueOnce(streamBytes(MAX_TELEGRAM_PHOTO_BYTES + 1));
    const api = new TelegramBotApi(TOKEN, { fetch });

    await expect(api.downloadPhoto("photo-id")).rejects.toMatchObject({
      message: "Telegram photo exceeds the size limit.",
      retryable: false,
    });
  });

  it("edits plain text and treats message-is-not-modified as success", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, result: { message_id: 9 } }))
      .mockResolvedValueOnce(json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, 400));
    const api = new TelegramBotApi(TOKEN, { fetch });

    await expect(api.sendMessage("-5", "Thinking…", 7)).resolves.toBe(9);
    await expect(api.editMessage("-5", 9, "done")).resolves.toBeUndefined();
    const editRequest = fetch.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(editRequest.body))).toEqual({ chat_id: "-5", message_id: 9, text: "done" });
  });

  it("classifies bounded 429 and 5xx/network failures without leaking secrets or raw responses", async () => {
    const api429 = new TelegramBotApi(TOKEN, {
      fetch: vi.fn().mockResolvedValue(json({
        ok: false,
        error_code: 429,
        description: `do not expose ${TOKEN}`,
        parameters: { retry_after: 999999 },
      }, 429)),
    });
    const error429 = await api429.sendMessage("1", "x").catch(error => error);
    expect(error429).toBeInstanceOf(TelegramApiError);
    expect(error429).toMatchObject({ retryable: true, retryAfterMs: 60_000 });
    expect(String(error429)).not.toContain(TOKEN);
    expect(String(error429)).not.toContain("do not expose");

    const api500 = new TelegramBotApi(TOKEN, { fetch: vi.fn().mockResolvedValue(json({}, 503)) });
    await expect(api500.sendMessage("1", "x")).rejects.toMatchObject({ retryable: true });

    const api400 = new TelegramBotApi(TOKEN, {
      fetch: vi.fn().mockResolvedValue(json({ ok: false, error_code: 500 }, 400)),
    });
    await expect(api400.sendMessage("1", "x")).rejects.toMatchObject({ retryable: false });

    const network = new TelegramBotApi(TOKEN, { fetch: vi.fn().mockRejectedValue(new Error(`url ${TOKEN}`)) });
    const networkError = await network.sendMessage("1", "x").catch(error => error);
    expect(networkError).toMatchObject({ retryable: true });
    expect(String(networkError)).not.toContain(TOKEN);
  });
});

describe("formatTelegramResponse", () => {
  it("bounds output while preserving an absolute Workshop chat URL", () => {
    const url = "https://workshop.example/workspace/abc?chat=3";
    const result = formatTelegramResponse("x".repeat(10_000), url);
    expect(result.length).toBeLessThanOrEqual(4096);
    expect(result.endsWith(url)).toBe(true);
  });
});
