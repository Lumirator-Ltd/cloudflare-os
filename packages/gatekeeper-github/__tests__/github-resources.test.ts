import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_RESOURCE,
  ACCOUNT_RESOURCE_DESCRIPTION,
  GITHUB_VENDOR_COPY,
  describeGitHubResource,
  ISSUE_RESOURCE,
  PULL_REQUEST_RESOURCE,
  REPO_RESOURCE,
  SUPPORTED_RESOURCES,
} from "../src/github-resources";

describe("GitHub supported resources", () => {
  it("keeps all four resource types in the compatibility catalog", () => {
    expect(SUPPORTED_RESOURCES).toEqual([
      ACCOUNT_RESOURCE,
      REPO_RESOURCE,
      ISSUE_RESOURCE,
      PULL_REQUEST_RESOURCE,
    ]);
    expect(SUPPORTED_RESOURCES.map(resource => resource.urlPattern)).toEqual([
      "https://github.com",
      "https://github.com/:owner/:repo",
      "https://github.com/:owner/:repo/issues/:number",
      "https://github.com/:owner/:repo/pull/:number",
    ]);
  });

  it("allows new bindings only for the account resource", () => {
    expect(SUPPORTED_RESOURCES.filter(
      resource => resource.newConnectionsAllowed !== false,
    )).toEqual([ACCOUNT_RESOURCE]);
    expect(REPO_RESOURCE.newConnectionsAllowed).toBe(false);
    expect(ISSUE_RESOURCE.newConnectionsAllowed).toBe(false);
    expect(PULL_REQUEST_RESOURCE.newConnectionsAllowed).toBe(false);
  });

  it("describes the account resource without credentialed metadata", async () => {
    const loadLegacyDescription = vi.fn(async () => {
      throw new Error("credentialed metadata should not be loaded");
    });

    await expect(describeGitHubResource("account", loadLegacyDescription)).resolves.toEqual(
      ACCOUNT_RESOURCE_DESCRIPTION,
    );
    expect(loadLegacyDescription).not.toHaveBeenCalled();
    expect(ACCOUNT_RESOURCE_DESCRIPTION).toEqual({
      url: "https://github.com",
      title: "GitHub account",
      snippet:
        "Owner-only account read access: discover repositories, search code, inspect issues and " +
        "pull requests, and read files and diffs.",
      suggestedBindingName: "GITHUB_ACCOUNT",
      tsType: "GitHubAccount",
    });
  });

  it("advertises only new account-wide reads and grandfathered scoped writes", () => {
    expect(GITHUB_VENDOR_COPY).toEqual({
      tagline: "Explore GitHub repositories and code",
      description:
        "Connect your GitHub account for owner-only, read-only access to repositories, code, " +
        "issues, pull requests, and diffs. Only persisted legacy repository, issue, and pull " +
        "request bindings retain scoped write access.",
    });
  });
});
