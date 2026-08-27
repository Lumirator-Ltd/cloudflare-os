import type { TranslationCatalog } from "./en";

export const ja = {
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
  chat: {
    activity: {
      thinking: {
        running: "考えています…",
        completed: "思考",
      },
      compacting: {
        running: "会話を圧縮しています…",
        completed: "会話を圧縮しました",
      },
      observation: {
        running: "{{target}}を読み取っています…",
        completed: "{{target}}を読み取りました",
      },
    },
  },
} as const satisfies TranslationCatalog;
