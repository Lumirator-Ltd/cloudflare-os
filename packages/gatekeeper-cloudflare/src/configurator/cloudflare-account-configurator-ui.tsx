import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CloudflareAccountConfiguratorValues,
  CloudflareAccountConfiguratorRpc,
} from "./cloudflare-configurator-types";

export default {
  initial: { accountId: null },

  isReady({ values }) {
    return !!values.accountId;
  },

  resourceUrl({ values }) {
    return `https://dash.cloudflare.com/${encodeURIComponent(values.accountId!)}/workers-and-pages/observability`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Cloudflare account", ja: "Cloudflare アカウント" })} description={localize(language, { en: "Queries telemetry across every Worker in this account.", ja: "このアカウント内のすべての Worker を横断してテレメトリを照会します。" })}>
        <Autocomplete
          name="accountId"
          value={values.accountId}
          placeholder={localize(language, { en: "Choose an account", ja: "アカウントを選択" })}
          loadOptions={query => ui.listAccounts(query)}
          onChange={accountId => setValues({ accountId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CloudflareAccountConfiguratorRpc, CloudflareAccountConfiguratorValues>;
