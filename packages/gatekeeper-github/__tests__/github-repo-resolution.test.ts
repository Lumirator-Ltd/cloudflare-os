import { describe, expect, it, vi } from "vitest";
import type { GitHubRepoSummary } from "../src/types";
import {
  GITHUB_REPO_RESOLUTION_MAX_PAGES,
  GITHUB_REPO_RESOLUTION_PAGE_SIZE,
  getDirectGitHubRepoOrNull,
  resolveGitHubRepo,
  resolveGitHubRepoAfterApproval,
  type GitHubRepoResolutionCallbacks,
} from "../src/github-repo-resolution";
import { GitHubApiError } from "../src/github-api";

function repo(fullName: string): GitHubRepoSummary {
  const [owner, name] = fullName.split("/");
  return {
    owner,
    name,
    fullName,
    url: `https://github.com/${fullName}`,
    visibility: "private",
    defaultBranch: "main",
  };
}

function callbacks(
  pages: readonly (readonly GitHubRepoSummary[])[],
): GitHubRepoResolutionCallbacks {
  return {
    getRepo: vi.fn(async () => null),
    listRepos: vi.fn(async ({ page }) => pages[page - 1] ?? []),
  };
}

function fullPage(page: number, match?: GitHubRepoSummary): GitHubRepoSummary[] {
  const repos = Array.from({ length: GITHUB_REPO_RESOLUTION_PAGE_SIZE }, (_, index) =>
    repo(`owner-${page}-${index}/repo-${page}-${index}`));
  if (match) repos[0] = match;
  return repos;
}

describe("resolveGitHubRepoAfterApproval", () => {
  it("forces sharing lockdown before delegating repository resolution", async () => {
    const calls: string[] = [];
    const authorize = vi.fn(async () => { calls.push("authorize"); });
    const expected = { status: "resolved", repo: repo("cloudflare/workerd") } as const;

    await expect(resolveGitHubRepoAfterApproval(
      "cloudflare/workerd",
      authorize,
      async input => {
        calls.push(`resolve:${input}`);
        return expected;
      },
    )).resolves.toEqual(expected);
    expect(calls).toEqual(["authorize", "resolve:cloudflare/workerd"]);
    expect(authorize).toHaveBeenCalledWith({
      title: "Resolve a GitHub repository",
      description: 'Resolve the accessible GitHub repository named by "cloudflare/workerd".',
      prohibitAllSharing: true,
    });
  });

  it("does not delegate when observation approval is rejected", async () => {
    const rejection = new Error("observation rejected");
    const resolve = vi.fn();

    await expect(resolveGitHubRepoAfterApproval(
      "cloudflare/workerd",
      async () => { throw rejection; },
      resolve,
    )).rejects.toBe(rejection);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("resolveGitHubRepo", () => {
  it.each([
    ["Cloudflare/workerd", "workerd"],
    ["https://github.com/Cloudflare/workerd", "workerd"],
    ["Cloudflare/workerd.git", "workerd.git"],
    ["https://github.com/Cloudflare/workerd.git", "workerd.git"],
  ])("directly resolves the exact qualified repository %s", async (input, exactRepo) => {
    const expected = repo(`cloudflare/${exactRepo}`);
    const getRepo = vi.fn(async () => expected);
    const listRepos = vi.fn();

    await expect(resolveGitHubRepo(input, { getRepo, listRepos })).resolves.toEqual({
      status: "resolved",
      repo: expected,
    });
    expect(getRepo).toHaveBeenCalledWith("Cloudflare", exactRepo);
    expect(listRepos).not.toHaveBeenCalled();
  });

  it("maps a direct repository 404 to notFound", async () => {
    const getRepo = vi.fn(async () => await getDirectGitHubRepoOrNull(async () => {
      throw new GitHubApiError(404, "Not Found");
    }));

    await expect(resolveGitHubRepo("private/missing", {
      getRepo,
      listRepos: vi.fn(),
    })).resolves.toMatchObject({ status: "notFound" });
    expect(getRepo).toHaveBeenCalledWith("private", "missing");
  });

  it("propagates non-404 direct repository errors", async () => {
    const unavailable = new GitHubApiError(503, "Service unavailable");

    await expect(resolveGitHubRepo("cloudflare/workerd", {
      getRepo: async () => await getDirectGitHubRepoOrNull(async () => { throw unavailable; }),
      listRepos: vi.fn(),
    })).rejects.toBe(unavailable);
  });

  it("matches a bare repository name case-insensitively across every affiliations page", async () => {
    const expected = repo("an-org/Workerd");
    const resolverCallbacks = callbacks([
      fullPage(1),
      fullPage(2, expected),
      [],
    ]);

    await expect(resolveGitHubRepo("wOrKeRd", resolverCallbacks)).resolves.toEqual({
      status: "resolved",
      repo: expected,
    });
    expect(resolverCallbacks.listRepos).toHaveBeenNthCalledWith(1, {
      affiliation: "owner,collaborator,organization_member",
      page: 1,
      perPage: GITHUB_REPO_RESOLUTION_PAGE_SIZE,
    });
    expect(resolverCallbacks.listRepos).toHaveBeenNthCalledWith(2, {
      affiliation: "owner,collaborator,organization_member",
      page: 2,
      perPage: GITHUB_REPO_RESOLUTION_PAGE_SIZE,
    });
    expect(resolverCallbacks.listRepos).toHaveBeenNthCalledWith(3, {
      affiliation: "owner,collaborator,organization_member",
      page: 3,
      perPage: GITHUB_REPO_RESOLUTION_PAGE_SIZE,
    });
    expect(resolverCallbacks.getRepo).not.toHaveBeenCalled();
  });

  it("returns notFound after all accessible repositories produce no exact name match", async () => {
    const resolverCallbacks = callbacks([[repo("cloudflare/workers")]]);

    await expect(resolveGitHubRepo("workerd", resolverCallbacks)).resolves.toMatchObject({
      status: "notFound",
    });
  });

  it("returns deterministic ambiguity candidates for duplicate names across owners", async () => {
    const resolverCallbacks = callbacks([[
      repo("zeta/widgets"),
      repo("Acme/WIDGETS"),
      repo("acme/widgets"),
    ]]);

    await expect(resolveGitHubRepo("widgets", resolverCallbacks)).resolves.toEqual({
      status: "ambiguous",
      reason: "multipleMatches",
      candidates: [repo("Acme/WIDGETS"), repo("zeta/widgets")],
      message: expect.stringMatching(/owner\/name/),
    });
  });

  it.each([
    "",
    "bad name",
    "owner/repo/extra",
    "https://gitlab.com/owner/repo",
    "https://github.com/owner",
    "https://github.com/owner/repo/issues/1",
    " owner/repo",
    "owner/repo ",
    " https://github.com/owner/repo",
    "https://github.com/owner/repo ",
    " workerd ",
  ])("returns notFound without guessing for malformed input %j", async input => {
    const resolverCallbacks = callbacks([]);

    await expect(resolveGitHubRepo(input, resolverCallbacks)).resolves.toMatchObject({
      status: "notFound",
    });
    expect(resolverCallbacks.getRepo).not.toHaveBeenCalled();
    expect(resolverCallbacks.listRepos).not.toHaveBeenCalled();
  });

  it("does not claim a unique bare-name match when the pagination bound is reached", async () => {
    const expected = repo("cloudflare/workerd");
    const pages = Array.from(
      { length: GITHUB_REPO_RESOLUTION_MAX_PAGES },
      (_, index) => fullPage(index + 1, index === 0 ? expected : undefined),
    );
    const resolverCallbacks = callbacks(pages);

    await expect(resolveGitHubRepo("workerd", resolverCallbacks)).resolves.toEqual({
      status: "ambiguous",
      reason: "paginationBound",
      candidates: [expected],
      message: expect.stringMatching(/owner\/name/),
    });
    expect(resolverCallbacks.listRepos).toHaveBeenCalledTimes(GITHUB_REPO_RESOLUTION_MAX_PAGES);
  });
});
