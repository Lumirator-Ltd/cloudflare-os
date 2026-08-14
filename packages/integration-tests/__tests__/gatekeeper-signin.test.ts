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
    await setLoginEmail(email);

    using publicApi = connect(harness.url) as RpcStub<PublicApi>;
    const login = await publicApi.startGatekeeperLogin(CLOUDFLARE_VENDOR_ID);
    using attempt = login.attempt;
    const token = await attempt.wait();
    using api = await publicApi.authenticate(token);

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
});
