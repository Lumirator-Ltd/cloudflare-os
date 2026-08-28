import { localize,
  CheckboxList, Field, h, RadioCards, Section, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  McpServerConfiguratorRpc,
  McpServerConfiguratorValues,
} from "./server-configurator-types";

export default {
  initial: { mode: "all", tools: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const params = new URLSearchParams(new URL(resourceUrl).hash.slice(1));
    const selected = params.getAll("tool").map(name => name.trim()).filter(Boolean)
      .map(encodeURIComponent);
    return {
      mode: params.has("tool") ? "choose" : "all",
      tools: selected.length > 0 ? selected.join(",") : null,
    };
  },

  isReady({ values }) {
    return values.mode === "all"
      || (values.tools ?? "").split(",").some(name => name.trim().length > 0);
  },

  async resourceUrl({ values, ui }) {
    const endpoint = await ui.getEndpoint();
    if (values.mode === "all") return endpoint;

    const params = new URLSearchParams();
    const selected = (values.tools ?? "").split(",").map(name => name.trim()).filter(Boolean)
      .map(decodeURIComponent);
    for (const tool of selected) params.append("tool", tool);
    if (selected.length === 0) params.append("tool", "");
    return `${endpoint}#${params}`;
  },

  render({ values, setValues, ui, language }) {
    const mode = values.mode === "choose" ? "choose" : "all";
    const selectedCount = (values.tools ?? "").split(",").filter(Boolean).length;

    return <Section>
      <Field label={localize(language, { en: "Tools", ja: "ツール" })} description={localize(language, { en: "Choose how much of this server this connection may call.", ja: "この接続が呼び出せるサーバーのツール範囲を選択します。" })}>
        <RadioCards
          value={mode}
          options={[
            {
              value: "all",
              title: localize(language, { en: "All tools", ja: "すべてのツール" }),
              description: localize(language, { en: "Every tool this server offers, including ones it adds later.", ja: "このサーバーが提供するすべてのツール（今後追加されるものを含む）。" }),
            },
            {
              value: "choose",
              title: localize(language, { en: "Choose tools", ja: "ツールを選択" }),
              description:
                localize(language, { en: "Only the tools you tick. Anything else is refused, including tools added later.", ja: "チェックしたツールのみ。今後追加されるツールを含め、それ以外は拒否されます。" }),
            },
          ]}
          onChange={next => setValues({ mode: next })}
        />
      </Field>
      <Field
        label={localize(language, { en: "Allowed tools", ja: "許可するツール" })}
        description={mode === "all"
          ? localize(language, { en: "Read-only tools return data straight away; the rest queue for your approval.", ja: "読み取り専用ツールはすぐにデータを返し、それ以外は承認待ちになります。" })
          : selectedCount > 0
            ? localize(language, {
                en: `${selectedCount} selected. Read-only tools return data straight away; the rest queue for your approval.`,
                ja: `${selectedCount} 件を選択。読み取り専用ツールはすぐにデータを返し、それ以外は承認待ちになります。`,
              })
            : localize(language, { en: "Tick at least one tool to grant anything.", ja: "許可するツールを 1 つ以上チェックしてください。" })}>
        <CheckboxList
          name="tools"
          value={values.tools}
          loadOptions={async () => (await ui.listToolOptions())
            .map(option => ({ ...option, value: encodeURIComponent(option.value) }))}
          allSelected={mode === "all"}
          disabled={mode === "all"}
          onChange={tools => setValues({ tools })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<McpServerConfiguratorRpc, McpServerConfiguratorValues>;
