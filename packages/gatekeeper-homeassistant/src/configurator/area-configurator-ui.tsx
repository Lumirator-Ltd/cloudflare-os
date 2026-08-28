import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantAreaConfiguratorRpc,
  HomeAssistantAreaConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.areaId === "string" && values.areaId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.areaId);
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Area", ja: "エリア" })} description={localize(language, { en: "Choose a Home Assistant area (room).", ja: "Home Assistant のエリア（部屋）を選択します。" })}>
        <Autocomplete
          name="areaId"
          value={values.areaId}
          placeholder={localize(language, { en: "Search areas...", ja: "エリアを検索..." })}
          loadOptions={query => ui.listAreas(query)}
          onChange={areaId => setValues({ areaId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantAreaConfiguratorRpc, HomeAssistantAreaConfiguratorValues>;
