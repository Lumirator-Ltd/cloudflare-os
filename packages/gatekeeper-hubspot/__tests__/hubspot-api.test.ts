import { describe, expect, it, vi } from "vitest";
import {
  HUBSPOT_CRM_PROPERTIES,
  HUBSPOT_OAUTH_SCOPES,
  MAX_HUBSPOT_PROPERTY_VALUE_LENGTH,
  HubSpotApi,
  HubSpotApiError,
  buildHubSpotAuthorizationUrl,
  exchangeHubSpotAuthorizationCode,
  generateHubSpotOAuthState,
  refreshHubSpotAccessToken,
} from "../src/hubspot-api";

const CLIENT_SECRET = "client-secret-never-expose";
const ACCESS_TOKEN = "access-token-never-expose";
const REFRESH_TOKEN = "refresh-token-never-expose";

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureFetch(reply: Response): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return reply;
    }),
  };
}

function formFrom(call: FetchCall): URLSearchParams {
  expect(call.init?.body).toBeTypeOf("string");
  return new URLSearchParams(call.init?.body as string);
}

describe("HubSpot OAuth", () => {
  it("builds the authorization URL with encoded required fields and scopes", () => {
    const url = new URL(buildHubSpotAuthorizationUrl({
      clientId: "client +/?",
      redirectUri: "https://example.com/oauth/callback?tenant=a+b",
      state: "state +/?&=",
    }));

    expect(url.origin + url.pathname).toBe("https://app.hubspot.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client +/?");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.com/oauth/callback?tenant=a+b",
    );
    expect(url.searchParams.get("scope")).toBe(HUBSPOT_OAUTH_SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe("state +/?&=");
  });

  it("generates URL-safe cryptographic OAuth state", () => {
    const first = generateHubSpotOAuthState();
    const second = generateHubSpotOAuthState();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it("exchanges an authorization code at the 2026-03 form endpoint", async () => {
    const injected = captureFetch(response({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: 1800,
      hub_id: 12345,
    }));

    const grant = await exchangeHubSpotAuthorizationCode({
      code: "code +/?",
      redirectUri: "https://example.com/oauth?tenant=a+b",
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: injected.fetch });

    expect(grant).toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresIn: 1800,
      hubId: 12345,
    });
    expect(injected.calls).toHaveLength(1);
    const call = injected.calls[0];
    expect(String(call.input)).toBe("https://api.hubspot.com/oauth/2026-03/token");
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(formFrom(call))).toEqual({
      grant_type: "authorization_code",
      code: "code +/?",
      redirect_uri: "https://example.com/oauth?tenant=a+b",
      client_id: "client-id",
      client_secret: CLIENT_SECRET,
    });
  });

  it("refreshes credentials and exposes an optional replacement refresh token", async () => {
    const rotated = captureFetch(response({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 1200,
    }));
    const preserved = captureFetch(response({
      access_token: "next-access",
      expires_in: 900,
    }));

    await expect(refreshHubSpotAccessToken({
      refreshToken: REFRESH_TOKEN,
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: rotated.fetch })).resolves.toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 1200,
    });
    await expect(refreshHubSpotAccessToken({
      refreshToken: REFRESH_TOKEN,
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: preserved.fetch })).resolves.toEqual({
      accessToken: "next-access",
      expiresIn: 900,
    });

    expect(Object.fromEntries(formFrom(rotated.calls[0]))).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: "client-id",
      client_secret: CLIENT_SECRET,
    });
  });

  it.each([
    [{ refresh_token: REFRESH_TOKEN, expires_in: 1800, hub_id: 1 }, "access_token"],
    [{ access_token: ACCESS_TOKEN, expires_in: 1800, hub_id: 1 }, "refresh_token"],
    [{ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 0, hub_id: 1 }, "expires_in"],
    [{ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 1800, hub_id: "1" }, "hub_id"],
  ])("rejects an invalid initial grant without exposing response values", async (body, field) => {
    const injected = captureFetch(response(body));

    const promise = exchangeHubSpotAuthorizationCode({
      code: "sensitive-code",
      redirectUri: "https://example.com/oauth",
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: injected.fetch });

    await expect(promise).rejects.toThrow(field);
    await expect(promise).rejects.not.toThrow(CLIENT_SECRET);
    await expect(promise).rejects.not.toThrow(ACCESS_TOKEN);
    await expect(promise).rejects.not.toThrow(REFRESH_TOKEN);
  });

  it("rejects incomplete scopes included in initial and refresh grants", async () => {
    const initial = exchangeHubSpotAuthorizationCode({
      code: "code",
      redirectUri: "https://example.com/oauth",
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: captureFetch(response({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: 1800,
      hub_id: 1,
      scopes: ["oauth", "crm.objects.contacts.read"],
    })).fetch });
    const refresh = refreshHubSpotAccessToken({
      refreshToken: REFRESH_TOKEN,
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: captureFetch(response({
      access_token: ACCESS_TOKEN,
      refresh_token: "rotated-refresh",
      expires_in: 1800,
      scopes: ["oauth"],
    })).fetch });

    await expect(initial).rejects.toThrow(/scope/i);
    await expect(refresh).rejects.toThrow(/scope/i);
  });

  it.each([
    ["invalid_grant", "credentials-expired"],
    ["invalid_client", "provider"],
  ])("classifies OAuth %s precisely", async (providerCode, kind) => {
    const promise = refreshHubSpotAccessToken({
      refreshToken: REFRESH_TOKEN,
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: captureFetch(response({ error: providerCode }, 400)).fetch });

    await expect(promise).rejects.toMatchObject({ kind, status: 400 });
  });

  it("does not classify non-invalid_grant OAuth 401 responses as credential expiry", async () => {
    const promise = refreshHubSpotAccessToken({
      refreshToken: REFRESH_TOKEN,
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: captureFetch(response({ error: "invalid_client" }, 401)).fetch });

    await expect(promise).rejects.toMatchObject({ kind: "provider", status: 401 });
  });

  it("reports bounded OAuth metadata without exposing secrets, tokens, or raw bodies", async () => {
    const injected = captureFetch(response({
      error: "BAD_GRANT",
      error_description: `${CLIENT_SECRET} ${ACCESS_TOKEN} ${REFRESH_TOKEN}`,
      correlationId: "oauth-correlation-1",
      raw: "x".repeat(50_000),
    }, 400));

    const promise = exchangeHubSpotAuthorizationCode({
      code: "sensitive-code",
      redirectUri: "https://example.com/oauth",
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: injected.fetch });

    await expect(promise).rejects.toMatchObject({
      status: 400,
      category: "BAD_GRANT",
      correlationId: "oauth-correlation-1",
    });
    const error = await promise.catch((caught: unknown) => caught as Error);
    expect(error.message.length).toBeLessThan(300);
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(error.message).not.toContain(ACCESS_TOKEN);
    expect(error.message).not.toContain(REFRESH_TOKEN);
    expect(error.message).not.toContain("x".repeat(100));
  });

  it("redacts token fields even when provider metadata repeats them", async () => {
    const injected = captureFetch(response({
      error: ACCESS_TOKEN,
      correlationId: REFRESH_TOKEN,
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
    }, 400));

    const promise = exchangeHubSpotAuthorizationCode({
      code: "sensitive-code",
      redirectUri: "https://example.com/oauth",
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: injected.fetch });

    const error = await promise.catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain(ACCESS_TOKEN);
    expect(error.message).not.toContain(REFRESH_TOKEN);
  });

  it("times out OAuth requests without propagating sensitive fetch errors", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error(`${CLIENT_SECRET} ${REFRESH_TOKEN}`));
        }, { once: true });
      })) as typeof fetch;

    const promise = refreshHubSpotAccessToken({
      refreshToken: REFRESH_TOKEN,
      clientId: "client-id",
      clientSecret: CLIENT_SECRET,
    }, { fetch: fetchImpl, timeoutMs: 5 });

    await expect(promise).rejects.toBeInstanceOf(HubSpotApiError);
    await expect(promise).rejects.toMatchObject({ kind: "timeout" });
    const error = await promise.catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(error.message).not.toContain(REFRESH_TOKEN);
  });
});

describe("HubSpot CRM API", () => {
  it("searches one bounded contact page with bearer auth and curated properties", async () => {
    const injected = captureFetch(response({
      total: 1,
      results: [{
        id: "101",
        properties: { email: "person@example.com", secret_internal: "hidden" },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }],
      paging: { next: { after: "200" } },
    }));
    const api = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: injected.fetch,
    });

    const page = await api.search("contacts", {
      query: "Ada + Lovelace",
      limit: 100,
      after: "100",
    });

    expect(page).toEqual({
      total: 1,
      results: [{
        id: "101",
        properties: { email: "person@example.com" },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }],
      nextAfter: "200",
    });
    const call = injected.calls[0];
    expect(String(call.input)).toBe(
      "https://api.hubapi.com/crm/objects/2026-03/contacts/search",
    );
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.parse(call.init?.body as string)).toEqual({
      query: "Ada + Lovelace",
      limit: 100,
      after: "100",
      properties: HUBSPOT_CRM_PROPERTIES.contacts,
    });
  });

  it("gets one company from the versioned object endpoint", async () => {
    const injected = captureFetch(response({
      id: "202",
      properties: { name: "Example", domain: "example.com", private_note: "hidden" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    }));
    const api = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: injected.fetch,
    });

    await expect(api.get("companies", "202")).resolves.toEqual({
      id: "202",
      properties: { name: "Example", domain: "example.com" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const url = new URL(String(injected.calls[0].input));
    expect(url.origin + url.pathname).toBe(
      "https://api.hubapi.com/crm/objects/2026-03/companies/202",
    );
    expect(url.searchParams.get("properties")).toBe(HUBSPOT_CRM_PROPERTIES.companies.join(","));
    expect(injected.calls[0].init?.method).toBe("GET");
  });

  it("creates one deal with only curated properties", async () => {
    const injected = captureFetch(response({
      id: "303",
      properties: { dealname: "Renewal", pipeline: "default", dealstage: "open" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }, 201));
    const api = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: injected.fetch,
    });

    await api.create("deals", {
      dealname: "Renewal",
      pipeline: "default",
      dealstage: "open",
    });

    expect(String(injected.calls[0].input)).toBe(
      "https://api.hubapi.com/crm/objects/2026-03/deals",
    );
    expect(injected.calls[0].init?.method).toBe("POST");
    expect(JSON.parse(injected.calls[0].init?.body as string)).toEqual({
      properties: {
        dealname: "Renewal",
        pipeline: "default",
        dealstage: "open",
      },
    });
  });

  it("updates one contact at the versioned object endpoint", async () => {
    const injected = captureFetch(response({
      id: "404",
      properties: { phone: "+1 555 0100" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
    }));
    const api = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: injected.fetch,
    });

    await api.update("contacts", "404", { phone: "+1 555 0100" });

    expect(String(injected.calls[0].input)).toBe(
      "https://api.hubapi.com/crm/objects/2026-03/contacts/404",
    );
    expect(injected.calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(injected.calls[0].init?.body as string)).toEqual({
      properties: { phone: "+1 555 0100" },
    });
  });

  it.each([
    [{ query: "x", limit: 0 }, "limit"],
    [{ query: "x", limit: 101 }, "limit"],
    [{ query: "x", limit: 1.5 }, "limit"],
    [{ query: "x".repeat(3001), limit: 10 }, "query"],
    [{ query: "x", limit: 10, after: "1.5" }, "after"],
    [{ query: "x", limit: 10, after: "-1" }, "after"],
    [{ query: "x", limit: 10, after: 1 }, "after"],
    [{ query: "x", limit: 10, after: "1".repeat(33) }, "after"],
  ])("rejects invalid search bounds before fetching", async (options, field) => {
    const injected = captureFetch(response({}));
    const api = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: injected.fetch,
    });

    await expect(api.search("contacts", options as never)).rejects.toThrow(field);
    expect(injected.calls).toHaveLength(0);
  });

  it("accepts the 3000-character query boundary and defaults to the connector page cap", async () => {
    const injected = captureFetch(response({ total: 0, results: [] }));
    const api = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: injected.fetch,
    });

    await api.search("companies", { query: "x".repeat(3000) });

    expect(JSON.parse(injected.calls[0].init?.body as string).limit).toBe(100);
  });

  it.each(["", "-1", "1.5", "1e3", "abc", "1".repeat(33), "1/associations/companies"])(
    "rejects malformed record ID %j before fetching",
    async id => {
      const injected = captureFetch(response({}));
      const api = new HubSpotApi({
        getAccessToken: async () => ACCESS_TOKEN,
        fetch: injected.fetch,
      });

      await expect(api.get("contacts", id)).rejects.toThrow("record ID");
      expect(injected.calls).toHaveLength(0);
    },
  );

  it("rejects oversized provider record IDs and cursors", async () => {
    const recordApi = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: captureFetch(response({
        id: "1".repeat(33),
        properties: {},
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      })).fetch,
    });
    const cursorApi = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: captureFetch(response({
        total: 0,
        results: [],
        paging: { next: { after: "9".repeat(33) } },
      })).fetch,
    });

    await expect(recordApi.get("contacts", "1")).rejects.toMatchObject({ kind: "invalid-response" });
    await expect(cursorApi.search("contacts", { query: "x" })).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });

  it("rejects arbitrary object types, unknown properties, non-strings, and oversized values", async () => {
    const injected = captureFetch(response({}));
    const api = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: injected.fetch,
    });

    await expect(api.search("tickets" as never, { query: "x" })).rejects.toThrow("object type");
    await expect(api.create("contacts", { custom_secret: "value" } as never)).rejects.toThrow(
      "property",
    );
    await expect(api.update("companies", "1", { name: 42 } as never)).rejects.toThrow("string");
    await expect(api.update("deals", "1", {
      description: "x".repeat(MAX_HUBSPOT_PROPERTY_VALUE_LENGTH + 1),
    })).rejects.toThrow("length");
    expect(injected.calls).toHaveLength(0);
  });

  it("exposes no delete, batch, association, or arbitrary request method", () => {
    const methods = Object.getOwnPropertyNames(HubSpotApi.prototype);
    expect(methods).toEqual(expect.arrayContaining(["search", "get", "create", "update"]));
    expect(methods).not.toEqual(expect.arrayContaining([
      "delete",
      "batch",
      "associate",
      "request",
    ]));
  });

  it.each([
    [401, "credentials-expired", true, false],
    [429, "rate-limited", false, true],
  ])("classifies status %i and exposes only safe bounded metadata", async (
    status,
    kind,
    isCredentialExpired,
    isRateLimited,
  ) => {
    const submitted = "private submitted CRM value";
    const injected = captureFetch(response({
      category: status === 401 ? "EXPIRED_AUTHENTICATION" : "RATE_LIMITS",
      correlationId: "crm-correlation-1",
      message: `${ACCESS_TOKEN} ${submitted}`,
      details: "raw provider detail",
    }, status));
    const api = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: injected.fetch,
    });

    const promise = api.create("companies", { name: submitted });

    await expect(promise).rejects.toMatchObject({
      status,
      kind,
      isCredentialExpired,
      isRateLimited,
      correlationId: "crm-correlation-1",
    });
    const error = await promise.catch((caught: unknown) => caught as Error);
    expect(error.message.length).toBeLessThan(300);
    expect(error.message).not.toContain(ACCESS_TOKEN);
    expect(error.message).not.toContain(submitted);
    expect(error.message).not.toContain("raw provider detail");
  });

  it("does not retry writes after a rate-limit response", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return response({ category: "RATE_LIMITS" }, 429);
    }) as typeof fetch;
    const api = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: fetchImpl,
    });

    await expect(api.update("deals", "1", { description: "only once" })).rejects.toMatchObject({
      kind: "rate-limited",
    });
    expect(calls).toBe(1);
  });

  it("rejects oversized and non-object JSON responses", async () => {
    const oversized = new Response(JSON.stringify({ value: "x".repeat(1_100_000) }), {
      headers: { "content-type": "application/json" },
    });
    const oversizedApi = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: vi.fn(async () => oversized) as typeof fetch,
    });
    const arrayApi = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: vi.fn(async () => response([])) as typeof fetch,
    });

    await expect(oversizedApi.get("contacts", "1")).rejects.toMatchObject({
      kind: "invalid-response",
    });
    await expect(arrayApi.get("contacts", "1")).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });

  it("times out CRM requests without exposing the bearer token", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(ACCESS_TOKEN)), { once: true });
      })) as typeof fetch;
    const api = new HubSpotApi({
      getAccessToken: async () => ACCESS_TOKEN,
      fetch: fetchImpl,
      timeoutMs: 5,
    });

    const promise = api.get("contacts", "1");
    await expect(promise).rejects.toMatchObject({ kind: "timeout" });
    const error = await promise.catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain(ACCESS_TOKEN);
  });
});
