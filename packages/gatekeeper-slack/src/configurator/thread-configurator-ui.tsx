import { localize, Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { ThreadConfiguratorRpc, ThreadConfiguratorValues } from "./thread-configurator-types";

function parsePermalink(raw: string): { conversationId: string; messageId: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!url.hostname.endsWith(".slack.com")) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "archives" || segments.length < 3) return null;
  const conversationId = segments[1];
  const messageId = segments[2];
  if (!/^[CDG][A-Z0-9]+$/.test(conversationId) || !/^p[0-9]+$/.test(messageId)) return null;
  return { conversationId, messageId };
}

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.permalink === "string" && parsePermalink(values.permalink) !== null;
  },

  resourceUrl({ values }) {
    return (values.permalink ?? "").trim();
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return parsePermalink(resourceUrl) ? { permalink: resourceUrl } : {};
  },

  render({ values, setValues, language }) {
    return <Section>
      <Field
        label={localize(language, { en: "Thread permalink", ja: "スレッドのパーマリンク" })}
        description={localize(language, { en: "Paste a Slack message link (Copy link on a message). It looks like https://your-workspace.slack.com/archives/C0.../p123...", ja: "Slack メッセージのリンク（メッセージの「リンクをコピー」）を貼り付けます。例: https://your-workspace.slack.com/archives/C0.../p123..." })}
      >
        <TextInput
          name="permalink"
          value={values.permalink}
          placeholder={localize(language, { en: "https://your-workspace.slack.com/archives/C.../p...", ja: "https://your-workspace.slack.com/archives/C.../p..." })}
          onChange={permalink => setValues({ permalink })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ThreadConfiguratorRpc, ThreadConfiguratorValues>;
