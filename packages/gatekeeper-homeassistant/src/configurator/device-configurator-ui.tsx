import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantDeviceConfiguratorRpc,
  HomeAssistantDeviceConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.deviceId === "string" && values.deviceId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.deviceId);
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Device", ja: "デバイス" })} description={localize(language, { en: "Choose a physical device. The binding grants access to all entities the device provides.", ja: "物理デバイスを選択します。このバインディングは、そのデバイスが提供するすべてのエンティティへのアクセスを許可します。" })}>
        <Autocomplete
          name="deviceId"
          value={values.deviceId}
          placeholder={localize(language, { en: "Search devices...", ja: "デバイスを検索..." })}
          loadOptions={query => ui.listDevices(query)}
          onChange={deviceId => setValues({ deviceId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantDeviceConfiguratorRpc, HomeAssistantDeviceConfiguratorValues>;
