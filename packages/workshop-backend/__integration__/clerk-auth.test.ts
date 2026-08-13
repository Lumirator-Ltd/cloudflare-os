import { verifyToken as verifyClerkToken } from "@clerk/backend";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyClerkIdentity } from "../src/clerk-auth.js";

const FRONTEND_API = "happy-otter-12.clerk.accounts.dev";
const PUBLISHABLE_KEY = `pk_test_${btoa(`${FRONTEND_API}$`).replace(/=+$/, "")}`;
const ISSUER = `https://${FRONTEND_API}`;
const AUTHORIZED_PARTY = "https://workshop.example";
const SUBJECT = "user_stable123";
const SESSION = "sess_active123";
const KEY_ID = `task4-${crypto.randomUUID()}`;
const SECRET_KEY = "sk_test_fixture_secret";
const CLERK_API_ORIGIN = "https://api.clerk.com";
const JWKS_URL = `${CLERK_API_ORIGIN}/v1/jwks`;
const SESSION_URL = `${CLERK_API_ORIGIN}/v1/sessions/${SESSION}`;
const USER_URL = `${CLERK_API_ORIGIN}/v1/users/${SUBJECT}`;

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let publicKeyPem: string;
let jwk: JsonWebKey;

function env(overrides: Record<string, unknown> = {}) {
  return {
    CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    CLERK_SECRET_KEY: SECRET_KEY,
    PUBLIC_BASE_URL: AUTHORIZED_PARTY,
    ...overrides,
  } as unknown as Cloudflare.Env;
}

function activeSession() {
  const now = Date.now();
  return {
    object: "session",
    id: SESSION,
    client_id: "client_fixture123",
    user_id: SUBJECT,
    status: "active",
    last_active_organization_id: null,
    actor: null,
    last_active_at: now,
    expire_at: now + 60_000,
    abandon_at: now + 120_000,
    created_at: now - 60_000,
    updated_at: now,
  };
}

function userProfile() {
  const now = Date.now();
  return {
    object: "user",
    id: SUBJECT,
    username: null,
    first_name: null,
    last_name: null,
    image_url: "https://img.clerk.com/fixture",
    has_image: false,
    primary_email_address_id: "idn_fixture123",
    primary_phone_number_id: null,
    primary_web3_wallet_id: null,
    password_enabled: true,
    two_factor_enabled: false,
    totp_enabled: false,
    backup_code_enabled: false,
    email_addresses: [{
      object: "email_address",
      id: "idn_fixture123",
      email_address: "verified@example.com",
      verification: {
        status: "verified",
        strategy: "email_code",
        attempts: 1,
        expire_at: null,
      },
      linked_to: [],
    }],
    phone_numbers: [],
    web3_wallets: [],
    external_accounts: [],
    enterprise_accounts: [],
    organization_memberships: null,
    password_last_updated_at: now,
    public_metadata: {},
    private_metadata: {},
    unsafe_metadata: {},
    external_id: null,
    last_sign_in_at: now,
    banned: false,
    locked: false,
    lockout_expires_in_seconds: null,
    verification_attempts_remaining: 100,
    created_at: now - 60_000,
    updated_at: now,
    last_active_at: now,
    create_organization_enabled: true,
    create_organizations_limit: null,
    delete_self_enabled: true,
    legal_accepted_at: null,
    locale: null,
  };
}

async function token(
    overrides: Record<string, unknown> = {},
    signingKey: CryptoKey = privateKey,
    keyId = KEY_ID,
) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: ISSUER,
    sub: SUBJECT,
    sid: SESSION,
    sts: "active",
    azp: AUTHORIZED_PARTY,
    iat: now - 10,
    nbf: now - 15,
    exp: now + 290,
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" }).sign(signingKey);
}

function localDependencies() {
  return {
    verifyToken: verifyClerkToken,
    createClient: vi.fn().mockReturnValue({
      sessions: { getSession: vi.fn().mockResolvedValue({ id: SESSION, userId: SUBJECT, status: "active" }) },
      users: {
        getUser: vi.fn().mockResolvedValue({
          id: SUBJECT,
          primaryEmailAddress: {
            emailAddress: "verified@example.com",
            verification: { status: "verified" },
          },
        }),
      },
    }),
  };
}

function installClerkFetchFixture() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === JWKS_URL && request.method === "GET") {
      return Response.json({ keys: [jwk] });
    }
    if (request.url === SESSION_URL && request.method === "GET") {
      return Response.json(activeSession());
    }
    if (request.url === USER_URL && request.method === "GET") {
      return Response.json(userProfile());
    }
    throw new Error(`unexpected network request: ${request.method} ${request.url}`);
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  ({ privateKey: otherPrivateKey } = await generateKeyPair("RS256", { extractable: true }));
  publicKeyPem = await exportSPKI(pair.publicKey);
  jwk = { ...await exportJWK(pair.publicKey), kid: KEY_ID, alg: "RS256", use: "sig" };
});

beforeEach(() => vi.stubEnv("NODE_ENV", "test"));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Clerk JWT cryptographic verification", () => {
  it("uses the actual Clerk verifier for a valid active standard session token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
    await expect(verifyClerkIdentity(
      await token(),
      env({ CLERK_JWT_KEY: publicKeyPem }),
      localDependencies(),
    )).resolves.toMatchObject({ subject: SUBJECT, email: "verified@example.com" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an actually signed pending session token", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
    await expect(verifyClerkIdentity(
      await token({ sts: "pending" }),
      env({ CLERK_JWT_KEY: publicKeyPem }),
      localDependencies(),
    )).rejects.toThrow("Clerk identity could not be verified.");
  });

  it("rejects an actually signed token over the 300 second lifetime bound", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
    const now = Math.floor(Date.now() / 1_000);
    await expect(verifyClerkIdentity(
      await token({ iat: now - 10, exp: now + 291 }),
      env({ CLERK_JWT_KEY: publicKeyPem }),
      localDependencies(),
    )).rejects.toThrow("Clerk identity could not be verified.");
  });

  it("rejects an actually signed token older than the 300 second age bound", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
    const now = Math.floor(Date.now() / 1_000);
    await expect(verifyClerkIdentity(
      await token({ iat: now - 301, exp: now + 1 }),
      env({ CLERK_JWT_KEY: publicKeyPem }),
      localDependencies(),
    )).rejects.toThrow("Clerk identity could not be verified.");
  });

  it("rejects a token with an invalid signature", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
    await expect(verifyClerkIdentity(
      await token({}, otherPrivateKey),
      env({ CLERK_JWT_KEY: publicKeyPem }),
      localDependencies(),
    )).rejects.toThrow("Clerk identity could not be verified.");
  });
});

describe("Clerk remote JWKS and Backend API integration", () => {
  it("uses only fixed Clerk endpoints with auth and telemetry disabled", async () => {
    const fetchSpy = installClerkFetchFixture();
    const remoteEnv = env();
    expect("CLERK_JWT_KEY" in remoteEnv).toBe(false);

    await expect(verifyClerkIdentity(await token(), remoteEnv)).resolves.toEqual({
      subject: SUBJECT,
      email: "verified@example.com",
      expiresAt: expect.any(Date),
    });

    const requests = fetchSpy.mock.calls.map(([input, init]) => new Request(input, init));
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      `GET ${JWKS_URL}`,
      `GET ${SESSION_URL}`,
      `GET ${USER_URL}`,
    ]);
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe(CLERK_API_ORIGIN);
      expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
    expect(requests.some(request => request.url.includes("clerk-telemetry.com"))).toBe(false);
  });

  it("rejects an unknown remote signing key without contacting any other host", async () => {
    const fetchSpy = installClerkFetchFixture();

    await expect(verifyClerkIdentity(await token({}, privateKey, `unknown-${crypto.randomUUID()}`), env()))
        .rejects.toThrow("Clerk identity could not be verified.");

    const requests = fetchSpy.mock.calls.map(([input, init]) => new Request(input, init));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(request => request.method === "GET" && request.url === JWKS_URL)).toBe(true);
    expect(requests.every(request => request.headers.get("authorization") === `Bearer ${SECRET_KEY}`)).toBe(true);
  });
});
