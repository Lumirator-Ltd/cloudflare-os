import { env, RpcStub, RpcTarget } from "cloudflare:workers";
import { abortAllDurableObjects, createExecutionContext, runInDurableObject } from "cloudflare:test";
import type {
  ActionDescription,
  ApprovalQueue,
  GatekeeperConnectCallback,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_HUBSPOT_PROPERTY_VALUE_LENGTH,
  HubSpotApi,
} from "../src/hubspot-api";
import { HubSpotGatekeeperImpl, HubSpotSessionImpl } from "../src/hubspot";
import type { HubSpotMutationResult } from "../src/types";

const ACCESS_TOKEN = "session-access-token-never-expose";
const PORTAL_ID = 24680;

type Observation = Parameters<ApprovalQueue["authorizeObservation"]>[0];
type Authorize = ReturnType<typeof vi.fn<(description: Observation) => Promise<void>>>;
type Submit = ReturnType<
  typeof vi.fn<(action: number, description: ActionDescription) => Promise<void>>
>;
type MutationKv = Pick<DurableObjectStorage["kv"], "delete" | "get" | "put">;

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

type HubSpotGatekeeperRpc = Pick<
  HubSpotGatekeeperImpl,
  "applyAction" | "rejectAction" | "revertAction"
>;

const testEnv = env as unknown as {
  USER_ACCOUNT: DurableObjectNamespace<UserAccountRpc>;
  HUBSPOT_GATEKEEPER: DurableObjectNamespace<HubSpotGatekeeperRpc>;
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

function mutationStorage() {
  const data = new Map<string, unknown>();
  const kv = {
    delete(key: string) {
      return data.delete(key);
    },
    get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    put<T>(key: string, value: T) {
      data.set(key, structuredClone(value));
    },
  } as MutationKv;
  return { data, kv };
}

function session(options?: {
  authorize?: Authorize;
  fetch?: typeof fetch;
  mutationKv?: MutationKv;
  notifyCredentialsExpired?: () => Promise<void>;
  submit?: Submit;
  assertExpectedHubId?: () => Promise<void>;
  isMutationActive?: (id: number) => boolean;
}) {
  const authorize = options?.authorize ?? vi.fn(async () => {});
  const submit = options?.submit ?? vi.fn(async () => {});
  const dispose = vi.fn();
  const approvalQueue = {
    authorizeObservation: authorize,
    submitAction: submit,
    [Symbol.dispose]: dispose,
  } as unknown as RpcStub<ApprovalQueue>;
  const api = new HubSpotApi({
    getAccessToken: async () => ACCESS_TOKEN,
    fetch: options?.fetch ?? vi.fn(async () => json({ total: 0, results: [] })),
  });
  const storage = options?.mutationKv ? undefined : mutationStorage();
  return {
    authorize,
    dispose,
    storage,
    submit,
    value: new HubSpotSessionImpl(
      api,
      PORTAL_ID,
      approvalQueue,
      options?.notifyCredentialsExpired ?? (async () => {}),
      options?.mutationKv ?? storage?.kv as MutationKv,
      options?.assertExpectedHubId ?? (async () => {}),
      options?.isMutationActive ?? (() => false),
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

    await expect(subject.value.searchContacts("contact query", {
      limit: 5,
      after: "90071992547409931234",
    })).resolves.toEqual({
      total: 1,
      results: [crmRecord("101", { email: "private@example.com" })],
      nextAfter: "400",
    });
    await expect(subject.value.getContact("101")).resolves.toEqual(
      crmRecord("101", { email: "private@example.com" }),
    );
    await expect(subject.value.searchCompanies("company query")).resolves.toEqual({
      total: 1,
      results: [crmRecord("202", { name: "Private Company" })],
      nextAfter: "400",
    });
    await expect(subject.value.getCompany("202")).resolves.toEqual(
      crmRecord("202", { name: "Private Company" }),
    );
    await expect(subject.value.searchDeals("deal query")).resolves.toEqual({
      total: 1,
      results: [crmRecord("303", { dealname: "Private Deal" })],
      nextAfter: "400",
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
      after: "90071992547409931234",
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
    await expect(Promise.resolve().then(() =>
      subject.value.searchDeals("x", { after: 1.5 as never })
    )).rejects.toThrow();
    await expect(subject.value.searchDeals("x", { after: "1".repeat(33) })).rejects.toThrow("after");
    await expect(subject.value.getContact("0")).rejects.toThrow("record ID");
    await expect(subject.value.getContact("1".repeat(33))).rejects.toThrow("record ID");
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

  it("does not report serialized OAuth provider failures as credential expiry", async () => {
    const notifyCredentialsExpired = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => json({})) as typeof fetch;
    const approvalQueue = {
      authorizeObservation: vi.fn(async () => {}),
      [Symbol.dispose]: vi.fn(),
    } as unknown as RpcStub<ApprovalQueue>;
    const value = new HubSpotSessionImpl(
      new HubSpotApi({
        getAccessToken: async () => {
          throw new Error("HubSpotApiError: OAuth invalid_client");
        },
        fetch: fetchMock,
      }),
      PORTAL_ID,
      approvalQueue,
      notifyCredentialsExpired,
    );

    const error = await value.getContact("101").catch((caught: unknown) => caught as Error);

    expect(error.message).not.toContain("reconnect");
    expect(notifyCredentialsExpired).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    value[Symbol.dispose]();
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

  it("fails closed before reads when the bound portal identity changes", async () => {
    const fetchMock = vi.fn(async () => json(crmRecord("101", {}))) as typeof fetch;
    const subject = session({
      fetch: fetchMock,
      assertExpectedHubId: async () => {
        throw new Error("HubSpot portal authority changed");
      },
    });

    await expect(subject.value.getContact("101")).rejects.toThrow(/authority/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(subject.authorize).not.toHaveBeenCalled();
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

});

describe("HubSpot approved CRM mutations", () => {
  it("validates malicious runtime inputs before persistence, submission, or fetch", async () => {
    const fetchMock = vi.fn(async () => json({})) as typeof fetch;
    const subject = session({ fetch: fetchMock });
    const invalidMutations = [
      () => subject.value.createContact({ phone: "123" }),
      () => subject.value.createContact({ email: "   " }),
      () => subject.value.createCompany({ phone: "123" }),
      () => subject.value.createCompany({ domain: "\t" }),
      () => subject.value.createDeal({ dealname: "Deal", pipeline: "default" }),
      () => subject.value.createDeal({
        dealname: "Deal",
        pipeline: "default",
        dealstage: " ",
      }),
      () => subject.value.updateContact("101", {}),
      () => subject.value.updateCompany("0", { name: "Company" }),
      () => subject.value.updateDeal(303 as never, { amount: "100" }),
      () => subject.value.updateContact("101", { custom: "secret" } as never),
      () => subject.value.updateCompany("202", { name: 42 } as never),
      () => subject.value.updateDeal("303", {
        description: "x".repeat(MAX_HUBSPOT_PROPERTY_VALUE_LENGTH + 1),
      }),
      () => subject.value.createContact(null as never),
      () => subject.value.getMutationResult(null as never),
    ];

    for (const mutate of invalidMutations) {
      await expect(Promise.resolve().then(mutate)).rejects.toThrow();
    }
    expect(subject.storage?.data.size).toBe(0);
    expect(subject.submit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(subject.authorize).not.toHaveBeenCalled();
  });

  it("submits all six explicit mutations with sequential tickets and exact safe metadata", async () => {
    const fetchMock = vi.fn(async () => json({})) as typeof fetch;
    const subject = session({ fetch: fetchMock });
    const unsafeValue = "Ada\n``` **admin** \u0000";

    const tickets = await Promise.all([
      subject.value.createContact({ email: unsafeValue, firstname: "Ada" }),
      subject.value.updateContact("101", { lastname: "Lovelace" }),
      subject.value.createCompany({ name: "Analytical Engines" }),
      subject.value.updateCompany("202", { domain: "analytical.example" }),
      subject.value.createDeal({
        dealname: "Renewal",
        pipeline: "default",
        dealstage: "appointmentscheduled",
      }),
      subject.value.updateDeal("303", { amount: "100" }),
    ]);

    expect(tickets).toEqual([
      { id: 1, objectType: "contact", operation: "create" },
      { id: 2, objectType: "contact", operation: "update" },
      { id: 3, objectType: "company", operation: "create" },
      { id: 4, objectType: "company", operation: "update" },
      { id: 5, objectType: "deal", operation: "create" },
      { id: 6, objectType: "deal", operation: "update" },
    ]);
    expect(subject.submit).toHaveBeenCalledTimes(6);
    for (let id = 1; id <= 6; id++) {
      expect(subject.storage?.data.get(`mutation:pending:${id}`)).toMatchObject({
        expectedHubId: PORTAL_ID,
      });
    }
    expect(subject.submit.mock.calls[0]).toEqual([1, {
      title: "Create HubSpot contact",
      description:
        "**Portal ID:** `24680`\n\n" +
        "**Object type:** `contact`\n\n" +
        "**Operation:** `create`\n\n" +
        "**Properties:**\n\n" +
        "    {\n" +
        `      "email": ${JSON.stringify(unsafeValue)},\n` +
        "      \"firstname\": \"Ada\"\n" +
        "    }",
      implementsRevert: false,
      awaitDecision: true,
    }]);
    expect(subject.submit.mock.calls[1]).toEqual([2, {
      title: "Update HubSpot contact 101",
      description:
        "**Portal ID:** `24680`\n\n" +
        "**Object type:** `contact`\n\n" +
        "**Operation:** `update`\n\n" +
        "**Record ID:** `101`\n\n" +
        "**Properties:**\n\n" +
        "    {\n" +
        "      \"lastname\": \"Lovelace\"\n" +
        "    }",
      implementsRevert: false,
      awaitDecision: true,
    }]);
    for (const [, description] of subject.submit.mock.calls) {
      expect(description).not.toHaveProperty("autoApprovable");
      expect(description).not.toHaveProperty("actionKind");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(subject.authorize).not.toHaveBeenCalled();
  });

  it("fails closed before persisting or submitting a mutation after portal identity changes", async () => {
    const subject = session({
      assertExpectedHubId: async () => {
        throw new Error("HubSpot portal authority changed");
      },
    });

    await expect(subject.value.createCompany({ name: "Private Company" })).rejects.toThrow(
      /authority/i,
    );
    expect(subject.storage?.data.size).toBe(0);
    expect(subject.submit).not.toHaveBeenCalled();
  });

  it("removes pending state when approval submission fails", async () => {
    const rejection = new Error("queue unavailable");
    const subject = session({ submit: vi.fn(async () => { throw rejection; }) });

    await expect(subject.value.createCompany({ name: "Private Company" })).rejects.toBe(rejection);

    expect([...subject.storage!.data.keys()]).toEqual(["mutation:nextId"]);
  });

  it("fails closed before mutation result lookup after portal identity changes", async () => {
    let matches = true;
    const subject = session({
      assertExpectedHubId: async () => {
        if (!matches) throw new Error("HubSpot portal authority changed");
      },
    });
    const ticket = await subject.value.createContact({ email: "person@example.com" });
    matches = false;

    await expect(subject.value.getMutationResult(ticket)).rejects.toThrow(/authority/i);
    expect(subject.authorize).not.toHaveBeenCalled();
  });

  it("rejects a pending mutation whose persisted portal authority changed", async () => {
    const subject = session();
    const ticket = await subject.value.createContact({ email: "person@example.com" });
    const key = `mutation:pending:${ticket.id}`;
    subject.storage!.data.set(key, {
      ...(subject.storage!.data.get(key) as object),
      expectedHubId: 99999,
    });

    await expect(subject.value.getMutationResult(ticket)).rejects.toThrow(/portal|authority/i);
    expect(subject.authorize).not.toHaveBeenCalled();
  });

  it("returns pending only after authorization and rejects unknown or mismatched tickets", async () => {
    const subject = session();
    const ticket = await subject.value.createContact({ email: "person@example.com" });

    await expect(subject.value.getMutationResult(ticket)).resolves.toEqual({ status: "pending" });
    expect(subject.authorize).toHaveBeenCalledWith({
      title: "Read HubSpot mutation result #1",
      description: "HubSpot contact create mutation #1 is **pending**.",
    });

    for (const invalid of [
      { ...ticket, objectType: "company" as const },
      { ...ticket, operation: "update" as const },
      { ...ticket, id: 2 },
      { ...ticket, id: 1.5 },
    ]) {
      await expect(subject.value.getMutationResult(invalid)).rejects.toThrow(/ticket|unknown|match|ID/i);
    }
    expect(subject.authorize).toHaveBeenCalledOnce();
  });

  it.each([
    ["contact", "create", undefined, { email: "person@example.com" }, "POST", "/crm/objects/2026-03/contacts"],
    ["contact", "update", "101", { firstname: "Ada" }, "PATCH", "/crm/objects/2026-03/contacts/101"],
    ["company", "create", undefined, { name: "Company" }, "POST", "/crm/objects/2026-03/companies"],
    ["company", "update", "202", { domain: "company.example" }, "PATCH", "/crm/objects/2026-03/companies/202"],
    ["deal", "create", undefined, {
      dealname: "Deal",
      pipeline: "default",
      dealstage: "appointmentscheduled",
    }, "POST", "/crm/objects/2026-03/deals"],
    ["deal", "update", "303", { amount: "100" }, "PATCH", "/crm/objects/2026-03/deals/303"],
  ] as const)(
    "applies one %s %s write to the curated route and stores the record ID",
    async (objectType, operation, recordId, properties, method, path) => {
      const submitted = session();
      const ticket = operation === "create"
        ? objectType === "contact"
          ? await submitted.value.createContact(properties)
          : objectType === "company"
          ? await submitted.value.createCompany(properties)
          : await submitted.value.createDeal(properties)
        : objectType === "contact"
        ? await submitted.value.updateContact(recordId!, properties)
        : objectType === "company"
        ? await submitted.value.updateCompany(recordId!, properties)
        : await submitted.value.updateDeal(recordId!, properties);
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(new URL(String(input)).pathname).toBe(path);
        expect(init?.method).toBe(method);
        expect(JSON.parse(init?.body as string)).toEqual({ properties });
        return json(crmRecord("909", properties));
      }) as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);
      const gatekeeper = testEnv.HUBSPOT_GATEKEEPER.getByName(`${objectType}-${operation}`);

      const stored = await runInDurableObject(gatekeeper, async (instance, state) => {
        for (const [key, value] of submitted.storage!.data) state.storage.kv.put(key, value);
        await instance.applyAction(ticket.id);
        return [...state.storage.kv.list()];
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const restored = mutationStorage();
      for (const [key, value] of stored) restored.kv.put(key, value);
      const reader = session({ mutationKv: restored.kv });
      await expect(reader.value.getMutationResult(ticket)).resolves.toEqual({
        status: "ready",
        objectType,
        recordId: "909",
      });
      expect(stored.some(([key]) => key === `mutation:pending:${ticket.id}`)).toBe(false);
    },
  );

  it("claims a pending mutation before remote I/O so concurrent approval delivery calls HubSpot once", async () => {
    const submitted = session();
    const ticket = await submitted.value.createCompany({ name: "Company" });
    const remote = deferred<Response>();
    const fetchMock = vi.fn(async () => remote.promise) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const gatekeeper = testEnv.HUBSPOT_GATEKEEPER.getByName("concurrent-apply");

    await runInDurableObject(gatekeeper, async (instance, state) => {
      for (const [key, value] of submitted.storage!.data) state.storage.kv.put(key, value);
      const first = instance.applyAction(ticket.id);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      expect(state.storage.kv.get(`mutation:pending:${ticket.id}`)).toMatchObject({
        id: ticket.id,
        applying: true,
      });
      const duplicate = expect(instance.applyAction(ticket.id)).rejects.toThrow(/active|applying/i);
      const rejection = expect(instance.rejectAction(ticket.id)).rejects.toThrow(/active|applying/i);
      await Promise.resolve();
      await Promise.resolve();
      remote.resolve(json(crmRecord("909", { name: "Company" })));
      await duplicate;
      await rejection;
      await expect(first).resolves.toBeUndefined();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed before applying a pending mutation for another portal", async () => {
    const submitted = session();
    const ticket = await submitted.value.createCompany({ name: "Company" });
    const fetchMock = vi.fn(async () => json(crmRecord("909", { name: "Company" }))) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const gatekeeper = testEnv.HUBSPOT_GATEKEEPER.getByName("identity-mismatch-apply");

    const stored = await runInDurableObject(gatekeeper, async (instance, state) => {
      for (const [key, value] of submitted.storage!.data) state.storage.kv.put(key, value);
      state.storage.kv.put("test:identityMismatch", true);
      await expect(instance.applyAction(ticket.id)).rejects.toThrow(/authority/i);
      return [...state.storage.kv.list()];
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored.some(([key]) => key === `mutation:pending:${ticket.id}`)).toBe(true);
    expect(stored.some(([key]) => key === `mutation:result:${ticket.id}`)).toBe(false);
  });

  it("records a redacted uncertain result, rejects apply, and never retries", async () => {
    const secret = "private-provider-response";
    const submitted = session();
    const ticket = await submitted.value.createContact({ email: "person@example.com" });
    const fetchMock = vi.fn(async () => { throw new Error(secret); }) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const gatekeeper = testEnv.HUBSPOT_GATEKEEPER.getByName("failed-create");

    const first = await runInDurableObject(gatekeeper, async (instance, state) => {
      for (const [key, value] of submitted.storage!.data) state.storage.kv.put(key, value);
      const error = await instance.applyAction(ticket.id).catch((caught: unknown) => caught as Error);
      expect(error.message).toMatch(/inspect/i);
      expect(error.message).not.toContain(secret);
      return [...state.storage.kv.list()];
    });
    await runInDurableObject(gatekeeper, async instance => {
      const error = await instance.applyAction(ticket.id).catch((caught: unknown) => caught as Error);
      expect(error.message).toMatch(/inspect/i);
      expect(error.message).not.toContain(secret);
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const restored = mutationStorage();
    for (const [key, value] of first) restored.kv.put(key, value);
    const reader = session({ mutationKv: restored.kv });
    const result = await reader.value.getMutationResult(ticket) as Extract<
      HubSpotMutationResult,
      { status: "uncertain" }
    >;
    expect(result.status).toBe("uncertain");
    expect(result.message.length).toBeLessThan(200);
    expect(result.message).not.toContain(secret);
  });

  it("best-effort notifies credential expiry before storing a safe CRM 401 result", async () => {
    const secret = "private-provider-response";
    const submitted = session();
    const ticket = await submitted.value.createContact({ email: "person@example.com" });
    const fetchMock = vi.fn(async () => json({ message: secret }, 401)) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const gatekeeper = testEnv.HUBSPOT_GATEKEEPER.getByName("expired-write");

    const stored = await runInDurableObject(gatekeeper, async (instance, state) => {
      for (const [key, value] of submitted.storage!.data) state.storage.kv.put(key, value);
      state.storage.kv.put("test:failNotification", true);
      await expect(instance.applyAction(ticket.id)).rejects.toThrow(/inspect/i);
      return [...state.storage.kv.list()];
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(stored).toContainEqual(["test:expiredCount", 1]);
    expect(stored).toContainEqual(["test:notifiedBeforeResult", true]);
    const restored = mutationStorage();
    for (const [key, value] of stored) restored.kv.put(key, value);
    const reader = session({ mutationKv: restored.kv });
    const result = await reader.value.getMutationResult(ticket) as Extract<
      HubSpotMutationResult,
      { status: "uncertain" }
    >;
    expect(result.status).toBe("uncertain");
    expect(result.message).toContain("credentials expired");
    expect(result.message).not.toContain(secret);
  });

  it("recovers stale applying state in a fresh instance without another write", async () => {
    const submitted = session();
    const ticket = await submitted.value.createCompany({ name: "Company" });
    const pendingKey = `mutation:pending:${ticket.id}`;
    const pending = submitted.storage!.data.get(pendingKey) as Record<string, unknown>;
    const fetchMock = vi.fn(async () => json(crmRecord("909", {}))) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    let gatekeeper = testEnv.HUBSPOT_GATEKEEPER.getByName("stale-fresh-apply");

    await runInDurableObject(gatekeeper, (_instance, state) => {
      for (const [key, value] of submitted.storage!.data) state.storage.kv.put(key, value);
      state.storage.kv.put(pendingKey, { ...pending, applying: true });
    });
    await abortAllDurableObjects();
    gatekeeper = testEnv.HUBSPOT_GATEKEEPER.getByName("stale-fresh-apply");
    const stored = await runInDurableObject(gatekeeper, async (instance, state) => {
      await expect(instance.applyAction(ticket.id)).rejects.toThrow(/outcome.*uncertain|inspect/i);
      await expect(instance.applyAction(ticket.id)).rejects.toThrow(/outcome.*uncertain|inspect/i);
      await expect(instance.rejectAction(ticket.id)).rejects.toThrow(/outcome.*uncertain|inspect/i);
      return [...state.storage.kv.list()];
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored.some(([key]) => key === pendingKey)).toBe(false);
    expect(stored).toContainEqual([
      `mutation:result:${ticket.id}`,
      expect.objectContaining({
        outcome: expect.objectContaining({
          status: "uncertain",
          message: expect.stringMatching(/inspect/i),
        }),
      }),
    ]);
  });

  it("recovers stale applying state during result lookup and rejection", async () => {
    const lookup = session();
    const lookupTicket = await lookup.value.createContact({ email: "person@example.com" });
    const lookupKey = `mutation:pending:${lookupTicket.id}`;
    lookup.storage!.data.set(lookupKey, {
      ...(lookup.storage!.data.get(lookupKey) as object),
      applying: true,
    });

    await expect(lookup.value.getMutationResult(lookupTicket)).resolves.toMatchObject({
      status: "uncertain",
      message: expect.stringMatching(/outcome.*uncertain|inspect/i),
    });
    expect(lookup.storage!.data.has(lookupKey)).toBe(false);

    const rejected = session();
    const rejectedTicket = await rejected.value.updateCompany("202", { name: "Company" });
    const rejectedKey = `mutation:pending:${rejectedTicket.id}`;
    const rejectedPending = rejected.storage!.data.get(rejectedKey) as object;
    const gatekeeper = testEnv.HUBSPOT_GATEKEEPER.getByName("stale-reject");
    const fetchMock = vi.fn(async () => json({})) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const stored = await runInDurableObject(gatekeeper, async (instance, state) => {
      for (const [key, value] of rejected.storage!.data) state.storage.kv.put(key, value);
      state.storage.kv.put(rejectedKey, { ...rejectedPending, applying: true });
      await expect(instance.rejectAction(rejectedTicket.id)).rejects.toThrow(
        /outcome.*uncertain|inspect/i,
      );
      return [...state.storage.kv.list()];
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored.some(([key]) => key === rejectedKey)).toBe(false);
    expect(stored).toContainEqual([
      `mutation:result:${rejectedTicket.id}`,
      expect.objectContaining({ outcome: expect.objectContaining({ status: "uncertain" }) }),
    ]);
  });

  it("rejects a pending mutation without a fetch and stores a rejected result", async () => {
    const submitted = session();
    const ticket = await submitted.value.updateCompany("202", { name: "New Name" });
    const fetchMock = vi.fn(async () => json({})) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const gatekeeper = testEnv.HUBSPOT_GATEKEEPER.getByName("rejected-update");

    const stored = await runInDurableObject(gatekeeper, async (instance, state) => {
      for (const [key, value] of submitted.storage!.data) state.storage.kv.put(key, value);
      await instance.rejectAction(ticket.id);
      await expect(instance.rejectAction(999)).rejects.toThrow(/unknown/i);
      return [...state.storage.kv.list()];
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const restored = mutationStorage();
    for (const [key, value] of stored) restored.kv.put(key, value);
    const reader = session({ mutationKv: restored.kv });
    await expect(reader.value.getMutationResult(ticket)).resolves.toEqual({ status: "rejected" });
  });

  it("never reverts remotely and returns manual remediation guidance", async () => {
    const fetchMock = vi.fn(async () => json({})) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const gatekeeper = testEnv.HUBSPOT_GATEKEEPER.getByName("manual-revert");

    await expect(gatekeeper.revertAction(1)).resolves.toEqual({
      message:
        "HubSpot CRM mutations cannot be reverted automatically. Review the record in HubSpot " +
        "and apply any needed correction manually.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
