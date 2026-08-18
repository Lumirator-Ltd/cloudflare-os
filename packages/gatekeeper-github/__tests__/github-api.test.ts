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

type StubbedRequest = { url: URL; headers: Headers };

function stubFetch(body: unknown): StubbedRequest[] {
  const requests: StubbedRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }));
  return requests;
}

describe("GitHubApi.searchCode", () => {
  it("requests text-match fragments and passes query and paging params", async () => {
    const requests = stubFetch({ items: [] });
    const api = new GitHubApi(async () => "test-token");
    await api.searchCode({ q: '"alarm" repo:cloudflare/workerd', per_page: 30, page: 2 });

    expect(requests).toHaveLength(1);
    expect(requests[0].url.pathname).toBe("/search/code");
    expect(requests[0].url.searchParams.get("q")).toBe('"alarm" repo:cloudflare/workerd');
    expect(requests[0].url.searchParams.get("per_page")).toBe("30");
    expect(requests[0].url.searchParams.get("page")).toBe("2");
    expect(requests[0].headers.get("Accept")).toBe("application/vnd.github.text-match+json");
  });
});

describe("GitHubApi.getContentsConditional", () => {
  it("encodes path segments individually and passes the ref", async () => {
    const requests = stubFetch({ type: "file", content: "", encoding: "base64" });
    const api = new GitHubApi(async () => "test-token");
    await api.getContentsConditional("cloudflare", "workerd", "src/a b/c#d.ts", "feature/x");

    expect(requests[0].url.pathname).toBe("/repos/cloudflare/workerd/contents/src/a%20b/c%23d.ts");
    expect(requests[0].url.searchParams.get("ref")).toBe("feature/x");
  });
});

describe("GitHubApi.getTreeConditional", () => {
  it("requests the recursive tree for an encoded ref", async () => {
    const requests = stubFetch({ sha: "abc", truncated: false, tree: [] });
    const api = new GitHubApi(async () => "test-token");
    await api.getTreeConditional("cloudflare", "workerd", "feature/x");

    expect(requests[0].url.pathname).toBe("/repos/cloudflare/workerd/git/trees/feature%2Fx");
    expect(requests[0].url.searchParams.get("recursive")).toBe("1");
  });
});

describe("GitHubApi.listBranches", () => {
  it("pages through the branches endpoint", async () => {
    const requests = stubFetch([]);
    const api = new GitHubApi(async () => "test-token");
    await api.listBranches("cloudflare", "workerd", { per_page: 100, page: 3 });

    expect(requests[0].url.pathname).toBe("/repos/cloudflare/workerd/branches");
    expect(requests[0].url.searchParams.get("per_page")).toBe("100");
    expect(requests[0].url.searchParams.get("page")).toBe("3");
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
