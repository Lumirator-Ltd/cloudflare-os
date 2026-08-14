import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AdminApi, ClerkAuthentication, PublicApi,
} from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { connect, connectBatch, waitFor } from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

const CLERK_FRONTEND_API = "task6.clerk.accounts.dev";
const CLERK_PUBLISHABLE_KEY =
  `pk_test_${Buffer.from(`${CLERK_FRONTEND_API}$`).toString("base64url")}`;
const CLERK_SECRET_KEY = "sk_test_task6_fixture";
const CLERK_ISSUER = `https://${CLERK_FRONTEND_API}`;
const CLERK_AUTHORIZED_PARTY = "https://workshop.test";
const CLERK_KEY_ID = "task6-clerk-key";
const ACCESS_ISSUER = "https://task6.cloudflareaccess.test";
const ACCESS_AUDIENCE = "task6-access-audience";
const ACCESS_KEY_ID = "task6-access-key";
const CLERK_TEST_SERVER = fileURLToPath(new URL(
  "../../workshop-backend/.wrangler/validate/src/testing/clerk-test-server.ts",
  import.meta.url,
).href);

let harness: Harness;
let interceptor: NetworkInterceptor;
let clerkPrivateKey: KeyObject;
let clerkPublicKeyPem: string;
let accessPrivateKey: KeyObject;
let accessPublicJwk: Record<string, unknown>;
const sensitiveValues = new Set<string>([CLERK_SECRET_KEY]);
let cleanupFixture: { email: string; token: string } | undefined;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(header: object, payload: object, privateKey: KeyObject): string {
  const unsigned = `${encodeJwtPart(header)}.${encodeJwtPart(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function clerkToken(subject: string, expiresInSeconds = 120): string {
  const now = Math.floor(Date.now() / 1_000);
  const token = signJwt(
    { alg: "RS256", kid: CLERK_KEY_ID, typ: "JWT" },
    {
      iss: CLERK_ISSUER,
      sub: subject,
      sid: `sess_${subject.slice("user_".length)}`,
      sts: "active",
      azp: CLERK_AUTHORIZED_PARTY,
      iat: now - 10,
      nbf: now - 15,
      exp: now + expiresInSeconds,
    },
    clerkPrivateKey,
  );
  sensitiveValues.add(token);
  return token;
}

function accessToken(
    email: string,
    expiresInSeconds = 120,
    subject = `access-${crypto.randomUUID()}`): string {
  sensitiveValues.add(email);
  const now = Math.floor(Date.now() / 1_000);
  const token = signJwt(
    { alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" },
    {
      iss: ACCESS_ISSUER,
      aud: ACCESS_AUDIENCE,
      sub: subject,
      email,
      iat: now - 10,
      nbf: now - 15,
      exp: now + expiresInSeconds,
    },
    accessPrivateKey,
  );
  sensitiveValues.add(token);
  return token;
}

async function setClerkProfile(subject: string, email: string, status = "active"): Promise<void> {
  sensitiveValues.add(email);
  const response = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/clerk-profile",
    { method: "POST", body: JSON.stringify({ subject, email, status }) },
  );
  if (!response.ok) throw new Error(`failed to configure Clerk profile: ${await response.text()}`);
}

async function setGatekeeperLoginEmail(email: string): Promise<void> {
  sensitiveValues.add(email);
  const response = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/gatekeeper-login-email",
    { method: "POST", body: JSON.stringify({ email }) },
  );
  if (!response.ok) {
    throw new Error(`failed to configure Gatekeeper login: ${await response.text()}`);
  }
}

async function authenticateWithClerk(
    publicApi: RpcStub<PublicApi>, subject: string, email: string): Promise<ClerkAuthentication> {
  await setClerkProfile(subject, email);
  return await publicApi.authenticateWithClerk(clerkToken(subject));
}

async function loginWithGatekeeper(publicApi: RpcStub<PublicApi>, email: string): Promise<string> {
  await setGatekeeperLoginEmail(email);
  const login = await publicApi.startGatekeeperLogin(TEST_VENDOR_ID);
  using attempt = login.attempt;
  expect(login.url).toContain("/oauth/test-login");
  const token = await attempt.wait();
  sensitiveValues.add(token);
  return token;
}

function accessBatch(token: string, origin = harness.url.origin): RpcStub<PublicApi> {
  const request = new Request(new URL("/api", harness.url), {
    headers: {
      Origin: origin,
      "cf-access-jwt-assertion": token,
    },
  });
  return connectBatch(request);
}

async function configureWorkshop(admins: string[], access = false): Promise<void> {
  await harness.updateWorkshop(config => {
    config.vars = {
      AUTH_GATEKEEPERS: TEST_VENDOR_ID,
      CLERK_PUBLISHABLE_KEY,
      CLERK_SECRET_KEY,
      CLERK_JWT_KEY: clerkPublicKeyPem,
      PUBLIC_BASE_URL: CLERK_AUTHORIZED_PARTY,
      DEV: true,
      ADMINS: admins,
      ...(access ? { CF_ACCESS_AUD: ACCESS_AUDIENCE, CF_ACCESS_ISS: ACCESS_ISSUER } : {}),
    };
  });
  await waitFor("the updated Workshop isolate to accept requests", async () => {
    const response = await harness.server.fetch("/api", {
      headers: access ? { Origin: harness.url.origin } : undefined,
    });
    return response.status === (access ? 403 : 400) ? true : null;
  });
}

type Scenario = {
  adminEmail: string;
  adminSubject: string;
  adminToken: string;
  internalUserId: string;
};

async function setupScenario(prefix: string): Promise<Scenario> {
  const adminEmail = uniqueEmail(`${prefix}-admin`);
  const cleanupEmail = uniqueEmail(`${prefix}-cleanup`);
  const adminSubject = `user_${prefix}_${crypto.randomUUID()}`;
  await configureWorkshop([adminEmail, cleanupEmail]);

  using clerkPublic = connect(harness.url);
  const clerk = await authenticateWithClerk(clerkPublic, adminSubject, adminEmail.toUpperCase());
  using clerkApi = clerk.api;
  using _clerkSession = clerk.session;
  const internalUserId = (await clerkApi.whoami()).id;

  using cleanupPublic = connect(harness.url);
  const cleanupToken = await loginWithGatekeeper(cleanupPublic, cleanupEmail);
  cleanupFixture = { email: cleanupEmail, token: cleanupToken };

  using gatekeeperPublic = connect(harness.url);
  const adminToken = await loginWithGatekeeper(gatekeeperPublic, `  ${adminEmail.toUpperCase()}  `);
  await waitFor("the fresh scenario admin config to reload", async () => {
    try {
      using adminPublic = connect(harness.url);
      using adminApi = await adminPublic.authenticate(adminToken);
      if (!(await adminApi.amIAdmin())) return null;
      const admin = await adminApi.getAdminApi();
      if (!admin) return null;
      using adminCapability = admin as RpcStub<AdminApi>;
      await adminCapability.setSignupsEnabled(true);
      return true;
    } catch {
      return null;
    }
  });

  return { adminEmail, adminSubject, adminToken, internalUserId };
}

beforeAll(async () => {
  const clerkPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  clerkPrivateKey = clerkPair.privateKey;
  clerkPublicKeyPem = clerkPair.publicKey
    .export({ type: "spki", format: "pem" }).toString().trim();

  const accessPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  accessPrivateKey = accessPair.privateKey;
  accessPublicJwk = {
    ...accessPair.publicKey.export({ format: "jwk" }),
    kid: ACCESS_KEY_ID,
    alg: "RS256",
    use: "sig",
  };

  interceptor = new NetworkInterceptor([
    (url, method) => {
      if (url.href === `${ACCESS_ISSUER}/cdn-cgi/access/certs` && method === "GET") {
        return Response.json({ keys: [accessPublicJwk] });
      }
      return null;
    },
  ]);
  interceptor.install();

  harness = await startTestGatekeeperHarness({
    patchWorkshop(config) {
      config.main = CLERK_TEST_SERVER;
      config.services!.push({
        binding: "TEST_CLERK_PROFILES",
        service: TEST_GATEKEEPER_WORKER,
        entrypoint: "ClerkTestProfiles",
      });
      config.vars = {
        AUTH_GATEKEEPERS: TEST_VENDOR_ID,
        CLERK_PUBLISHABLE_KEY,
        CLERK_SECRET_KEY,
        CLERK_JWT_KEY: clerkPublicKeyPem,
        PUBLIC_BASE_URL: CLERK_AUTHORIZED_PARTY,
        DEV: true,
        ADMINS: [],
      };
    },
  });
  harness.server.clearLogs();
});

afterEach(async () => {
  const fixture = cleanupFixture;
  cleanupFixture = undefined;
  if (fixture) {
    await configureWorkshop([fixture.email]);
    await waitFor("the per-test cleanup admin to restore signups", async () => {
      try {
        using publicApi = connect(harness.url);
        using api = await publicApi.authenticate(fixture.token);
        const admin = await api.getAdminApi();
        if (!admin) return null;
        using capability = admin as RpcStub<AdminApi>;
        await capability.setSignupsEnabled(true);
        return true;
      } catch {
        return null;
      }
    });
  }
  await configureWorkshop([]);
});

afterAll(async () => {
  const logs = JSON.stringify(harness?.server.getLogs() ?? []);
  for (const sensitive of sensitiveValues) expect(logs).not.toContain(sensitive);
  const unmocked = interceptor?.getUnmockedCalls() ?? [];
  await harness?.server.close();
  interceptor?.uninstall();
  expect(unmocked).toEqual([]);
});

describe.sequential("verified authentication convergence", () => {
  it("converges Clerk and a real Gatekeeper login while retaining local session semantics",
      async () => {
    const scenario = await setupScenario("converge");
    using clerkPublic = connect(harness.url);
    const clerk = await authenticateWithClerk(
      clerkPublic, scenario.adminSubject, scenario.adminEmail.toUpperCase());
    using clerkApi = clerk.api;
    using _clerkSession = clerk.session;
    await clerkApi.setOwnDisplayName("Converged identity");

    expect(scenario.internalUserId).toMatch(/^[0-9a-f]{64}$/);
    expect(scenario.internalUserId).not.toContain(scenario.adminEmail);
    await expect(clerkApi.amIAdmin()).resolves.toBe(true);

    using firstLocalPublic = connect(harness.url);
    using firstLocalApi = await firstLocalPublic.authenticate(scenario.adminToken);
    await expect(firstLocalApi.whoami()).resolves.toMatchObject({
      id: scenario.internalUserId,
      name: "Converged identity",
    });
    await expect(firstLocalApi.amIAdmin()).resolves.toBe(true);

    using secondLocalPublic = connect(harness.url);
    using secondLocalApi = await secondLocalPublic.authenticate(scenario.adminToken);
    await expect(secondLocalApi.whoami()).resolves.toMatchObject({ id: scenario.internalUserId });
  });

  it("canonicalizes ADMINS and fails malformed configuration without exposing its contents",
      async () => {
    const scenario = await setupScenario("admins-config");
    await harness.updateWorkshop(config => {
      config.vars = { ...config.vars, ADMINS: "{\"private-marker\":true}" };
    });

    const expected = "ADMINS must be configured as an array of verified email strings.";
    const message = await waitFor("the malformed ADMINS config to reload", async () => {
      try {
        using publicApi = connect(harness.url);
        using api = await publicApi.authenticate(scenario.adminToken);
        await api.amIAdmin();
        return null;
      } catch (error) {
        const observed = error instanceof Error ? error.message : String(error);
        return observed.includes(expected) ? observed : null;
      }
    });
    expect(message).toContain(expected);
    expect(message).not.toContain("private-marker");
  });

  it("revokes a retained Gatekeeper admin graph when its verified email moves", async () => {
    const scenario = await setupScenario("retained-admin");
    using retainedPublic = connect(harness.url);
    using retainedApi = await retainedPublic.authenticate(scenario.adminToken);
    await retainedApi.provisionAmbientAccount(TEST_VENDOR_ID);

    const retainedAdmin = await retainedApi.getAdminApi();
    if (!retainedAdmin) throw new Error("retained Gatekeeper identity did not receive AdminApi");
    using adminCapability = retainedAdmin as RpcStub<AdminApi>;
    await expect(adminCapability.getSettings()).resolves.toMatchObject({ signupsEnabled: true });

    const frame = await retainedApi.getGatekeeperApp(TEST_VENDOR_ID);
    if (!frame) throw new Error("fixture Gatekeeper app was not returned");
    using appUi = frame.ui as unknown as RpcStub<{ ping(): Promise<string> }>;
    await expect(appUi.ping()).resolves.toBe("app:admin");
    let resolveAppBroken!: () => void;
    const appBroken = new Promise<void>(resolve => { resolveAppBroken = resolve; });
    appUi.onRpcBroken(() => resolveAppBroken());

    await setClerkProfile(scenario.adminSubject, uniqueEmail("retained-admin-moved"));
    using moverPublic = connect(harness.url);
    const moved = await moverPublic.authenticateWithClerk(clerkToken(scenario.adminSubject));
    moved.api[Symbol.dispose]();
    moved.session[Symbol.dispose]();

    await expect(adminCapability.getSettings()).rejects.toThrow();
    await expect(retainedApi.getAdminApi()).rejects.toThrow();
    await expect(Promise.race([
      appBroken.then(() => "broken"),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 5_000)),
    ])).resolves.toBe("broken");

    using rejectedPublic = connect(harness.url);
    await expect(rejectedPublic.authenticate(scenario.adminToken)).rejects.toThrow();
  });

  it("denies unknown Clerk and Gatekeeper identities when signups close but permits existing ones",
      async () => {
    const scenario = await setupScenario("signup-policy");
    using adminPublic = connect(harness.url);
    using adminApi = await adminPublic.authenticate(scenario.adminToken);
    const admin = await adminApi.getAdminApi();
    if (!admin) throw new Error("scenario identity did not receive AdminApi");
    using adminCapability = admin as RpcStub<AdminApi>;
    await adminCapability.setSignupsEnabled(false);

    using unknownClerkPublic = connect(harness.url);
    const unknownSubject = `user_unknown_${crypto.randomUUID()}`;
    await setClerkProfile(unknownSubject, uniqueEmail("unknown-clerk"));
    await expect(unknownClerkPublic.authenticateWithClerk(clerkToken(unknownSubject)))
      .rejects.toThrow(/sign-ups are currently disabled/i);

    using existingClerkPublic = connect(harness.url);
    const existingClerk = await authenticateWithClerk(
      existingClerkPublic, scenario.adminSubject, scenario.adminEmail);
    using existingClerkApi = existingClerk.api;
    using _existingClerkSession = existingClerk.session;
    await expect(existingClerkApi.whoami())
      .resolves.toMatchObject({ id: scenario.internalUserId });

    using unknownGatekeeperPublic = connect(harness.url);
    await expect(loginWithGatekeeper(unknownGatekeeperPublic, uniqueEmail("unknown-gatekeeper")))
      .rejects.toThrow(/sign-ups are currently disabled/i);

    using existingGatekeeperPublic = connect(harness.url);
    const existingToken = await loginWithGatekeeper(existingGatekeeperPublic, scenario.adminEmail);
    using existingLocalPublic = connect(harness.url);
    using existingLocalApi = await existingLocalPublic.authenticate(existingToken);
    await expect(existingLocalApi.whoami())
      .resolves.toMatchObject({ id: scenario.internalUserId });
  });

  it("grants no admin capability to a different verified Gatekeeper email", async () => {
    await setupScenario("non-admin");
    const nonAdminEmail = uniqueEmail("non-admin");
    await waitFor("a non-admin login after the harness reload", async () => {
      try {
        using loginPublic = connect(harness.url);
        const token = await loginWithGatekeeper(loginPublic, nonAdminEmail);
        using localPublic = connect(harness.url);
        using localApi = await localPublic.authenticate(token);
        if (await localApi.amIAdmin()) throw new Error("non-admin unexpectedly received admin");
        if (await localApi.getAdminApi() !== null) {
          throw new Error("non-admin unexpectedly received AdminApi");
        }
        return true;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Peer closed WebSocket: 1006")) {
          return null;
        }
        throw error;
      }
    });
  });

  it("locks a collided identity and eagerly aborts its retained Gatekeeper RPC graph", async () => {
    await setupScenario("collision-admin");
    const firstEmail = uniqueEmail("collision-first");
    const occupiedEmail = uniqueEmail("collision-occupied");
    const subject = `user_collision_${crypto.randomUUID()}`;

    using firstClerkPublic = connect(harness.url);
    const firstClerk = await authenticateWithClerk(firstClerkPublic, subject, firstEmail);
    using firstClerkApi = firstClerk.api;
    using _firstClerkSession = firstClerk.session;
    const firstId = (await firstClerkApi.whoami()).id;

    using firstGatekeeperPublic = connect(harness.url);
    const firstToken = await loginWithGatekeeper(firstGatekeeperPublic, firstEmail);
    using retainedPublic = connect(harness.url);
    using retainedApi = await retainedPublic.authenticate(firstToken);

    using occupiedGatekeeperPublic = connect(harness.url);
    const occupiedToken = await loginWithGatekeeper(occupiedGatekeeperPublic, occupiedEmail);
    using occupiedLocalPublic = connect(harness.url);
    using occupiedApi = await occupiedLocalPublic.authenticate(occupiedToken);
    expect((await occupiedApi.whoami()).id).not.toBe(firstId);

    await setClerkProfile(subject, occupiedEmail);
    using collisionPublic = connect(harness.url);
    await expect(collisionPublic.authenticateWithClerk(clerkToken(subject)))
      .rejects.toThrow(/collision/i);

    await expect(retainedApi.whoami()).rejects.toThrow();
    using rejectedPublic = connect(harness.url);
    await expect(rejectedPublic.authenticate(firstToken)).rejects.toThrow(/collision/i);
  });

  it("keeps Gatekeeper authentication independent of Clerk configuration", async () => {
    const scenario = await setupScenario("gatekeeper-only");
    await harness.updateWorkshop(config => {
      delete config.vars!.CLERK_PUBLISHABLE_KEY;
      delete config.vars!.CLERK_SECRET_KEY;
      delete config.vars!.CLERK_JWT_KEY;
      delete config.vars!.PUBLIC_BASE_URL;
    });

    using publicApi = connect(harness.url);
    using api = await publicApi.authenticate(scenario.adminToken);
    await expect(api.whoami()).resolves.toMatchObject({ id: scenario.internalUserId });
  });

  it("converges Access without Clerk keys and enforces disabled signup and admin authority",
      async () => {
    const scenario = await setupScenario("access");
    const nonAdminEmail = uniqueEmail("access-non-admin");
    using nonAdminLoginPublic = connect(harness.url);
    const nonAdminToken = await loginWithGatekeeper(nonAdminLoginPublic, nonAdminEmail);
    using nonAdminPublic = connect(harness.url);
    using nonAdminApi = await nonAdminPublic.authenticate(nonAdminToken);
    const nonAdminInternalUserId = (await nonAdminApi.whoami()).id;

    using adminPublic = connect(harness.url);
    using adminApi = await adminPublic.authenticate(scenario.adminToken);
    const admin = await adminApi.getAdminApi();
    if (!admin) throw new Error("scenario identity did not receive AdminApi");
    using adminCapability = admin as RpcStub<AdminApi>;
    await adminCapability.setSignupsEnabled(false);

    await configureWorkshop([scenario.adminEmail, cleanupFixture!.email], true);
    await waitFor("Cloudflare Access mode to reload", async () => {
      const response = await harness.server.fetch("/api", {
        headers: { Origin: harness.url.origin },
      });
      return response.status === 403 ? true : null;
    });

    using accessPublic = accessBatch(accessToken(`  ${scenario.adminEmail.toUpperCase()}  `));
    const profile = await accessPublic.authenticateFromCfAccess().whoami();
    expect(profile).toMatchObject({ id: scenario.internalUserId });

    using accessAdminPublic = accessBatch(accessToken(scenario.adminEmail));
    await expect(accessAdminPublic.authenticateFromCfAccess().amIAdmin()).resolves.toBe(true);
    using accessSettingsPublic = accessBatch(accessToken(scenario.adminEmail));
    using accessSettings = (accessSettingsPublic.authenticateFromCfAccess().getAdminApi() as unknown as RpcStub<AdminApi>);
    await expect(accessSettings.getSettings())
      .resolves.toMatchObject({ signupsEnabled: false });

    using accessNonAdminPublic = accessBatch(accessToken(nonAdminEmail));
    await expect(accessNonAdminPublic.authenticateFromCfAccess().whoami())
      .resolves.toMatchObject({ id: nonAdminInternalUserId });
    using nonAdminCapabilityPublic = accessBatch(accessToken(nonAdminEmail));
    await expect(nonAdminCapabilityPublic.authenticateFromCfAccess().getAdminApi())
      .resolves.toBeNull();

    using unknownAccessPublic = accessBatch(accessToken(uniqueEmail("unknown-access")));
    await expect(unknownAccessPublic.authenticateFromCfAccess().whoami())
      .rejects.toThrow(/sign-ups are currently disabled/i);
  });

  it("keeps one Access identity and current admin authority across a verified email change",
      async () => {
    const scenario = await setupScenario("access-email-move");
    const accessSubject = `access-stable-${crypto.randomUUID()}`;
    await configureWorkshop([scenario.adminEmail, cleanupFixture!.email], true);
    await waitFor("Cloudflare Access mode to reload for the email move", async () => {
      const response = await harness.server.fetch("/api", {
        headers: { Origin: harness.url.origin },
      });
      return response.status === 403 ? true : null;
    });

    const firstToken = accessToken(scenario.adminEmail, 120, accessSubject);
    using firstPublic = accessBatch(firstToken);
    await firstPublic.authenticateFromCfAccess().setOwnDisplayName("Stable Access identity");
    using firstProfilePublic = accessBatch(firstToken);
    await expect(firstProfilePublic.authenticateFromCfAccess().whoami())
      .resolves.toMatchObject({ id: scenario.internalUserId });

    const movedEmail = uniqueEmail("access-email-moved");
    await configureWorkshop([movedEmail, cleanupFixture!.email], true);
    await waitFor("the changed Access admin allowlist to reload", async () => {
      const response = await harness.server.fetch("/api", {
        headers: { Origin: harness.url.origin },
      });
      return response.status === 403 ? true : null;
    });

    const movedToken = accessToken(movedEmail, 120, accessSubject);
    using movedPublic = accessBatch(movedToken);
    await expect(movedPublic.authenticateFromCfAccess().whoami()).resolves.toMatchObject({
      id: scenario.internalUserId,
      name: "Stable Access identity",
    });
    using movedAdminPublic = accessBatch(movedToken);
    await expect(movedAdminPublic.authenticateFromCfAccess().amIAdmin()).resolves.toBe(true);
  });

  it("retains Access JWT and same-origin rejection behavior", async () => {
    const scenario = await setupScenario("access-edge");
    await configureWorkshop([scenario.adminEmail, cleanupFixture!.email], true);
    await waitFor("Cloudflare Access edge checks to reload", async () => {
      const response = await harness.server.fetch("/api", {
        headers: { Origin: harness.url.origin },
      });
      return response.status === 403 ? true : null;
    });
    const validToken = accessToken(scenario.adminEmail);
    const missing = await harness.server.fetch("/api", {
      headers: { Origin: harness.url.origin },
    });
    expect(missing.status).toBe(403);

    const crossOrigin = await harness.server.fetch("/api", {
      headers: {
        Origin: "https://attacker.example",
        "cf-access-jwt-assertion": validToken,
      },
    });
    expect(crossOrigin.status).toBe(403);

    const invalid = await harness.server.fetch("/api", {
      headers: {
        Origin: harness.url.origin,
        "cf-access-jwt-assertion": "invalid-access-token",
      },
    });
    expect(invalid.status).toBe(403);

    const logout = await harness.server.fetch("/cdn-cgi/access/logout");
    expect(logout.status).toBe(404);
  });
});
