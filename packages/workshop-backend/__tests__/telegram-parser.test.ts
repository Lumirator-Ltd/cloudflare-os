import { describe, expect, it } from "vitest";
import { parseTelegramUpdate } from "../src/telegram/parser.js";

const bot = { id: 42, username: "verified_bot" };

function message(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 10,
    from: { id: 7, is_bot: false, first_name: "Private profile" },
    chat: { id: 7, type: "private", first_name: "Private profile" },
    text: "hello",
    ...overrides,
  };
}

describe("parseTelegramUpdate", () => {
  it("routes private messages without retaining Telegram profiles", () => {
    expect(parseTelegramUpdate({ update_id: 101, message: message() }, bot)).toEqual({
      kind: "message",
      updateId: "101",
      userId: "7",
      chatId: "7",
      workspaceKey: "dm:7",
      chatKey: "root",
      prompt: "hello",
      title: "Telegram chat",
    });
  });

  it("accepts private /start only when the chat and sender IDs match", () => {
    expect(parseTelegramUpdate({
      update_id: 102,
      message: message({ text: "/start opaque-token", entities: [{ type: "bot_command", offset: 0, length: 6 }] }),
    }, bot)).toEqual({ kind: "link", updateId: "102", userId: "7", chatId: "7", token: "opaque-token" });

    expect(parseTelegramUpdate({
      update_id: 103,
      message: message({ chat: { id: -1, type: "group" }, text: "/start opaque-token" }),
    }, bot)).toBeNull();
    expect(parseTelegramUpdate({
      update_id: 115,
      message: message({
        text: "/start@verified_bot opaque-token",
        entities: [{ type: "bot_command", offset: 0, length: 19 }],
      }),
    }, bot)).toBeNull();
  });

  it("requires verified Telegram entities for group activation", () => {
    const base = { chat: { id: -200, type: "supergroup", title: "Secret group title" } };
    expect(parseTelegramUpdate({ update_id: 104, message: message({ ...base, text: "@verified_bot fake" }) }, bot)).toBeNull();
    expect(parseTelegramUpdate({
      update_id: 105,
      message: message({
        ...base,
        text: "😀 @verified_bot help",
        entities: [{ type: "mention", offset: 3, length: 13 }],
      }),
    }, bot)).toMatchObject({
      kind: "message",
      workspaceKey: "group:-200",
      prompt: "😀  help",
      title: "Telegram group",
    });
  });

  it("accepts only /ask commands for the verified bot and strips the command", () => {
    const group = { id: -200, type: "group" };
    const parse = (text: string, length: number) => parseTelegramUpdate({
      update_id: 106,
      message: message({ chat: group, text, entities: [{ type: "bot_command", offset: 0, length }] }),
    }, bot);

    expect(parse("/ask@other_bot nope", 14)).toBeNull();
    expect(parse("/ask@verified_bot explain", 17)).toMatchObject({ prompt: "explain" });
    expect(parse("/other nope", 6)).toBeNull();
  });

  it("accepts replies to the verified numeric bot ID and preserves topic routing", () => {
    expect(parseTelegramUpdate({
      update_id: 107,
      message: message({
        chat: { id: -300, type: "supergroup" },
        message_thread_id: 88,
        text: "continue",
        reply_to_message: { message_id: 9, from: { id: 42, is_bot: true } },
      }),
    }, bot)).toMatchObject({ workspaceKey: "group:-300", chatKey: "topic:88", prompt: "continue" });
  });

  it("selects the largest declared photo at most one MiB and supplies a caption fallback", () => {
    expect(parseTelegramUpdate({
      update_id: 108,
      message: message({
        text: undefined,
        photo: [
          { file_id: "small", width: 10, height: 10, file_size: 100 },
          { file_id: "best", width: 100, height: 100, file_size: 1_048_576 },
          { file_id: "too-big", width: 200, height: 200, file_size: 1_048_577 },
        ],
      }),
    }, bot)).toMatchObject({
      prompt: "Please analyze this image.",
      photo: { fileId: "best" },
    });
  });

  it("rejects unsupported updates, bot/anonymous senders, albums, and malformed UTF-16 ranges", () => {
    expect(parseTelegramUpdate({ update_id: -1, message: message() }, bot)).toBeNull();
    expect(parseTelegramUpdate({ update_id: 109, edited_message: message() }, bot)).toBeNull();
    expect(parseTelegramUpdate({ update_id: 110, message: message({ from: { id: 7, is_bot: true } }) }, bot)).toBeNull();
    expect(parseTelegramUpdate({ update_id: 111, message: message({ sender_chat: { id: -3 } }) }, bot)).toBeNull();
    expect(parseTelegramUpdate({ update_id: 112, message: message({ media_group_id: "album" }) }, bot)).toBeNull();
    expect(parseTelegramUpdate({
      update_id: 114,
      message: message({ document: { file_id: "unsupported" } }),
    }, bot)).toBeNull();
    expect(parseTelegramUpdate({
      update_id: 113,
      message: message({
        chat: { id: -2, type: "group" },
        text: "😀 @verified_bot",
        entities: [{ type: "mention", offset: 1, length: 13 }],
      }),
    }, bot)).toBeNull();
  });
});
