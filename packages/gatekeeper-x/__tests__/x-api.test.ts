import { describe, expect, it, vi } from "vitest";
import {
  X_OAUTH_SCOPES,
  XApiError,
  buildXAuthorizationUrl,
  exchangeXAuthorizationCode,
  generateXOAuthState,
  generateXPkceVerifier,
  refreshXAccessToken,
  xPkceChallenge,
} from "../src/x-api";

const CLIENT_SECRET = "client-secret-never-expose";
const ACCESS_TOKEN = "access-token-never-expose";
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

function requestHeaders(call: FetchCall): Headers {
  return new Headers(call.init?.headers);
}

function requestForm(call: FetchCall): URLSearchParams {
  expect(call.init?.body).toBeTypeOf("string");
  return new URLSearchParams(call.init?.body as string);
}

describe("X OAuth client", () => {
  it("generates independent URL-safe state and PKCE values", async () => {
    const state = generateXOAuthState();
    const verifier = generateXPkceVerifier();

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).not.toBe(verifier);
    expect(await xPkceChallenge(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("builds the fixed authorization URL with exact scopes and S256 PKCE", () => {
    const url = new URL(buildXAuthorizationUrl({
      clientId: "client +/?",
      redirectUri: "https://example.com/gatekeeper/x/oauth",
      state: "state_123",
      codeChallenge: "challenge_123",
    }));

    expect(`${url.origin}${url.pathname}`).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client +/?",
      redirect_uri: "https://example.com/gatekeeper/x/oauth",
      scope: X_OAUTH_SCOPES.join(" "),
      state: "state_123",
      code_challenge: "challenge_123",
      code_challenge_method: "S256",
    });
  });

  it("exchanges a code with confidential-client Basic auth and no secret in the form", async () => {
    const injected = captureFetch(jsonResponse({
      token_type: "bearer",
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: 7200,
      scope: X_OAUTH_SCOPES.join(" "),
    }));

    await expect(exchangeXAuthorizationCode({
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
      code: "authorization-code",
      codeVerifier: "verifier",
      redirectUri: "https://example.com/gatekeeper/x/oauth",
    }, { fetch: injected.fetch })).resolves.toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresIn: 7200,
      scopes: [...X_OAUTH_SCOPES],
    });

    expect(injected.calls).toHaveLength(1);
    const call = injected.calls[0];
    expect(String(call.input)).toBe("https://api.x.com/2/oauth2/token");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.redirect).toBe("error");
    expect(requestHeaders(call).get("authorization")).toBe(
      `Basic ${btoa(`client-id:${CLIENT_SECRET}`)}`,
    );
    expect(Object.fromEntries(requestForm(call))).toEqual({
      grant_type: "authorization_code",
      code: "authorization-code",
      redirect_uri: "https://example.com/gatekeeper/x/oauth",
      code_verifier: "verifier",
    });
    expect(requestForm(call).has("client_secret")).toBe(false);
  });

  it("refreshes with the stored client and accepts a rotated refresh token", async () => {
    const injected = captureFetch(jsonResponse({
      token_type: "bearer",
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 7200,
      scope: X_OAUTH_SCOPES.join(" "),
    }));

    await expect(refreshXAccessToken({
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN,
    }, { fetch: injected.fetch })).resolves.toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 7200,
      scopes: [...X_OAUTH_SCOPES],
    });

    expect(Object.fromEntries(requestForm(injected.calls[0]))).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
    });
  });

  it("preserves the current refresh token when X omits a replacement", async () => {
    const injected = captureFetch(jsonResponse({
      token_type: "bearer",
      access_token: "new-access",
      expires_in: 7200,
      scope: X_OAUTH_SCOPES.join(" "),
    }));

    await expect(refreshXAccessToken({
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN,
    }, { fetch: injected.fetch })).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: REFRESH_TOKEN,
    });
  });

  it.each([
    [X_OAUTH_SCOPES.filter(scope => scope !== "tweet.write"), "missing"],
    [[...X_OAUTH_SCOPES, "dm.read"], "unexpected"],
  ])("rejects %s returned scopes", async (scopes, message) => {
    const promise = exchangeXAuthorizationCode({
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
      code: "authorization-code",
      codeVerifier: "verifier",
      redirectUri: "https://example.com/gatekeeper/x/oauth",
    }, { fetch: captureFetch(jsonResponse({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: 7200,
      scope: scopes.join(" "),
    })).fetch });

    await expect(promise).rejects.toThrow(new RegExp(message, "i"));
  });

  it("rejects malformed grants without exposing any credential", async () => {
    const promise = exchangeXAuthorizationCode({
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
      code: "authorization-code",
      codeVerifier: "verifier",
      redirectUri: "https://example.com/gatekeeper/x/oauth",
    }, { fetch: captureFetch(jsonResponse({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: 0,
      scope: X_OAUTH_SCOPES.join(" "),
    })).fetch });

    await expect(promise).rejects.toBeInstanceOf(XApiError);
    await expect(promise).rejects.not.toThrow(CLIENT_SECRET);
    await expect(promise).rejects.not.toThrow(ACCESS_TOKEN);
    await expect(promise).rejects.not.toThrow(REFRESH_TOKEN);
  });
});
