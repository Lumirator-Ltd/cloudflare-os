import { h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
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

  render() {
    return <Section title="GitHub Account">
      {"Grants read-only access to every repository this GitHub account can access: repository "
        + "discovery, code, issue and pull-request details, and pull-request diffs. This "
        + "owner-only connection is blocked in shared workspaces and prevents future sharing. "
        + "New write-capable GitHub connections are not available."}
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubAccountConfiguratorRpc, GitHubAccountConfiguratorValues>;
