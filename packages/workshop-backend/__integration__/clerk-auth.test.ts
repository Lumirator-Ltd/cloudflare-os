import { verifyToken as verifyClerkToken } from "@clerk/backend";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyClerkIdentity } from "../src/clerk-auth.js";

const FRONTEND_API = "happy-otter-12.clerk.accounts.dev";
const PUBLISHABLE_KEY = `pk_test_${btoa(`${FRONTEND_API}$`).replace(/=+$/, "")}`;
const ISSUER = `https://${FRONTEND_API}`;
const AUTHORIZED_PARTY = "https://workshop.example";
const SUBJECT = "user_stable123";
const SESSION = "sess_active123";
const KEY_ID = `task4-${crypto.randomUUID()}`;
const SECRET_KEY = "sk_test_fixture_secret";

const env = {
  CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
  CLERK_SECRET_KEY: SECRET_KEY,
  PUBLIC_BASE_URL: AUTHORIZED_PARTY,
  CLERK_JWT_KEY: "",
} as unknown as Cloudflare.Env;

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwk: JsonWebKey;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const createClient = vi.fn().mockReturnValue({
  users: {
    getUser: vi.fn().mockResolvedValue({
      id: SUBJECT,
      primaryEmailAddress: {
        emailAddress: "verified@example.com",
        verification: { status: "verified" },
      },
    }),
  },
});
const dependencies = { verifyToken: verifyClerkToken, createClient };

function verify(tokenValue: string, customEnv: Cloudflare.Env = env) {
  return verifyClerkIdentity(tokenValue, customEnv, dependencies);
}

async function token(
    overrides: Record<string, unknown> = {},
    signingKey: CryptoKey = privateKey,
    keyId = KEY_ID,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER,
    sub: SUBJECT,
    sid: SESSION,
    azp: AUTHORIZED_PARTY,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300,
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: keyId }).sign(signingKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  ({ privateKey: otherPrivateKey } = await generateKeyPair("RS256", { extractable: true }));
  jwk = { ...await exportJWK(pair.publicKey), kid: KEY_ID, alg: "RS256", use: "sig" };
  env.CLERK_JWT_KEY = await exportSPKI(pair.publicKey);

  // Networkless verification uses the local Clerk JWT key. The fetch spy proves the cryptographic
  // SDK path does not fall back to remote JWKS or telemetry traffic.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
});

afterAll(() => fetchSpy.mockRestore());

describe("Clerk JWT cryptographic verification", () => {
  it("verifies a valid session JWT and resolves trusted email through the backend client", async () => {
    await expect(verify(await token())).resolves.toMatchObject({
      subject: SUBJECT,
      email: "verified@example.com",
    });
    expect(jwk).toMatchObject({ kid: KEY_ID, alg: "RS256", use: "sig" });
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      apiUrl: "https://api.clerk.com",
      telemetry: { disabled: true },
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    await expect(verify(await token({ exp: Math.floor(Date.now() / 1000) - 60 })))
        .rejects.toThrow("Clerk identity could not be verified.");
  });

  it("rejects a token that is not active yet", async () => {
    await expect(verify(await token({ nbf: Math.floor(Date.now() / 1000) + 60 })))
        .rejects.toThrow("Clerk identity could not be verified.");
  });

  it("rejects a token with an invalid signature", async () => {
    await expect(verify(await token({}, otherPrivateKey)))
        .rejects.toThrow("Clerk identity could not be verified.");
  });

  it.each([
    undefined,
    `http://${FRONTEND_API}`,
    `${ISSUER}/path`,
    `${ISSUER}.attacker.example`,
  ])("rejects issuer %j", async (iss) => {
    await expect(verify(await token({ iss })))
        .rejects.toThrow("Clerk identity could not be verified.");
  });

  it.each([undefined, "", "wrong", [], ["wrong"], ["expected", ""]])(
    "rejects configured malformed or wrong audience %j",
    async (aud) => {
      await expect(verify(
        await token({ aud }),
        { ...env, CLERK_JWT_AUDIENCE: "expected" } as unknown as Cloudflare.Env,
      )).rejects.toThrow("Clerk identity could not be verified.");
    },
  );

  it.each(["expected", ["other", "expected"]])("accepts exact configured audience %j", async (aud) => {
    await expect(verify(
      await token({ aud }),
      { ...env, CLERK_JWT_AUDIENCE: "expected" } as unknown as Cloudflare.Env,
    )).resolves.toMatchObject({ subject: SUBJECT });
  });

  it.each([undefined, "https://wrong.example"])("rejects authorized party %j", async (azp) => {
    await expect(verify(await token({ azp })))
        .rejects.toThrow("Clerk identity could not be verified.");
  });

  it("rejects a same-key JWT that is not a Clerk session token", async () => {
    await expect(verify(await token({ sid: undefined })))
        .rejects.toThrow("Clerk identity could not be verified.");
  });
});
