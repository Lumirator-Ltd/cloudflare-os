// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiChatMessage,
  AiChatMessageBody,
  AiChatMetadata,
  AiToolCall,
  ChatActivityLanguage,
  Overseer,
} from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import ChatInterface, {
  buildChatDisplayEntries,
  buildProvisionalToolSummary,
} from "./ChatInterface";
import i18n from "./i18n/config";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: null,
    currentUser: { id: "current-user", name: "Current User" },
  }),
}));
vi.mock("./useVendorBranding", () => ({
  useVendorBranding: () => new Map(),
}));
vi.mock("./useActions", () => ({
  useActionEntries: () => {},
}));
vi.mock("./useAlwaysApproveTag", () => ({
  useAlwaysApproveTag: () => ({
    alwaysApproveTag: async () => false,
    isTagAutoApproved: () => false,
  }),
}));
vi.mock("./useResolveAction", () => ({
  useResolveAction: () => async () => {},
}));
vi.mock("./GatekeeperModal", () => ({ default: () => null }));
vi.mock("./components/HookToggle", () => ({ HookToggle: () => null }));
vi.mock("./components/DeleteConfirmationDialog", () => ({ default: () => null }));
vi.mock("./components/AutoApproveConfirmDialog", () => ({ default: () => null }));
vi.mock("./components/billing/OutOfCreditsModal", () => ({ default: () => null }));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;
HTMLElement.prototype.scrollTo = () => {};

const AUTHOR = { type: "agent", id: "test-model", name: "Test" } as const;

function call(toolCallId: string, tool: object): AiToolCall {
  return { toolCallId, ...tool } as AiToolCall;
}

const TOOL_CALLS = {
  readFile: call("read", { toolName: "readFile", input: { filename: "src/app.ts" } }),
  writeFile: call("write", {
    toolName: "writeFile",
    input: { filename: "src/new.ts", content: "content" },
  }),
  editFile: call("edit", {
    toolName: "editFile",
    input: { filename: "src/edit.ts", textToReplace: "old", replacement: "new" },
  }),
  describeBinding: call("describe", {
    toolName: "describeBinding",
    input: { name: "SEARCH" },
  }),
  setBindingHook: call("hook", {
    toolName: "setBindingHook",
    input: { bindingName: "MAIL", entrypoint: "onMail" },
  }),
  setGadgetBinding: call("wire", {
    toolName: "setGadgetBinding",
    input: { gadget: "dashboard", source: "DATA", name: "stats" },
  }),
  saveCapsuleAsBinding: call("save", {
    toolName: "saveCapsuleAsBinding",
    input: { capsuleId: 1, bindingName: "LEGACY" },
  }),
  createGadget: call("create", {
    toolName: "createGadget",
    input: { title: "売上 Dashboard", bindingName: "dashboard" },
  }),
  executeCode: call("execute", {
    toolName: "executeCode",
    input: { code: "console.log('raw code')" },
    output: "raw output",
  }),
  giveUp: call("give-up", { toolName: "giveUp", input: { error: "raw failure" } }),
  webFetch: call("fetch", { toolName: "webFetch", input: { url: "https://example.com/path" } }),
  observeUserChanges: call("observe", { toolName: "observeUserChanges", input: {} }),
  listBlueprints: call("blueprints", { toolName: "listBlueprints", input: {} }),
  listConnectableResources: call("resources", {
    toolName: "listConnectableResources",
    input: { vendorId: "cloudflare" },
  }),
  requestConnection: call("connection", {
    toolName: "requestConnection",
    input: { vendorId: "github", reason: "raw reason" },
  }),
} satisfies Record<AiToolCall["toolName"], AiToolCall>;

function secondCall(toolCall: AiToolCall): AiToolCall {
  const copy = { ...toolCall, toolCallId: `${toolCall.toolName}-2` } as AiToolCall;
  switch (copy.toolName) {
    case "readFile":
    case "writeFile":
    case "editFile":
      copy.input = { ...copy.input, filename: `other-${copy.input.filename}` } as never;
      break;
    case "describeBinding":
      copy.input = { name: "OTHER" };
      break;
    case "setBindingHook":
      copy.input = { bindingName: "OTHER", entrypoint: "onOther" };
      break;
    case "setGadgetBinding":
      copy.input = { gadget: "other", source: "DATA", name: "stats" };
      break;
    case "saveCapsuleAsBinding":
      copy.input = { capsuleId: 2, bindingName: "OTHER" };
      break;
    case "createGadget":
      copy.input = { title: "Other", bindingName: "other" };
      break;
    case "executeCode":
      copy.input = { code: "other()" };
      break;
    case "webFetch":
      copy.input = { url: "https://other.example/path" };
      break;
    case "listConnectableResources":
      copy.input = { vendorId: "other" };
      break;
    case "requestConnection":
      copy.input = { vendorId: "other", reason: "raw reason" };
      break;
    case "giveUp":
    case "observeUserChanges":
    case "listBlueprints":
      break;
  }
  return copy;
}

function provisionalToolCall(
  toolCallId: string,
  toolName: AiToolCall["toolName"] | null,
  target?: string,
) {
  return {
    toolCallId,
    toolName,
    target,
    code: "",
    output: "",
    finished: false,
  };
}

function toolMessage(
  sequence: number,
  toolCalls: AiToolCall[],
  activityLanguage?: ChatActivityLanguage,
): AiChatMessage {
  return {
    chatId: 1,
    sequence,
    timestamp: new Date(sequence * 1000),
    author: AUTHOR,
    activityLanguage,
    type: "message",
    message: "",
    toolCalls,
  };
}

function labels(messages: AiChatMessage[]): string[] {
  return buildChatDisplayEntries(messages, new Map(), [], undefined, i18n.t).flatMap((entry) =>
    "toolCallGroups" in entry && entry.toolCallGroups
      ? entry.toolCallGroups.map((group) => group.label)
      : [],
  );
}

const USER = { type: "user", id: "reviewer", name: "作成者原文" } as const;

function durableMessage(
  sequence: number,
  body: AiChatMessageBody,
  activityLanguage?: ChatActivityLanguage,
  author = AUTHOR as AiChatMessage["author"],
): AiChatMessage {
  return {
    chatId: 7,
    sequence,
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, sequence)),
    author,
    activityLanguage,
    ...body,
  } as AiChatMessage;
}

function durableActivityMessages(
  activityLanguage?: ChatActivityLanguage,
): AiChatMessage[] {
  return [
    durableMessage(0, {
      type: "connectionRequest",
      requestId: "pending-connection",
      vendorId: "provider",
      vendorName: "プロバイダー原文",
      resourceTitle: "リソース原文",
      reason: "理由原文",
      state: "pending",
    }, activityLanguage),
    durableMessage(1, {
      type: "connectionRequest",
      requestId: "accepted-connection",
      vendorId: "provider",
      vendorName: "接続済みプロバイダー原文",
      resourceUrl: "https://resource.example/raw",
      reason: "接続理由原文",
      state: "accepted",
      gatekeeperId: 22,
    }, activityLanguage),
    durableMessage(2, {
      type: "action",
      actionId: 2,
      actionLog: {
        id: 2,
        type: "action",
        resourceTitle: "承認リソース原文",
        createdAt: new Date(Date.UTC(2025, 0, 1)),
        state: "approved",
        description: {
          title: "承認タイトル原文",
          description: "承認説明原文",
          implementsRevert: false,
        },
      },
    }, activityLanguage),
    durableMessage(3, {
      type: "action",
      actionId: 3,
      actionLog: {
        id: 3,
        type: "bindHook",
        resourceTitle: "フックリソース原文",
        createdAt: new Date(Date.UTC(2025, 0, 1)),
        state: "approved",
        description: {
          title: "フックタイトル原文",
          description: "フック説明原文",
        },
        hookId: 3,
        enabled: true,
      },
    }, activityLanguage),
    durableMessage(4, { type: "changes" }, activityLanguage),
    durableMessage(5, { type: "merge", mergeThrough: 4, version: 1 }, activityLanguage, USER),
    durableMessage(6, { type: "changes" }, activityLanguage),
    durableMessage(7, { type: "revert", revertFrom: 6 }, activityLanguage, USER),
    durableMessage(8, { type: "useGadget" }, activityLanguage),
    durableMessage(9, { type: "error", message: "エラー本文原文" }, activityLanguage),
  ];
}

function fakeOverseer(messages: AiChatMessage[]): RpcStub<Overseer> {
  const metadata: AiChatMetadata = {
    id: 7,
    title: "Raw chat title",
    started: new Date(Date.UTC(2025, 0, 1)),
    lastActive: new Date(Date.UTC(2025, 0, 1, 0, 9)),
  };
  const subscription = Object.assign(new Promise<never>(() => {}), {
    [Symbol.dispose]() {},
  });
  return {
    subscribeToChat: () => subscription,
    listChats: async () => [metadata],
    listModels: async () => [AUTHOR],
    getChatHistory: async () => ({ messages }),
  } as unknown as RpcStub<Overseer>;
}

async function renderDurableActivity(messages: AiChatMessage[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(
      TooltipProvider,
      null,
      createElement(
        Toasty,
        null,
        createElement(ChatInterface, {
          workspaceId: "workspace",
          overseer: fakeOverseer(messages),
          selectedChatId: 7,
          onNavigateToChat: () => {},
          pendingConsoleLogCount: 0,
          consoleLogPreview: "",
          consoleLogSeverity: "info",
          onConsumeConsoleLogs: () => "",
          onDiscardConsoleLogs: () => {},
          onOpenGadget: () => {},
          outputOfWorkpiece: () => undefined,
        }),
      ),
    ));
  });
  for (let attempt = 0; attempt < 10 && !container.textContent?.includes("エラー本文原文"); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(container.textContent).toContain("エラー本文原文");
  return { container, root };
}

function expectEnglishDurableActivity(container: HTMLElement) {
  const text = container.textContent ?? "";
  expect.soft(text).toContain("Connect プロバイダー原文");
  expect.soft(text).toContain("Connect 接続済みプロバイダー原文");
  expect.soft(text).toContain("Connected");
  expect.soft(text).toContain("リソース原文");
  expect.soft(text).toContain("https://resource.example/raw");
  expect.soft(text).toContain("理由原文");
  expect.soft(text).toContain("接続理由原文");
  expect.soft(text).toContain("承認タイトル原文");
  expect.soft(text).toContain("Approved");
  expect.soft(text).toContain("Hook: フックタイトル原文");
  expect.soft(text).toContain("Enabled");
  expect.soft(text).toContain("作成者原文 accepted changes");
  expect.soft(text).toContain("作成者原文 discarded changes");
  expect.soft(text).toContain("Used the gadget");
  expect.soft(text).toContain("Error: エラー本文原文");
  expect.soft(text).toContain("拒否");
  expect.soft(text).toContain("設定");
  expect.soft(text).toContain("再試行");
}

describe("completed chat activity localization", () => {
  it("renders every completed tool variant in stamped Japanese while preserving raw values", () => {
    const expected: Record<AiToolCall["toolName"], string> = {
      readFile: "src/app.tsを読み取りました",
      writeFile: "src/new.tsに書き込みました",
      editFile: "src/edit.tsを編集しました",
      describeBinding: "SEARCHバインディングを確認しました",
      setBindingHook: "MAIL → onMailを接続しました",
      setGadgetBinding: "dashboard.statsを接続しました",
      saveCapsuleAsBinding: "リソースLEGACYを保存しました",
      createGadget: "ガジェット「売上 Dashboard」を作成しました",
      executeCode: "コードconsole.log('raw code')を実行しました",
      giveUp: "停止しました",
      webFetch: "https://example.com/pathを取得しました",
      observeUserChanges: "ユーザーの変更を確認しました",
      listBlueprints: "ブループリントを一覧表示しました",
      listConnectableResources: "cloudflareの接続可能なリソースを一覧表示しました",
      requestConnection: "githubへの接続をリクエストしました",
    };

    for (const [toolName, toolCall] of Object.entries(TOOL_CALLS)) {
      expect(labels([toolMessage(1, [toolCall], "ja")])).toEqual([
        expected[toolName as AiToolCall["toolName"]],
      ]);
    }
  });

  it("uses localized count messages for every tool variant", () => {
    const expected: Record<AiToolCall["toolName"], string> = {
      readFile: "2個のファイルを読み取りました",
      writeFile: "2個のファイルに書き込みました",
      editFile: "2件の編集を行いました",
      describeBinding: "2個のバインディングを確認しました",
      setBindingHook: "2個のバインディングを接続しました",
      setGadgetBinding: "2個のバインディングを接続しました",
      saveCapsuleAsBinding: "2個のリソースを保存しました",
      createGadget: "2個のガジェットを作成しました",
      executeCode: "コードを2回実行しました",
      giveUp: "2回停止しました",
      webFetch: "2ページを取得しました",
      observeUserChanges: "2件の変更を確認しました",
      listBlueprints: "ブループリントを2回一覧表示しました",
      listConnectableResources: "接続可能なリソースを2回一覧表示しました",
      requestConnection: "2件の接続をリクエストしました",
    };

    for (const [toolName, toolCall] of Object.entries(TOOL_CALLS)) {
      expect(
        labels([toolMessage(1, [toolCall, secondCall(toolCall)], "ja")]),
      ).toEqual([expected[toolName as AiToolCall["toolName"]]]);
    }
  });

  it("keeps adjacent turns with different stamped languages in separate groups", () => {
    expect(labels([
      toolMessage(1, [TOOL_CALLS.readFile], "ja"),
      toolMessage(2, [TOOL_CALLS.writeFile], "en"),
    ])).toEqual(["src/app.tsを読み取りました", "Wrote src/new.ts"]);
  });

  it("uses English for legacy unstamped activity", () => {
    expect(labels([toolMessage(1, [TOOL_CALLS.readFile])])).toEqual(["Read src/app.ts"]);
  });
});

describe("durable non-tool semantic activity localization", () => {
  let rendered: Awaited<ReturnType<typeof renderDurableActivity>> | undefined;

  afterEach(async () => {
    if (rendered) {
      await act(async () => rendered?.root.unmount());
      rendered.container.remove();
      rendered = undefined;
    }
    await i18n.changeLanguage("en");
  });

  it("uses each stamped turn language while keeping Japanese UI controls and raw payloads", async () => {
    expect.hasAssertions();
    await i18n.changeLanguage("ja");
    rendered = await renderDurableActivity(durableActivityMessages("en"));

    expectEnglishDurableActivity(rendered.container);
  }, 15_000);

  it("falls back legacy unstamped activity to English while keeping Japanese UI controls", async () => {
    expect.hasAssertions();
    await i18n.changeLanguage("ja");
    rendered = await renderDurableActivity(durableActivityMessages());

    expectEnglishDurableActivity(rendered.container);
  }, 15_000);
});

describe("provisional and status activity catalog", () => {
  it("formats provisional tool activity in the requested language", () => {
    expect(buildProvisionalToolSummary(i18n.t, [
      provisionalToolCall("read", "readFile", "src/app.ts"),
    ], "ja")).toEqual({ label: "src/app.tsを読み取っています…", detailLines: [] });
    expect(buildProvisionalToolSummary(i18n.t, [
      provisionalToolCall("write", "writeFile"),
    ], "en")).toEqual({ label: "Writing file…", detailLines: [] });
    expect(buildProvisionalToolSummary(i18n.t, [
      provisionalToolCall("unknown", null),
    ], "ja")).toEqual({ label: "ツールを使用しています…", detailLines: [] });
  });

  it("provides Japanese whole-message running templates for every tool variant", () => {
    const expected: Record<AiToolCall["toolName"], string> = {
      readFile: "src/app.tsを読み取っています…",
      writeFile: "src/new.tsに書き込んでいます…",
      editFile: "src/edit.tsを編集中です…",
      describeBinding: "SEARCHバインディングを確認しています…",
      setBindingHook: "MAIL → onMailを接続しています…",
      setGadgetBinding: "dashboard.statsを接続しています…",
      saveCapsuleAsBinding: "リソースLEGACYを保存しています…",
      createGadget: "ガジェット「売上 Dashboard」を作成しています…",
      executeCode: "コードconsole.log('raw code')を実行しています…",
      giveUp: "停止しています…",
      webFetch: "https://example.com/pathを取得しています…",
      observeUserChanges: "ユーザーの変更を確認しています…",
      listBlueprints: "ブループリントを一覧表示しています…",
      listConnectableResources: "cloudflareの接続可能なリソースを一覧表示しています…",
      requestConnection: "githubへの接続をリクエストしています…",
    };

    for (const [toolName, target] of Object.entries({
      readFile: "src/app.ts",
      writeFile: "src/new.ts",
      editFile: "src/edit.ts",
      describeBinding: "SEARCH",
      setBindingHook: "MAIL → onMail",
      setGadgetBinding: "dashboard.stats",
      saveCapsuleAsBinding: "LEGACY",
      createGadget: "売上 Dashboard",
      executeCode: "console.log('raw code')",
      giveUp: undefined,
      webFetch: "https://example.com/path",
      observeUserChanges: undefined,
      listBlueprints: undefined,
      listConnectableResources: "cloudflare",
      requestConnection: "github",
    } satisfies Record<AiToolCall["toolName"], string | undefined>)) {
      expect(i18n.t(`chat.activity.tool.${toolName}.runningTarget`, {
        lng: "ja",
        target,
      })).toBe(expected[toolName as AiToolCall["toolName"]]);
    }
  });

  it("provides Japanese count-aware running templates for every tool variant", () => {
    const expected: Record<AiToolCall["toolName"], string> = {
      readFile: "2個のファイルを読み取っています…",
      writeFile: "2個のファイルに書き込んでいます…",
      editFile: "2件の編集を行っています…",
      describeBinding: "2個のバインディングを確認しています…",
      setBindingHook: "2個のバインディングを接続しています…",
      setGadgetBinding: "2個のバインディングを接続しています…",
      saveCapsuleAsBinding: "2個のリソースを保存しています…",
      createGadget: "2個のガジェットを作成しています…",
      executeCode: "コードを2回実行しています…",
      giveUp: "2回停止しています…",
      webFetch: "2ページを取得しています…",
      observeUserChanges: "2件の変更を確認しています…",
      listBlueprints: "ブループリントを2回一覧表示しています…",
      listConnectableResources: "接続可能なリソースを2回一覧表示しています…",
      requestConnection: "2件の接続をリクエストしています…",
    };

    for (const toolName of Object.keys(TOOL_CALLS) as AiToolCall["toolName"][]) {
      expect(i18n.t(`chat.activity.tool.${toolName}.runningCount`, {
        lng: "ja",
        count: 2,
      })).toBe(expected[toolName]);
    }
  });

  it("localizes generic activity, observations, thinking, compacting, and tool status headings", () => {
    expect(i18n.t("chat.activity.tool.generic.running", { lng: "ja" })).toBe("ツールを使用しています…");
    expect(i18n.t("chat.activity.tool.generic.completedCount", { lng: "ja", count: 4 })).toBe("4件のツール呼び出し");
    expect(i18n.t("chat.activity.observation.running", { lng: "ja", target: "顧客 CRM" })).toBe("顧客 CRMを読み取っています…");
    expect(i18n.t("chat.activity.observation.completedCount", { lng: "ja", count: 2 })).toBe("2件のリソースを読み取りました");
    expect(i18n.t("chat.activity.thinking.running", { lng: "en" })).toBe("Thinking…");
    expect(i18n.t("chat.activity.thinking.running", { lng: "ja" })).toBe("考えています…");
    expect(i18n.t("chat.activity.compacting.running", { lng: "en" })).toBe("Compacting conversation…");
    expect(i18n.t("chat.activity.compacting.running", { lng: "ja" })).toBe("会話を圧縮しています…");
    expect(i18n.t("chat.activity.compacting.completed", { lng: "ja" })).toBe("会話を圧縮しました");
    expect(i18n.t("chat.activity.status.code", { lng: "ja" })).toBe("コード");
    expect(i18n.t("chat.activity.status.output", { lng: "ja" })).toBe("出力");
    expect(i18n.t("chat.activity.status.error", { lng: "ja" })).toBe("エラー");
  });
});
