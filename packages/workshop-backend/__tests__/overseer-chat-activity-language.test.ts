import { describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo,
  AiChatMessage,
  AiChatMessageBody,
  AiChatMetadata,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import { keyString } from "@gadgets/typed-storage";
import type { UserChatContext } from "../src/user.js";
import * as overseerModule from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const OWNER: AiChatAuthorInfo = {type: "user", id: "owner", name: "Owner"};
const COLLABORATOR: AiChatAuthorInfo = {type: "user", id: "collaborator", name: "Collaborator"};
const AGENT: AiChatAuthorInfo = {type: "agent", id: "model", name: "Agent"};

type ActivityOverseer = {
  storage: {
    chatMeta: {
      get(id: number): AiChatMetadata | undefined;
    };
    chats: {
      list(options: {prefix: string}): Iterable<AiChatMessage>;
    };
  };
  newChat(clientUser: object, userMeta: UserChatContext,
          initialMessage: string | SlashCommandRequest): Promise<number>;
  sendChatMessage(clientUser: object, userMeta: UserChatContext, chatId: number,
                  message: string | SlashCommandRequest): Promise<void>;
  addChatMessages(chatId: number, author: AiChatAuthorInfo, messages: AiChatMessageBody[]): void;
  postAgentErrorMessage(chatId: number, author: AiChatAuthorInfo, message: string): void;
};

function overseer(): ActivityOverseer {
  const OverseerImpl = Reflect.get(overseerModule, "OverseerImpl");
  expect(OverseerImpl).toBeTypeOf("function");
  return Reflect.construct(OverseerImpl, [{
    id: {toString: () => "workspace-id"},
    storage: makeMockStorage(),
    exports: {UserDurableObject: {}},
  }, {}]);
}

function user(profile: AiChatAuthorInfo): UserChatContext {
  return {profile};
}

function client(id: string): object {
  return {id: {toString: () => id}};
}

function messages(target: ActivityOverseer, chatId: number): AiChatMessage[] {
  return [...target.storage.chats.list({prefix: `${keyString(chatId)}.`})];
}

describe("Overseer chat activity language flow", () => {
  it("defaults a neutral new human chat to English and stamps its message", async () => {
    const target = overseer();
    const chatId = await target.newChat(client("owner"), user(OWNER), "🎉 123");

    expect(target.storage.chatMeta.get(chatId)).toMatchObject({
      activityLanguage: "en",
      title: "New Chat",
    });
    expect(messages(target, chatId)).toMatchObject([{activityLanguage: "en"}]);
  });

  it("starts a Japanese human chat with a Japanese fallback title", async () => {
    const target = overseer();
    const chatId = await target.newChat(client("owner"), user(OWNER), "請求書を作って");

    expect(target.storage.chatMeta.get(chatId)).toMatchObject({
      activityLanguage: "ja",
      title: "新しいチャット",
    });
    expect(messages(target, chatId)).toMatchObject([{activityLanguage: "ja"}]);
  });

  it("lets collaborators switch language while neutral turns inherit without retitling", async () => {
    const target = overseer();
    const chatId = await target.newChat(client("owner"), user(OWNER), "Build an invoice tracker");

    await target.sendChatMessage(
        client("collaborator"), user(COLLABORATOR), chatId, "家計簿に変更して");
    await target.sendChatMessage(client("owner"), user(OWNER), chatId, "👍");

    expect(target.storage.chatMeta.get(chatId)).toMatchObject({
      activityLanguage: "ja",
      title: "New Chat",
    });
    expect(messages(target, chatId).map(message => message.activityLanguage))
      .toEqual(["en", "ja", "ja"]);
  });

  it("classifies slash-command natural-language arguments", async () => {
    const target = overseer();
    const chatId = await target.newChat(client("owner"), user(OWNER), {
      id: {builtin: true, commandId: "compact"},
      args: "古い会話を短くまとめて",
    });

    expect(target.storage.chatMeta.get(chatId)?.activityLanguage).toBe("ja");
    expect(messages(target, chatId)).toMatchObject([{
      type: "slashCommand",
      activityLanguage: "ja",
    }]);
  });

  it("does not let synthetic user-authored notes reclassify the chat", async () => {
    const target = overseer();
    const chatId = await target.newChat(client("owner"), user(OWNER), "Build a report");

    target.addChatMessages(chatId, OWNER, [{type: "message", message: "変更を承認しました"}]);

    expect(target.storage.chatMeta.get(chatId)?.activityLanguage).toBe("en");
    expect(messages(target, chatId).map(message => message.activityLanguage)).toEqual(["en", "en"]);
  });

  it("stamps later durable turn records from metadata centrally", async () => {
    const target = overseer();
    const chatId = await target.newChat(client("owner"), user(OWNER), "日本語で作って");

    target.addChatMessages(chatId, AGENT, [
      {type: "message", message: "承知しました"},
      {type: "agentNudge", text: "続けます"},
    ]);
    target.postAgentErrorMessage(chatId, AGENT, "再試行してください");

    expect(messages(target, chatId).map(message => message.activityLanguage))
      .toEqual(["ja", "ja", "ja", "ja"]);
  });
});
