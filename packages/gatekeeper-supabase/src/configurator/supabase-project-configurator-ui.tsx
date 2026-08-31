import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  SupabaseProjectConfiguratorRpc,
  SupabaseProjectConfiguratorValues,
} from "./supabase-project-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.ref === "string" && values.ref.length > 0;
  },

  resourceUrl({ values }) {
    return `https://supabase.com/dashboard/project/${values.ref}`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Project", ja: "プロジェクト" })} description={localize(language, { en: "Search the projects in your connected Supabase account.", ja: "接続された Supabase アカウントのプロジェクトを検索します。" })}>
        <Autocomplete
          name="ref"
          value={values.ref}
          placeholder={localize(language, { en: "Search projects...", ja: "プロジェクトを検索..." })}
          loadOptions={query => ui.listProjects(query)}
          onChange={ref => setValues({ ref })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SupabaseProjectConfiguratorRpc, SupabaseProjectConfiguratorValues>;
