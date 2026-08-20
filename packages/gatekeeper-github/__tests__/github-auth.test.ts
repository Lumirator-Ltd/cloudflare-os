import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkAuthenticatedGitHubRepoAccess,
  notifyGitHubCredentialsExpired,
  withAuthenticatedGitHubApi,
} from "../src/github-auth";

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
      getCredentials: vi.fn(async () => ({ accessToken: "expired-token", generation: 7 })),
      noteCredentialsExpired: vi.fn(async () => {}),
    };

    const error = await withAuthenticatedGitHubApi(
      account,
      api => api.getIssue("cloudflare", "workerd", 12),
    ).then(() => undefined, caught => caught);

    expect(requestPath).toBe("/repos/cloudflare/workerd/issues/12");
    expect(authorization).toBe("Bearer expired-token");
    expect(account.noteCredentialsExpired).toHaveBeenCalledOnce();
    expect(account.noteCredentialsExpired).toHaveBeenCalledWith(7);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "GitHub credentials have expired or been revoked. Please reconnect the account.",
    );
    expect((error as Error).message).not.toContain("Bad credentials");
  });

  it("returns reconnect guidance and retries expiry delivery after a callback failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad credentials", { status: 401 })));
    const noteCredentialsExpired = vi.fn()
      .mockRejectedValueOnce(new Error("callback unavailable"))
      .mockResolvedValueOnce(undefined);
    const account = {
      getCredentials: vi.fn(async () => ({ accessToken: "expired-token", generation: 4 })),
      noteCredentialsExpired,
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(withAuthenticatedGitHubApi(account, api => api.getViewer()))
        .rejects.toThrow("Please reconnect the account");
    }
    expect(noteCredentialsExpired).toHaveBeenCalledTimes(2);
  });

  it("binds an expiry report to the credential generation used by the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad credentials", { status: 401 })));
    const account = {
      getCredentials: vi.fn(async () => ({ accessToken: "old-token", generation: 11 })),
      noteCredentialsExpired: vi.fn(async () => {}),
    };

    await expect(withAuthenticatedGitHubApi(account, api => api.getViewer()))
      .rejects.toThrow("Please reconnect the account");
    expect(account.noteCredentialsExpired).toHaveBeenCalledWith(11);
  });

  it("ignores stale generations and latches expiry only after successful delivery", async () => {
    let generation = 3;
    let notified = false;
    const state = {
      getGeneration: () => generation,
      getNotified: () => notified,
      setNotified: (value: boolean) => { notified = value; },
    };
    const callback = vi.fn()
      .mockRejectedValueOnce(new Error("callback unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(notifyGitHubCredentialsExpired(state, 3, callback)).rejects.toThrow(
      "callback unavailable",
    );
    expect(notified).toBe(false);
    await expect(notifyGitHubCredentialsExpired(state, 3, callback)).resolves.toBeUndefined();
    expect(notified).toBe(true);

    generation = 4;
    notified = false;
    await expect(notifyGitHubCredentialsExpired(state, 3, callback)).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(notified).toBe(false);
  });

  it("marks verifier 401s expired while treating repository policy failures as no access", async () => {
    let status = 401;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider response", { status })));
    const account = {
      getCredentials: vi.fn(async () => ({ accessToken: "expired-token", generation: 5 })),
      noteCredentialsExpired: vi.fn(async () => {}),
    };

    await expect(checkAuthenticatedGitHubRepoAccess(account, "cloudflare", "workerd"))
      .rejects.toThrow("Please reconnect the account");
    expect(account.noteCredentialsExpired).toHaveBeenCalledWith(5);

    status = 404;
    await expect(checkAuthenticatedGitHubRepoAccess(account, "cloudflare", "private"))
      .resolves.toBe(false);
    status = 403;
    await expect(checkAuthenticatedGitHubRepoAccess(account, "cloudflare", "private"))
      .resolves.toBe(false);
  });
});
