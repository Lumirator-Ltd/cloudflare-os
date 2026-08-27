import { localize, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  NotionWorkspaceConfiguratorRpc,
  NotionWorkspaceConfiguratorValues,
} from "./notion-workspace-configurator-types";

export default {
  initial: {},

  // Whole-workspace access takes no parameters, so it is always ready to add.
  isReady() {
    return true;
  },

  resourceUrl() {
    return "https://www.notion.so/";
  },

  render({ language }) {
    return <Section>
      <Field
        label={localize(language, { en: "Whole workspace", ja: "ワークスペース全体" })}
        description={localize(language, { en: "Grants access to every page and database you have shared with this Notion connection. To limit access, connect a single page or database instead.", ja: "この Notion 接続と共有したすべてのページとデータベースへのアクセスを許可します。範囲を限定するには、代わりに単一のページまたはデータベースを接続してください。" })}
      >
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NotionWorkspaceConfiguratorRpc, NotionWorkspaceConfiguratorValues>;
