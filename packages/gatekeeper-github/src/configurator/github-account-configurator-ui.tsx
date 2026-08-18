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
      {"Grants read access to every repository this GitHub account can access: repository "
        + "discovery, code and issue search, and file reading. Issues, pull requests, and "
        + "write access still require connecting a specific repository. Account-wide "
        + "connections cannot be shared with collaborators."}
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubAccountConfiguratorRpc, GitHubAccountConfiguratorValues>;
