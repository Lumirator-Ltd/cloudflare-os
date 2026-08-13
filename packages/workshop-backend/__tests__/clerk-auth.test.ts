import { describe, expect, it, vi } from "vitest";
import {
  deriveClerkIssuer,
  resolveClerkVerificationConfig,
  verifyClerkIdentity,
} from "../src/clerk-auth.js";
import { getServerConfig } from "../src/deployment-config.js";

const FRONTEND_API = "happy-otter-12.clerk.accounts.dev";
const PUBLISHABLE_KEY = `pk_test_${btoa(`${FRONTEND_API}$`).replace(/=+$/, "")}`;
const ISSUER = `https://${FRONTEND_API}`;
const TOKEN = "header.sensitive-token.signature";
const NOW = Math.floor(Date.now() / 1000);

function env(overrides: Record<string, unknown> = {}) {
  return {
    CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    CLERK_SECRET_KEY: "sk_test_secret",
    PUBLIC_BASE_URL: "https://workshop.example/path",
    ...overrides,
  } as unknown as Cloudflare.Env;
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    sub: "user_stable123",
    sid: "sess_active123",
    azp: "https://workshop.example",
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 300,
    ...overrides,
  };
}

function dependencies(
    tokenClaims = claims(),
    user: Record<string, unknown> = {
      id: "user_stable123",
      primaryEmailAddress: {
        emailAddress: "verified@example.com",
        verification: { status: "verified" },
      },
    }) {
  const verifyToken = vi.fn().mockResolvedValue(tokenClaims);
  const getUser = vi.fn().mockResolvedValue(user);
  const createClient = vi.fn().mockReturnValue({ users: { getUser } });
  return { verifyToken, createClient, getUser };
}

describe("Clerk verification configuration", () => {
  it("derives the exact HTTPS issuer from a Clerk publishable key", () => {
    expect(deriveClerkIssuer(PUBLISHABLE_KEY)).toBe(ISSUER);
  });

  it.each([
    "",
    "pk_test_not-base64",
    `pk_test_${btoa("https://clerk.example$")}`,
    `pk_test_${btoa("clerk.example/path$")}`,
    `pk_test_${btoa("clerk.example:443$")}`,
    `pk_test_${btoa("clerk.example$$")}`,
    `pk_other_${btoa("clerk.example$")}`,
  ])("rejects malformed publishable key %j", (publishableKey) => {
    expect(() => deriveClerkIssuer(publishableKey)).toThrow("Clerk authentication is not configured correctly.");
  });

  it("uses only the exact PUBLIC_BASE_URL origin in production", () => {
    expect(resolveClerkVerificationConfig(env())).toMatchObject({
      issuer: ISSUER,
      authorizedParties: ["https://workshop.example"],
    });
  });

  it("adds exact development authorized parties only in local development", () => {
    const local = env({
      DEV: true,
      PUBLIC_BASE_URL: "http://localhost:8787",
      CLERK_DEV_AUTHORIZED_PARTIES: "http://localhost:3000,http://127.0.0.1:8787,https://localhost:3000",
    });
    expect(resolveClerkVerificationConfig(local).authorizedParties).toEqual([
      "http://localhost:8787",
      "http://localhost:3000",
      "http://127.0.0.1:8787",
      "https://localhost:3000",
    ]);

    const production = env({
      CLERK_DEV_AUTHORIZED_PARTIES: "https://attacker.example",
    });
    expect(resolveClerkVerificationConfig(production).authorizedParties)
        .toEqual(["https://workshop.example"]);
  });

  it.each([
    { PUBLIC_BASE_URL: undefined },
    { PUBLIC_BASE_URL: "" },
    { PUBLIC_BASE_URL: "not a URL" },
    { PUBLIC_BASE_URL: "http://workshop.example" },
    { PUBLIC_BASE_URL: "https://user@workshop.example" },
    { CLERK_SECRET_KEY: undefined },
    { CLERK_SECRET_KEY: "" },
    { CLERK_PUBLISHABLE_KEY: undefined },
    { CLERK_JWT_AUDIENCE: "" },
    { CLERK_JWT_KEY: "not-a-public-key" },
  ])("fails closed for malformed or missing production config %#", (overrides) => {
    expect(() => resolveClerkVerificationConfig(env(overrides)))
        .toThrow("Clerk authentication is not configured correctly.");
  });

  it.each([
    "http://localhost:3000/path",
    "*",
    "",
  ])("rejects malformed exact development party %j", (party) => {
    expect(() => resolveClerkVerificationConfig(env({
      DEV: true,
      PUBLIC_BASE_URL: "http://localhost:8787",
      CLERK_DEV_AUTHORIZED_PARTIES: party,
    }))).toThrow("Clerk authentication is not configured correctly.");
  });
});

describe("verifyClerkIdentity", () => {
  it("passes fixed SDK options, prefers the local JWT key, and returns bounded identity data", async () => {
    const deps = dependencies();
    const result = await verifyClerkIdentity(TOKEN, env({
      CLERK_JWT_KEY: "-----BEGIN PUBLIC KEY-----\nbG9jYWw=\n-----END PUBLIC KEY-----",
    }), deps);

    expect(result).toEqual({
      subject: "user_stable123",
      email: "verified@example.com",
      expiresAt: new Date((NOW + 300) * 1000),
    });
    expect(deps.verifyToken).toHaveBeenCalledWith(TOKEN, expect.objectContaining({
      apiUrl: "https://api.clerk.com",
      authorizedParties: ["https://workshop.example"],
      jwtKey: expect.stringContaining("BEGIN PUBLIC KEY"),
      secretKey: "sk_test_secret",
    }));
    expect(deps.createClient).toHaveBeenCalledWith(expect.objectContaining({
      apiUrl: "https://api.clerk.com",
      telemetry: { disabled: true },
    }));
    expect(deps.getUser).toHaveBeenCalledWith("user_stable123");
  });

  it("independently requires the configured audience to be present and exact", async () => {
    for (const aud of [undefined, "", "wrong", [], ["wrong"], ["expected", ""], 42]) {
      const deps = dependencies(claims({ aud }));
      await expect(verifyClerkIdentity(TOKEN, env({ CLERK_JWT_AUDIENCE: "expected" }), deps))
          .rejects.toThrow("Clerk identity could not be verified.");
    }

    await expect(verifyClerkIdentity(
      TOKEN,
      env({ CLERK_JWT_AUDIENCE: "expected" }),
      dependencies(claims({ aud: "expected" })),
    )).resolves.toMatchObject({ subject: "user_stable123" });
    await expect(verifyClerkIdentity(
      TOKEN,
      env({ CLERK_JWT_AUDIENCE: "expected" }),
      dependencies(claims({ aud: ["other", "expected"] })),
    )).resolves.toMatchObject({ subject: "user_stable123" });
  });

  it.each([
    { iss: undefined },
    { iss: `http://${FRONTEND_API}` },
    { iss: `${ISSUER}/path` },
    { iss: "https://happy-otter-12.clerk.accounts.dev.attacker.example" },
    { azp: undefined },
    { azp: "https://workshop.example.attacker.example" },
    { sid: undefined },
    { sid: "not-a-session" },
    { sub: undefined },
    { sub: "not-a-user" },
  ])("rejects independently invalid required session claims %#", async (claimOverrides) => {
    await expect(verifyClerkIdentity(TOKEN, env(), dependencies(claims(claimOverrides))))
        .rejects.toThrow("Clerk identity could not be verified.");
  });

  it.each([
    null,
    { emailAddress: "verified@example.com", verification: null },
    { emailAddress: "verified@example.com", verification: { status: "unverified" } },
    { emailAddress: "", verification: { status: "verified" } },
  ])("rejects missing, unverified, or malformed primary email %#", async (primaryEmailAddress) => {
    const deps = dependencies(claims(), { id: "user_stable123", primaryEmailAddress });
    await expect(verifyClerkIdentity(TOKEN, env(), deps))
        .rejects.toThrow("Clerk identity could not be verified.");
  });

  it("does not trust an API profile for a different subject", async () => {
    const deps = dependencies(claims(), {
      id: "user_other",
      primaryEmailAddress: {
        emailAddress: "verified@example.com",
        verification: { status: "verified" },
      },
    });
    await expect(verifyClerkIdentity(TOKEN, env(), deps))
        .rejects.toThrow("Clerk identity could not be verified.");
  });

  it("never logs the token or provider profile", async () => {
    const spies = ["debug", "info", "log", "warn", "error"].map(method =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined));
    const profileMarker = "private-profile-marker";
    const deps = dependencies(claims(), {
      id: "user_stable123",
      privateMetadata: { marker: profileMarker },
      primaryEmailAddress: {
        emailAddress: "verified@example.com",
        verification: { status: "verified" },
      },
    });

    await verifyClerkIdentity(TOKEN, env(), deps);

    const output = spies.flatMap(spy => spy.mock.calls.flat()).join(" ");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(profileMarker);
    for (const spy of spies) spy.mockRestore();
  });
});

describe("ServerConfig Clerk mode", () => {
  const blueprints = { get: vi.fn().mockResolvedValue(null) };

  it("includes the runtime publishable key in normal Clerk mode", async () => {
    const config = await getServerConfig({ ...env(), BLUEPRINTS: blueprints } as unknown as Cloudflare.Env);
    expect(config.clerkPublishableKey).toBe(PUBLISHABLE_KEY);
  });

  it("omits the Clerk publishable key in Cloudflare Access mode", async () => {
    const config = await getServerConfig({
      BLUEPRINTS: blueprints,
      CF_ACCESS_AUD: "access-audience",
    } as unknown as Cloudflare.Env);
    expect(config.clerkPublishableKey).toBeUndefined();
  });
});
