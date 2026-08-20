import { GitHubApiError } from "./github-api";
import { splitRepoFullName } from "./github-code";
import type { GitHubRepoResolution, GitHubRepoSummary } from "./types";

export const GITHUB_REPO_RESOLUTION_PAGE_SIZE = 100;
export const GITHUB_REPO_RESOLUTION_MAX_PAGES = 10;

const ALL_REPO_AFFILIATIONS = "owner,collaborator,organization_member" as const;
const GITHUB_REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export type GitHubRepoResolutionCallbacks = {
  getRepo(owner: string, repo: string): Promise<GitHubRepoSummary | null>;
  listRepos(options: {
    affiliation: typeof ALL_REPO_AFFILIATIONS;
    page: number;
    perPage: number;
  }): Promise<readonly GitHubRepoSummary[]>;
};

export async function getDirectGitHubRepoOrNull<T>(
  getRepo: () => Promise<T>,
): Promise<T | null> {
  try {
    return await getRepo();
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

export async function resolveGitHubRepoAfterApproval(
  input: string,
  authorizeObservation: (description: {
    title: string;
    description: string;
    prohibitAllSharing: true;
  }) => PromiseLike<void>,
  resolveRepo: (input: string) => PromiseLike<GitHubRepoResolution>,
): Promise<GitHubRepoResolution> {
  await authorizeObservation({
    title: "Resolve a GitHub repository",
    description: `Resolve the accessible GitHub repository named by "${input}".`,
    prohibitAllSharing: true,
  });
  return await resolveRepo(input);
}

function compareRepos(left: GitHubRepoSummary, right: GitHubRepoSummary): number {
  const normalizedLeft = left.fullName.toLowerCase();
  const normalizedRight = right.fullName.toLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return left.fullName < right.fullName ? -1 : left.fullName > right.fullName ? 1 : 0;
}

function ambiguous(
  reason: "multipleMatches" | "paginationBound",
  candidates: GitHubRepoSummary[],
): GitHubRepoResolution {
  return {
    status: "ambiguous",
    reason,
    candidates,
    message: reason === "paginationBound"
      ? "Repository resolution reached its search limit. Provide the qualified owner/name."
      : "More than one accessible repository has that name. Provide the qualified owner/name.",
  };
}

export async function resolveGitHubRepo(
  input: string,
  callbacks: GitHubRepoResolutionCallbacks,
): Promise<GitHubRepoResolution> {
  const qualified = splitRepoFullName(input);
  if (qualified) {
    const repo = await callbacks.getRepo(qualified.owner, qualified.repo);
    return repo
      ? { status: "resolved", repo }
      : {
          status: "notFound",
          message: `The GitHub repository ${qualified.owner}/${qualified.repo} was not found or is not accessible.`,
        };
  }

  const name = input;
  if (!GITHUB_REPO_NAME_PATTERN.test(name)) {
    return {
      status: "notFound",
      message: "The input is not a repository name, qualified owner/name, or GitHub repository URL.",
    };
  }

  const matches = new Map<string, GitHubRepoSummary>();
  let exhausted = false;
  for (let page = 1; page <= GITHUB_REPO_RESOLUTION_MAX_PAGES; page++) {
    const repos = await callbacks.listRepos({
      affiliation: ALL_REPO_AFFILIATIONS,
      page,
      perPage: GITHUB_REPO_RESOLUTION_PAGE_SIZE,
    });
    for (const repo of repos) {
      if (repo.name.toLowerCase() === name.toLowerCase()) {
        const key = repo.fullName.toLowerCase();
        if (!matches.has(key)) matches.set(key, repo);
      }
    }
    if (repos.length < GITHUB_REPO_RESOLUTION_PAGE_SIZE) {
      exhausted = true;
      break;
    }
  }

  const candidates = [...matches.values()].toSorted(compareRepos);
  if (candidates.length > 1) return ambiguous("multipleMatches", candidates);
  if (!exhausted) return ambiguous("paginationBound", candidates);
  if (candidates.length === 1) return { status: "resolved", repo: candidates[0] };
  return {
    status: "notFound",
    message: `No accessible GitHub repository has the exact name "${name}".`,
  };
}
