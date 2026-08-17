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
import {
  HUBSPOT_OAUTH_SCOPES,
  buildHubSpotAuthorizationUrl,
} from "../src/hubspot-api";
import { hubSpotVendorDescription, isHubSpotAccountUrl } from "../src/hubspot";

const BASE_URL = "https://workshop.example/gatekeeper/hubspot";
const CLIENT_ID = "hubspot-client-id";
const CLIENT_SECRET = "hubspot-client-secret";
const ACCESS_TOKEN = "access-token-never-expose";
const REFRESH_TOKEN = "refresh-token-never-expose";
const ACCOUNT_PATTERN = "https://app.hubspot.com/contacts/:hubId";

type Vendor = {
  describe(): Promise<Record<string, unknown>>;
  connectAccount(callback: Fetcher): Promise<{ url: string }>;
  getSupportedResources(): Promise<Array<Record<string, unknown>>>;
};

type Callback = Fetcher & {
  read(): Promise<{
    completeCount: number;
    completeExpiry?: number;
    completedDescription?: { displayName?: string; uniqueName?: string };
    expiredCount: number;
    restoredCount: number;
    restoredExpiry?: number;
  }>;
  reset(): Promise<void>;
  describeConnected(): Promise<Record<string, unknown>>;
  reconnectConnected(): Promise<{ url: string }>;
  revokeConnected(): Promise<void>;
  validateConnectedUrl(url: string): Promise<string>;
  configuredResourceUrl(pattern: string): Promise<string>;
  verifyConnected(): Promise<void>;
};

type UserAccountRpc = {
  getAccessToken(): Promise<string>;
  prepareReconnect(nonce: string): Promise<void>;
  revoke(): Promise<void>;
};

type TestExports = {
  GatekeeperVendor(options: object): Vendor;
  TestConnectCallback(options: object): Callback;
};

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
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
  return runInDurableObject(account(doId), (_instance, state) => state.storage.kv.get<T>(key));
}

async function setStoredExpiry(doId: string, expiresAt: number): Promise<void> {
  await runInDurableObject(account(doId), (_instance, state) => {
    const nonce = state.storage.kv.get<StoredNonce>("nonce");
    if (!nonce) throw new Error("Missing nonce");
    state.storage.kv.put<StoredNonce>("nonce", { ...nonce, expiresAt });
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function oauthGrant(options?: {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  hubId?: number;
  scopes?: readonly string[];
}): Response {
  return Response.json({
    access_token: options?.accessToken ?? ACCESS_TOKEN,
    refresh_token: options?.refreshToken ?? REFRESH_TOKEN,
    expires_in: options?.expiresIn ?? 1800,
    hub_id: options?.hubId ?? 12345,
    scopes: options?.scopes ?? HUBSPOT_OAUTH_SCOPES,
  });
}

async function beginFlow(): Promise<{
  doId: string;
  initiationNonce: string;
  state: string;
  authorizationResponse: Response;
}> {
  const connected = await vendor().connectAccount(callback);
  const { doId, nonce: initiationNonce } = parseInitiationUrl(connected.url);
  const authorizationResponse = await SELF.fetch(connected.url, { redirect: "manual" });
  const state = new URL(authorizationResponse.headers.get("location") ?? "").searchParams.get("state") ?? "";
  return { doId, initiationNonce, state, authorizationResponse };
}

async function completeFlow(hubId = 12345): Promise<{ doId: string; state: string; response: Response }> {
  const flow = await beginFlow();
  vi.stubGlobal("fetch", vi.fn(async () => oauthGrant({ hubId })));
  const response = await SELF.fetch(
    `${BASE_URL}/oauth?code=provider-code&state=${encodeURIComponent(flow.state)}`,
  );
  return { doId: flow.doId, state: flow.state, response };
}

beforeEach(async () => {
  await reset();
  await callback.reset();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await abortAllDurableObjects();
});

describe("HubSpot vendor metadata", () => {
  it("reports static OAuth readiness, branding, and one whole-account resource", async () => {
    const description = await vendor().describe();
    const resources = await vendor().getSupportedResources();

    expect(description).toMatchObject({
      displayName: "HubSpot",
      url: "https://www.hubspot.com",
      configuration: { configured: true },
    });
    expect(description.providesAuth).toBeUndefined();
    expect(description.logo).toMatchObject({ url: expect.stringMatching(/^data:image\/svg\+xml,/) });
    expect(resources).toEqual([expect.objectContaining({
      urlPattern: ACCOUNT_PATTERN,
      title: "HubSpot account",
      icon: description.logo,
    })]);
    expect(hubSpotVendorDescription({})).toMatchObject({
      configuration: { configured: false },
    });
  });

  it("creates unique accounts with cryptographic initiation nonces and an abandonment alarm", async () => {
    const first = await vendor().connectAccount(callback);
    const second = await vendor().connectAccount(callback);
    const parsedFirst = parseInitiationUrl(first.url);
    const parsedSecond = parseInitiationUrl(second.url);

    expect(first.url.startsWith(`${BASE_URL}/`)).toBe(true);
    expect(parsedFirst.doId).toMatch(/^[0-9a-f]{64}$/);
    expect(parsedFirst.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parsedSecond.doId).not.toBe(parsedFirst.doId);
    expect(parsedSecond.nonce).not.toBe(parsedFirst.nonce);
    expect(await runInDurableObject(account(parsedFirst.doId), (_instance, state) =>
      state.storage.getAlarm())).toBeGreaterThan(Date.now());
  });
});

describe("HubSpot OAuth HTTP lifecycle", () => {
  it("consumes the initiation nonce and redirects to the exact non-PKCE authorize URL", async () => {
    const flow = await beginFlow();
    const stateNonce = flow.state.slice(flow.doId.length + 1);

    expect(flow.authorizationResponse.status).toBe(302);
    expect(flow.authorizationResponse.headers.get("location")).toBe(buildHubSpotAuthorizationUrl({
      clientId: CLIENT_ID,
      redirectUri: `${BASE_URL}/oauth`,
      state: `${flow.doId}:${stateNonce}`,
    }));
    expect(flow.authorizationResponse.headers.get("location")).not.toContain("code_challenge");
    expect(stateNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const replay = await SELF.fetch(
      `${BASE_URL}/${flow.doId}/${flow.initiationNonce}`,
      { redirect: "manual" },
    );
    expect(replay.status).toBe(400);
    expect(await replay.text()).not.toContain(flow.initiationNonce);
  });

  it("rejects expired initiation nonces and clears abandoned flows by alarm", async () => {
    const connected = await vendor().connectAccount(callback);
    const { doId, nonce } = parseInitiationUrl(connected.url);
    await setStoredExpiry(doId, Date.now() - 1);

    const expired = await SELF.fetch(`${BASE_URL}/${doId}/${nonce}`, { redirect: "manual" });
    expect(expired.status).toBe(400);
    expect(await runDurableObjectAlarm(account(doId))).toBe(true);
    expect(await runInDurableObject(account(doId), (_instance, state) =>
      state.storage.list())).toEqual(new Map());
  });

  it("rejects malformed and expired OAuth state without exchanging a code", async () => {
    const flow = await beginFlow();
    await setStoredExpiry(flow.doId, Date.now() - 1);
    const fetchMock = vi.fn(async () => oauthGrant());
    vi.stubGlobal("fetch", fetchMock);

    for (const state of [
      flow.state,
      "missing-colon",
      `not-a-do-id:${flow.state}`,
      `${flow.doId}:short`,
      `${flow.doId}:${flow.state}:extra`,
    ]) {
      const response = await SELF.fetch(
        `${BASE_URL}/oauth?code=secret-code&state=${encodeURIComponent(state)}`,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("secret-code");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consumes provider-error state and returns only a bounded user-safe error", async () => {
    const flow = await beginFlow();
    const raw = `${CLIENT_SECRET}-${ACCESS_TOKEN}-provider-description`;
    const denied = await SELF.fetch(
      `${BASE_URL}/oauth?error=access_denied&error_description=${encodeURIComponent(raw)}` +
        `&state=${encodeURIComponent(flow.state)}`,
    );
    const body = await denied.text();

    expect(denied.status).toBe(400);
    expect(body.length).toBeLessThan(300);
    expect(body).not.toContain(CLIENT_SECRET);
    expect(body).not.toContain(ACCESS_TOKEN);
    expect(body).not.toContain("provider-description");

    const replay = await SELF.fetch(
      `${BASE_URL}/oauth?code=provider-code&state=${encodeURIComponent(flow.state)}`,
    );
    expect(replay.status).toBe(400);
  });

  it("stores credentials and identity before completing without an account expiry", async () => {
    const flow = await beginFlow();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.hubspot.com/oauth/2026-03/token");
      return oauthGrant();
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await SELF.fetch(
      `${BASE_URL}/oauth?code=provider-code&state=${encodeURIComponent(flow.state)}`,
    );
    const result = await callback.read();

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("window.close()");
    expect(result).toMatchObject({
      completeCount: 1,
      completeExpiry: undefined,
      completedDescription: { displayName: "HubSpot account 12345" },
    });
    expect(await storageValue(flow.doId, "accessToken")).toBe(ACCESS_TOKEN);
    expect(await storageValue(flow.doId, "refreshToken")).toBe(REFRESH_TOKEN);
    expect(await storageValue(flow.doId, "hubId")).toBe(12345);
    expect(await storageValue(flow.doId, "scopes")).toEqual(HUBSPOT_OAUTH_SCOPES);
    expect(await storageValue(flow.doId, "credentialGeneration")).toBe(1);
    expect(await storageValue<number>(flow.doId, "accessTokenExpiresAt")).toBeGreaterThan(Date.now());
    expect(await runInDurableObject(account(flow.doId), (_instance, state) =>
      state.storage.getAlarm())).toBeNull();
  });

  it("rejects incomplete returned scopes before storing initial credentials", async () => {
    const flow = await beginFlow();
    vi.stubGlobal("fetch", vi.fn(async () => oauthGrant({
      scopes: ["oauth", "crm.objects.contacts.read"],
    })));

    expect((await SELF.fetch(
      `${BASE_URL}/oauth?code=provider-code&state=${encodeURIComponent(flow.state)}`,
    )).status).toBe(400);
    expect(await storageValue(flow.doId, "accessToken")).toBeUndefined();
    expect(await storageValue(flow.doId, "refreshToken")).toBeUndefined();
    expect((await callback.read()).completeCount).toBe(0);
  });

  it("rejects replayed OAuth state after one successful exchange", async () => {
    const flow = await beginFlow();
    const fetchMock = vi.fn(async () => oauthGrant());
    vi.stubGlobal("fetch", fetchMock);
    const callbackUrl = `${BASE_URL}/oauth?code=provider-code&state=${encodeURIComponent(flow.state)}`;

    expect((await SELF.fetch(callbackUrl)).status).toBe(200);
    expect((await SELF.fetch(callbackUrl)).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await callback.read()).completeCount).toBe(1);
  });

  it("redacts token-exchange failures and consumes their one-time state", async () => {
    const flow = await beginFlow();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: "invalid_grant",
      error_description: `${CLIENT_SECRET} ${ACCESS_TOKEN} raw-provider-body`,
    }, { status: 400 })));

    const failed = await SELF.fetch(
      `${BASE_URL}/oauth?code=sensitive-code&state=${encodeURIComponent(flow.state)}`,
    );
    const body = await failed.text();

    expect(failed.status).toBe(400);
    expect(body.length).toBeLessThan(300);
    expect(body).not.toContain(CLIENT_SECRET);
    expect(body).not.toContain(ACCESS_TOKEN);
    expect(body).not.toContain("sensitive-code");
    expect(body).not.toContain("raw-provider-body");
    expect((await callback.read()).completeCount).toBe(0);
    expect((await SELF.fetch(
      `${BASE_URL}/oauth?code=again&state=${encodeURIComponent(flow.state)}`,
    )).status).toBe(400);
  });
});

describe("HubSpot connected account", () => {
  it("refreshes before expiry, saves a rotated token, and preserves an unrotated token", async () => {
    const first = await completeFlow(111);
    await runInDurableObject(account(first.doId), (_instance, state) => {
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 1);
    });
    const rotatedFetch = vi.fn(async () => Response.json({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 1200,
    }));
    vi.stubGlobal("fetch", rotatedFetch);

    await expect(account(first.doId).getAccessToken()).resolves.toBe("rotated-access");
    expect(await storageValue(first.doId, "refreshToken")).toBe("rotated-refresh");

    await runInDurableObject(account(first.doId), (_instance, state) => {
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 1);
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      access_token: "unrotated-access",
      expires_in: 900,
    })));

    await expect(account(first.doId).getAccessToken()).resolves.toBe("unrotated-access");
    expect(await storageValue(first.doId, "refreshToken")).toBe("rotated-refresh");
  });

  it("single-flights concurrent refreshes and preserves the rotated refresh token", async () => {
    const flow = await completeFlow();
    await runInDurableObject(account(flow.doId), (_instance, state) => {
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 1);
    });
    const response = deferred<Response>();
    const fetchMock = vi.fn(async () => response.promise);
    vi.stubGlobal("fetch", fetchMock);

    await runInDurableObject(account(flow.doId), async instance => {
      const first = instance.getAccessToken();
      const second = instance.getAccessToken();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      response.resolve(oauthGrant({
        accessToken: "single-flight-access",
        refreshToken: "single-flight-refresh",
      }));
      await expect(Promise.all([first, second])).resolves.toEqual([
        "single-flight-access",
        "single-flight-access",
      ]);
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await storageValue(flow.doId, "refreshToken")).toBe("single-flight-refresh");
    expect((await callback.read()).expiredCount).toBe(0);
  });

  it("notifies credentialsExpired once for invalid refresh credentials", async () => {
    const flow = await completeFlow();
    await runInDurableObject(account(flow.doId), (_instance, state) => {
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 1);
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: "invalid_grant",
      error_description: `${REFRESH_TOKEN} raw-provider-body`,
    }, { status: 400 })));

    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await runInDurableObject(
        account(flow.doId),
        instance => instance.getAccessToken(),
      ).catch((caught: unknown) => caught as Error);
      expect(error.message).toContain("reconnect");
      expect(error.message).not.toContain(REFRESH_TOKEN);
      expect(error.message).not.toContain("raw-provider-body");
    }
    expect((await callback.read()).expiredCount).toBe(1);
  });

  it("does not report invalid_client as credential expiry or replace refresh credentials", async () => {
    const flow = await completeFlow();
    await runInDurableObject(account(flow.doId), (_instance, state) => {
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 1);
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: "invalid_client",
    }, { status: 400 })));

    const error = await runInDurableObject(
      account(flow.doId),
      instance => instance.getAccessToken(),
    ).catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain("reconnect");
    expect((await callback.read()).expiredCount).toBe(0);
    expect(await storageValue(flow.doId, "refreshToken")).toBe(REFRESH_TOKEN);
  });

  it("preserves refresh credentials when a refresh response omits required scopes", async () => {
    const flow = await completeFlow();
    await runInDurableObject(account(flow.doId), (_instance, state) => {
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 1);
    });
    vi.stubGlobal("fetch", vi.fn(async () => oauthGrant({
      accessToken: "under-scoped-access",
      refreshToken: "under-scoped-refresh",
      scopes: ["oauth"],
    })));

    const error = await runInDurableObject(
      account(flow.doId),
      instance => instance.getAccessToken(),
    ).catch((caught: unknown) => caught as Error);
    expect(error.message).toMatch(/scope/i);
    expect(await storageValue(flow.doId, "accessToken")).toBe(ACCESS_TOKEN);
    expect(await storageValue(flow.doId, "refreshToken")).toBe(REFRESH_TOKEN);
    expect((await callback.read()).expiredCount).toBe(0);
  });

  it("clears reconnect state after provider denial without changing credentials", async () => {
    const original = await completeFlow(12345);
    const reconnect = await callback.reconnectConnected();
    const authorization = await SELF.fetch(reconnect.url, { redirect: "manual" });
    const state = new URL(authorization.headers.get("location") ?? "").searchParams.get("state") ?? "";

    expect((await SELF.fetch(
      `${BASE_URL}/oauth?error=access_denied&state=${encodeURIComponent(state)}`,
    )).status).toBe(400);
    expect(await storageValue(original.doId, "reconnecting")).toBeUndefined();
    expect(await storageValue(original.doId, "accessToken")).toBe(ACCESS_TOKEN);
    expect(await storageValue(original.doId, "hubId")).toBe(12345);
    expect((await callback.read()).restoredCount).toBe(0);
  });

  it("reconnects only to the original portal and reports restoration", async () => {
    const original = await completeFlow(12345);
    const reconnect = await callback.reconnectConnected();
    const parsed = parseInitiationUrl(reconnect.url);
    expect(parsed.doId).toBe(original.doId);

    const authorization = await SELF.fetch(reconnect.url, { redirect: "manual" });
    const state = new URL(authorization.headers.get("location") ?? "").searchParams.get("state") ?? "";
    vi.stubGlobal("fetch", vi.fn(async () => oauthGrant({
      accessToken: "restored-access",
      refreshToken: "restored-refresh",
      hubId: 12345,
    })));

    expect((await SELF.fetch(
      `${BASE_URL}/oauth?code=reconnect-code&state=${encodeURIComponent(state)}`,
    )).status).toBe(200);
    expect(await callback.read()).toMatchObject({
      completeCount: 1,
      restoredCount: 1,
      restoredExpiry: undefined,
    });
    expect(await callback.describeConnected()).toMatchObject({
      displayName: "HubSpot account 12345",
    });
    expect(await storageValue(original.doId, "accessToken")).toBe("restored-access");
    expect(await storageValue(original.doId, "credentialGeneration")).toBe(2);
  });

  it("keeps reconnected credentials authoritative over a stale successful refresh", async () => {
    const original = await completeFlow(12345);
    await runInDurableObject(account(original.doId), (_instance, state) => {
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 1);
    });
    const refreshResponse = deferred<void>();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = new URLSearchParams(init?.body as string);
      if (form.get("grant_type") === "refresh_token") {
        await refreshResponse.promise;
        return oauthGrant({
          accessToken: "stale-refresh-access",
          refreshToken: "stale-refresh-token",
        });
      }
      return oauthGrant({
        accessToken: "reconnected-access",
        refreshToken: "reconnected-refresh",
        hubId: 12345,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const staleRefresh = account(original.doId).getAccessToken().catch(() => undefined);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const reconnect = await callback.reconnectConnected();
    const authorization = await SELF.fetch(reconnect.url, { redirect: "manual" });
    const state = new URL(authorization.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect((await SELF.fetch(
      `${BASE_URL}/oauth?code=reconnect-code&state=${encodeURIComponent(state)}`,
    )).status).toBe(200);

    refreshResponse.resolve();
    await staleRefresh;

    expect(await storageValue(original.doId, "accessToken")).toBe("reconnected-access");
    expect(await storageValue(original.doId, "refreshToken")).toBe("reconnected-refresh");
    await expect(account(original.doId).getAccessToken()).resolves.toBe("reconnected-access");
  });

  it("does not notify expiry when a superseded refresh fails after reconnect", async () => {
    const original = await completeFlow(12345);
    await runInDurableObject(account(original.doId), (_instance, state) => {
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 1);
    });
    const refreshResponse = deferred<void>();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = new URLSearchParams(init?.body as string);
      if (form.get("grant_type") === "refresh_token") {
        await refreshResponse.promise;
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return oauthGrant({
        accessToken: "reconnected-access",
        refreshToken: "reconnected-refresh",
        hubId: 12345,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const staleRefresh = account(original.doId).getAccessToken().catch(() => undefined);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const reconnect = await callback.reconnectConnected();
    const authorization = await SELF.fetch(reconnect.url, { redirect: "manual" });
    const state = new URL(authorization.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect((await SELF.fetch(
      `${BASE_URL}/oauth?code=reconnect-code&state=${encodeURIComponent(state)}`,
    )).status).toBe(200);

    refreshResponse.resolve();
    await staleRefresh;

    expect((await callback.read()).expiredCount).toBe(0);
    expect(await storageValue(original.doId, "accessToken")).toBe("reconnected-access");
    expect(await storageValue(original.doId, "refreshToken")).toBe("reconnected-refresh");
  });

  it("rejects reconnecting to another portal without replacing the original authority", async () => {
    const original = await completeFlow(12345);
    const reconnect = await callback.reconnectConnected();
    const authorization = await SELF.fetch(reconnect.url, { redirect: "manual" });
    const state = new URL(authorization.headers.get("location") ?? "").searchParams.get("state") ?? "";
    vi.stubGlobal("fetch", vi.fn(async () => oauthGrant({
      accessToken: "other-access",
      refreshToken: "other-refresh",
      hubId: 67890,
    })));

    const response = await SELF.fetch(
      `${BASE_URL}/oauth?code=reconnect-code&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(400);
    expect(await callback.read()).toMatchObject({ completeCount: 1, restoredCount: 0 });
    expect(await storageValue(original.doId, "accessToken")).toBe(ACCESS_TOKEN);
    expect(await storageValue(original.doId, "refreshToken")).toBe(REFRESH_TOKEN);
    expect(await storageValue(original.doId, "hubId")).toBe(12345);
    expect(await storageValue(original.doId, "scopes")).toEqual(HUBSPOT_OAUTH_SCOPES);
    expect(await storageValue(original.doId, "reconnecting")).toBeUndefined();
  });

  it("preserves original credentials when reconnect returns incomplete scopes", async () => {
    const original = await completeFlow(12345);
    const reconnect = await callback.reconnectConnected();
    const authorization = await SELF.fetch(reconnect.url, { redirect: "manual" });
    const state = new URL(authorization.headers.get("location") ?? "").searchParams.get("state") ?? "";
    vi.stubGlobal("fetch", vi.fn(async () => oauthGrant({
      accessToken: "under-scoped-access",
      refreshToken: "under-scoped-refresh",
      hubId: 12345,
      scopes: ["oauth"],
    })));

    expect((await SELF.fetch(
      `${BASE_URL}/oauth?code=reconnect-code&state=${encodeURIComponent(state)}`,
    )).status).toBe(400);
    expect(await storageValue(original.doId, "accessToken")).toBe(ACCESS_TOKEN);
    expect(await storageValue(original.doId, "refreshToken")).toBe(REFRESH_TOKEN);
    expect(await storageValue(original.doId, "hubId")).toBe(12345);
    expect(await storageValue(original.doId, "scopes")).toEqual(HUBSPOT_OAUTH_SCOPES);
    expect(await storageValue(original.doId, "reconnecting")).toBeUndefined();
    expect((await callback.read()).restoredCount).toBe(0);
  });

  it("describes the portal, serves its canonical no-input configurator, and validates URLs", async () => {
    await completeFlow(24680);

    expect(await callback.describeConnected()).toMatchObject({
      displayName: "HubSpot account 24680",
      avatar: { url: expect.stringMatching(/^data:image\/svg\+xml,/) },
    });
    expect(await callback.configuredResourceUrl(ACCOUNT_PATTERN)).toBe(
      "https://app.hubspot.com/contacts/24680",
    );
    await expect(callback.validateConnectedUrl(
      "https://app.hubspot.com/contacts/24680",
    )).resolves.toBe("HubSpot account");
    for (const invalid of [
      "http://app.hubspot.com/contacts/24680",
      "https://example.com/contacts/24680",
      "https://app.hubspot.com/contacts/99999",
      "https://app.hubspot.com/contacts/24680/extra",
      "https://user@app.hubspot.com/contacts/24680",
    ]) {
      expect(isHubSpotAccountUrl(invalid, 24680)).toBe(false);
    }
    await expect(callback.verifyConnected()).resolves.toBeUndefined();
  });

  it("keeps credentials while provider revocation is pending and fails closed", async () => {
    const flow = await completeFlow();
    const providerResponse = deferred<void>();
    const fetchMock = vi.fn(async () => {
      await providerResponse.promise;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runInDurableObject(account(flow.doId), async (instance, state) => {
      const revocation = instance.revoke();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

      expect(state.storage.kv.get("accessToken")).toBe(ACCESS_TOKEN);
      expect(state.storage.kv.get("refreshToken")).toBe(REFRESH_TOKEN);
      expect(state.storage.kv.get("revoking")).toBe(true);
      const accessError = await instance.getAccessToken()
        .catch((caught: unknown) => caught as Error);
      const reconnectError = await instance.prepareReconnect("n".repeat(43))
        .catch((caught: unknown) => caught as Error);
      expect(accessError.message).toMatch(/disconnect|revok/i);
      expect(reconnectError.message).toMatch(/disconnect|revok/i);

      providerResponse.resolve();
      await expect(revocation).resolves.toBeUndefined();
      expect(await state.storage.list()).toEqual(new Map());
    });
  });

  it("preserves reconnectable credentials when provider revocation fails", async () => {
    const flow = await completeFlow();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      raw: "private-provider-body",
    }, { status: 500 })));

    const error = await runInDurableObject(
      account(flow.doId),
      instance => instance.revoke(),
    ).catch((caught: unknown) => caught as Error);

    expect(error.message).toMatch(/retry|uninstall/i);
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(error.message).not.toContain(REFRESH_TOKEN);
    expect(error.message).not.toContain("private-provider-body");
    expect(await storageValue(flow.doId, "accessToken")).toBe(ACCESS_TOKEN);
    expect(await storageValue(flow.doId, "refreshToken")).toBe(REFRESH_TOKEN);
    expect(await storageValue(flow.doId, "revoking")).toBeUndefined();
    await expect(callback.reconnectConnected()).resolves.toMatchObject({
      url: expect.stringContaining(flow.doId),
    });
  });

  it("cleans up locally without a provider call when no refresh token remains", async () => {
    const flow = await completeFlow();
    await runInDurableObject(account(flow.doId), (_instance, state) => {
      state.storage.kv.delete("refreshToken");
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await callback.revokeConnected();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await runInDurableObject(account(flow.doId), (_instance, state) =>
      state.storage.list())).toEqual(new Map());
  });

  it("does not resurrect credentials when refresh succeeds after revocation", async () => {
    const flow = await completeFlow();
    await runInDurableObject(account(flow.doId), (_instance, state) => {
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 1);
    });
    const refreshResponse = deferred<void>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/revoke")) return new Response(null, { status: 204 });
      await refreshResponse.promise;
      return oauthGrant({
        accessToken: "stale-refresh-access",
        refreshToken: "stale-refresh-token",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runInDurableObject(account(flow.doId), async (instance, state) => {
      const staleRefresh = instance.getAccessToken().catch(() => undefined);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await instance.revoke();
      refreshResponse.resolve();
      await staleRefresh;

      expect(await state.storage.list()).toEqual(new Map());
    });
  });

  it("does not notify expiry when refresh fails after revocation", async () => {
    const flow = await completeFlow();
    await runInDurableObject(account(flow.doId), (_instance, state) => {
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 1);
    });
    const refreshResponse = deferred<void>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/revoke")) return new Response(null, { status: 204 });
      await refreshResponse.promise;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runInDurableObject(account(flow.doId), async (instance, state) => {
      const staleRefresh = instance.getAccessToken().catch(() => undefined);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await instance.revoke();
      refreshResponse.resolve();
      await staleRefresh;

      expect(await state.storage.list()).toEqual(new Map());
    });
    expect((await callback.read()).expiredCount).toBe(0);
  });
});
