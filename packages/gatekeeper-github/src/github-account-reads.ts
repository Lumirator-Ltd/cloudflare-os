import type { GitHubPullRequestRevision } from "./types";

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** A validated canonical `owner/name` repository identifier. */
export type CanonicalGitHubRepository = {
  owner: string;
  repo: string;
};

/** An issue-like entity kind supported by account-level reads. */
export type GitHubAccountEntityKind = "issue" | "pull";

/** Maximum page size accepted by account-wide cursor methods. */
export const GITHUB_ACCOUNT_MAX_PAGE_SIZE = 200;

/** Parses an exact `owner/name` identifier without accepting URLs or shorthand. */
export function parseCanonicalGitHubRepository(input: string): CanonicalGitHubRepository {
  const [owner, repo, ...rest] = input.split("/");
  if (rest.length > 0 || !owner || !repo
      || !GITHUB_OWNER_PATTERN.test(owner)
      || !GITHUB_REPO_PATTERN.test(repo)
      || repo === "." || repo === "..") {
    throw new Error(`"${input}" is not a valid GitHub repository; expected a canonical owner/name.`);
  }
  return { owner, repo };
}

/** Returns a positive safe integer issue/PR number or throws. */
export function requirePositiveGitHubNumber(number: number): number {
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("GitHub issue and pull-request numbers must be positive integers.");
  }
  return number;
}

/** Validates an account cursor page size, applying the method default when omitted. */
export function requireGitHubAccountPageSize(
  resultsPerPage: number | undefined,
  defaultPageSize: number,
): number {
  const pageSize = resultsPerPage ?? defaultPageSize;
  if (!Number.isFinite(pageSize) || !Number.isInteger(pageSize)
      || pageSize < 1 || pageSize > GITHUB_ACCOUNT_MAX_PAGE_SIZE) {
    throw new Error(
      `GitHub account resultsPerPage must be a finite integer between 1 and ${GITHUB_ACCOUNT_MAX_PAGE_SIZE}.`,
    );
  }
  return pageSize;
}

function normalizedRepository(owner: string, repo: string): CanonicalGitHubRepository {
  const parsed = parseCanonicalGitHubRepository(`${owner}/${repo}`);
  return {
    owner: parsed.owner.toLowerCase(),
    repo: parsed.repo.toLowerCase(),
  };
}

/** Builds a repository-qualified, case-normalized account entity cache key. */
export function githubAccountEntityCacheKey(
  owner: string,
  repo: string,
  kind: GitHubAccountEntityKind,
  number: number,
): string {
  const normalized = normalizedRepository(owner, repo);
  return `cache:account:${normalized.owner}:${normalized.repo}:${kind}:${requirePositiveGitHubNumber(number)}`;
}

/** Builds a repository-, number-, revision-, and optional page-qualified diff cache key. */
export function githubAccountDiffCacheKey(
  owner: string,
  repo: string,
  number: number,
  revision: GitHubPullRequestRevision,
  page?: number,
): string {
  const normalized = normalizedRepository(owner, repo);
  const key = [
    "cache",
    "account",
    normalized.owner,
    normalized.repo,
    "pull",
    String(requirePositiveGitHubNumber(number)),
    "diff",
    encodeURIComponent(revision.baseSha),
    encodeURIComponent(revision.headSha),
  ];
  if (page !== undefined) key.push(`p${requirePositiveGitHubNumber(page)}`);
  return key.join(":");
}

/** Returns the canonical web URL for an account issue or pull request. */
export function githubAccountEntityUrl(
  owner: string,
  repo: string,
  kind: GitHubAccountEntityKind,
  number: number,
): string {
  const canonical = parseCanonicalGitHubRepository(`${owner}/${repo}`);
  const pathKind = kind === "issue" ? "issues" : "pull";
  return `https://github.com/${canonical.owner}/${canonical.repo}/${pathKind}/${requirePositiveGitHubNumber(number)}`;
}

/** Rejects an entity response that does not exactly match its requested repository and kind. */
export function assertGitHubAccountEntityResponse(
  kind: GitHubAccountEntityKind,
  repo: CanonicalGitHubRepository,
  number: number,
  response: { number: number; html_url: string },
): void {
  const expectedNumber = requirePositiveGitHubNumber(number);
  let url: URL;
  try {
    url = new URL(response.html_url);
  } catch {
    throw new Error("The GitHub response did not match the requested repository, kind, and number.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const [owner, repoName, pathKind, rawNumber] = segments;
  const expectedPathKind = kind === "issue" ? "issues" : "pull";
  if (url.protocol !== "https:" || url.host.toLowerCase() !== "github.com"
      || url.username !== "" || url.password !== ""
      || response.html_url !== `https://github.com${url.pathname}`
      || segments.length !== 4
      || url.pathname !== `/${owner}/${repoName}/${pathKind}/${rawNumber}`
      || owner?.toLowerCase() !== repo.owner.toLowerCase()
      || repoName?.toLowerCase() !== repo.repo.toLowerCase()
      || pathKind !== expectedPathKind
      || rawNumber !== String(expectedNumber)
      || response.number !== expectedNumber) {
    throw new Error("The GitHub response did not match the requested repository, kind, and number.");
  }
}

/** Validates an issue response and reports a correctly scoped pull request as a friendly kind error. */
export function assertGitHubAccountIssueResponse(
  repo: CanonicalGitHubRepository,
  number: number,
  response: { number: number; html_url: string; pull_request?: unknown },
): void {
  if (response.pull_request !== undefined) {
    assertGitHubAccountEntityResponse("pull", repo, number, response);
    throw new Error(`#${number} is a pull request, not an issue.`);
  }
  assertGitHubAccountEntityResponse("issue", repo, number, response);
}

/** Reads and validates the current pull-request revision without consulting entity caches. */
export async function readFreshGitHubPullRequestRevision(
  reader: {
    getPullRequest(
      owner: string,
      repo: string,
      number: number,
    ): Promise<{
      number: number;
      html_url: string;
      base: { sha: string };
      head: { sha: string };
    }>;
  },
  repo: CanonicalGitHubRepository,
  number: number,
): Promise<GitHubPullRequestRevision> {
  const canonical = parseCanonicalGitHubRepository(`${repo.owner}/${repo.repo}`);
  const expectedNumber = requirePositiveGitHubNumber(number);
  const response = await reader.getPullRequest(canonical.owner, canonical.repo, expectedNumber);
  assertGitHubAccountEntityResponse("pull", canonical, expectedNumber, response);
  return { baseSha: response.base.sha, headSha: response.head.sha };
}

/** Runs an account read only after its owner-only observation has been authorized. */
export async function authorizeGitHubAccountRead<T>(
  authorizeObservation: (description: {
    title: string;
    description: string;
    prohibitAllSharing: true;
  }) => PromiseLike<void>,
  description: { title: string; description: string },
  read: () => PromiseLike<T>,
): Promise<T> {
  await authorizeObservation({ ...description, prohibitAllSharing: true });
  return await read();
}

/** Validates paging before authorization, then creates an owner-only account cursor. */
export async function authorizeGitHubAccountCursorRead<T>(
  authorizeObservation: (description: {
    title: string;
    description: string;
    prohibitAllSharing: true;
  }) => PromiseLike<void>,
  description: { title: string; description: string },
  resultsPerPage: number | undefined,
  defaultPageSize: number,
  read: (pageSize: number) => PromiseLike<T>,
): Promise<T> {
  const pageSize = requireGitHubAccountPageSize(resultsPerPage, defaultPageSize);
  return await authorizeGitHubAccountRead(
    authorizeObservation,
    description,
    () => read(pageSize),
  );
}
