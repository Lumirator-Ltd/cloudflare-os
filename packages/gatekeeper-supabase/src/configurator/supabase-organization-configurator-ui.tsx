import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  SupabaseOrganizationConfiguratorRpc,
  SupabaseOrganizationConfiguratorValues,
} from "./supabase-organization-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.slug === "string" && values.slug.length > 0;
  },

  resourceUrl({ values }) {
    return `https://supabase.com/dashboard/org/${values.slug}`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Organization", ja: "組織" })} description={localize(language, { en: "Search the organizations in your connected Supabase account.", ja: "接続された Supabase アカウントの組織を検索します。" })}>
        <Autocomplete
          name="slug"
          value={values.slug}
          placeholder={localize(language, { en: "Search organizations...", ja: "組織を検索..." })}
          loadOptions={query => ui.listOrganizations(query)}
          onChange={slug => setValues({ slug })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SupabaseOrganizationConfiguratorRpc, SupabaseOrganizationConfiguratorValues>;
