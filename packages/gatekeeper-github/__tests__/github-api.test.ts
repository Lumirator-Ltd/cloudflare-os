import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubApi,
  type GitHubIssueResponse,
} from "../src/github-api";
import {
  assertCodeSearchResultsInScope,
  assertIssueSearchResultsInScope,
  assertIssueSearchResultsInRepo,
  assertRepoSearchResultsInScope,
  buildCodeSearchQuery,
  buildIssueSearchQuery,
  buildScopedIssueSearchQuery,
} from "../src/github-search";

function issueAt(htmlUrl: string): Pick<GitHubIssueResponse, "html_url"> {
  return { html_url: htmlUrl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assertIssueSearchResultsInRepo", () => {
  it("accepts exact repository path segments case-insensitively", () => {
    expect(() => assertIssueSearchResultsInRepo("Cloudflare", "Workerd", [
      issueAt("https://github.com/cloudflare/workerd/issues/1"),
    ])).not.toThrow();
  });

  it("rejects results from another repository", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://github.com/cloudflare/quiche/issues/1"),
    ])).toThrow("outside the connected repository");
  });

  it("does not accept repository names that only share a prefix", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://github.com/cloudflare/workerd-private/issues/1"),
    ])).toThrow("outside the connected repository");
  });

  it("rejects pull requests returned by an injected search expression", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://github.com/cloudflare/workerd/pull/1"),
    ])).toThrow("non-issue result");
  });

  it("rejects malformed and non-GitHub result URLs", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("not a URL"),
    ])).toThrow("outside the connected repository");
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://example.com/cloudflare/workerd/issues/1"),
    ])).toThrow("outside the connected repository");
  });
});

describe("buildIssueSearchQuery", () => {
  it("builds a benign literal phrase search with structured filters", () => {
    expect(buildIssueSearchQuery("cloudflare", "workerd", {
      text: "durable objects",
      state: "open",
      labels: ["bug"],
      author: "jasnell",
    })).toBe(
      '"durable objects" repo:cloudflare/workerd is:issue state:open label:"bug" author:"jasnell"',
    );
  });

  it("quotes every caller-controlled query fragment", () => {
    expect(buildIssueSearchQuery("cloudflare", "workerd", {
      text: "repo:cloudflare/quiche OR scheduler",
      author: "jasnell OR repo:cloudflare/quiche",
      assignee: "octocat OR repo:cloudflare/quiche",
    })).toBe(
      '"repo:cloudflare/quiche OR scheduler" repo:cloudflare/workerd is:issue '
      + 'author:"jasnell OR repo:cloudflare/quiche" assignee:"octocat OR repo:cloudflare/quiche"',
    );
  });

  it("escapes quotes inside plain search text", () => {
    expect(buildIssueSearchQuery("cloudflare", "workerd", {
      text: 'bug" OR repo:cloudflare/quiche OR "',
    })).toBe('"bug\\" OR repo:cloudflare/quiche OR \\"" repo:cloudflare/workerd is:issue');
  });
});

describe("buildCodeSearchQuery", () => {
  it("quotes text and scopes to a repository", () => {
    expect(buildCodeSearchQuery({ owner: "cloudflare", repo: "workerd" }, {
      text: "durable objects",
    })).toBe('"durable objects" repo:cloudflare/workerd');
  });

  it("scopes owner-only searches with the user qualifier", () => {
    expect(buildCodeSearchQuery({ owner: "cloudflare" }, { text: "alarm" }))
      .toBe('"alarm" user:cloudflare');
  });

  it("quotes qualifier-injection attempts in every caller field", () => {
    expect(buildCodeSearchQuery({ owner: "cloudflare", repo: "workerd" }, {
      text: "alarm repo:evil/repo",
      path: "src OR repo:evil/repo",
      extension: "ts repo:evil/repo",
    })).toBe(
      '"alarm repo:evil/repo" repo:cloudflare/workerd '
      + 'path:"src OR repo:evil/repo" extension:"ts repo:evil/repo"',
    );
  });
});

describe("assertCodeSearchResultsInScope", () => {
  it("accepts results in the scoped repository case-insensitively", () => {
    expect(() => assertCodeSearchResultsInScope({ owner: "Cloudflare", repo: "Workerd" }, [
      { repository: { full_name: "cloudflare/workerd" } },
    ])).not.toThrow();
  });

  it("accepts any repository of the scoped owner", () => {
    expect(() => assertCodeSearchResultsInScope({ owner: "cloudflare" }, [
      { repository: { full_name: "cloudflare/quiche" } },
    ])).not.toThrow();
  });

  it("rejects results outside the scope", () => {
    expect(() => assertCodeSearchResultsInScope({ owner: "cloudflare", repo: "workerd" }, [
      { repository: { full_name: "cloudflare/workerd-private" } },
    ])).toThrow("outside the requested scope");
    expect(() => assertCodeSearchResultsInScope({ owner: "cloudflare" }, [
      { repository: { full_name: "evil/workerd" } },
    ])).toThrow("outside the requested scope");
    expect(() => assertCodeSearchResultsInScope({ owner: "cloudflare" }, [
      { repository: { full_name: "cloudflare/workerd/extra" } },
    ])).toThrow("outside the requested scope");
  });
});

describe("assertRepoSearchResultsInScope", () => {
  it("accepts repositories owned by the scope owner", () => {
    expect(() => assertRepoSearchResultsInScope({ owner: "cloudflare" }, [
      { full_name: "Cloudflare/workerd" },
    ])).not.toThrow();
  });

  it("rejects repositories of other owners", () => {
    expect(() => assertRepoSearchResultsInScope({ owner: "cloudflare" }, [
      { full_name: "evil/workerd" },
    ])).toThrow("outside the requested scope");
  });
});

describe("buildScopedIssueSearchQuery", () => {
  it("scopes to a repository like the legacy builder", () => {
    expect(buildScopedIssueSearchQuery({ owner: "cloudflare", repo: "workerd" }, { text: "bug" }))
      .toBe('"bug" repo:cloudflare/workerd is:issue');
  });

  it("scopes owner-only searches with the user qualifier", () => {
    expect(buildScopedIssueSearchQuery({ owner: "cloudflare" }, { text: "bug", state: "open" }))
      .toBe('"bug" user:cloudflare is:issue state:open');
  });
});

describe("assertIssueSearchResultsInScope", () => {
  it("accepts issues from any repository of an owner-only scope", () => {
    expect(() => assertIssueSearchResultsInScope({ owner: "cloudflare" }, [
      issueAt("https://github.com/cloudflare/quiche/issues/1"),
    ])).not.toThrow();
  });

  it("rejects issues from other owners and non-issue results", () => {
    expect(() => assertIssueSearchResultsInScope({ owner: "cloudflare" }, [
      issueAt("https://github.com/evil/quiche/issues/1"),
    ])).toThrow("outside the requested scope");
    expect(() => assertIssueSearchResultsInScope({ owner: "cloudflare" }, [
      issueAt("https://github.com/cloudflare/quiche/pull/1"),
    ])).toThrow("non-issue result");
  });
});

describe("GitHubApi.searchIssuesConditional", () => {
  it("enables GitHub advanced search parsing", async () => {
    let requestUrl: URL | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestUrl = new URL(String(input));
      return new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/json" },
      });
    }));

    const api = new GitHubApi(async () => "test-token");
    await api.searchIssuesConditional(
      "repo:cloudflare/quiche OR repo:cloudflare/workerd is:issue",
      1,
      100,
    );

    expect(requestUrl?.searchParams.get("advanced_search")).toBe("true");
  });
});
