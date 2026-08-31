import { describe, expect, it, vi } from "vitest";
import { XApi } from "../src/x-api-client";

const ACCESS_TOKEN = "access-token-never-expose";
const CLIENT_SECRET = "client-secret-never-expose";
const REFRESH_TOKEN = "refresh-token-never-expose";

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function captureFetch(reply: Response | (() => Response)) {
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return typeof reply === "function" ? reply() : reply;
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function apiWith(reply: Response | (() => Response)) {
  const injected = captureFetch(reply);
  return {
    api: new XApi({
      accessToken: ACCESS_TOKEN,
      userId: "2244994945",
      fetch: injected.fetch,
    }),
    calls: injected.calls,
  };
}

function requestUrl(call: FetchCall): URL {
  return new URL(String(call.input));
}

function requestHeaders(call: FetchCall): Headers {
  return new Headers(call.init?.headers);
}

function requestJson(call: FetchCall): unknown {
  expect(call.init?.body).toBeTypeOf("string");
  return JSON.parse(call.init?.body as string);
}

const USER = {
  id: "2244994945",
  name: "X Developer",
  username: "XDevelopers",
  description: "API news",
  protected: false,
  verified: true,
};

const POST = {
  id: "1346889436626259968",
  text: "Hello from X",
  author_id: USER.id,
  created_at: "2026-08-28T00:00:00.000Z",
  conversation_id: "1346889436626259968",
};

describe("X API reads", () => {
  it.each([
    ["getMe", () => ({ data: USER }), "/2/users/me"],
    ["getUserById", () => ({ data: USER }), `/2/users/${USER.id}`],
    ["getUserByUsername", () => ({ data: USER }), "/2/users/by/username/XDevelopers"],
    ["getPost", () => ({ data: POST, includes: { users: [USER] } }), `/2/tweets/${POST.id}`],
  ])("performs one fixed-origin %s request", async (operation, body, pathname) => {
    const { api, calls } = apiWith(jsonResponse(body()));

    const result = operation === "getMe"
      ? await api.getMe()
      : operation === "getUserById"
      ? await api.getUser({ id: USER.id })
      : operation === "getUserByUsername"
      ? await api.getUser({ username: USER.username })
      : await api.getPost(POST.id);

    expect(result).toMatchObject(operation === "getPost"
      ? { id: POST.id, text: POST.text, authorId: USER.id }
      : { id: USER.id, username: USER.username });
    expect(calls).toHaveLength(1);
    expect(requestUrl(calls[0]).origin + requestUrl(calls[0]).pathname)
      .toBe(`https://api.x.com${pathname}`);
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.redirect).toBe("error");
    expect(requestHeaders(calls[0]).get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it.each([
    ["listMyPosts", "/2/users/2244994945/tweets"],
    ["listMentions", "/2/users/2244994945/mentions"],
    ["listHomeTimeline", "/2/users/2244994945/timelines/reverse_chronological"],
    ["listLikedPosts", "/2/users/2244994945/liked_tweets"],
    ["listBookmarks", "/2/users/2244994945/bookmarks"],
  ])("uses the stored actor for %s and returns explicit pagination", async (method, pathname) => {
    const { api, calls } = apiWith(jsonResponse({
      data: [POST],
      includes: { users: [USER] },
      meta: { next_token: "NEXT_123", result_count: 1 },
    }));

    const result = await (api[method as keyof XApi] as (
      options: { maxResults: number; nextToken: string },
    ) => Promise<unknown>)({ maxResults: 20, nextToken: "PAGE_1" });

    expect(result).toMatchObject({
      data: [{ id: POST.id, text: POST.text }],
      users: [{ id: USER.id, username: USER.username }],
      nextToken: "NEXT_123",
    });
    expect(requestUrl(calls[0]).pathname).toBe(pathname);
    expect(requestUrl(calls[0]).searchParams.get("max_results")).toBe("20");
    expect(requestUrl(calls[0]).searchParams.get("pagination_token")).toBe("PAGE_1");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["listFollowers", "/2/users/2244994945/followers"],
    ["listFollowing", "/2/users/2244994945/following"],
  ])("returns bounded user pages for %s", async (method, pathname) => {
    const { api, calls } = apiWith(jsonResponse({
      data: [USER],
      meta: { next_token: "NEXT_123" },
    }));

    const result = await (api[method as keyof XApi] as () => Promise<unknown>)();

    expect(result).toMatchObject({
      data: [{ id: USER.id, username: USER.username }],
      nextToken: "NEXT_123",
    });
    expect(requestUrl(calls[0]).pathname).toBe(pathname);
    expect(requestUrl(calls[0]).searchParams.get("max_results")).toBe("10");
  });

  it("searches only the recent endpoint with a bounded query", async () => {
    const { api, calls } = apiWith(jsonResponse({ data: [POST], meta: {} }));

    await api.searchRecent("cloudflare -is:retweet", { maxResults: 10 });

    expect(requestUrl(calls[0]).pathname).toBe("/2/tweets/search/recent");
    expect(requestUrl(calls[0]).searchParams.get("query")).toBe("cloudflare -is:retweet");
  });

  it.each([
    [() => apiWith(jsonResponse({ data: USER })).api.getUser({}), "exactly one"],
    [() => apiWith(jsonResponse({ data: USER })).api.getUser({ id: USER.id, username: USER.username }), "exactly one"],
    [() => apiWith(jsonResponse({ data: USER })).api.getUser({ id: "https://evil.test/1" }), "id"],
    [() => apiWith(jsonResponse({ data: USER })).api.getUser({ username: "bad/name" }), "username"],
    [() => apiWith(jsonResponse({ data: POST })).api.getPost("1/../2"), "id"],
    [() => apiWith(jsonResponse({ data: [POST], meta: {} })).api.searchRecent(""), "query"],
    [() => apiWith(jsonResponse({ data: [POST], meta: {} })).api.searchRecent("x".repeat(513)), "query"],
    [() => apiWith(jsonResponse({ data: [POST], meta: {} })).api.listMyPosts({ maxResults: 21 }), "maxResults"],
    [() => apiWith(jsonResponse({ data: [POST], meta: {} })).api.listMyPosts({ nextToken: "bad token" }), "nextToken"],
  ])("rejects invalid input before dispatch: %s", async (operation, message) => {
    await expect(operation()).rejects.toThrow(new RegExp(message, "i"));
  });

  it("rejects provider pages and expansions larger than the requested bound", async () => {
    const postOverflow = apiWith(jsonResponse({
      data: Array.from({ length: 21 }, (_, index) => ({
        ...POST,
        id: String(1000000000000000000n + BigInt(index)),
      })),
      meta: {},
    })).api.listMyPosts({ maxResults: 20 });
    const expansionOverflow = apiWith(jsonResponse({
      data: [POST],
      includes: {
        users: Array.from({ length: 21 }, (_, index) => ({
          ...USER,
          id: String(2000000000000000000n + BigInt(index)),
          username: `user_${index}`,
        })),
      },
      meta: {},
    })).api.listMyPosts({ maxResults: 20 });
    const userOverflow = apiWith(jsonResponse({
      data: Array.from({ length: 11 }, (_, index) => ({
        ...USER,
        id: String(3000000000000000000n + BigInt(index)),
        username: `follower_${index}`,
      })),
      meta: {},
    })).api.listFollowers({ maxResults: 10 });

    await expect(postOverflow).rejects.toMatchObject({ kind: "invalid-response" });
    await expect(expansionOverflow).rejects.toMatchObject({ kind: "invalid-response" });
    await expect(userOverflow).rejects.toMatchObject({ kind: "invalid-response" });
  });

  it("rejects oversized and malformed success responses", async () => {
    const oversized = apiWith(new Response(JSON.stringify({ data: USER }), {
      headers: { "content-length": String(2 * 1024 * 1024) },
    })).api.getMe();
    const malformed = apiWith(jsonResponse({ data: { id: USER.id } })).api.getMe();

    await expect(oversized).rejects.toMatchObject({ kind: "invalid-response" });
    await expect(malformed).rejects.toMatchObject({ kind: "invalid-response" });
  });
});

describe("X API mutations", () => {
  it.each([
    ["createPost", ["A new post"], "POST", "/2/tweets", { text: "A new post" }, { data: POST }],
    ["reply", ["A reply", POST.id], "POST", "/2/tweets", {
      text: "A reply", reply: { in_reply_to_tweet_id: POST.id },
    }, { data: POST }],
    ["deletePost", [POST.id], "DELETE", `/2/tweets/${POST.id}`, undefined, { data: { deleted: true } }],
    ["like", [POST.id], "POST", `/2/users/${USER.id}/likes`, { tweet_id: POST.id }, { data: { liked: true } }],
    ["unlike", [POST.id], "DELETE", `/2/users/${USER.id}/likes/${POST.id}`, undefined, { data: { liked: false } }],
    ["bookmark", [POST.id], "POST", `/2/users/${USER.id}/bookmarks`, { tweet_id: POST.id }, { data: { bookmarked: true } }],
    ["removeBookmark", [POST.id], "DELETE", `/2/users/${USER.id}/bookmarks/${POST.id}`, undefined, { data: { bookmarked: false } }],
    ["follow", [USER.id], "POST", `/2/users/${USER.id}/following`, { target_user_id: USER.id }, { data: { following: true } }],
    ["unfollow", [USER.id], "DELETE", `/2/users/${USER.id}/following/${USER.id}`, undefined, { data: { following: false } }],
  ])("dispatches one exact %s request", async (method, args, httpMethod, pathname, body, reply) => {
    const { api, calls } = apiWith(jsonResponse(reply));

    await (api[method as keyof XApi] as (...values: string[]) => Promise<unknown>)(...args);

    expect(calls).toHaveLength(1);
    expect(requestUrl(calls[0]).pathname).toBe(pathname);
    expect(calls[0].init?.method).toBe(httpMethod);
    expect(calls[0].init?.redirect).toBe("error");
    expect(body === undefined ? calls[0].init?.body : requestJson(calls[0])).toEqual(body);
  });

  it.each([
    [() => apiWith(jsonResponse({ data: POST })).api.createPost(""), "text"],
    [() => apiWith(jsonResponse({ data: POST })).api.createPost("x".repeat(25_001)), "text"],
    [() => apiWith(jsonResponse({ data: POST })).api.reply("reply", "https://evil.test"), "id"],
    [() => apiWith(jsonResponse({ data: { following: true } })).api.follow("../../1"), "id"],
  ])("rejects invalid mutation input before dispatch: %s", async (operation, message) => {
    await expect(operation()).rejects.toThrow(new RegExp(message, "i"));
  });
});

describe("X API failures", () => {
  it.each([
    [401, { title: "Unauthorized" }, "credentials-expired"],
    [402, { type: "credits-exhausted" }, "funding"],
    [403, { type: "usage-cap-exceeded" }, "funding"],
    [403, { type: "missing-scope" }, "provider"],
    [500, { title: "Internal" }, "provider"],
  ])("classifies HTTP %s without retry", async (status, body, kind) => {
    const { api, calls } = apiWith(jsonResponse(body, status));

    await expect(api.getMe()).rejects.toMatchObject({ status, kind });
    expect(calls).toHaveLength(1);
  });

  it("classifies 429 with a bounded reset time and no retry", async () => {
    const reset = Math.floor(Date.now() / 1000) + 60;
    const { api, calls } = apiWith(jsonResponse({ title: "Too Many Requests" }, 429, {
      "x-rate-limit-reset": String(reset),
    }));

    await expect(api.getMe()).rejects.toMatchObject({
      status: 429,
      kind: "rate-limited",
      rateLimitReset: new Date(reset * 1000),
    });
    expect(calls).toHaveLength(1);
  });

  it("does not expose access tokens or provider bodies in errors", async () => {
    const secretBody = { detail: `${ACCESS_TOKEN} ${CLIENT_SECRET} ${REFRESH_TOKEN}` };
    const promise = apiWith(jsonResponse(secretBody, 500)).api.getMe();

    await expect(promise).rejects.not.toThrow(ACCESS_TOKEN);
    await expect(promise).rejects.not.toThrow(CLIENT_SECRET);
    await expect(promise).rejects.not.toThrow(REFRESH_TOKEN);
  });

  it("makes no retry after transport failure", async () => {
    const calls: FetchCall[] = [];
    const api = new XApi({
      accessToken: ACCESS_TOKEN,
      userId: USER.id,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        throw new Error("network down");
      }) as typeof fetch,
    });

    await expect(api.getMe()).rejects.toMatchObject({ kind: "network" });
    expect(calls).toHaveLength(1);
  });
});
