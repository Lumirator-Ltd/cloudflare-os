import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RpcStub, RpcTarget } from "capnweb";
import type {
  AdminApi, AuthenticatedApi, ClerkAuthentication, ConnectedAccountsSubscriber, PublicApi,
} from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  callbackStubFor, connect, listConnectedAccounts, ObserverConfigRecorder, stubFor, waitFor,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

const FRONTEND_API = "task5.clerk.accounts.dev";
const PUBLISHABLE_KEY = `pk_test_${Buffer.from(`${FRONTEND_API}$`).toString("base64url")}`;
const AUTHORIZED_PARTY = "https://workshop.test";
const ISSUER = `https://${FRONTEND_API}`;
const SECRET_KEY = "sk_test_task5_fixture";
const KEY_ID = "task5-integration-key";
const PRIMARY_SUBJECT = "user_task5_primary";
const OLD_EMAIL = "clerk-admin-old@example.com";
const MOVE_EMAIL = "clerk-admin-move@example.com";
const GRAPH_EMAIL = "clerk-admin-graph@example.com";
const NEW_EMAIL = "clerk-admin-new@example.com";
const RESOURCE_PATTERN = "https://gadgets-test.example/things/*";
const RESOURCE_URL = "https://gadgets-test.example/things/session-capability";
const CLERK_TEST_SERVER = fileURLToPath(new URL(
  "../../workshop-backend/.wrangler/validate/src/testing/clerk-test-server.ts",
  import.meta.url,
).href);

let harness: Harness;
let interceptor: NetworkInterceptor;
let privateKey: KeyObject;
let publicKeyPem: string;

function sessionIdFor(subject: string): string {
  return `sess_${subject.slice("user_".length)}`;
}

async function setClerkProfile(subject: string, email: string, status = "active"): Promise<void> {
  const response = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/clerk-profile",
    { method: "POST", body: JSON.stringify({ subject, email, status }) },
  );
  if (!response.ok) throw new Error(`failed to configure Clerk profile: ${await response.text()}`);
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function signToken(options: {
  subject?: string;
  expiresInSeconds: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const subject = options.subject ?? PRIMARY_SUBJECT;
  const sessionId = sessionIdFor(subject);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const expiresAt = new Date((issuedAt + options.expiresInSeconds) * 1_000);

  const header = encodeJwtPart({ alg: "RS256", kid: KEY_ID, typ: "JWT" });
  const payload = encodeJwtPart({
    iss: ISSUER,
    sub: subject,
    sid: sessionId,
    sts: "active",
    azp: AUTHORIZED_PARTY,
    iat: issuedAt - 10,
    nbf: issuedAt - 15,
    exp: Math.floor(expiresAt.getTime() / 1_000),
  });
  const unsigned = `${header}.${payload}`;
  const signature = Buffer.from(
    sign("RSA-SHA256", Buffer.from(unsigned), privateKey),
  ).toString("base64url");
  return { token: `${unsigned}.${signature}`, expiresAt };
}

async function authenticate(
    publicApi: RpcStub<PublicApi>, token: string): Promise<ClerkAuthentication> {
  return await publicApi.authenticateWithClerk(token);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitPast(date: Date): Promise<void> {
  await delay(Math.max(0, date.getTime() - Date.now()) + 100);
}

async function provisionTestAccount(api: RpcStub<AuthenticatedApi>) {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return await waitFor("the fixture account", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(account => account.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

class RetainedSubscriber extends ObserverConfigRecorder implements ConnectedAccountsSubscriber {
  add(): void {}
  remove(): void {}
  ready(): void {}
  init(): void {}
  entry(): void {}
  removed(): void {}
  update(): void {}
  streamGeneration(): void {}
  metadata(): void {}
  deleted(): void {}
  message(): void {}
  draftUpdate(): void {}
  draftCleared(): void {}
  stream(): void {}
  async event(): Promise<void> {}
}

type PingTarget = RpcTarget & { ping(): Promise<string> };

beforeAll(async () => {
  // The harness cannot intercept Clerk SDK runtime fetches (see task report), so this separate
  // test-only server entry uses the actual Clerk verifier with a local public key and profile RPC.
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startTestGatekeeperHarness({
    enableWorkerLoader: true,
    patchWorkshop(config) {
      config.main = CLERK_TEST_SERVER;
      config.services!.push({
        binding: "TEST_CLERK_PROFILES",
        service: TEST_GATEKEEPER_WORKER,
        entrypoint: "ClerkTestProfiles",
      });
      config.vars = {
        ...config.vars,
        CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
        CLERK_SECRET_KEY: SECRET_KEY,
        CLERK_JWT_KEY: publicKeyPem,
        PUBLIC_BASE_URL: AUTHORIZED_PARTY,
        DEV: true,
        ADMINS: [OLD_EMAIL, MOVE_EMAIL, GRAPH_EMAIL],
      };
    },
  });
});

beforeEach(async () => {
  await setClerkProfile(PRIMARY_SUBJECT, OLD_EMAIL);
});

afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  // The local-key test entry must make no Clerk, telemetry, or other outbound network calls.
  expect(unmocked).toEqual([]);
});

describe.sequential("Clerk WebSocket sessions", () => {
  it("hard-closes the real Cap'n Web socket at the exact accepted token expiry", async () => {
    using publicApi = connect(harness.url);
    const accepted = await signToken({ expiresInSeconds: 3 });
    const auth = await authenticate(publicApi, accepted.token);
    using api = auth.api;
    using session = auth.session;

    expect(auth.expiresAt).toEqual(accepted.expiresAt);
    await expect(api.whoami()).resolves.toMatchObject({ type: "user" });
    await waitPast(accepted.expiresAt);
    await expect(api.whoami()).rejects.toThrow();
    await expect(session.refresh(accepted.token)).rejects.toThrow();
    await expect(publicApi.getServerConfig()).rejects.toThrow();
  });

  it("successful refresh replaces the old deadline with the exact new verified expiry", async () => {
    using publicApi = connect(harness.url);
    const initial = await signToken({ expiresInSeconds: 3 });
    const auth = await authenticate(publicApi, initial.token);
    using api = auth.api;
    using session = auth.session;
    const replacement = await signToken({ expiresInSeconds: 6 });

    await expect(session.refresh(replacement.token)).resolves.toEqual(replacement.expiresAt);
    await waitPast(initial.expiresAt);
    await expect(api.whoami()).resolves.toMatchObject({ type: "user" });
    await waitPast(replacement.expiresAt);
    await expect(api.whoami()).rejects.toThrow();
  });

  it("rejects duplicate Clerk authentication without changing the first lifecycle", async () => {
    using publicApi = connect(harness.url);
    const initial = await signToken({ expiresInSeconds: 3 });
    const auth = await authenticate(publicApi, initial.token);
    using api = auth.api;
    using _session = auth.session;
    const longer = await signToken({ expiresInSeconds: 30 });

    await expect(authenticate(publicApi, initial.token)).rejects.toThrow(/already authenticated/i);
    await expect(authenticate(publicApi, longer.token)).rejects.toThrow(/already authenticated/i);
    await expect(api.whoami()).resolves.toMatchObject({ type: "user" });
    await waitPast(initial.expiresAt);
    await expect(api.whoami()).rejects.toThrow();
  });

  it("invalid refresh aborts the whole socket immediately", async () => {
    using publicApi = connect(harness.url);
    const initial = await signToken({ expiresInSeconds: 30 });
    const auth = await authenticate(publicApi, initial.token);
    using api = auth.api;
    using session = auth.session;
    const otherSubject = "user_task5_other";
    await setClerkProfile(otherSubject, "other@example.com");
    const other = await signToken({ subject: otherSubject, expiresInSeconds: 30 });

    await expect(session.refresh(other.token)).rejects.toThrow();
    await expect(api.whoami()).rejects.toThrow();
  });

  it("inactive replacement session status aborts the whole socket immediately", async () => {
    using publicApi = connect(harness.url);
    const initial = await signToken({ expiresInSeconds: 30 });
    const auth = await authenticate(publicApi, initial.token);
    using api = auth.api;
    using session = auth.session;
    await setClerkProfile(PRIMARY_SUBJECT, OLD_EMAIL, "revoked");
    const inactive = await signToken({ expiresInSeconds: 30 });

    await expect(session.refresh(inactive.token)).rejects.toThrow();
    await expect(api.whoami()).rejects.toThrow();
  });

  it("explicit logout aborts all siblings, while dropping only session control does not", async () => {
    using firstPublicApi = connect(harness.url);
    const firstToken = await signToken({ expiresInSeconds: 30 });
    const first = await authenticate(firstPublicApi, firstToken.token);
    using firstApi = first.api;
    first.session[Symbol.dispose]();
    await expect(firstApi.whoami()).resolves.toMatchObject({ type: "user" });

    using secondPublicApi = connect(harness.url);
    const secondToken = await signToken({ expiresInSeconds: 30 });
    const second = await authenticate(secondPublicApi, secondToken.token);
    using secondApi = second.api;
    using secondSession = second.session;
    await expect(secondSession.logout()).rejects.toThrow();
    await expect(secondApi.whoami()).rejects.toThrow();
  });

  it("rejects an initiating refresh whose current Clerk email changes and kills its graph",
      async () => {
    const subject = "user_task5_email_move";
    await setClerkProfile(subject, MOVE_EMAIL);
    using publicApi = connect(harness.url);
    const initial = await signToken({ subject, expiresInSeconds: 30 });
    const auth = await authenticate(publicApi, initial.token);
    using api = auth.api;
    using session = auth.session;
    const originalProfile = await api.whoami();
    const adminResult = await api.getAdminApi();
    if (!adminResult) throw new Error("old exact admin email did not receive AdminApi");
    using admin = adminResult;
    using overseer = await api.newGadget();
    using gadget = await overseer.createGadget("Task 5 changed authority", undefined, "TASK5_AUTH");
    await expect(admin.getSettings()).resolves.toBeDefined();
    await expect(overseer.getMetadata()).resolves.toBeDefined();
    await expect(gadget.getTitle()).resolves.toBeTypeOf("string");

    // Email comes only from the current Backend API profile; the signed JWT carries no email claim.
    await setClerkProfile(subject, NEW_EMAIL);
    const replacement = await signToken({ subject, expiresInSeconds: 30 });
    await expect(session.refresh(replacement.token)).rejects.toThrow();
    await expect(api.whoami()).rejects.toThrow();
    await expect(admin.getSettings()).rejects.toThrow();
    await expect(overseer.getMetadata()).rejects.toThrow();
    await expect(gadget.getTitle()).rejects.toThrow();
    await expect(publicApi.getServerConfig()).rejects.toThrow();

    using reconnectedPublic = connect(harness.url);
    const reconnected = await authenticate(reconnectedPublic, replacement.token);
    using reconnectedApi = reconnected.api;
    using _reconnectedSession = reconnected.session;
    await expect(reconnectedApi.whoami()).resolves.toMatchObject({ id: originalProfile.id });
    await expect(reconnectedApi.amIAdmin()).resolves.toBe(false);
    await expect(reconnectedApi.getAdminApi()).resolves.toBeNull();
  });

  it("invalidates retained cross-worker, UI-child, subscription, and workspace descendants together",
      async () => {
    using publicApi = connect(harness.url);
    const graphSubject = "user_task5_graph";
    await setClerkProfile(graphSubject, GRAPH_EMAIL);
    const accepted = await signToken({ subject: graphSubject, expiresInSeconds: 15 });
    const auth = await authenticate(publicApi, accepted.token);
    using api = auth.api;
    using _session = auth.session;
    using admin = await api.getAdminApi() as RpcStub<AdminApi>;
    const account = await provisionTestAccount(api);

    const configurator = await api.startResourceConfigurator(account.id, RESOURCE_PATTERN);
    using configuratorUi = configurator.ui as unknown as RpcStub<PingTarget>;
    const app = await api.getGatekeeperApp(TEST_VENDOR_ID);
    if (!app) throw new Error("fixture app UI was not returned");
    using appUi = app.ui as unknown as RpcStub<PingTarget>;

    using overseer = await api.newGadget();
    const metadata = await overseer.getMetadata();
    using gadget = await overseer.createGadget("Task 5 graph gadget", undefined, "TASK5_GRAPH");
    using dynamicGadget = await gadget.connectToGadget();
    let resolveDynamicBreak!: () => void;
    const dynamicBreak = new Promise<void>(resolve => { resolveDynamicBreak = resolve; });
    dynamicGadget.onRpcBroken(() => resolveDynamicBreak());
    using gatekeeper = await overseer.newGatekeeper(account.id, RESOURCE_URL);
    if (!gatekeeper) throw new Error("fixture gatekeeper was not created");
    await gadget.bind("TEST_THING", await gatekeeper.getId());
    using boundGatekeeper = await gadget.getBinding("TEST_THING");
    if (!boundGatekeeper) throw new Error("fixture binding was not returned");
    using gatekeeperSession = await boundGatekeeper.openSession() as RpcStub<PingTarget>;

    using callback = stubFor(new RetainedSubscriber());
    using connectedSubscription = await api.subscribeConnectedAccounts(callback);
    using presenceSubscription = await overseer.subscribeToPresence(callback);
    using workpiecesSubscription = await overseer.subscribeToWorkpieces(callback);
    using codeSubscription = await overseer.subscribeToCode(callback);
    using actionSubscription = await overseer.subscribeToActions(callback);
    using chatSubscription = await overseer.subscribeToChat(callback);
    using logSubscription = await overseer.subscribeToConsoleLogs(callback);
    using metadataCallback = callbackStubFor((_metadata: unknown) => {});
    using metadataSubscription = await overseer.subscribeToMetadata(metadataCallback);
    const subscriptionBreaks = [
      connectedSubscription, presenceSubscription, workpiecesSubscription, codeSubscription,
      actionSubscription, chatSubscription, logSubscription, metadataSubscription,
    ].map(stub => {
      let resolveBroken!: () => void;
      const broken = new Promise<void>(resolve => { resolveBroken = resolve; });
      stub.onRpcBroken(() => resolveBroken());
      return broken;
    });

    await expect(admin.getSettings()).resolves.toBeDefined();
    await expect(overseer.getMetadata()).resolves.toMatchObject({ id: metadata.id });
    await expect(gadget.getTitle()).resolves.toBeTypeOf("string");
    await expect(gatekeeper.describe()).resolves.toMatchObject({ title: expect.any(String) });
    await expect(boundGatekeeper.describe()).resolves.toMatchObject({ title: expect.any(String) });
    await expect(gatekeeperSession.ping()).resolves.toBe("gatekeeper-session");
    await expect(configuratorUi.ping()).resolves.toBe(`configurator:${RESOURCE_PATTERN}`);
    await expect(appUi.ping()).resolves.toBe("app:admin");

    await waitPast(accepted.expiresAt);
    await expect(Promise.all([...subscriptionBreaks, dynamicBreak]))
      .resolves.toHaveLength(subscriptionBreaks.length + 1);
    await expect(admin.getSettings()).rejects.toThrow();
    await expect(overseer.getMetadata()).rejects.toThrow();
    await expect(gadget.getTitle()).rejects.toThrow();
    await expect(gatekeeper.describe()).rejects.toThrow();
    await expect(boundGatekeeper.describe()).rejects.toThrow();
    await expect(gatekeeperSession.ping()).rejects.toThrow();
    await expect(configuratorUi.ping()).rejects.toThrow();
    await expect(appUi.ping()).rejects.toThrow();
  }, 30_000);
});
