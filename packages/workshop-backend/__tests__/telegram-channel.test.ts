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
import serverSource from "../src/server.ts?raw";
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
  const receiveExternalMessage = vi.fn().mockResolvedValue({ accepted: true });
  const idFromString = vi.fn((value: string) => ({ toString: () => value }));
  const getOverseerByName = vi.fn(() => ({ receiveExternalMessage }));
  const state = {
    storage,
    waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(promise)),
    exports: {
      UserDurableObject: { idFromString },
      OverseerDurableObject: { getByName: getOverseerByName },
      TelegramResponseTarget: vi.fn(() => ({})),
    },
  } as unknown as DurableObjectState;
  return {
    channel: new TelegramChannel(state, env),
    storage,
    idFromString,
    getOverseerByName,
    receiveExternalMessage,
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

  it("completes /start in TelegramLinkStore and replays the exact update idempotently", async () => {
    const harness = makeChannel();
    const link = await harness.channel.startLink("canonical-user-do-id");
    const update = rawMessage(900, {
      text: `/start ${link.token}`,
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    });

    await harness.channel.enqueueUpdate(update);
    await harness.channel.enqueueUpdate(update);

    expect(await harness.channel.getLinkStatus("canonical-user-do-id"))
      .toEqual({ connected: true });
    expect(TelegramBotApi.prototype.sendMessage)
      .toHaveBeenCalledExactlyOnceWith("7", "Telegram connected.");
    expect(storedText(harness.storage)).not.toContain(link.token);
  });

  it("routes a linked numeric subject through the stored canonical User DO ID", async () => {
    const harness = makeChannel();
    const link = await harness.channel.startLink("canonical-user-do-id");
    await harness.channel.enqueueUpdate(rawMessage(904, {
      text: `/start ${link.token}`,
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    }));
    vi.mocked(TelegramBotApi.prototype.sendMessage).mockClear();

    await harness.channel.enqueueUpdate(rawMessage(905, {
      from: { id: 7, is_bot: false, username: "attacker-selected-user-do-id" },
    }));
    await harness.flush();

    expect(harness.idFromString).toHaveBeenCalledExactlyOnceWith("canonical-user-do-id");
    expect(harness.getOverseerByName).toHaveBeenCalledExactlyOnceWith("telegram:dm:7");
    expect(harness.receiveExternalMessage).toHaveBeenCalledOnce();
    expect(harness.receiveExternalMessage.mock.calls[0][0]).toBe("canonical-user-do-id");
    expect(harness.receiveExternalMessage.mock.calls[0][1]).toMatchObject({
      externalChatKey: "telegram:root",
      idempotencyKey: "telegram:905",
      prompt: "hello",
    });
  });

  it("rejects an unlinked Telegram subject before User DO reconstruction", async () => {
    const harness = makeChannel();

    await harness.channel.enqueueUpdate(rawMessage(906));
    await harness.flush();

    expect(harness.idFromString).not.toHaveBeenCalled();
    expect(harness.receiveExternalMessage).not.toHaveBeenCalled();
    expect(TelegramBotApi.prototype.editMessage).toHaveBeenCalledWith(
      "7",
      10,
      expect.stringMatching(/link.*account/i),
    );
  });

  it("keeps browser Telegram methods argument-free and forwards only the session User DO ID", () => {
    expect(serverSource).toMatch(
      /getTelegramLinkStatus\(\):[\s\S]*?\.getLinkStatus\(this\.#userId\.toString\(\)\)/,
    );
    expect(serverSource).toMatch(
      /startTelegramLink\(\):[\s\S]*?\.startLink\(this\.#userId\.toString\(\)\)/,
    );
    expect(serverSource).toMatch(
      /unlinkTelegram\(\):[\s\S]*?\.unlink\(this\.#userId\.toString\(\)\)/,
    );
  });

  it("re-arms a durably queued duplicate after the first alarm scheduling failure", async () => {
    const harness = makeChannel();
    const link = await harness.channel.startLink("canonical-user-do-id");
    await harness.channel.enqueueUpdate(rawMessage(899, {
      text: `/start ${link.token}`,
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    }));
    vi.mocked(TelegramBotApi.prototype.sendMessage).mockClear();
    vi.mocked(harness.storage.setAlarm).mockClear();
    vi.mocked(harness.storage.setAlarm)
      .mockRejectedValueOnce(new Error("alarm unavailable"))
      .mockResolvedValue(undefined);
    const update = rawMessage(903);

    await expect(harness.channel.enqueueUpdate(update)).rejects.toThrow("alarm unavailable");
    expect(harness.receiveExternalMessage).not.toHaveBeenCalled();

    await expect(harness.channel.enqueueUpdate(update)).resolves.toBeUndefined();
    await harness.flush();

    expect(harness.receiveExternalMessage).toHaveBeenCalledTimes(1);
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
    expect(harness.receiveExternalMessage).not.toHaveBeenCalled();
    expectNoRetryAlarm(harness.storage);
    expect(storedText(harness.storage)).not.toContain("oversized");

    await harness.channel.enqueueUpdate(rawMessage(901, {
      text: undefined,
      photo: [{ file_id: "oversized", width: 100, height: 100, file_size: 1_048_577 }],
    }));
    await harness.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("coordinates queued-message and link-cleanup alarms without losing either", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));
    try {
      const harness = makeChannel();
      const link = await harness.channel.startLink("pending-user-do-id");
      vi.mocked(harness.storage.setAlarm).mockClear();

      await harness.channel.enqueueUpdate(rawMessage(910));
      await harness.flush();

      expect(TelegramBotApi.prototype.editMessage).toHaveBeenCalled();
      expect(vi.mocked(harness.storage.setAlarm).mock.calls.at(-1)?.[0])
        .toBe(link.expiresAt.getTime());

      vi.setSystemTime(link.expiresAt);
      await harness.channel.alarm();

      expect(storedText(harness.storage)).not.toContain("pending-user-do-id");
      expect(vi.mocked(harness.storage.setAlarm).mock.calls.at(-1)?.[0])
        .toEqual(new Date("2026-04-02T12:00:00Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("coordinates retry and link-cleanup alarms without losing either", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));
    try {
      const harness = makeChannel();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const linked = await harness.channel.startLink("canonical-user-do-id");
      await harness.channel.enqueueUpdate(rawMessage(911, {
        text: `/start ${linked.token}`,
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }));
      const pending = await harness.channel.startLink("pending-user-do-id");
      harness.receiveExternalMessage.mockRejectedValueOnce(new Error("temporary failure"));
      vi.mocked(harness.storage.setAlarm).mockClear();

      await harness.channel.enqueueUpdate(rawMessage(912));
      await harness.flush();

      const retryAt = Date.now() + 5_000;
      expect(vi.mocked(harness.storage.setAlarm).mock.calls.at(-1)?.[0]).toBe(retryAt);

      vi.setSystemTime(retryAt);
      await harness.channel.alarm();
      expect(harness.receiveExternalMessage).toHaveBeenCalledTimes(2);
      expect(vi.mocked(harness.storage.setAlarm).mock.calls.at(-1)?.[0])
        .toBe(pending.expiresAt.getTime());

      vi.setSystemTime(pending.expiresAt);
      await harness.channel.alarm();
      expect(storedText(harness.storage)).not.toContain("pending-user-do-id");
    } finally {
      vi.useRealTimers();
    }
  });

  it("coordinates tombstone and link-cleanup alarms without losing either", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));
    try {
      const harness = makeChannel();
      const link = await harness.channel.startLink("pending-user-do-id");
      await harness.channel.enqueueUpdate({ update_id: 913 });

      expect(vi.mocked(harness.storage.setAlarm).mock.calls.at(-1)?.[0])
        .toBe(link.expiresAt.getTime());
      vi.setSystemTime(link.expiresAt);
      await harness.channel.alarm();
      expect(storedText(harness.storage)).not.toContain("pending-user-do-id");

      const tombstoneExpiry = new Date("2026-04-02T12:00:00Z").getTime();
      expect(vi.mocked(harness.storage.setAlarm).mock.calls.at(-1)?.[0])
        .toBe(tombstoneExpiry);
      vi.setSystemTime(tombstoneExpiry);
      await harness.channel.alarm();
      expect(storedText(harness.storage)).not.toContain("telegram:tombstone:update:");
    } finally {
      vi.useRealTimers();
    }
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
      expect(harness.receiveExternalMessage).not.toHaveBeenCalled();
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
