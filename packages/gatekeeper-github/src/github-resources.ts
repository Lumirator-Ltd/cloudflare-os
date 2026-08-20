import type {
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

export const GITHUB_VENDOR_COPY: Pick<VendorDescription, "tagline" | "description"> = {
  tagline: "Explore GitHub repositories and code",
  description:
    "Connect your GitHub account for owner-only, read-only access to repositories, code, " +
    "issues, pull requests, and diffs. Only persisted legacy repository, issue, and pull " +
    "request bindings retain scoped write access.",
};

export type GitHubResourceKind = "account" | "repo" | "issue" | "pull";

export const ACCOUNT_RESOURCE_DESCRIPTION: ResourceDescription = {
  url: "https://github.com",
  title: "GitHub account",
  snippet:
    "Owner-only account read access: discover repositories, search code, inspect issues and " +
    "pull requests, and read files and diffs.",
  suggestedBindingName: "GITHUB_ACCOUNT",
  tsType: "GitHubAccount",
};

export async function describeGitHubResource(
  resourceKind: GitHubResourceKind,
  loadLegacyDescription: (
    resourceKind: Exclude<GitHubResourceKind, "account">,
  ) => Promise<ResourceDescription>,
): Promise<ResourceDescription> {
  if (resourceKind === "account") return ACCOUNT_RESOURCE_DESCRIPTION;
  return await loadLegacyDescription(resourceKind);
}

export const REPO_RESOURCE: SupportedResource = {
  urlPattern: "https://github.com/:owner/:repo",
  title: "GitHub Repository",
  description: "Read and manage issues, pull requests, reviews, and discussions in a GitHub repository.",
  newConnectionsAllowed: false,
};

export const ISSUE_RESOURCE: SupportedResource = {
  urlPattern: "https://github.com/:owner/:repo/issues/:number",
  title: "GitHub Issue",
  description: "Read and manage a specific GitHub issue.",
  newConnectionsAllowed: false,
};

export const PULL_REQUEST_RESOURCE: SupportedResource = {
  urlPattern: "https://github.com/:owner/:repo/pull/:number",
  title: "GitHub Pull Request",
  description: "Read and manage a specific GitHub pull request and its review threads.",
  newConnectionsAllowed: false,
};

export const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: "https://github.com",
  title: "GitHub Account",
  description:
    "Read-only repository discovery, code, issues, pull requests, and diffs across this GitHub " +
    "account. Owner-only; this connection cannot be used from a shared workspace.",
};

export const SUPPORTED_RESOURCES: SupportedResource[] = [
  ACCOUNT_RESOURCE,
  REPO_RESOURCE,
  ISSUE_RESOURCE,
  PULL_REQUEST_RESOURCE,
];
