import { localize, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HubSpotAccountConfiguratorRpc,
  HubSpotAccountConfiguratorValues,
} from "./account-configurator-types";

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render({ language }) {
    return <Section>
      <Field
        label={localize(language, { en: "Whole-account access", ja: "アカウント全体へのアクセス" })}
        description={localize(language, { en: "This binding grants access to contacts, companies, and deals in the connected HubSpot account.", ja: "このバインディングは、接続された HubSpot アカウントの連絡先、会社、取引へのアクセスを許可します。" })}
      />
    </Section>;
  },
} satisfies ConfiguratorUISpec<HubSpotAccountConfiguratorRpc, HubSpotAccountConfiguratorValues>;
