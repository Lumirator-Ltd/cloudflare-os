import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues } from "./github-repo-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    return owner && repo ? { repoFullName: `${owner}/${repo}` } : {};
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Repository", ja: "リポジトリ" })} description={localize(language, { en: "Search your repositories, or enter a GitHub URL.", ja: "リポジトリを検索するか、GitHub URL を入力します。" })}>
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder={localize(language, { en: "Search or paste a repository URL...", ja: "リポジトリを検索または URL を貼り付け..." })}
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues>;
