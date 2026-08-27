import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  GoogleSheetsConfiguratorRpc, GoogleSheetsConfiguratorValues,
} from "./google-sheets-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.spreadsheetId === "string" && values.spreadsheetId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(values.spreadsheetId ?? "")}/edit`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Spreadsheet", ja: "スプレッドシート" })} description={localize(language, { en: "Search recent spreadsheets from Drive.", ja: "Google ドライブの最近のスプレッドシートを検索します。" })}>
        <Autocomplete
          name="spreadsheetId"
          value={values.spreadsheetId}
          placeholder={localize(language, { en: "Search recent spreadsheets...", ja: "最近のスプレッドシートを検索..." })}
          loadOptions={query => ui.listSpreadsheets(query)}
          onChange={spreadsheetId => setValues({ spreadsheetId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GoogleSheetsConfiguratorRpc, GoogleSheetsConfiguratorValues>;
