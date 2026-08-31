import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: DurableObjectState;
    protected env: Cloudflare.Env;

    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkerEntrypoint: class {
    readonly __mock = true;
  },
}));

import { TelegramBotApi, TelegramInputError } from "../src/telegram/api.js";
import { TelegramChannel } from "../src/telegram/channel.js";
import { makeMockStorage } from "./mock-storage.js";

const bot = { id: 42, username: "verified_bot" };
const env = {
  TELEGRAM_BOT_TOKEN: "123:secret-token",
  PUBLIC_BASE_URL: "https://workshop.example",
} as Cloudflare.Env;

function rawMessage(updateId: number, overrides: Record<string, unknown> = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      from: { id: 7, is_bot: false },
      chat: { id: 7, type: "private" },
      text: "hello",
      ...overrides,
    },
  };
}

function makeChannel() {
  const storage = makeMockStorage();
  storage.setAlarm = vi.fn().mockResolvedValue(undefined);
  storage.deleteAlarm = vi.fn().mockResolvedValue(undefined);
  const pending: Promise<unknown>[] = [];
  const completeExternalLink = vi.fn().mockResolvedValue("internal-user");
  const submitExternalMessage = vi.fn().mockResolvedValue({ accepted: true });
  const state = {
    storage,
    waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(promise)),
    exports: {
      IdentityRegistry: { getByName: vi.fn(() => ({ completeExternalLink })) },
      TelegramResponseTarget: vi.fn(() => ({})),
      ExternalMessageGateway: vi.fn(() => ({ submitExternalMessage })),
    },
  } as unknown as DurableObjectState;
  return {
    channel: new TelegramChannel(state, env),
    storage,
    completeExternalLink,
    submitExternalMessage,
    async flush() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
  };
}

function storedText(storage: DurableObjectStorage): string {
  return JSON.stringify([...storage.kv.list()]);
}

function expectNoRetryAlarm(storage: DurableObjectStorage): void {
  const alarms = vi.mocked(storage.setAlarm).mock.calls.map(([time]) => Number(time));
  expect(alarms).toHaveLength(2);
  expect(alarms[1]).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
}

describe("TelegramChannel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(TelegramBotApi.prototype, "getMe").mockResolvedValue(bot);
    vi.spyOn(TelegramBotApi.prototype, "sendMessage").mockResolvedValue(10);
    vi.spyOn(TelegramBotApi.prototype, "editMessage").mockResolvedValue(undefined);
  });

  it("completes private /start synchronously without persisting its bearer token", async () => {
    const harness = makeChannel();
    const token = "raw-link-bearer";
    harness.completeExternalLink
      .mockRejectedValueOnce(new Error("registry acknowledgement lost"))
      .mockResolvedValueOnce("internal-user");
    const update = rawMessage(900, {
      text: `/start ${token}`,
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    });

    await expect(harness.channel.enqueueUpdate(update)).rejects.toThrow();
    expect(storedText(harness.storage)).not.toContain(token);

    await expect(harness.channel.enqueueUpdate(update)).resolves.toBeUndefined();
    expect(harness.completeExternalLink).toHaveBeenCalledTimes(2);
    expect(harness.completeExternalLink).toHaveBeenLastCalledWith(
      "telegram",
      token,
      "7",
      "900",
    );
    expect(storedText(harness.storage)).not.toContain(token);
  });

  it("re-arms a durably queued duplicate after the first alarm scheduling failure", async () => {
    const harness = makeChannel();
    vi.mocked(harness.storage.setAlarm)
      .mockRejectedValueOnce(new Error("alarm unavailable"))
      .mockResolvedValue(undefined);
    const update = rawMessage(903);

    await expect(harness.channel.enqueueUpdate(update)).rejects.toThrow("alarm unavailable");
    expect(harness.submitExternalMessage).not.toHaveBeenCalled();

    await expect(harness.channel.enqueueUpdate(update)).resolves.toBeUndefined();
    await harness.flush();

    expect(harness.submitExternalMessage).toHaveBeenCalledTimes(1);
    expect(TelegramBotApi.prototype.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends one direct rejection for a declared oversized photo", async () => {
    const harness = makeChannel();
    const send = vi.mocked(TelegramBotApi.prototype.sendMessage);

    await harness.channel.enqueueUpdate(rawMessage(901, {
      text: undefined,
      photo: [{ file_id: "oversized", width: 100, height: 100, file_size: 1_048_577 }],
    }));
    await harness.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatch(/JPEG.*1 MB/i);
    expect(harness.submitExternalMessage).not.toHaveBeenCalled();
    expectNoRetryAlarm(harness.storage);
    expect(storedText(harness.storage)).not.toContain("oversized");

    await harness.channel.enqueueUpdate(rawMessage(901, {
      text: undefined,
      photo: [{ file_id: "oversized", width: 100, height: 100, file_size: 1_048_577 }],
    }));
    await harness.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  for (const [name, error] of [
    ["streamed oversized photo", new TelegramInputError("Telegram photo exceeds the size limit.", "photoTooLarge")],
    ["invalid JPEG signature", new TelegramInputError("Telegram photo is not a valid JPEG.", "invalidJpeg")],
  ] as const) {
    it(`edits the placeholder once for a ${name} and does not retry`, async () => {
      const harness = makeChannel();
      vi.spyOn(TelegramBotApi.prototype, "downloadPhoto").mockRejectedValue(error);
      const send = vi.mocked(TelegramBotApi.prototype.sendMessage);
      const edit = vi.mocked(TelegramBotApi.prototype.editMessage);

      await harness.channel.enqueueUpdate(rawMessage(902, {
        text: undefined,
        photo: [{ file_id: "photo", width: 100, height: 100, file_size: 1_000 }],
      }));
      await harness.flush();

      expect(send).toHaveBeenCalledExactlyOnceWith("7", "Thinking…", undefined);
      expect(edit).toHaveBeenCalledTimes(1);
      expect(edit.mock.calls[0][2]).toMatch(/JPEG.*1 MB/i);
      expect(harness.submitExternalMessage).not.toHaveBeenCalled();
      expectNoRetryAlarm(harness.storage);
      expect(storedText(harness.storage)).not.toContain("photo");

      await harness.channel.enqueueUpdate(rawMessage(902, {
        text: undefined,
        photo: [{ file_id: "photo", width: 100, height: 100, file_size: 1_000 }],
      }));
      await harness.flush();
      expect(send).toHaveBeenCalledTimes(1);
      expect(edit).toHaveBeenCalledTimes(1);
    });
  }
});
