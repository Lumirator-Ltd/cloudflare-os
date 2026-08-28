import { localize, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues,
} from "./workspace-configurator-types";

export default {
  initial: {},

  isReady() {
    return true;
  },

  async resourceUrl({ ui }) {
    return await ui.getWorkspaceUrl();
  },

  render({ language }) {
    return <Section>
      <Field
        label={localize(language, { en: "Whole workspace", ja: "ワークスペース全体" })}
        description={localize(language, { en: "This connection lets the client read the channels and direct messages you can access, browse Slack workspace members, and search messages.", ja: "この接続により、クライアントはアクセス可能なチャンネルとダイレクトメッセージの読み取り、Slack ワークスペースメンバーの参照、メッセージの検索を行えます。" })}
      >
        <span />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues>;
