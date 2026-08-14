import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubGitHub(...bodies: unknown[]): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => {
    const body = bodies.shift();
    return Response.json(body, {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("GitHubApi.getAuthenticationIdentity", () => {
  it("uses the immutable numeric viewer id rather than mutable login or email", async () => {
    stubGitHub(
      { id: 123456, login: "renameable-login", avatar_url: "https://example.com/avatar", html_url: "https://github.com/renameable-login" },
      [{ email: "person@example.com", primary: true, verified: true }],
    );
    const api = new GitHubApi(async () => "test-token");

    await expect(api.getAuthenticationIdentity()).resolves.toEqual({
      subject: "123456",
      verifiedEmail: "person@example.com",
    });
  });

  it.each([
    [{ login: "missing-id", avatar_url: "https://example.com/avatar", html_url: "https://github.com/missing-id" }],
    [{ id: 0, login: "zero-id", avatar_url: "https://example.com/avatar", html_url: "https://github.com/zero-id" }],
    [{ id: "123456", login: "string-id", avatar_url: "https://example.com/avatar", html_url: "https://github.com/string-id" }],
  ])("rejects a missing or invalid immutable viewer id", async (viewer) => {
    stubGitHub(viewer, [{ email: "person@example.com", primary: true, verified: true }]);
    const api = new GitHubApi(async () => "test-token");

    await expect(api.getAuthenticationIdentity()).resolves.toBeNull();
  });

  it("requires a non-blank primary verified email", async () => {
    stubGitHub(
      { id: 123456, login: "person", avatar_url: "https://example.com/avatar", html_url: "https://github.com/person" },
      [
        { email: "secondary@example.com", primary: false, verified: true },
        { email: "", primary: true, verified: true },
      ],
    );
    const api = new GitHubApi(async () => "test-token");

    await expect(api.getAuthenticationIdentity()).resolves.toBeNull();
  });
});
