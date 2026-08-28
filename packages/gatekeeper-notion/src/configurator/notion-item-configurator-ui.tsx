import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  NotionItemConfiguratorRpc,
  NotionItemConfiguratorValues,
} from "./notion-item-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.itemUrl === "string" && values.itemUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { itemUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.itemUrl ?? "";
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field
        label={localize(language, { en: "Page or database", ja: "ページまたはデータベース" })}
        description={localize(language, { en: "Search the Notion pages and databases shared with this connection, or paste a Notion URL.", ja: "この接続と共有されている Notion のページやデータベースを検索するか、Notion URL を貼り付けます。" })}
      >
        <Autocomplete
          name="itemUrl"
          value={values.itemUrl}
          placeholder={localize(language, { en: "Search Notion...", ja: "Notion を検索..." })}
          loadOptions={query => ui.listItems(query)}
          onChange={itemUrl => setValues({ itemUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NotionItemConfiguratorRpc, NotionItemConfiguratorValues>;
