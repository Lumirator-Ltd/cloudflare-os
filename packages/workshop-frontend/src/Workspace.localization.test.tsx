// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suggestValueLabel } from "./components/BlueprintBindingCard";
import { ResolveButton } from "./components/ResolveButton";
import { renderDiffLayer, type RenderArgs } from "./diff/diffRenderer";
import { formatRelativeTime } from "./Activity";
import i18n from "./i18n/config";
import { formatFullTimestamp } from "./utils/formatTimestamp";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Japanese workspace localization", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ja");
  });

  afterEach(async () => {
    vi.useRealTimers();
    document.body.replaceChildren();
    await i18n.changeLanguage("en");
  });

  it("provides Japanese copy for every workspace surface", () => {
    const expected = {
      "workspace.activity.needsReview": "確認が必要",
      "workspace.chat.composer.placeholder": "メッセージを入力…",
      "workspace.connections.empty.title": "接続済みのリソースはありません",
      "workspace.files.newFile": "新しいファイル",
      "workspace.editor.share": "ワークスペースを共有",
      "workspace.export.failed": "{{format}}へのエクスポートに失敗しました",
      "workspace.gadgetUi.errorTitle": "エラー",
      "workspace.outputs.title": "出力",
      "workspace.sharing.invite": "招待",
      "workspace.workpieces.viewActivity": "アクティビティを表示",
      "workspace.dialogs.delete.confirm": "削除",
      "workspace.approval.approve": "承認",
      "workspace.diff.accept": "承認",
      "workspace.open.observerRequired": "このワークスペースを開くには、使用するサービスの接続済みアカウントを選択する必要があります。",
    } as const;

    for (const [key, value] of Object.entries(expected)) {
      expect(i18n.t(key, { lng: "ja" })).toBe(value);
    }
  });

  it("uses Japanese whole-message count and sharing templates", () => {
    expect(i18n.t("workspace.activity.requestsWaiting", { count: 3, lng: "ja" }))
      .toBe("3件のリクエストが待機中です");
    expect(i18n.t("workspace.sharing.peopleWithRoleMustVerify", {
      role: "ワークスペース",
      count: 2,
      lng: "ja",
    })).toBe("ワークスペース権限を持つユーザーは、2件の接続を確認する必要があります");
    expect(i18n.t("workspace.outputs.count", { count: 12, lng: "ja" })).toBe("12件の出力");
  });

  it("formats workspace dates and relative times with the active locale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T03:00:00Z"));

    expect(formatRelativeTime(
      new Date("2026-08-28T02:55:00Z"),
      i18n.getFixedT("ja"),
    )).toBe("5分前");
    expect(formatFullTimestamp(
      new Date("2026-08-28T03:04:00Z"),
      "ja",
    )).toContain("2026/08/28");
  });

  it("localizes imperative diff DOM copy", () => {
    let deletionZone: HTMLElement | undefined;
    const editor = {
      getModel: () => ({
        getLineCount: () => 1,
        getLineLength: () => 0,
        getLineMaxColumn: () => 1,
      }),
      changeViewZones: (callback: (accessor: {
        removeZone: () => void;
        addZone: (zone: { domNode: HTMLElement }) => string;
      }) => void) => callback({
        removeZone: () => {},
        addZone: (zone) => {
          deletionZone = zone.domNode;
          return "zone";
        },
      }),
    } as unknown as RenderArgs["editor"];
    const monaco = {
      editor: { TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 0 } },
      Range: class {},
    } as unknown as RenderArgs["monaco"];

    renderDiffLayer({
      editor,
      monaco,
      model: {
        status: "Deleted",
        additions: 0,
        deletions: 130,
        changes: [{
          key: "deleted",
          modifiedStart: 1,
          modifiedCount: 0,
          originalStart: 1,
          originalCount: 130,
          deletedText: Array.from({ length: 130 }, (_, index) => `line ${index}`),
          charChanges: [],
          pairedModifiedLines: new Set(),
          pairedOriginalLines: new Set(),
          whitespaceModifiedRanges: new Map(),
          whitespaceOriginalRanges: new Map(),
        }],
      },
      expandedDeletions: new Set(),
      decorationCollection: null,
      previousViewZoneIds: [],
      onExpandDeletion: () => {},
    });

    expect(deletionZone?.querySelector("button")?.textContent)
      .toBe("非表示の削除行34行を表示");
  });

  it("renders localized approval controls and suggestion grammar", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <>
          <ResolveButton tone="approve" disabled={false} onClick={() => {}} />
          <ResolveButton tone="deny" disabled={false} onClick={() => {}} />
        </>,
      );
    });

    expect(container.textContent).toBe("承認拒否");
    expect(suggestValueLabel(
      { type: "gatekeeper", vendorId: "test", resourceUrl: "https://example.com", typeUrlPattern: "https://example.com/*" },
      "顧客データ",
      i18n.getFixedT("ja"),
    )).toBe("「顧客データ」をデフォルトとして提案");

    act(() => root.unmount());
  });
});
