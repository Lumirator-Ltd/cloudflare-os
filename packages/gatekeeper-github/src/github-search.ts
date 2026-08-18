import type { GitHubIssueResponse } from "./github-api";
import type { GitHubIssueSearch } from "./types";

/**
 * The scope a search is confined to: a single repository, or every repository owned by
 * `owner` (GitHub's `user:` qualifier — note this does not cover org/collaborator repos the
 * account can merely access).
 */
export type GitHubSearchScope = { owner: string; repo?: string };

function scopeQualifier(scope: GitHubSearchScope): string {
  return scope.repo ? `repo:${scope.owner}/${scope.repo}` : `user:${scope.owner}`;
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

type IssueScopeViolation = "scope" | "kind" | null;

function checkIssueSearchResult(
  scope: GitHubSearchScope,
  result: Pick<GitHubIssueResponse, "html_url">,
): IssueScopeViolation {
  let url: URL | undefined;
  try {
    url = new URL(result.html_url);
  } catch {
    // Handled by the scope check below.
  }

  const [owner, repo, kind] = url?.pathname.split("/").filter(Boolean) ?? [];
  if (url?.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com"
      || !repoInScope(scope, owner, repo)) {
    return "scope";
  }
  return kind === "issues" ? null : "kind";
}

export function assertIssueSearchResultsInScope(
  scope: GitHubSearchScope,
  results: readonly Pick<GitHubIssueResponse, "html_url">[],
): void {
  for (const result of results) {
    switch (checkIssueSearchResult(scope, result)) {
      case "scope":
        throw new Error("GitHub returned an issue outside the requested scope.");
      case "kind":
        throw new Error("GitHub returned a non-issue result for an issue search.");
    }
  }
}

export function assertIssueSearchResultsInRepo(
  owner: string,
  repo: string,
  results: readonly Pick<GitHubIssueResponse, "html_url">[],
): void {
  for (const result of results) {
    switch (checkIssueSearchResult({ owner, repo }, result)) {
      case "scope":
        throw new Error("GitHub returned an issue outside the connected repository.");
      case "kind":
        throw new Error("GitHub returned a non-issue result for an issue search.");
    }
  }
}
