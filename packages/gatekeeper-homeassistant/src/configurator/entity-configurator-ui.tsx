import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantEntityConfiguratorRpc,
  HomeAssistantEntityConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.entityId === "string" && values.entityId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.entityId);
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Entity", ja: "エンティティ" })} description={localize(language, { en: "Choose a single Home Assistant entity (light, sensor, switch, etc).", ja: "Home Assistant のエンティティ（照明、センサー、スイッチなど）を 1 つ選択します。" })}>
        <Autocomplete
          name="entityId"
          value={values.entityId}
          placeholder={localize(language, { en: "Search entities...", ja: "エンティティを検索..." })}
          loadOptions={query => ui.listEntities(query)}
          onChange={entityId => setValues({ entityId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantEntityConfiguratorRpc, HomeAssistantEntityConfiguratorValues>;
