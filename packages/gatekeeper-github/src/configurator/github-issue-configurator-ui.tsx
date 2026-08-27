import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubIssueConfiguratorRpc, GitHubIssueConfiguratorValues } from "./github-issue-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0 &&
      typeof values.issueNumber === "string" && values.issueNumber.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo, , number] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    if (!owner || !repo) return {};
    return { repoFullName: `${owner}/${repo}`, issueNumber: number ?? null };
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}/issues/${values.issueNumber}`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Repository", ja: "リポジトリ" })} description={localize(language, { en: "Search your repositories, or enter a GitHub URL.", ja: "リポジトリを検索するか、GitHub URL を入力します。" })}>
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder={localize(language, { en: "Search or paste a repository URL...", ja: "リポジトリを検索または URL を貼り付け..." })}
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName, issueNumber: null })}
        />
      </Field>

      <Field label={localize(language, { en: "Issue", ja: "Issue" })} description={localize(language, { en: "Choose an issue in the selected repository.", ja: "選択したリポジトリの Issue を選択します。" })}>
        <Autocomplete
          name="issueNumber"
          value={values.issueNumber}
          placeholder={values.repoFullName ? localize(language, { en: "Search issues...", ja: "Issue を検索..." }) : localize(language, { en: "Choose a repository first", ja: "先にリポジトリを選択" })}
          disabled={!values.repoFullName}
          loadOptions={query => ui.listIssues(values.repoFullName, query)}
          onChange={issueNumber => setValues({ issueNumber })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubIssueConfiguratorRpc, GitHubIssueConfiguratorValues>;
