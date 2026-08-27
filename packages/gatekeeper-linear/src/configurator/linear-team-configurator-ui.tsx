import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  LinearTeamConfiguratorRpc,
  LinearTeamConfiguratorValues,
} from "./linear-team-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.teamKey === "string" && values.teamKey.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const teamIndex = segments.indexOf("team");
    const teamKey = teamIndex >= 0 ? segments[teamIndex + 1] : undefined;
    return teamKey ? { teamKey } : {};
  },

  async resourceUrl({ values, ui }) {
    const workspaceUrlKey = await ui.getWorkspaceUrlKey();
    return `https://linear.app/${workspaceUrlKey}/team/${values.teamKey}`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Team", ja: "チーム" })} description={localize(language, { en: "Search the teams in your workspace.", ja: "ワークスペース内のチームを検索します。" })}>
        <Autocomplete
          name="teamKey"
          value={values.teamKey}
          placeholder={localize(language, { en: "Search teams...", ja: "チームを検索..." })}
          loadOptions={query => ui.listTeams(query)}
          onChange={teamKey => setValues({ teamKey })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<LinearTeamConfiguratorRpc, LinearTeamConfiguratorValues>;
