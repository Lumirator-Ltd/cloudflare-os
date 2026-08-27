import type { CatalogShape } from "../catalog";
import type { enCommon } from "../en/common";

export const jaCommon = {
  common: {
    cancel: "キャンセル",
    close: "閉じる",
    error: "エラーが発生しました",
    loading: "読み込み中…",
    retry: "再試行",
    save: "保存",
  },
  language: {
    title: "言語",
    auto: "自動",
    autoWithLanguage: "自動（{{language}}）",
    english: "English",
    japanese: "日本語",
    saveError: "言語設定を保存できませんでした。",
  },
} as const satisfies CatalogShape<typeof enCommon>;
