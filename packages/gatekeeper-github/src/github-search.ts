import type { GitHubIssueResponse } from "./github-api";
import type { GitHubIssueSearch, GitHubPullRequestSearch } from "./types";

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The scope a search is confined to: a single repository, or every repository owned by
 * `owner` (GitHub's `user:`/`org:` qualifier — note this does not cover repos the account
 * can merely access as a collaborator). `ownerIsOrg` selects the `org:` qualifier, which
 * GitHub requires for organization owners.
 */
export type GitHubSearchScope = { owner: string; repo?: string; ownerIsOrg?: boolean };

/** The GitHub search qualifier that confines a query to `scope`. */
export function scopeQualifier(scope: GitHubSearchScope): string {
  if (!GITHUB_OWNER_PATTERN.test(scope.owner)) {
    throw new Error(`"${scope.owner}" is not a valid GitHub owner.`);
  }
  if (scope.repo !== undefined && (!GITHUB_REPO_PATTERN.test(scope.repo)
      || scope.repo === "." || scope.repo === "..")) {
    throw new Error(`"${scope.repo}" is not a valid GitHub repository.`);
  }
  if (scope.repo) return `repo:${scope.owner}/${scope.repo}`;
  return scope.ownerIsOrg ? `org:${scope.owner}` : `user:${scope.owner}`;
}

export function buildScopedIssueSearchQuery(scope: GitHubSearchScope, query: GitHubIssueSearch): string {
  const parts = [query.text ? JSON.stringify(query.text) : "", scopeQualifier(scope), "is:issue"];
  if (query.state && query.state !== "all") parts.push(`state:${query.state}`);
  for (const label of query.labels ?? []) {
    parts.push(`label:${JSON.stringify(label)}`);
  }
  if (query.author) parts.push(`author:${JSON.stringify(query.author)}`);
  if (query.assignee) parts.push(`assignee:${JSON.stringify(query.assignee)}`);
  return parts.filter(Boolean).join(" ");
}

export function buildIssueSearchQuery(owner: string, repo: string, query: GitHubIssueSearch): string {
  return buildScopedIssueSearchQuery({ owner, repo }, query);
}

/** Builds a pull-request search whose caller-controlled fields cannot alter its scope or kind. */
export function buildScopedPullRequestSearchQuery(
  scope: GitHubSearchScope,
  query: GitHubPullRequestSearch,
): string {
  const parts = [query.text ? JSON.stringify(query.text) : "", scopeQualifier(scope), "is:pr"];
  if (query.state && query.state !== "all") parts.push(`state:${query.state}`);
  if (query.merged !== undefined) parts.push(query.merged ? "is:merged" : "is:unmerged");
  if (query.draft !== undefined) parts.push(`draft:${query.draft}`);
  for (const label of query.labels ?? []) {
    parts.push(`label:${JSON.stringify(label)}`);
  }
  if (query.author) parts.push(`author:${JSON.stringify(query.author)}`);
  if (query.assignee) parts.push(`assignee:${JSON.stringify(query.assignee)}`);
  return parts.filter(Boolean).join(" ");
}

/**
 * Builds a code search query. All caller-controlled fragments are quoted so search
 * qualifiers cannot be injected to escape the scope. Code search only covers the default
 * branch of each repository.
 */
export function buildCodeSearchQuery(
  scope: GitHubSearchScope,
  query: { text: string; path?: string; extension?: string },
): string {
  const parts = [JSON.stringify(query.text), scopeQualifier(scope)];
  if (query.path) parts.push(`path:${JSON.stringify(query.path)}`);
  if (query.extension) parts.push(`extension:${JSON.stringify(query.extension)}`);
  return parts.join(" ");
}

function repoInScope(scope: GitHubSearchScope, owner?: string, repo?: string): boolean {
  if (owner?.toLowerCase() !== scope.owner.toLowerCase()) return false;
  if (!repo) return false;
  if (scope.repo !== undefined && repo.toLowerCase() !== scope.repo.toLowerCase()) return false;
  return true;
}

/**
 * Search endpoints interpret qualifiers server-side, so even with quoted queries we verify
 * every result actually falls inside the requested scope before returning it.
 */
export function assertCodeSearchResultsInScope(
  scope: GitHubSearchScope,
  results: readonly { repository: { full_name: string } }[],
): void {
  for (const result of results) {
    const [owner, repo, ...rest] = result.repository.full_name.split("/");
    if (rest.length > 0 || !repoInScope(scope, owner, repo)) {
      throw new Error("GitHub returned a code search result outside the requested scope.");
    }
  }
}

export function assertRepoSearchResultsInScope(
  scope: GitHubSearchScope,
  results: readonly { full_name: string }[],
): void {
  for (const result of results) {
    const [owner, repo, ...rest] = result.full_name.split("/");
    if (rest.length > 0 || !repoInScope(scope, owner, repo)) {
      throw new Error("GitHub returned a repository outside the requested scope.");
    }
  }
}

type SearchResult = Pick<GitHubIssueResponse, "html_url">
  & Partial<Pick<GitHubIssueResponse, "number" | "pull_request">>;
type SearchResultViolation = "scope" | "kind" | "malformed" | null;
type SearchResultKind = "issue" | "pull";

function checkSearchResult(
  scope: GitHubSearchScope,
  result: SearchResult,
  expectedKind: SearchResultKind,
): SearchResultViolation {
  let url: URL;
  try {
    url = new URL(result.html_url);
  } catch {
    return "malformed";
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const [owner, repo, kind, rawNumber] = segments;
  if (url.protocol !== "https:" || url.host.toLowerCase() !== "github.com"
      || url.username !== "" || url.password !== ""
      || result.html_url !== `https://github.com${url.pathname}`
      || !repoInScope(scope, owner, repo)) {
    return "scope";
  }
  if (segments.length !== 4 || !/^[1-9]\d*$/.test(rawNumber ?? "")
      || url.pathname !== `/${owner}/${repo}/${kind}/${rawNumber}`) {
    return "malformed";
  }

  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || (result.number !== undefined && result.number !== number)) {
    return "malformed";
  }

  const expectedPathKind = expectedKind === "issue" ? "issues" : "pull";
  if (kind !== expectedPathKind) return "kind";
  if (expectedKind === "issue" && result.pull_request !== undefined) return "kind";
  if (expectedKind === "pull" && result.pull_request === undefined) return "kind";
  return null;
}

function assertSearchResultsInScope(
  scope: GitHubSearchScope,
  results: readonly SearchResult[],
  expectedKind: SearchResultKind,
  scopeMessage: string,
): void {
  for (const result of results) {
    switch (checkSearchResult(scope, result, expectedKind)) {
      case "scope":
        throw new Error(scopeMessage);
      case "malformed":
        throw new Error(scopeMessage);
      case "kind":
        throw new Error(expectedKind === "issue"
          ? "GitHub returned a non-issue result for an issue search."
          : "GitHub returned a non-pull-request result for a pull request search.");
    }
  }
}

export function assertIssueSearchResultsInScope(
  scope: GitHubSearchScope,
  results: readonly SearchResult[],
): void {
  assertSearchResultsInScope(
    scope,
    results,
    "issue",
    "GitHub returned an issue outside the requested scope.",
  );
}

export function assertPullRequestSearchResultsInScope(
  scope: GitHubSearchScope,
  results: readonly SearchResult[],
): void {
  assertSearchResultsInScope(
    scope,
    results,
    "pull",
    "GitHub returned a pull request outside the requested scope.",
  );
}

export function assertIssueSearchResultsInRepo(
  owner: string,
  repo: string,
  results: readonly SearchResult[],
): void {
  assertSearchResultsInScope(
    { owner, repo },
    results,
    "issue",
    "GitHub returned an issue outside the connected repository.",
  );
}
