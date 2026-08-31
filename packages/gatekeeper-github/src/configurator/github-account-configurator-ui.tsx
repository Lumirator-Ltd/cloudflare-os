import { localize, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  GitHubAccountConfiguratorRpc,
  GitHubAccountConfiguratorValues,
} from "./github-account-configurator-types";

/**
 * The account resource covers the whole connected GitHub account, so there is nothing to
 * configure: this frame only explains what the connection grants.
 */
export default {
  initial: {},

  resourceUrl() {
    return "https://github.com";
  },

  render({ language }) {
    return <Section title={localize(language, { en: "GitHub Account", ja: "GitHub アカウント" })}>
      {localize(language, { en: "Grants read-only access to every repository this GitHub account can access: repository ", ja: "この GitHub アカウントがアクセスできるすべてのリポジトリへの読み取り専用アクセスを許可します。" })
        + localize(language, { en: "discovery, code, issue and pull-request details, and pull-request diffs. This ", ja: "リポジトリの検索、コード、Issue と Pull Request の詳細、Pull Request の差分が対象です。" })
        + localize(language, { en: "owner-only connection is blocked in shared workspaces and prevents future sharing. ", ja: "この所有者専用接続は共有ワークスペースではブロックされ、今後の共有もできません。" })
        + localize(language, { en: "New write-capable GitHub connections are not available.", ja: "書き込み可能な新しい GitHub 接続は利用できません。" })}
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubAccountConfiguratorRpc, GitHubAccountConfiguratorValues>;
