import { localize, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantInstanceConfiguratorRpc,
  HomeAssistantInstanceConfiguratorValues,
} from "./instance-configurator-types";

// The whole-instance resource has no user-selectable inputs — once the user has connected an
// account, the resource URL is fully determined. The configurator just displays a confirmation
// of which HA instance is being connected and signals readiness.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  // Note: the sandboxed configurator UI runtime doesn't support useEffect-style hooks, so we
  // can't lazily fetch and display the actual HA instance name here. We render static text
  // and let the user trust that the configurator wires up the correct account; the `ui`
  // capability is only used by `resourceUrl` above.
  render({ language }) {
    return <Section>
      <Field
        label={localize(language, { en: "Whole instance access", ja: "インスタンス全体へのアクセス" })}
        description={localize(language, { en: "This binding grants access to every area, device, entity, and dashboard on the connected Home Assistant instance.", ja: "このバインディングは、接続された Home Assistant インスタンスのすべてのエリア、デバイス、エンティティ、ダッシュボードへのアクセスを許可します。" })}>
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantInstanceConfiguratorRpc, HomeAssistantInstanceConfiguratorValues>;
