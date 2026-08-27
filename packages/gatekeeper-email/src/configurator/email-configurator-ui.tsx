import { localize, Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { EmailMailboxConfiguratorRpc, EmailMailboxConfiguratorValues } from "./email-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.emailName === "string" && values.emailName.trim().length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const user = segments[segments.length - 1];
    return user ? { emailName: decodeURIComponent(user) } : {};
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.emailName);
  },

  render({ values, setValues, language }) {
    return <Section>
      <Field label={localize(language, { en: "Email name", ja: "メール名" })} description={localize(language, { en: "Choose the local part of the mailbox address this connection can receive.", ja: "この接続が受信できるメールボックスアドレスのローカル部を選択します。" })}>
        <TextInput
          name="emailName"
          value={values.emailName}
          placeholder={localize(language, { en: "alerts", ja: "alerts" })}
          onChange={emailName => setValues({ emailName })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<EmailMailboxConfiguratorRpc, EmailMailboxConfiguratorValues>;
