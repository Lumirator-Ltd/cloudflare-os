import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConfluencePageConfiguratorRpc,
  ConfluencePageConfiguratorValues,
} from "./confluence-page-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.pageUrl === "string" && values.pageUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { pageUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.pageUrl ?? "";
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field
        label={localize(language, { en: "Page or blog post", ja: "ページまたはブログ記事" })}
        description={localize(language, { en: "Search the pages and blog posts shared with this connection, or paste a Confluence URL.", ja: "この接続と共有されているページやブログ記事を検索するか、Confluence URL を貼り付けます。" })}
      >
        <Autocomplete
          name="pageUrl"
          value={values.pageUrl}
          placeholder={localize(language, { en: "Search Confluence...", ja: "Confluence を検索..." })}
          loadOptions={query => ui.listPages(query)}
          onChange={pageUrl => setValues({ pageUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluencePageConfiguratorRpc, ConfluencePageConfiguratorValues>;
