import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
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

async function setLoginEmail(email: string): Promise<void> {
  const response = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/gatekeeper-login-email",
    { method: "POST", body: JSON.stringify({ email }) },
  );
  if (!response.ok) throw new Error(`failed to configure login email: ${await response.text()}`);
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
    await setLoginEmail(email);

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

  it("keys Gatekeeper users by exact authenticated email", async () => {
    const firstEmail = `first-${crypto.randomUUID()}@example.com`;
    const movedEmail = `moved-${crypto.randomUUID()}@example.com`;

    await setLoginEmail(firstEmail);
    const first = await login(CLOUDFLARE_VENDOR_ID);
    using firstPublic = first.publicApi;
    using firstApi = await firstPublic.authenticate(first.token);
    await firstApi.setOwnDisplayName("Customized first profile");

    await setLoginEmail(movedEmail);
    const moved = await login(CLOUDFLARE_VENDOR_ID);
    using movedPublic = moved.publicApi;
    using movedApi = await movedPublic.authenticate(moved.token);
    await expect(movedApi.whoami()).resolves.toMatchObject({
      id: movedEmail,
      name: movedEmail.split("@")[0],
    });

    await setLoginEmail(firstEmail);
    const returned = await login(CLOUDFLARE_VENDOR_ID);
    using returnedPublic = returned.publicApi;
    using returnedApi = await returnedPublic.authenticate(returned.token);
    await expect(returnedApi.whoami()).resolves.toMatchObject({
      id: firstEmail,
      name: "Customized first profile",
    });
  });

});
