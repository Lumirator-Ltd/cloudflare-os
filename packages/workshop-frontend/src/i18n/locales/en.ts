export const en = {
  common: {
    cancel: "Cancel",
    close: "Close",
    error: "Something went wrong",
    loading: "Loading…",
    retry: "Try again",
    save: "Save",
  },
  language: {
    title: "Language",
    auto: "Auto",
    autoWithLanguage: "Auto ({{language}})",
    english: "English",
    japanese: "日本語",
    saveError: "Couldn't save the language preference.",
  },
  chat: {
    activity: {
      thinking: {
        running: "Thinking…",
        completed: "Thought",
      },
      compacting: {
        running: "Compacting conversation…",
        completed: "Compacted conversation",
      },
      observation: {
        running: "Reading {{target}}…",
        completed: "Read {{target}}",
      },
    },
  },
} as const;

export type TranslationCatalog = {
  [Key in keyof typeof en]: CatalogNode<(typeof en)[Key]>;
};

type CatalogNode<Value> = Value extends string
  ? string
  : { [Key in keyof Value]: CatalogNode<Value[Key]> };
