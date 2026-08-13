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
    sts: "active",
    azp: "https://workshop.example",
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 290,
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
    },
    session: Record<string, unknown> = {
      id: "sess_active123",
      userId: "user_stable123",
      status: "active",
    }) {
  const verifyToken = vi.fn().mockResolvedValue(tokenClaims);
  const getSession = vi.fn().mockResolvedValue(session);
  const getUser = vi.fn().mockResolvedValue(user);
  const createClient = vi.fn().mockReturnValue({ sessions: { getSession }, users: { getUser } });
  return { verifyToken, createClient, getSession, getUser };
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

    for (const DEV of [undefined, false, "true", 1]) {
      const production = env({
        DEV,
        CLERK_DEV_AUTHORIZED_PARTIES: "https://attacker.example",
      });
      expect(resolveClerkVerificationConfig(production).authorizedParties)
          .toEqual(["https://workshop.example"]);
    }
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
      expiresAt: new Date((NOW + 290) * 1000),
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
    expect(deps.getSession).toHaveBeenCalledWith("sess_active123");
    expect(deps.getUser).toHaveBeenCalledWith("user_stable123");
  });

  it.each([undefined, "pending", "ended", "revoked", "unknown", null])(
    "requires exact active token session status %j",
    async (sts) => {
      await expect(verifyClerkIdentity(TOKEN, env(), dependencies(claims({ sts }))))
          .rejects.toThrow("Clerk identity could not be verified.");
    },
  );

  it.each([null, { sub: "user_actor" }, { type: "agent", sub: "agent_123" }])(
    "rejects actor and agent session claims %j",
    async (act) => {
      await expect(verifyClerkIdentity(TOKEN, env(), dependencies(claims({ act }))))
          .rejects.toThrow("Clerk identity could not be verified.");
    },
  );

  it("enforces a 300 second maximum token lifetime", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    try {
      await expect(verifyClerkIdentity(
        TOKEN,
        env(),
        dependencies(claims({ iat: NOW - 10, exp: NOW + 290 })),
      )).resolves.toMatchObject({ subject: "user_stable123" });
      await expect(verifyClerkIdentity(
        TOKEN,
        env(),
        dependencies(claims({ iat: NOW - 10, exp: NOW + 291 })),
      )).rejects.toThrow("Clerk identity could not be verified.");
      await expect(verifyClerkIdentity(
        TOKEN,
        env(),
        dependencies(claims({ iat: NOW, exp: NOW })),
      )).rejects.toThrow("Clerk identity could not be verified.");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("enforces a 300 second maximum token age", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    try {
      await expect(verifyClerkIdentity(
        TOKEN,
        env(),
        dependencies(claims({ iat: NOW - 299, exp: NOW + 1 })),
      )).resolves.toMatchObject({ subject: "user_stable123" });
      await expect(verifyClerkIdentity(
        TOKEN,
        env(),
        dependencies(claims({ iat: NOW - 301, exp: NOW + 1 })),
      )).rejects.toThrow("Clerk identity could not be verified.");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([
    { id: "sess_other", userId: "user_stable123", status: "active" },
    { id: "sess_active123", userId: "user_other", status: "active" },
    { id: "sess_active123", userId: "user_stable123", status: "pending" },
    { id: "sess_active123", userId: "user_stable123", status: "ended" },
    { id: "sess_active123", userId: "user_stable123", status: "revoked" },
  ])("rejects a mismatched or non-active backend session %#", async (session) => {
    await expect(verifyClerkIdentity(TOKEN, env(), dependencies(claims(), undefined, session)))
        .rejects.toThrow("Clerk identity could not be verified.");
  });

  it("rejects a missing backend session with a bounded error", async () => {
    const deps = dependencies();
    deps.getSession.mockRejectedValue(new Error("provider detail must not escape"));
    await expect(verifyClerkIdentity(TOKEN, env(), deps))
        .rejects.toThrow("Clerk identity could not be verified.");
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
