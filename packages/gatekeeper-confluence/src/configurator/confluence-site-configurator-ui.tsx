import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConfluenceSiteConfiguratorRpc,
  ConfluenceSiteConfiguratorValues,
} from "./confluence-site-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.siteUrl === "string" && values.siteUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { siteUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.siteUrl ?? "";
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Confluence site", ja: "Confluence サイト" })} description={localize(language, { en: "Choose the Confluence site to connect.", ja: "接続する Confluence サイトを選択します。" })}>
        <Autocomplete
          name="siteUrl"
          value={values.siteUrl}
          placeholder={localize(language, { en: "Search sites...", ja: "サイトを検索..." })}
          loadOptions={query => ui.listSites(query)}
          onChange={siteUrl => setValues({ siteUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluenceSiteConfiguratorRpc, ConfluenceSiteConfiguratorValues>;
