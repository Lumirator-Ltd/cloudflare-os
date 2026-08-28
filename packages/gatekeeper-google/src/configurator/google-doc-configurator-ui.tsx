import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GoogleDocConfiguratorRpc, GoogleDocConfiguratorValues } from "./google-doc-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.docId === "string" && values.docId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://docs.google.com/document/d/${encodeURIComponent(values.docId ?? "")}/edit`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Document", ja: "ドキュメント" })} description={localize(language, { en: "Search recent documents from Drive.", ja: "Google ドライブの最近のドキュメントを検索します。" })}>
        <Autocomplete
          name="docId"
          value={values.docId}
          placeholder={localize(language, { en: "Search recent docs...", ja: "最近のドキュメントを検索..." })}
          loadOptions={query => ui.listDocs(query)}
          onChange={docId => setValues({ docId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GoogleDocConfiguratorRpc, GoogleDocConfiguratorValues>;
