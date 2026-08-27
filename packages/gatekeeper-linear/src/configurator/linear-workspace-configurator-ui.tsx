import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  LinearWorkspaceConfiguratorRpc,
  LinearWorkspaceConfiguratorValues,
} from "./linear-workspace-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.workspaceUrlKey === "string" && values.workspaceUrlKey.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [workspaceUrlKey] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    return workspaceUrlKey ? { workspaceUrlKey } : {};
  },

  resourceUrl({ values }) {
    return `https://linear.app/${values.workspaceUrlKey}`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Workspace", ja: "ワークスペース" })} description={localize(language, { en: "The Linear workspace this account is connected to.", ja: "このアカウントが接続されている Linear ワークスペースです。" })}>
        <Autocomplete
          name="workspaceUrlKey"
          value={values.workspaceUrlKey}
          placeholder={localize(language, { en: "Select your workspace...", ja: "ワークスペースを選択..." })}
          loadOptions={() => ui.listWorkspaces()}
          onChange={workspaceUrlKey => setValues({ workspaceUrlKey })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<LinearWorkspaceConfiguratorRpc, LinearWorkspaceConfiguratorValues>;
