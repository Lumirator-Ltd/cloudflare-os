import { afterEach, describe, expect, it, vi } from "vitest";
import { withAuthenticatedGitHubApi } from "../src/github-auth";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("withAuthenticatedGitHubApi", () => {
  it("marks a 401 account read as expired and returns the reconnect message", async () => {
    let authorization: string | null = null;
    let requestPath: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestPath = new URL(String(input)).pathname;
      authorization = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }));
    const account = {
      getAccessToken: vi.fn(async () => "expired-token"),
      noteCredentialsExpired: vi.fn(async () => {}),
    };

    const error = await withAuthenticatedGitHubApi(
      account,
      api => api.getIssue("cloudflare", "workerd", 12),
    ).then(() => undefined, caught => caught);

    expect(requestPath).toBe("/repos/cloudflare/workerd/issues/12");
    expect(authorization).toBe("Bearer expired-token");
    expect(account.noteCredentialsExpired).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "GitHub credentials have expired or been revoked. Please reconnect the account.",
    );
    expect((error as Error).message).not.toContain("Bad credentials");
  });
});
