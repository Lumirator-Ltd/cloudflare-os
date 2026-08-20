import { describe, expect, it, vi } from "vitest";
import {
  assertGitHubAccountEntityResponse,
  assertGitHubAccountIssueResponse,
  authorizeGitHubAccountCursorRead,
  authorizeGitHubAccountRead,
  githubAccountDiffCacheKey,
  githubAccountEntityCacheKey,
  githubAccountEntityUrl,
  parseCanonicalGitHubRepository,
  readFreshGitHubPullRequestRevision,
  requireGitHubAccountPageSize,
  requirePositiveGitHubNumber,
} from "../src/github-account-reads";
import { normalizeGitHubPullRequestDiffFile } from "../src/github-code";

describe("parseCanonicalGitHubRepository", () => {
  it("accepts canonical owner/name identifiers and preserves API spelling", () => {
    expect(parseCanonicalGitHubRepository("Cloudflare/Workerd.js")).toEqual({
      owner: "Cloudflare",
      repo: "Workerd.js",
    });
  });

  it.each([
    "",
    "cloudflare",
    "cloudflare/workerd/extra",
    " cloudflare/workerd",
    "cloudflare/workerd ",
    "https://github.com/cloudflare/workerd",
    "bad owner/workerd",
    "-owner/workerd",
    "owner-/workerd",
    "cloudflare/bad repo",
  ])("rejects malformed or non-canonical repository input %j", input => {
    expect(() => parseCanonicalGitHubRepository(input)).toThrow(
      "expected a canonical owner/name",
    );
  });
});

describe("requirePositiveGitHubNumber", () => {
  it("accepts positive safe integers", () => {
    expect(requirePositiveGitHubNumber(1)).toBe(1);
    expect(requirePositiveGitHubNumber(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed issue or pull-request number %s",
    number => {
      expect(() => requirePositiveGitHubNumber(number)).toThrow("positive integer");
    },
  );
});

describe("account read cache keys", () => {
  it("normalizes repository case and isolates entity kind, number, and repository", () => {
    expect(githubAccountEntityCacheKey("Cloudflare", "Workerd", "issue", 7))
      .toBe(githubAccountEntityCacheKey("cloudflare", "workerd", "issue", 7));

    const cache = new Map<string, string>();
    cache.set(githubAccountEntityCacheKey("acme", "alpha", "issue", 7), "alpha issue");
    cache.set(githubAccountEntityCacheKey("acme", "beta", "issue", 7), "beta issue");
    cache.set(githubAccountEntityCacheKey("acme", "alpha", "pull", 7), "alpha pull");
    cache.set(githubAccountEntityCacheKey("acme", "alpha", "issue", 8), "alpha issue 8");

    expect(cache.size).toBe(4);
    expect(cache.get(githubAccountEntityCacheKey("ACME", "ALPHA", "issue", 7)))
      .toBe("alpha issue");
    expect(cache.get(githubAccountEntityCacheKey("acme", "beta", "issue", 7)))
      .toBe("beta issue");
    expect(cache.get(githubAccountEntityCacheKey("acme", "alpha", "pull", 7)))
      .toBe("alpha pull");
  });

  it("isolates identical PR numbers and diff revisions across repositories", () => {
    const revisionOne = { baseSha: "base-1", headSha: "head-1" };
    const revisionTwo = { baseSha: "base-1", headSha: "head-2" };
    const cache = new Map<string, string>();

    cache.set(githubAccountDiffCacheKey("acme", "alpha", 9, revisionOne), "alpha revision one");
    cache.set(githubAccountDiffCacheKey("acme", "beta", 9, revisionOne), "beta revision one");
    cache.set(githubAccountDiffCacheKey("acme", "alpha", 9, revisionTwo), "alpha revision two");
    cache.set(githubAccountDiffCacheKey("acme", "alpha", 9, revisionOne, 1), "alpha page one");
    cache.set(githubAccountDiffCacheKey("acme", "alpha", 9, revisionOne, 2), "alpha page two");

    expect(cache.size).toBe(5);
    expect(cache.get(githubAccountDiffCacheKey("ACME", "ALPHA", 9, revisionOne)))
      .toBe("alpha revision one");
    expect(cache.get(githubAccountDiffCacheKey("acme", "beta", 9, revisionOne)))
      .toBe("beta revision one");
    expect(cache.get(githubAccountDiffCacheKey("acme", "alpha", 9, revisionTwo)))
      .toBe("alpha revision two");
    expect(cache.get(githubAccountDiffCacheKey("acme", "alpha", 9, revisionOne, 2)))
      .toBe("alpha page two");
  });
});

describe("account entity response validation", () => {
  it("accepts exact issue and pull-request responses", () => {
    expect(() => assertGitHubAccountEntityResponse(
      "issue",
      { owner: "Cloudflare", repo: "Workerd" },
      12,
      { number: 12, html_url: "https://github.com/cloudflare/workerd/issues/12" },
    )).not.toThrow();
    expect(() => assertGitHubAccountEntityResponse(
      "pull",
      { owner: "Cloudflare", repo: "Workerd" },
      12,
      { number: 12, html_url: "https://github.com/cloudflare/workerd/pull/12" },
    )).not.toThrow();
  });

  it.each([
    ["issue", 12, "https://github.com/cloudflare/workerd/pull/12"],
    ["pull", 12, "https://github.com/cloudflare/workerd/issues/12"],
    ["pull", 13, "https://github.com/cloudflare/workerd/pull/12"],
    ["pull", 12, "https://github.com/cloudflare/other/pull/12"],
    ["pull", 12, "https://example.com/cloudflare/workerd/pull/12"],
    ["pull", 12, "https://github.com/cloudflare//workerd/pull/12"],
    ["pull", 12, "https://user@github.com/cloudflare/workerd/pull/12"],
    ["pull", 12, "https://github.com:8443/cloudflare/workerd/pull/12"],
    ["pull", 12, "https://github.com:443/cloudflare/workerd/pull/12"],
    ["pull", 12, "https://github.com/cloudflare/workerd/pull/12?source=api"],
    ["pull", 12, "https://github.com/cloudflare/workerd/pull/12#discussion"],
    ["pull", 12, "not a URL"],
  ] as const)("rejects wrong-kind, wrong-number, or wrong-repository responses", (kind, number, htmlUrl) => {
    expect(() => assertGitHubAccountEntityResponse(
      kind,
      { owner: "cloudflare", repo: "workerd" },
      number,
      { number: 12, html_url: htmlUrl },
    )).toThrow("did not match the requested");
  });
});

describe("account read authorization", () => {
  it("forces sharing lockdown before delegating every account read", async () => {
    const calls: string[] = [];
    const authorize = vi.fn(async () => { calls.push("authorize"); });
    const result = await authorizeGitHubAccountRead(
      authorize,
      { title: "Read PR", description: "Read PR #1." },
      async () => {
        calls.push("read");
        return "result";
      },
    );

    expect(result).toBe("result");
    expect(calls).toEqual(["authorize", "read"]);
    expect(authorize).toHaveBeenCalledWith({
      title: "Read PR",
      description: "Read PR #1.",
      prohibitAllSharing: true,
    });
  });

  it("does not delegate when sharing policy rejects the observation", async () => {
    const rejection = new Error("observation rejected");
    const read = vi.fn();

    await expect(authorizeGitHubAccountRead(
      async () => { throw rejection; },
      { title: "Read PR", description: "Read PR #1." },
      read,
    )).rejects.toBe(rejection);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("account cursor page sizes", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 201])(
    "rejects invalid page size %s",
    pageSize => {
      expect(() => requireGitHubAccountPageSize(pageSize, 50)).toThrow(
        "between 1 and 200",
      );
    },
  );

  it("accepts the documented bounds and applies the method default", () => {
    expect(requireGitHubAccountPageSize(undefined, 50)).toBe(50);
    expect(requireGitHubAccountPageSize(1, 50)).toBe(1);
    expect(requireGitHubAccountPageSize(200, 50)).toBe(200);
  });

  it.each(["cached", "uncached"])(
    "rejects before approval or %s cursor creation",
    async _path => {
      const authorize = vi.fn();
      const createCursor = vi.fn();

      await expect(authorizeGitHubAccountCursorRead(
        authorize,
        { title: "List repositories", description: "List repositories." },
        0,
        50,
        createCursor,
      )).rejects.toThrow("between 1 and 200");
      expect(authorize).not.toHaveBeenCalled();
      expect(createCursor).not.toHaveBeenCalled();
    },
  );

  it("forces sharing lockdown before creating a valid cursor", async () => {
    const authorize = vi.fn(async () => {});
    const createCursor = vi.fn(async (pageSize: number) => pageSize);

    await expect(authorizeGitHubAccountCursorRead(
      authorize,
      { title: "List repositories", description: "List repositories." },
      200,
      50,
      createCursor,
    )).resolves.toBe(200);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ prohibitAllSharing: true }));
    expect(createCursor).toHaveBeenCalledWith(200);
  });
});

describe("account issue and pull-request identity", () => {
  it("uses the pull path for pull-request details", () => {
    expect(githubAccountEntityUrl("cloudflare", "workerd", "issue", 12))
      .toBe("https://github.com/cloudflare/workerd/issues/12");
    expect(githubAccountEntityUrl("cloudflare", "workerd", "pull", 12))
      .toBe("https://github.com/cloudflare/workerd/pull/12");
  });

  it("returns the friendly wrong-kind error for a normal PR returned by getIssue", () => {
    expect(() => assertGitHubAccountIssueResponse(
      { owner: "cloudflare", repo: "workerd" },
      12,
      {
        number: 12,
        html_url: "https://github.com/cloudflare/workerd/pull/12",
        pull_request: { html_url: "https://github.com/cloudflare/workerd/pull/12" },
      },
    )).toThrow("#12 is a pull request, not an issue");
  });

  it("validates repository and number before reporting a wrong kind", () => {
    expect(() => assertGitHubAccountIssueResponse(
      { owner: "cloudflare", repo: "workerd" },
      12,
      {
        number: 13,
        html_url: "https://github.com/attacker/other/pull/13",
        pull_request: { html_url: "https://github.com/attacker/other/pull/13" },
      },
    )).toThrow("did not match the requested");
  });
});

describe("fresh account pull-request revisions", () => {
  it("reads current pull-request details on every diff call instead of reusing cached details", async () => {
    const getPullRequest = vi.fn()
      .mockResolvedValueOnce({
        number: 12,
        html_url: "https://github.com/cloudflare/workerd/pull/12",
        base: { sha: "base-a" },
        head: { sha: "head-a" },
      })
      .mockResolvedValueOnce({
        number: 12,
        html_url: "https://github.com/cloudflare/workerd/pull/12",
        base: { sha: "base-b" },
        head: { sha: "head-b" },
      });
    const reader = { getPullRequest };
    const repository = { owner: "cloudflare", repo: "workerd" };

    await expect(readFreshGitHubPullRequestRevision(reader, repository, 12)).resolves.toEqual({
      baseSha: "base-a",
      headSha: "head-a",
    });
    await expect(readFreshGitHubPullRequestRevision(reader, repository, 12)).resolves.toEqual({
      baseSha: "base-b",
      headSha: "head-b",
    });
    expect(getPullRequest).toHaveBeenCalledTimes(2);
  });
});

describe("normalizeGitHubPullRequestDiffFile", () => {
  it("provides the shared diff shape for account and legacy reads", () => {
    expect(normalizeGitHubPullRequestDiffFile({
      filename: "src/new.ts",
      previous_filename: "src/old.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    })).toEqual({
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      diffOmitted: false,
      hunks: [{
        header: "@@ -1 +1 @@",
        lines: [
          { kind: "removed", text: "old", oldLineNumber: 1 },
          { kind: "added", text: "new", newLineNumber: 1 },
        ],
      }],
    });
  });
});
