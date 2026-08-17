import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
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

  render() {
    return <Section>
      <Field
        label="Whole-account access"
        description="This binding grants access to contacts, companies, and deals in the connected HubSpot account."
      />
    </Section>;
  },
} satisfies ConfiguratorUISpec<HubSpotAccountConfiguratorRpc, HubSpotAccountConfiguratorValues>;
