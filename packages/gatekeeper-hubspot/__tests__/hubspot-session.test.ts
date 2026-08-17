import { env, RpcStub, RpcTarget } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import type { ApprovalQueue, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubSpotApi } from "../src/hubspot-api";
import { HubSpotGatekeeperImpl, HubSpotSessionImpl } from "../src/hubspot";
import type { HubSpotMutationTicket } from "../src/types";

const ACCESS_TOKEN = "session-access-token-never-expose";
const PORTAL_ID = 24680;

type Observation = Parameters<ApprovalQueue["authorizeObservation"]>[0];
type Authorize = ReturnType<typeof vi.fn<(description: Observation) => Promise<void>>>;

type UserAccountRpc = {
  setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void>;
  getAccessToken(): Promise<string>;
  notifyCredentialsExpired(): Promise<void>;
};

type Callback = Fetcher<GatekeeperConnectCallback> & {
  read(): Promise<{ expiredCount: number }>;
  reset(): Promise<void>;
};

type TestExports = {
  TestConnectCallback(options: object): Callback;
};

const testEnv = env as unknown as {
  USER_ACCOUNT: DurableObjectNamespace<UserAccountRpc>;
};
const worker = createExecutionContext().exports as unknown as TestExports;

function crmRecord(id: string, properties: Record<string, string>) {
  return {
    id,
    properties,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function session(options?: {
  authorize?: Authorize;
  fetch?: typeof fetch;
  notifyCredentialsExpired?: () => Promise<void>;
}) {
  const authorize = options?.authorize ?? vi.fn(async () => {});
  const dispose = vi.fn();
  const approvalQueue = {
    authorizeObservation: authorize,
    [Symbol.dispose]: dispose,
  } as unknown as RpcStub<ApprovalQueue>;
  const api = new HubSpotApi({
    getAccessToken: async () => ACCESS_TOKEN,
    fetch: options?.fetch ?? vi.fn(async () => json({ total: 0, results: [] })),
  });
  return {
    authorize,
    dispose,
    value: new HubSpotSessionImpl(
      api,
      PORTAL_ID,
      approvalQueue,
      options?.notifyCredentialsExpired ?? (async () => {}),
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HubSpot CRM observations", () => {
  it("fetches first and withholds CRM data until observation authorization resolves", async () => {
    const fetchResult = deferred<Response>();
    const authorization = deferred<void>();
    const authorize = vi.fn(async () => authorization.promise);
    const fetchMock = vi.fn(async () => fetchResult.promise) as typeof fetch;
    const subject = session({ authorize, fetch: fetchMock });
    let returned = false;

    const result = subject.value.searchContacts("Ada", { limit: 10 }).then(value => {
      returned = true;
      return value;
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(authorize).not.toHaveBeenCalled();
    fetchResult.resolve(json({
      total: 1,
      results: [crmRecord("101", { email: "private@example.com" })],
    }));
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    expect(returned).toBe(false);

    authorization.resolve();
    await expect(result).resolves.toMatchObject({ results: [{ id: "101" }] });
  });

  it("propagates authorization rejection without returning fetched CRM data", async () => {
    const rejection = new Error("observation rejected");
    const subject = session({
      authorize: vi.fn(async () => { throw rejection; }),
      fetch: vi.fn(async () => json(crmRecord("101", { email: "private@example.com" }))) as typeof fetch,
    });

    await expect(subject.value.getContact("101")).rejects.toBe(rejection);
  });

  it("maps contact, company, and deal reads to curated endpoints and results", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const match = url.pathname.match(/^\/crm\/objects\/2026-03\/(contacts|companies|deals)(?:\/([^/]+))?/);
      if (!match) return json({}, 404);
      const [, type, suffix] = match;
      const properties = type === "contacts"
        ? { email: "private@example.com", uncurated: "hidden" }
        : type === "companies"
        ? { name: "Private Company", uncurated: "hidden" }
        : { dealname: "Private Deal", uncurated: "hidden" };
      const record = crmRecord(type === "contacts" ? "101" : type === "companies" ? "202" : "303", properties);
      return suffix === "search"
        ? json({ total: 1, results: [record], paging: { next: { after: "400" } } })
        : json(record);
    }) as typeof fetch;
    const subject = session({ fetch: fetchMock });

    await expect(subject.value.searchContacts("contact query", { limit: 5, after: 10 })).resolves.toEqual({
      total: 1,
      results: [crmRecord("101", { email: "private@example.com" })],
      nextAfter: 400,
    });
    await expect(subject.value.getContact("101")).resolves.toEqual(
      crmRecord("101", { email: "private@example.com" }),
    );
    await expect(subject.value.searchCompanies("company query")).resolves.toEqual({
      total: 1,
      results: [crmRecord("202", { name: "Private Company" })],
      nextAfter: 400,
    });
    await expect(subject.value.getCompany("202")).resolves.toEqual(
      crmRecord("202", { name: "Private Company" }),
    );
    await expect(subject.value.searchDeals("deal query")).resolves.toEqual({
      total: 1,
      results: [crmRecord("303", { dealname: "Private Deal" })],
      nextAfter: 400,
    });
    await expect(subject.value.getDeal("303")).resolves.toEqual(
      crmRecord("303", { dealname: "Private Deal" }),
    );

    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/crm/objects/2026-03/contacts/search",
      "/crm/objects/2026-03/contacts/101",
      "/crm/objects/2026-03/companies/search",
      "/crm/objects/2026-03/companies/202",
      "/crm/objects/2026-03/deals/search",
      "/crm/objects/2026-03/deals/303",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      query: "contact query",
      limit: 5,
      after: "10",
    });
    expect(subject.authorize).toHaveBeenCalledTimes(6);
    for (const [description] of subject.authorize.mock.calls) {
      expect(description).not.toHaveProperty("prohibitAllSharing");
      expect(description.title.length).toBeLessThanOrEqual(100);
      expect(description.description.length).toBeLessThanOrEqual(500);
      expect(description.description).toContain(String(PORTAL_ID));
      expect(description.description).not.toContain("private@example.com");
      expect(description.description).not.toContain("Private Company");
      expect(description.description).not.toContain("Private Deal");
    }
  });

  it("uses HubSpot API search and record-ID bounds before fetch or authorization", async () => {
    const fetchMock = vi.fn(async () => json({})) as typeof fetch;
    const subject = session({ fetch: fetchMock });

    await expect(subject.value.searchContacts("x".repeat(3001))).rejects.toThrow("query");
    await expect(subject.value.searchCompanies("x", { limit: 101 })).rejects.toThrow("limit");
    await expect(subject.value.searchDeals("x", { after: 1.5 })).rejects.toThrow("after");
    await expect(subject.value.getContact("0")).rejects.toThrow("record ID");
    await expect(subject.value.getCompany("1.5")).rejects.toThrow("record ID");
    await expect(subject.value.getDeal("1/associations/contacts")).rejects.toThrow("record ID");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(subject.authorize).not.toHaveBeenCalled();
  });

  it("keeps authorization metadata bounded at the maximum accepted query length", async () => {
    const subject = session({
      fetch: vi.fn(async () => json({ total: 0, results: [] })) as typeof fetch,
    });

    await subject.value.searchContacts("x".repeat(3000));

    const description = subject.authorize.mock.calls[0][0];
    expect(description.title.length).toBeLessThanOrEqual(100);
    expect(description.description.length).toBeLessThanOrEqual(500);
  });

  it("notifies the account callback once and returns a reconnect error after CRM 401 responses", async () => {
    const callback = worker.TestConnectCallback({});
    await callback.reset();
    const id = testEnv.USER_ACCOUNT.newUniqueId();
    const account = testEnv.USER_ACCOUNT.get(id);
    await account.setCallback(callback, "n".repeat(43));
    await runInDurableObject(account, (_instance, state) => {
      state.storage.kv.put("accessToken", ACCESS_TOKEN);
      state.storage.kv.put("accessTokenExpiresAt", Date.now() + 600_000);
    });
    const fetchMock = vi.fn(async () => json({
      category: "EXPIRED_AUTHENTICATION",
      message: "private provider detail",
    }, 401)) as typeof fetch;
    const approvalQueue = {
      authorizeObservation: vi.fn(async () => {}),
      [Symbol.dispose]: vi.fn(),
    } as unknown as RpcStub<ApprovalQueue>;
    const subject = new HubSpotSessionImpl(
      new HubSpotApi({ getAccessToken: () => account.getAccessToken(), fetch: fetchMock }),
      PORTAL_ID,
      approvalQueue,
      () => account.notifyCredentialsExpired(),
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await subject.getContact("101").catch((caught: unknown) => caught as Error);
      expect(error.message).toContain("reconnect");
      expect(error.message).not.toContain(ACCESS_TOKEN);
      expect(error.message).not.toContain("private provider detail");
    }
    expect((await callback.read()).expiredCount).toBe(1);
  });

  it("does not report rate limits as credential expiry", async () => {
    const notifyCredentialsExpired = vi.fn(async () => {});
    const subject = session({
      notifyCredentialsExpired,
      fetch: vi.fn(async () => json({ category: "RATE_LIMITS" }, 429)) as typeof fetch,
    });

    await expect(subject.value.getDeal("303")).rejects.toMatchObject({ kind: "rate-limited" });
    expect(notifyCredentialsExpired).not.toHaveBeenCalled();
  });

  it("disposes the duplicated approval queue with the session", () => {
    const subject = session();

    subject.value[Symbol.dispose]();

    expect(subject.dispose).toHaveBeenCalledOnce();
  });
});

describe("HubSpot fail-closed policies", () => {
  it("rejects every observer even when its verifier succeeds and removes idempotently", async () => {
    const verify = vi.fn(async () => {});
    class SuccessfulVerifier extends RpcTarget {
      verify = verify;
    }
    const verifier = new RpcStub(new SuccessfulVerifier());
    const gatekeeper = HubSpotGatekeeperImpl.prototype;

    try {
      await expect(
        gatekeeper.addObserver("observer", verifier as unknown as Fetcher),
      ).rejects.toThrow(/cannot be shared.*owner/i);
      expect(verify).not.toHaveBeenCalled();
      await expect(gatekeeper.removeObserver("observer")).resolves.toBeUndefined();
      await expect(gatekeeper.removeObserver("observer")).resolves.toBeUndefined();
    } finally {
      verifier[Symbol.dispose]();
    }
  });

  it("keeps all mutation methods fail-closed without fetch or queue activity", async () => {
    const fetchMock = vi.fn(async () => json({})) as typeof fetch;
    const subject = session({ fetch: fetchMock });
    const ticket: HubSpotMutationTicket = { id: 1, objectType: "contact", operation: "create" };

    const writes = [
      () => subject.value.createContact({ email: "private@example.com" }),
      () => subject.value.updateContact("101", { firstname: "Private" }),
      () => subject.value.createCompany({ name: "Private Company" }),
      () => subject.value.updateCompany("202", { domain: "private.example" }),
      () => subject.value.createDeal({ dealname: "Private Deal" }),
      () => subject.value.updateDeal("303", { amount: "100" }),
      () => subject.value.getMutationResult(ticket),
    ];
    for (const write of writes) await expect(write()).rejects.toThrow(/not available/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(subject.authorize).not.toHaveBeenCalled();
  });
});
