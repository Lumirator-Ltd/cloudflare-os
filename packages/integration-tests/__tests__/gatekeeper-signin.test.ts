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
  it("uses transient auth scope while explicit connection uses full scope and persists", async () => {
    const email = `cloudflare-signin-${crypto.randomUUID()}@example.com`;
    await setLoginIdentity(`cloudflare-subject-${crypto.randomUUID()}`, email);

    const signedIn = await login(CLOUDFLARE_VENDOR_ID);
    using publicApi = signedIn.publicApi;
    using api = await publicApi.authenticate(signedIn.token);

    expect(await connectScopes()).toEqual(["auth"]);
    expect(await listConnectedAccounts(api)).toEqual([]);

    await expect(api.connectAccount(CLOUDFLARE_VENDOR_ID)).resolves.toEqual({
      url: "https://gadgets-test.example/oauth/test-login",
    });

    expect(await connectScopes()).toEqual(["auth", "full"]);
    expect(await listConnectedAccounts(api)).toEqual([
      expect.objectContaining({
        vendorId: CLOUDFLARE_VENDOR_ID,
        description: expect.objectContaining({ uniqueName: email }),
      }),
    ]);
  });

  it("keeps one vendor subject stable across email moves and denies a recycled old email", async () => {
    const subject = `stable-provider-subject-${crypto.randomUUID()}`;
    const firstEmail = `first-${crypto.randomUUID()}@example.com`;
    const movedEmail = `moved-${crypto.randomUUID()}@example.com`;

    await setLoginIdentity(subject, firstEmail);
    const first = await login(CLOUDFLARE_VENDOR_ID);
    using firstPublic = first.publicApi;
    using firstApi = await firstPublic.authenticate(first.token);
    const internalUserId = (await firstApi.whoami()).id;

    await setLoginIdentity(subject, movedEmail);
    const moved = await login(CLOUDFLARE_VENDOR_ID);
    using movedPublic = moved.publicApi;
    using movedApi = await movedPublic.authenticate(moved.token);
    expect((await movedApi.whoami()).id).toBe(internalUserId);

    await setLoginIdentity(`recycled-subject-${crypto.randomUUID()}`, firstEmail);
    using recycledPublic = connect(harness.url) as RpcStub<PublicApi>;
    const recycledLogin = await recycledPublic.startGatekeeperLogin(CLOUDFLARE_VENDOR_ID);
    using recycledAttempt = recycledLogin.attempt;
    await expect(recycledAttempt.wait())
      .rejects.toThrow(/explicit linking|operator resolution/i);

    await setLoginIdentity(subject, firstEmail);
    const returned = await login(CLOUDFLARE_VENDOR_ID);
    using returnedPublic = returned.publicApi;
    using returnedApi = await returnedPublic.authenticate(returned.token);
    expect((await returnedApi.whoami()).id).toBe(internalUserId);
  });

  it("revokes one local bearer across sibling sockets without affecting another user", async () => {
    const ownerEmail = `logout-owner-${crypto.randomUUID()}@example.com`;
    await setLoginIdentity(`logout-owner-subject-${crypto.randomUUID()}`, ownerEmail);
    const owner = await login(CLOUDFLARE_VENDOR_ID);
    using firstPublic = owner.publicApi;
    using firstApi = await firstPublic.authenticate(owner.token);
    using siblingPublic = connect(harness.url) as RpcStub<PublicApi>;
    using siblingApi = await siblingPublic.authenticate(owner.token);

    const otherEmail = `logout-other-${crypto.randomUUID()}@example.com`;
    await setLoginIdentity(`logout-other-subject-${crypto.randomUUID()}`, otherEmail);
    const other = await login(CLOUDFLARE_VENDOR_ID);
    using otherPublic = other.publicApi;
    using otherApi = await otherPublic.authenticate(other.token);

    const response = await logoutGatekeeperSession(owner.token);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();

    using replayPublic = connect(harness.url) as RpcStub<PublicApi>;
    await expect(replayPublic.authenticate(owner.token)).rejects.toThrow(/invalid session token/i);
    await expect(siblingApi.whoami()).rejects.toThrow();
    await expect(firstApi.whoami()).rejects.toThrow();
    await expect(otherApi.whoami()).resolves.toMatchObject({ name: otherEmail.split("@")[0] });
    await expect(logoutGatekeeperSession(owner.token)).resolves.toMatchObject({ status: 204 });
  });

  it("breaks a real retained capability graph at the provider's earlier expiry", async () => {
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
    await expect(api.whoami()).rejects.toThrow();
  });
});
