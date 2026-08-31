import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubPullRequestConfiguratorRpc, GitHubPullRequestConfiguratorValues } from "./github-pull-request-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0 &&
      typeof values.pullNumber === "string" && values.pullNumber.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo, , number] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    if (!owner || !repo) return {};
    return { repoFullName: `${owner}/${repo}`, pullNumber: number ?? null };
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}/pull/${values.pullNumber}`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Repository", ja: "リポジトリ" })} description={localize(language, { en: "Search your repositories, or enter a GitHub URL.", ja: "リポジトリを検索するか、GitHub URL を入力します。" })}>
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder={localize(language, { en: "Search or paste a repository URL...", ja: "リポジトリを検索または URL を貼り付け..." })}
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName, pullNumber: null })}
        />
      </Field>

      <Field label={localize(language, { en: "Pull Request", ja: "Pull Request" })} description={localize(language, { en: "Choose a pull request in the selected repository.", ja: "選択したリポジトリの Pull Request を選択します。" })}>
        <Autocomplete
          name="pullNumber"
          value={values.pullNumber}
          placeholder={values.repoFullName ? localize(language, { en: "Search pull requests...", ja: "Pull Request を検索..." }) : localize(language, { en: "Choose a repository first", ja: "先にリポジトリを選択" })}
          disabled={!values.repoFullName}
          loadOptions={query => ui.listPullRequests(values.repoFullName, query)}
          onChange={pullNumber => setValues({ pullNumber })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubPullRequestConfiguratorRpc, GitHubPullRequestConfiguratorValues>;
