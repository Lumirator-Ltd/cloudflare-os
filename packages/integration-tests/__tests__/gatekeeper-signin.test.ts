import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import {
  GATEKEEPER_SESSION_LOGOUT_PATH,
  type PublicApi,
} from "@gadgets/workshop-shared/api";
import {
  startHarness, TEST_GATEKEEPER_DIR, TEST_GATEKEEPER_WORKER, type Harness,
} from "../src/harness.js";
import { connect, listConnectedAccounts } from "../src/rpc-client.js";

const CLOUDFLARE_VENDOR_ID = "cloudflare";

let harness: Harness;

async function connectScopes(): Promise<Array<"auth" | "full">> {
  const response = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/connect-scopes",
  );
  if (!response.ok) throw new Error(`failed to read connect scopes: ${await response.text()}`);
  return (await response.json() as { scopes: Array<"auth" | "full"> }).scopes;
}

async function setLoginIdentity(
    subject: string, email: string, expiresAt?: Date): Promise<void> {
  const response = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/gatekeeper-login-email",
    { method: "POST", body: JSON.stringify({ subject, email, expiresAt }) },
  );
  if (!response.ok) throw new Error(`failed to configure login identity: ${await response.text()}`);
}

async function login(vendorId: string): Promise<{
  publicApi: RpcStub<PublicApi>;
  token: string;
}> {
  const publicApi = connect(harness.url) as RpcStub<PublicApi>;
  const started = await publicApi.startGatekeeperLogin(vendorId);
  using attempt = started.attempt;
  return { publicApi, token: await attempt.wait() };
}

async function logoutGatekeeperSession(token: string): Promise<Response> {
  const origin = new URL(harness.url).origin;
  return await fetch(new URL(GATEKEEPER_SESSION_LOGOUT_PATH, origin), {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

beforeAll(async () => {
  harness = await startHarness({
    gatekeepers: [{ binding: "CLOUDFLARE", dir: TEST_GATEKEEPER_DIR }],
    patchWorkshop(config) {
      config.vars = { ...config.vars, AUTH_GATEKEEPERS: CLOUDFLARE_VENDOR_ID };
    },
  });
});

afterAll(async () => {
  await harness?.server.close();
});

describe("Cloudflare Gatekeeper sign-in", () => {
  it("requests full Cloudflare scope and persists the billing connection during sign-in", async () => {
    const email = `cloudflare-signin-${crypto.randomUUID()}@example.com`;
    await setLoginIdentity(`cloudflare-subject-${crypto.randomUUID()}`, email);

    const signedIn = await login(CLOUDFLARE_VENDOR_ID);
    using publicApi = signedIn.publicApi;
    using api = await publicApi.authenticate(signedIn.token);

    expect(await connectScopes()).toEqual(["full"]);
    expect(await listConnectedAccounts(api)).toEqual([
      expect.objectContaining({
        vendorId: CLOUDFLARE_VENDOR_ID,
        description: expect.objectContaining({ uniqueName: email }),
      }),
    ]);
  });

  it("keys Gatekeeper users by exact authenticated email rather than provider subject", async () => {
    const subject = `stable-provider-subject-${crypto.randomUUID()}`;
    const firstEmail = `first-${crypto.randomUUID()}@example.com`;
    const movedEmail = `moved-${crypto.randomUUID()}@example.com`;

    await setLoginIdentity(subject, firstEmail);
    const first = await login(CLOUDFLARE_VENDOR_ID);
    using firstPublic = first.publicApi;
    using firstApi = await firstPublic.authenticate(first.token);
    await firstApi.setOwnDisplayName("Customized first profile");

    await setLoginIdentity(subject, movedEmail);
    const moved = await login(CLOUDFLARE_VENDOR_ID);
    using movedPublic = moved.publicApi;
    using movedApi = await movedPublic.authenticate(moved.token);
    await expect(movedApi.whoami()).resolves.toMatchObject({
      id: movedEmail,
      name: movedEmail.split("@")[0],
    });

    await setLoginIdentity(`recycled-subject-${crypto.randomUUID()}`, firstEmail);
    const returned = await login(CLOUDFLARE_VENDOR_ID);
    using returnedPublic = returned.publicApi;
    using returnedApi = await returnedPublic.authenticate(returned.token);
    await expect(returnedApi.whoami()).resolves.toMatchObject({
      id: firstEmail,
      name: "Customized first profile",
    });
  });

  it("keeps the temporary internal-id logout path isolated from email-keyed sessions", async () => {
    const ownerEmail = `logout-owner-${crypto.randomUUID()}@example.com`;
    await setLoginIdentity(`logout-owner-subject-${crypto.randomUUID()}`, ownerEmail);
    const owner = await login(CLOUDFLARE_VENDOR_ID);
    using firstPublic = owner.publicApi;
    using firstApi = await firstPublic.authenticate(owner.token);

    const otherEmail = `logout-other-${crypto.randomUUID()}@example.com`;
    await setLoginIdentity(`logout-other-subject-${crypto.randomUUID()}`, otherEmail);
    const other = await login(CLOUDFLARE_VENDOR_ID);
    using otherPublic = other.publicApi;
    using otherApi = await otherPublic.authenticate(other.token);

    const response = await logoutGatekeeperSession(owner.token);
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();

    using replayPublic = connect(harness.url) as RpcStub<PublicApi>;
    using replayApi = await replayPublic.authenticate(owner.token);
    await expect(replayApi.whoami()).resolves.toMatchObject({ name: ownerEmail.split("@")[0] });
    await expect(firstApi.whoami()).resolves.toMatchObject({ name: ownerEmail.split("@")[0] });
    await expect(otherApi.whoami()).resolves.toMatchObject({ name: otherEmail.split("@")[0] });
  });

  it("keeps the generic local session independent of provider expiry", async () => {
    const expiresAt = new Date(Date.now() + 1_000);
    await setLoginIdentity(
      `expiring-subject-${crypto.randomUUID()}`,
      `expiring-${crypto.randomUUID()}@example.com`,
      expiresAt,
    );
    const signedIn = await login(CLOUDFLARE_VENDOR_ID);
    using publicApi = signedIn.publicApi;
    using api = await publicApi.authenticate(signedIn.token);
    await expect(api.whoami()).resolves.toBeDefined();

    await new Promise(resolve =>
      setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 100)));
    await expect(api.whoami()).resolves.toBeDefined();
  });
});
