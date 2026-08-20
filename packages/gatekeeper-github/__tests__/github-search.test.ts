import { lstat, readFile, readlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { GitHubIssueResponse } from "../src/github-api";
import {
  assertIssueSearchResultsInScope,
  assertPullRequestSearchResultsInScope,
  buildScopedPullRequestSearchQuery,
  scopeQualifier,
} from "../src/github-search";

function searchResult(
  htmlUrl: string,
  kind: "issue" | "pull",
): Pick<GitHubIssueResponse, "html_url" | "number" | "pull_request"> {
  const number = Number(new URL(htmlUrl).pathname.split("/").at(-1));
  return {
    html_url: htmlUrl,
    number,
    pull_request: kind === "pull" ? { html_url: htmlUrl } : undefined,
  };
}

describe("buildScopedPullRequestSearchQuery", () => {
  it("quotes caller-controlled fields and fixes the exact repository and PR kind", () => {
    expect(buildScopedPullRequestSearchQuery(
      { owner: "cloudflare", repo: "workerd" },
      {
        text: "bug OR repo:evil/escape",
        state: "open",
        merged: false,
        draft: true,
        labels: ["help wanted", "bug OR repo:evil/escape"],
        author: "octocat OR repo:evil/escape",
        assignee: "hubot OR repo:evil/escape",
      },
    )).toBe(
      '"bug OR repo:evil/escape" repo:cloudflare/workerd is:pr state:open '
      + 'is:unmerged draft:true label:"help wanted" label:"bug OR repo:evil/escape" '
      + 'author:"octocat OR repo:evil/escape" assignee:"hubot OR repo:evil/escape"',
    );
  });

  it("uses exact owner scopes and rejects malformed scope qualifiers", () => {
    expect(buildScopedPullRequestSearchQuery(
      { owner: "cloudflare", ownerIsOrg: true },
      { text: 'fix "quotes"', merged: true },
    )).toBe('"fix \\"quotes\\"" org:cloudflare is:pr is:merged');

    expect(() => scopeQualifier({ owner: "cloudflare OR org:evil" }))
      .toThrow("valid GitHub owner");
    expect(() => scopeQualifier({ owner: "cloudflare", repo: "workerd OR repo:evil/escape" }))
      .toThrow("valid GitHub repository");
    expect(() => scopeQualifier({ owner: "cloudflare", repo: ".." }))
      .toThrow("valid GitHub repository");
  });
});

describe("kind-aware issue and pull-request search validation", () => {
  const issueScope = { owner: "Cloudflare", repo: "Workerd" };

  it("accepts exact issue and pull-request results case-insensitively", () => {
    expect(() => assertIssueSearchResultsInScope(issueScope, [
      searchResult("https://github.com/cloudflare/workerd/issues/12", "issue"),
    ])).not.toThrow();
    expect(() => assertPullRequestSearchResultsInScope(issueScope, [
      searchResult("https://github.com/cloudflare/workerd/pull/12", "pull"),
    ])).not.toThrow();
  });

  it.each([
    "https://example.com/cloudflare/workerd/pull/12",
    "https://github.com/evil/workerd/pull/12",
    "https://github.com/cloudflare/other/pull/12",
    "https://github.com/cloudflare/workerd/pull/not-a-number",
    "https://github.com/cloudflare/workerd/pull/12/files",
    "https://github.com/cloudflare//workerd/pull/12",
    "https://user@github.com/cloudflare/workerd/pull/12",
    "https://github.com:8443/cloudflare/workerd/pull/12",
  ])("rejects malformed or out-of-scope pull-request result %s", htmlUrl => {
    expect(() => assertPullRequestSearchResultsInScope(issueScope, [{
      html_url: htmlUrl,
      number: 12,
      pull_request: { html_url: htmlUrl },
    }])).toThrow(/outside the requested scope|malformed/);
  });

  it("rejects issue results from PR search and PR results from issue search", () => {
    expect(() => assertPullRequestSearchResultsInScope(issueScope, [
      searchResult("https://github.com/cloudflare/workerd/issues/12", "issue"),
    ])).toThrow("non-pull-request result");
    expect(() => assertIssueSearchResultsInScope(issueScope, [
      searchResult("https://github.com/cloudflare/workerd/pull/12", "pull"),
    ])).toThrow("non-issue result");
  });

  it("rejects a PR URL without the PR kind marker", () => {
    expect(() => assertPullRequestSearchResultsInScope(issueScope, [{
      html_url: "https://github.com/cloudflare/workerd/pull/12",
      number: 12,
    }])).toThrow("non-pull-request result");
  });
});

describe("public GitHub agent types", () => {
  it("serves types.d.ts through the tracked types.txt symlink", async () => {
    const typesTxt = new URL("../src/types.txt", import.meta.url);
    const typesDts = new URL("../src/types.d.ts", import.meta.url);

    expect((await lstat(typesTxt)).isSymbolicLink()).toBe(true);
    expect(await readlink(typesTxt)).toBe("types.d.ts");
    expect(await readFile(typesTxt, "utf8")).toBe(await readFile(typesDts, "utf8"));
  });
});
