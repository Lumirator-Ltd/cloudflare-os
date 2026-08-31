import { env } from "cloudflare:workers";
import {
  SELF,
  abortAllDurableObjects,
  createExecutionContext,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { X_OAUTH_SCOPES } from "../src/x-api";
import { isConnectedAccountUrl } from "../src/x";

const BASE_URL = "https://workshop.example/gatekeeper/x";
const CLIENT_ID = "x-client-id";
const CLIENT_SECRET = "x-client-secret-never-expose";
const ACCESS_TOKEN = "x-access-token-never-expose";
const REFRESH_TOKEN = "x-refresh-token-never-expose";
const USER = { id: "2244994945", name: "X Developer", username: "XDevelopers" };

type Vendor = {
  describe(): Promise<Record<string, unknown>>;
  connectAccount(callback: Fetcher, options?: { language?: string }): Promise<{ url: string }>;
  getSupportedResources(): Promise<Array<Record<string, unknown>>>;
};

type Callback = Fetcher & {
  read(): Promise<{
    completeCount: number;
    expiredCount: number;
    restoredCount: number;
    completedDescription?: { displayName?: string; uniqueName?: string };
  }>;
  reset(): Promise<void>;
  describeConnected(): Promise<Record<string, unknown>>;
  reconnectConnected(): Promise<{ url: string }>;
  revokeConnected(): Promise<void>;
  validateConnectedUrl(url: string): Promise<Record<string, unknown>>;
  configuredResourceUrl(pattern: string): Promise<string>;
};

type UserAccountRpc = {
  performRead(operation: { type: "getMe" }): Promise<unknown>;
  getCredentialGeneration(): Promise<number>;
};

type TestExports = {
  GatekeeperVendor(options: object): Vendor;
  TestConnectCallback(options: object): Callback;
};

const worker = createExecutionContext().exports as unknown as TestExports;
const callback = worker.TestConnectCallback({});
const testEnv = env as unknown as {
  USER_ACCOUNT: DurableObjectNamespace<UserAccountRpc>;
};

function vendor(): Vendor {
  return worker.GatekeeperVendor({});
}

function parseInitiationUrl(url: string): { doId: string; nonce: string } {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  return { doId: segments.at(-2) ?? "", nonce: segments.at(-1) ?? "" };
}

function account(doId: string): DurableObjectStub<UserAccountRpc> {
  return testEnv.USER_ACCOUNT.get(testEnv.USER_ACCOUNT.idFromString(doId));
}

async function storageValue<T>(doId: string, key: string): Promise<T | undefined> {
  return await runInDurableObject(account(doId), (_instance, state) => state.storage.kv.get<T>(key));
}

function credentialsRequest(url: string, values: {
  clientId?: string;
  clientSecret?: string;
  language?: string;
} = {}): Request {
  const body = new URLSearchParams({
    clientId: values.clientId ?? CLIENT_ID,
    clientSecret: values.clientSecret ?? CLIENT_SECRET,
    language: values.language ?? "en",
  });
  return new Request(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: new URL(url).origin,
    },
    body,
  });
}

function oauthGrant(options: {
  accessToken?: string;
  refreshToken?: string;
  scopes?: readonly string[];
} = {}): Response {
  return Response.json({
    token_type: "bearer",
    access_token: options.accessToken ?? ACCESS_TOKEN,
    refresh_token: options.refreshToken ?? REFRESH_TOKEN,
    expires_in: 7200,
    scope: (options.scopes ?? X_OAUTH_SCOPES).join(" "),
  });
}

function oauthFetch(options: {
  user?: typeof USER;
  accessToken?: string;
  refreshToken?: string;
  scopes?: readonly string[];
} = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://api.x.com/2/oauth2/token") {
      return oauthGrant(options);
    }
    if (url.startsWith("https://api.x.com/2/users/me")) {
      return Response.json({ data: options.user ?? USER });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
}

async function beginFlow(options: { language?: string; reconnect?: boolean } = {}) {
  const url = options.reconnect
    ? (await callback.reconnectConnected()).url
    : (await vendor().connectAccount(callback, { language: options.language })).url;
  const parsed = parseInitiationUrl(url);
  const response = await SELF.fetch(credentialsRequest(url, { language: options.language }));
  const location = response.headers.get("location");
  if (!location) throw new Error("Missing X authorization redirect");
  const authorization = new URL(location);
  return {
    ...parsed,
    formUrl: url,
    authorization,
    state: authorization.searchParams.get("state") ?? "",
  };
}

async function completeFlow(options: {
  user?: typeof USER;
  accessToken?: string;
  refreshToken?: string;
  scopes?: readonly string[];
} = {}) {
  const fetchMock = oauthFetch(options);
  vi.stubGlobal("fetch", fetchMock);
  const flow = await beginFlow();
  const response = await SELF.fetch(
    `${BASE_URL}/oauth?code=authorization-code&state=${encodeURIComponent(flow.state)}`,
  );
  expect(response.status).toBe(200);
  return { ...flow, fetchMock };
}

beforeEach(async () => {
  await callback.reset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await abortAllDurableObjects();
  await reset();
});

describe("X connected account OAuth", () => {
  it("reports one owner-only whole-account resource and no deployment credential setup", async () => {
    await expect(vendor().describe()).resolves.toMatchObject({
      displayName: "X",
      url: "https://x.com/",
      providesAuth: false,
    });
    await expect(vendor().getSupportedResources()).resolves.toEqual([
      expect.objectContaining({
        urlPattern: "https://*",
        title: "X Account",
        workspaceAccess: "owner-only",
      }),
    ]);
  });

  it("creates a unique nonce-bearing localized credential form", async () => {
    const first = await vendor().connectAccount(callback, { language: "ja" });
    const second = await vendor().connectAccount(callback, { language: "en" });
    const firstParts = parseInitiationUrl(first.url);
    const secondParts = parseInitiationUrl(second.url);

    expect(firstParts.doId).toMatch(/^[0-9a-f]{64}$/);
    expect(firstParts.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondParts.doId).not.toBe(firstParts.doId);
    expect(first.url).toContain("language=ja");

    const response = await SELF.fetch(first.url);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("X Developer App を接続");
    expect(html).toContain(`${BASE_URL}/oauth`);
    expect(html).not.toContain(CLIENT_SECRET);
  });

  it("claims the credential form once and redirects with exact PKCE authorization", async () => {
    const start = await vendor().connectAccount(callback, { language: "en" });
    const [first, second] = await Promise.all([
      SELF.fetch(credentialsRequest(start.url)),
      SELF.fetch(credentialsRequest(start.url)),
    ]);
    const responses = [first, second].sort((a, b) => a.status - b.status);

    expect(responses.map(response => response.status)).toEqual([302, 400]);
    const location = responses[0].headers.get("location");
    expect(location).not.toBeNull();
    const authorization = new URL(location!);
    expect(`${authorization.origin}${authorization.pathname}`)
      .toBe("https://x.com/i/oauth2/authorize");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get("scope")).toBe(X_OAUTH_SCOPES.join(" "));
    expect(location).not.toContain(CLIENT_SECRET);
  });

  it("stores identity before completing, caches describe, and rejects callback replay", async () => {
    const { doId, state, fetchMock } = await completeFlow();

    expect(await callback.read()).toMatchObject({
      completeCount: 1,
      completedDescription: {
        displayName: "X Developer (@XDevelopers)",
        uniqueName: `x:${USER.id}`,
      },
    });
    expect(await account(doId).getCredentialGeneration()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(callback.describeConnected()).resolves.toMatchObject({
      displayName: "X Developer (@XDevelopers)",
      uniqueName: `x:${USER.id}`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const replay = await SELF.fetch(
      `${BASE_URL}/oauth?code=authorization-code&state=${encodeURIComponent(state)}`,
    );
    expect(replay.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("consumes failed callback state and stores no candidate credentials", async () => {
    const fetchMock = oauthFetch({ scopes: X_OAUTH_SCOPES.filter(scope => scope !== "tweet.write") });
    vi.stubGlobal("fetch", fetchMock);
    const flow = await beginFlow();

    const failed = await SELF.fetch(
      `${BASE_URL}/oauth?code=authorization-code&state=${encodeURIComponent(flow.state)}`,
    );
    const replay = await SELF.fetch(
      `${BASE_URL}/oauth?code=authorization-code&state=${encodeURIComponent(flow.state)}`,
    );

    expect(failed.status).toBe(400);
    expect(replay.status).toBe(400);
    expect(await callback.read()).toMatchObject({ completeCount: 0 });
    expect(await storageValue(flow.doId, "oauthAttempt")).toBeUndefined();
    expect(await storageValue(flow.doId, "credentials")).toBeUndefined();
    const body = await failed.text();
    expect(body).not.toContain(CLIENT_SECRET);
    expect(body).not.toContain(ACCESS_TOKEN);
  });

  it("rejects expired initiation nonces and clears abandoned accounts by alarm", async () => {
    const start = await vendor().connectAccount(callback);
    const { doId } = parseInitiationUrl(start.url);
    await runInDurableObject(account(doId), (_instance, state) => {
      const attempt = state.storage.kv.get<Record<string, unknown>>("connectionAttempt")!;
      state.storage.kv.put("connectionAttempt", { ...attempt, expiresAt: Date.now() - 1 });
    });

    expect((await SELF.fetch(credentialsRequest(start.url))).status).toBe(400);
    await runDurableObjectAlarm(account(doId));
    expect(await runInDurableObject(account(doId), (_instance, state) => state.storage.list()))
      .toEqual(new Map());
  });

  it("serves only the canonical owner-only account resource", async () => {
    await completeFlow();

    await expect(callback.validateConnectedUrl("https://x.com/XDevelopers"))
      .resolves.toMatchObject({ title: "X Account", workspaceAccess: "owner-only" });
    expect(isConnectedAccountUrl("https://evil.example/XDevelopers", USER)).toBe(false);
    await expect(callback.configuredResourceUrl("https://*"))
      .resolves.toBe("https://x.com/XDevelopers");
  });

  it("preserves the resolved form language for reconnect", async () => {
    const fetchMock = oauthFetch();
    vi.stubGlobal("fetch", fetchMock);
    const first = await beginFlow({ language: "ja" });
    expect((await SELF.fetch(
      `${BASE_URL}/oauth?code=authorization-code&state=${encodeURIComponent(first.state)}`,
    )).status).toBe(200);

    const reconnect = await callback.reconnectConnected();

    expect(reconnect.url).toContain("language=ja");
    expect(await SELF.fetch(reconnect.url).then(response => response.text()))
      .toContain("X Developer App を接続");
  });

  it("reconnects only to the same immutable X identity and advances generation", async () => {
    const initial = await completeFlow();
    const before = await account(initial.doId).getCredentialGeneration();
    const reconnectFetch = oauthFetch({
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
    });
    vi.stubGlobal("fetch", reconnectFetch);
    const reconnect = await beginFlow({ reconnect: true });
    const response = await SELF.fetch(
      `${BASE_URL}/oauth?code=reconnect-code&state=${encodeURIComponent(reconnect.state)}`,
    );

    expect(response.status).toBe(200);
    expect(await account(initial.doId).getCredentialGeneration()).toBe(before + 1);
    expect(await callback.read()).toMatchObject({ completeCount: 1, restoredCount: 1 });
    expect(await storageValue<any>(initial.doId, "credentials")).toMatchObject({
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
      user: { id: USER.id },
    });
  });

  it("preserves the old generation when reconnect authorizes another X account", async () => {
    const initial = await completeFlow();
    const before = await storageValue<any>(initial.doId, "credentials");
    vi.stubGlobal("fetch", oauthFetch({
      user: { id: "6253282", name: "Other", username: "OtherUser" },
      accessToken: "wrong-access",
      refreshToken: "wrong-refresh",
    }));
    const reconnect = await beginFlow({ reconnect: true });

    const response = await SELF.fetch(
      `${BASE_URL}/oauth?code=reconnect-code&state=${encodeURIComponent(reconnect.state)}`,
    );

    expect(response.status).toBe(400);
    expect(await storageValue(initial.doId, "credentials")).toEqual(before);
    expect(await callback.read()).toMatchObject({ completeCount: 1, restoredCount: 0 });
  });

  it("single-flights refresh and commits a rotated token", async () => {
    const initial = await completeFlow();
    await runInDurableObject(account(initial.doId), (_instance, state) => {
      const credentials = state.storage.kv.get<any>("credentials");
      state.storage.kv.put("credentials", { ...credentials, accessTokenExpiresAt: Date.now() - 1 });
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://api.x.com/2/oauth2/token") {
        return oauthGrant({
          accessToken: "rotated-access",
          refreshToken: "rotated-refresh",
        });
      }
      return Response.json({ data: USER });
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await expect(Promise.all([
      account(initial.doId).performRead({ type: "getMe" }),
      account(initial.doId).performRead({ type: "getMe" }),
    ])).resolves.toEqual([USER, USER]);
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input) === "https://api.x.com/2/oauth2/token")).toHaveLength(1);
    expect(await storageValue<any>(initial.doId, "credentials")).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    });
  });

  it("notifies credential expiry once after refresh invalid_grant", async () => {
    const initial = await completeFlow();
    await runInDurableObject(account(initial.doId), (_instance, state) => {
      const credentials = state.storage.kv.get<any>("credentials");
      state.storage.kv.put("credentials", { ...credentials, accessTokenExpiresAt: Date.now() - 1 });
    });
    const fetchMock = vi.fn(async () => Response.json(
      { error: "invalid_grant" },
      { status: 400 },
    )) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const first = await runInDurableObject(
      account(initial.doId),
      instance => (instance as unknown as UserAccountRpc).performRead({ type: "getMe" }),
    ).catch(error => error as Error);
    const second = await runInDurableObject(
      account(initial.doId),
      instance => (instance as unknown as UserAccountRpc).performRead({ type: "getMe" }),
    ).catch(error => error as Error);
    expect(first.message).toMatch(/reconnect/i);
    expect(second.message).toMatch(/reconnect/i);
    expect(await callback.read()).toMatchObject({ expiredCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deletes every local secret on disconnect without a provider request", async () => {
    const initial = await completeFlow();
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); }) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await callback.revokeConnected();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await runInDurableObject(account(initial.doId), (_instance, state) => state.storage.list()))
      .toEqual(new Map());
  });
});
