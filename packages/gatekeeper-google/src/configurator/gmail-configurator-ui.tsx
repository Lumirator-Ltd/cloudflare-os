import { localize, Field, h, RadioCards, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GmailConfiguratorRpc, GmailConfiguratorValues } from "./gmail-configurator-types";

export default {
  initial: { mode: "all" },

  isReady({ values }) {
    const mode = values.mode ?? "all";
    if (mode === "all") return true;
    if (mode === "search") return typeof values.query === "string" && values.query.trim().length > 0;
    if (mode === "label") return typeof values.label === "string" && values.label.trim().length > 0;
    return false;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const hash = new URL(resourceUrl).hash.replace(/^#/, "");
    if (hash.startsWith("search/")) {
      return { mode: "search", query: decodeURIComponent(hash.slice("search/".length)) };
    }
    if (hash.startsWith("label/")) {
      return { mode: "label", label: decodeURIComponent(hash.slice("label/".length)) };
    }
    return { mode: "all" };
  },

  resourceUrl({ values }) {
    const mode = values.mode ?? "all";
    if (mode === "search") {
      return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(values.query ?? "")}`;
    }
    if (mode === "label") {
      return `https://mail.google.com/mail/u/0/#label/${encodeURIComponent(values.label ?? "")}`;
    }
    return "https://mail.google.com/mail/u/0/";
  },

  render({ values, setValues, clearFields, language }) {
    const mode = values.mode ?? "all";
    return <Section>
      <Field label={localize(language, { en: "Mailbox scope", ja: "メールボックスの範囲" })} description={localize(language, { en: "Choose whether this connection can access all Gmail messages or a narrower native Gmail view.", ja: "この接続がすべての Gmail メッセージにアクセスするか、Gmail の特定のビューだけにアクセスするかを選択します。" })}>
        <RadioCards
          value={mode}
          options={[
            { value: "all", title: localize(language, { en: "All Gmail", ja: "Gmail 全体" }), description: localize(language, { en: "Allow access to the whole mailbox.", ja: "メールボックス全体へのアクセスを許可します。" }) },
            { value: "search", title: localize(language, { en: "Search", ja: "検索" }), description: localize(language, { en: "Allow messages matching a Gmail search query.", ja: "Gmail 検索クエリに一致するメッセージを許可します。" }) },
            { value: "label", title: localize(language, { en: "Label", ja: "ラベル" }), description: localize(language, { en: "Allow messages with a specific Gmail label.", ja: "特定の Gmail ラベルが付いたメッセージを許可します。" }) },
          ]}
          onChange={nextMode => {
            if (nextMode !== "all" && nextMode !== "search" && nextMode !== "label") return;
            clearFields("query", "label");
            setValues({ mode: nextMode, query: null, label: null });
          }}
        />
      </Field>

      {mode === "search" && <Field label={localize(language, { en: "Search query", ja: "検索クエリ" })} description={localize(language, { en: "Use the same query syntax as Gmail search.", ja: "Gmail 検索と同じクエリ構文を使用します。" })}>
        <TextInput
          name="query"
          value={values.query}
          placeholder={localize(language, { en: "from:alerts@example.com newer_than:30d", ja: "from:alerts@example.com newer_than:30d" })}
          onChange={query => setValues({ query })}
        />
      </Field>}

      {mode === "label" && <Field label={localize(language, { en: "Label", ja: "ラベル" })} description={localize(language, { en: "Use the Gmail label name exactly as it appears in Gmail.", ja: "Gmail に表示されているラベル名をそのまま入力します。" })}>
        <TextInput
          name="label"
          value={values.label}
          placeholder={localize(language, { en: "Receipts", ja: "領収書" })}
          onChange={label => setValues({ label })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<GmailConfiguratorRpc, GmailConfiguratorValues>;
