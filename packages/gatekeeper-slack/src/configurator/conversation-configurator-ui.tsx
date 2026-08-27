import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConversationConfiguratorRpc, ConversationConfiguratorValues,
} from "./conversation-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.conversationId === "string" && values.conversationId.length > 0;
  },

  async resourceUrl({ values, ui }) {
    const teamId = await ui.getTeamId();
    return `https://app.slack.com/client/${teamId}/${encodeURIComponent(values.conversationId ?? "")}`;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const conversationId = segments[2];
    return conversationId ? { conversationId: decodeURIComponent(conversationId) } : {};
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field
        label={localize(language, { en: "Conversation", ja: "会話" })}
        description={localize(language, { en: "Choose a channel or direct message this connection can read.", ja: "この接続が読み取れるチャンネルまたはダイレクトメッセージを選択します。" })}
      >
        <Autocomplete
          name="conversationId"
          value={values.conversationId}
          placeholder={localize(language, { en: "Search channels and DMs...", ja: "チャンネルと DM を検索..." })}
          loadOptions={query => ui.listConversations(query)}
          onChange={conversationId => setValues({ conversationId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConversationConfiguratorRpc, ConversationConfiguratorValues>;
