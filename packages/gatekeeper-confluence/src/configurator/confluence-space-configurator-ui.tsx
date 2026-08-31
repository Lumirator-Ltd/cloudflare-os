import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConfluenceSpaceConfiguratorRpc,
  ConfluenceSpaceConfiguratorValues,
} from "./confluence-space-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.spaceUrl === "string" && values.spaceUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { spaceUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.spaceUrl ?? "";
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Space", ja: "スペース" })} description={localize(language, { en: "Search the spaces shared with this connection.", ja: "この接続と共有されているスペースを検索します。" })}>
        <Autocomplete
          name="spaceUrl"
          value={values.spaceUrl}
          placeholder={localize(language, { en: "Search spaces...", ja: "スペースを検索..." })}
          loadOptions={query => ui.listSpaces(query)}
          onChange={spaceUrl => setValues({ spaceUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluenceSpaceConfiguratorRpc, ConfluenceSpaceConfiguratorValues>;
