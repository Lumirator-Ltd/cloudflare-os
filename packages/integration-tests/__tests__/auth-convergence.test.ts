import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const CANONICAL_EMAIL = "same.user@example.com";
const CLERK_EMAIL_VARIANT = "Same.User@Example.COM";
const PADDED_EMAIL_VARIANT = "  Same.User@Example.COM  ";
const NON_ADMIN_EMAIL = "ordinary@example.com";
const CLERK_TEST_SERVER = fileURLToPath(new URL(
  "../../workshop-backend/.wrangler/validate/src/testing/clerk-test-server.ts",
  import.meta.url,
).href);

let harness: Harness;
let interceptor: NetworkInterceptor;
let clerkPrivateKey: KeyObject;
let accessPrivateKey: KeyObject;
let accessPublicJwk: Record<string, unknown>;
let canonicalInternalUserId: string;
let canonicalGatekeeperToken: string;
let nonAdminInternalUserId: string;
const sensitiveValues = new Set<string>([CLERK_SECRET_KEY]);

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

function accessToken(email: string, expiresInSeconds = 120): string {
  sensitiveValues.add(email);
  const now = Math.floor(Date.now() / 1_000);
  const token = signJwt(
    { alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" },
    {
      iss: ACCESS_ISSUER,
      aud: ACCESS_AUDIENCE,
      sub: `access-${crypto.randomUUID()}`,
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

beforeAll(async () => {
  const clerkPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  clerkPrivateKey = clerkPair.privateKey;
  const clerkPublicKeyPem = clerkPair.publicKey
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
        ...config.vars,
        AUTH_GATEKEEPERS: TEST_VENDOR_ID,
        CLERK_PUBLISHABLE_KEY,
        CLERK_SECRET_KEY,
        CLERK_JWT_KEY: clerkPublicKeyPem,
        PUBLIC_BASE_URL: CLERK_AUTHORIZED_PARTY,
        DEV: true,
        ADMINS: [`  ${CANONICAL_EMAIL.toUpperCase()}  `],
      };
    },
  });
  harness.server.clearLogs();
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
  it("converges Clerk and a real Gatekeeper login while retaining local session semantics", async () => {
    using clerkPublic = connect(harness.url);
    const clerk = await authenticateWithClerk(
      clerkPublic, "user_task6_canonical", CLERK_EMAIL_VARIANT);
    using clerkApi = clerk.api;
    using _clerkSession = clerk.session;
    const clerkProfile = await clerkApi.whoami();
    canonicalInternalUserId = clerkProfile.id;
    await clerkApi.setOwnDisplayName("Converged identity");

    expect(canonicalInternalUserId).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalInternalUserId).not.toContain(CANONICAL_EMAIL);
    await expect(clerkApi.amIAdmin()).resolves.toBe(true);
    const clerkAdmin = await clerkApi.getAdminApi();
    expect(clerkAdmin).not.toBeNull();
    clerkAdmin?.[Symbol.dispose]();

    using gatekeeperPublic = connect(harness.url);
    canonicalGatekeeperToken = await loginWithGatekeeper(
      gatekeeperPublic, `  ${CANONICAL_EMAIL.toUpperCase()}  `);
    expect(canonicalGatekeeperToken).toMatch(/^[0-9a-f]{64}:[A-Za-z0-9+/=]+$/);
    expect(canonicalGatekeeperToken).not.toContain(CANONICAL_EMAIL);

    using firstLocalPublic = connect(harness.url);
    using firstLocalApi = await firstLocalPublic.authenticate(canonicalGatekeeperToken);
    await expect(firstLocalApi.whoami()).resolves.toMatchObject({
      id: canonicalInternalUserId,
      name: "Converged identity",
    });
    await expect(firstLocalApi.amIAdmin()).resolves.toBe(true);
    const localAdmin = await firstLocalApi.getAdminApi();
    expect(localAdmin).not.toBeNull();
    localAdmin?.[Symbol.dispose]();

    // The random Workshop token remains independently reusable across local WebSocket sessions.
    using secondLocalPublic = connect(harness.url);
    using secondLocalApi = await secondLocalPublic.authenticate(canonicalGatekeeperToken);
    await expect(secondLocalApi.whoami()).resolves.toMatchObject({ id: canonicalInternalUserId });
  });

  it("canonicalizes ADMINS and fails malformed configuration without exposing its contents",
      async () => {
    await harness.updateWorkshop(config => {
      config.vars = { ...config.vars, ADMINS: "{\"private-marker\":true}" };
    });

    const expected = "ADMINS must be configured as an array of verified email strings.";
    const message = await waitFor("the malformed ADMINS config to reload", async () => {
      try {
        using malformedPublic = connect(harness.url);
        using malformedApi = await malformedPublic.authenticate(canonicalGatekeeperToken);
        await malformedApi.amIAdmin();
        return null;
      } catch (error) {
        const observed = error instanceof Error ? error.message : String(error);
        return observed.includes(expected) ? observed : null;
      }
    });
    expect(message).toContain(expected);
    expect(message).not.toContain("private-marker");

    await harness.updateWorkshop(config => {
      config.vars = { ...config.vars, ADMINS: [` ${CANONICAL_EMAIL.toUpperCase()} `] };
    });
    await waitFor("the valid ADMINS config to reload", async () => {
      try {
        using publicApi = connect(harness.url);
        using api = await publicApi.authenticate(canonicalGatekeeperToken);
        return await api.amIAdmin() ? true : null;
      } catch {
        return null;
      }
    });
  });

  it("denies unknown Clerk and Gatekeeper identities when signups close but permits existing ones",
      async () => {
    using adminPublic = connect(harness.url);
    using adminApi = await adminPublic.authenticate(canonicalGatekeeperToken);
    const admin = await adminApi.getAdminApi();
    if (!admin) throw new Error("canonical Gatekeeper identity did not receive AdminApi");
    using adminCapability = admin as RpcStub<AdminApi>;
    await adminCapability.setSignupsEnabled(false);

    using unknownClerkPublic = connect(harness.url);
    await setClerkProfile("user_task6_disabled_unknown", "unknown-clerk@example.com");
    await expect(unknownClerkPublic.authenticateWithClerk(clerkToken("user_task6_disabled_unknown")))
      .rejects.toThrow(/sign-ups are currently disabled/i);

    using existingClerkPublic = connect(harness.url);
    const existingClerk = await authenticateWithClerk(
      existingClerkPublic, "user_task6_canonical", CANONICAL_EMAIL);
    using existingClerkApi = existingClerk.api;
    using _existingClerkSession = existingClerk.session;
    await expect(existingClerkApi.whoami())
      .resolves.toMatchObject({ id: canonicalInternalUserId });

    using unknownGatekeeperPublic = connect(harness.url);
    await expect(loginWithGatekeeper(unknownGatekeeperPublic, "unknown-gatekeeper@example.com"))
      .rejects.toThrow(/sign-ups are currently disabled/i);

    using existingGatekeeperPublic = connect(harness.url);
    const existingToken = await loginWithGatekeeper(existingGatekeeperPublic, CANONICAL_EMAIL);
    using existingLocalPublic = connect(harness.url);
    using existingLocalApi = await existingLocalPublic.authenticate(existingToken);
    await expect(existingLocalApi.whoami())
      .resolves.toMatchObject({ id: canonicalInternalUserId });
  });

  it("grants no admin capability to a different verified Gatekeeper email", async () => {
    using adminPublic = connect(harness.url);
    using adminApi = await adminPublic.authenticate(canonicalGatekeeperToken);
    const admin = await adminApi.getAdminApi();
    if (!admin) throw new Error("canonical identity did not receive AdminApi");
    using adminCapability = admin as RpcStub<AdminApi>;
    await adminCapability.setSignupsEnabled(true);

    using loginPublic = connect(harness.url);
    const token = await loginWithGatekeeper(loginPublic, NON_ADMIN_EMAIL);
    using localPublic = connect(harness.url);
    using localApi = await localPublic.authenticate(token);
    nonAdminInternalUserId = (await localApi.whoami()).id;
    await expect(localApi.amIAdmin()).resolves.toBe(false);
    await expect(localApi.getAdminApi()).resolves.toBeNull();
  });

  it("locks a collided identity for new authentication without revoking retained Gatekeeper RPC",
      async () => {
    const firstEmail = "collision-first@example.com";
    const occupiedEmail = "collision-occupied@example.com";
    const subject = "user_task6_collision";

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

    // Gatekeeper sessions keep their prior lifetime semantics; only a new registry-backed auth is
    // denied after the collision. Clerk is the only provider with eager session broadcasts.
    await expect(retainedApi.whoami()).resolves.toMatchObject({ id: firstId });
    using rejectedPublic = connect(harness.url);
    await expect(rejectedPublic.authenticate(firstToken)).rejects.toThrow(/collision/i);
  });

  it("keeps Gatekeeper authentication independent of Clerk configuration", async () => {
    await harness.updateWorkshop(config => {
      delete config.vars!.CLERK_PUBLISHABLE_KEY;
      delete config.vars!.CLERK_SECRET_KEY;
      delete config.vars!.CLERK_JWT_KEY;
      delete config.vars!.PUBLIC_BASE_URL;
    });

    using publicApi = connect(harness.url);
    using api = await publicApi.authenticate(canonicalGatekeeperToken);
    await expect(api.whoami()).resolves.toMatchObject({ id: canonicalInternalUserId });
  });

  it("converges Access without Clerk keys and enforces disabled signup and admin authority",
      async () => {
    using adminPublic = connect(harness.url);
    using adminApi = await adminPublic.authenticate(canonicalGatekeeperToken);
    const admin = await adminApi.getAdminApi();
    if (!admin) throw new Error("canonical identity did not receive AdminApi");
    using adminCapability = admin as RpcStub<AdminApi>;
    await adminCapability.setSignupsEnabled(false);

    await harness.updateWorkshop(config => {
      config.vars = {
        ...config.vars,
        CF_ACCESS_AUD: ACCESS_AUDIENCE,
        CF_ACCESS_ISS: ACCESS_ISSUER,
      };
      delete config.vars.CLERK_PUBLISHABLE_KEY;
      delete config.vars.CLERK_SECRET_KEY;
      delete config.vars.CLERK_JWT_KEY;
      delete config.vars.PUBLIC_BASE_URL;
    });
    await waitFor("Cloudflare Access mode to reload", async () => {
      const response = await harness.server.fetch("/api", {
        headers: { Origin: harness.url.origin },
      });
      return response.status === 403 ? true : null;
    });

    using accessPublic = accessBatch(accessToken(PADDED_EMAIL_VARIANT));
    const profile = await accessPublic.authenticateFromCfAccess().whoami();
    expect(profile).toMatchObject({
      id: canonicalInternalUserId,
      name: "Converged identity",
    });

    using accessAdminPublic = accessBatch(accessToken(CANONICAL_EMAIL));
    await expect(accessAdminPublic.authenticateFromCfAccess().amIAdmin()).resolves.toBe(true);

    using accessNonAdminPublic = accessBatch(accessToken(NON_ADMIN_EMAIL));
    await expect(accessNonAdminPublic.authenticateFromCfAccess().whoami())
      .resolves.toMatchObject({ id: nonAdminInternalUserId });

    using nonAdminCapabilityPublic = accessBatch(accessToken(NON_ADMIN_EMAIL));
    await expect(nonAdminCapabilityPublic.authenticateFromCfAccess().getAdminApi())
      .resolves.toBeNull();

    using unknownAccessPublic = accessBatch(accessToken("unknown-access@example.com"));
    await expect(unknownAccessPublic.authenticateFromCfAccess().whoami())
      .rejects.toThrow(/sign-ups are currently disabled/i);
  });

  it("retains Access JWT and same-origin rejection behavior", async () => {
    const validToken = accessToken(CANONICAL_EMAIL);
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

    // Cloudflare Access owns this edge route; the Workshop still does not implement or redirect it.
    const logout = await harness.server.fetch("/cdn-cgi/access/logout");
    expect(logout.status).toBe(404);
  });
});
