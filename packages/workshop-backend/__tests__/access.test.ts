import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRateLimitKey, verifyCfAccessJwt } from "../src/access.js";
import workshop from "../src/server.js";

const joseMocks = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn().mockResolvedValue({ payload: { sub: "user-1" } }),
}));

vi.mock("jose", () => joseMocks);

const accessEnv = {
  CF_ACCESS_AUD: "workshop-audience",
  CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
};

function workshopRequest(payload: Record<string, unknown>): Promise<Response> {
  joseMocks.jwtVerify.mockResolvedValueOnce({ payload });
  const request = new Request("https://workshop.example/api", {
    headers: {
      Origin: "https://workshop.example",
      "cf-access-jwt-assertion": "signed-token",
    },
  });
  const env = {
    ...accessEnv,
    BLUEPRINTS: { get: vi.fn().mockResolvedValue(null) },
  } as unknown as Cloudflare.Env;
  const ctx = {
    exports: {
      AdminSettings: {
        getByName: vi.fn().mockReturnValue({
          ensureFormatBlueprintsInstalled: vi.fn().mockResolvedValue(true),
        }),
      },
      UserDurableObject: {},
    },
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
  return workshop.fetch(request, env, ctx);
}

beforeEach(() => {
  joseMocks.jwtVerify.mockReset();
});

describe("verifyCfAccessJwt", () => {
  it("passes the exact configured issuer and audience to JWT verification", async () => {
    joseMocks.jwtVerify.mockResolvedValueOnce({ payload: { sub: "user-1" } });
    const request = new Request("https://workshop.example/api", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const exactEnv = {
      CF_ACCESS_ISS: "https://exact-team.cloudflareaccess.com",
      CF_ACCESS_AUD: "exact-workshop-audience",
    };

    await verifyCfAccessJwt(request, exactEnv);

    expect(joseMocks.jwtVerify).toHaveBeenCalledWith(
      "signed-token",
      expect.any(Function),
      {
        issuer: exactEnv.CF_ACCESS_ISS,
        audience: exactEnv.CF_ACCESS_AUD,
      },
    );
  });

  it("reuses the remote JWK set for requests with the same issuer", async () => {
    joseMocks.jwtVerify.mockResolvedValue({ payload: { sub: "user-1" } });
    joseMocks.createRemoteJWKSet.mockClear();
    const request = new Request("https://workshop.example/api", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const otherEnv = {
      ...accessEnv,
      CF_ACCESS_ISS: "https://other-team.cloudflareaccess.com",
    };

    await verifyCfAccessJwt(request, accessEnv);
    await verifyCfAccessJwt(request, accessEnv);
    await verifyCfAccessJwt(request, otherEnv);

    expect(joseMocks.createRemoteJWKSet).toHaveBeenCalledTimes(2);
    expect(joseMocks.createRemoteJWKSet).toHaveBeenNthCalledWith(
      1, new URL("https://team.cloudflareaccess.com/cdn-cgi/access/certs"),
    );
    expect(joseMocks.createRemoteJWKSet).toHaveBeenNthCalledWith(
      2, new URL("https://other-team.cloudflareaccess.com/cdn-cgi/access/certs"),
    );
  });

  it("rejects missing and invalid assertions", async () => {
    const requestWithoutToken = new Request("https://workshop.example/api/client-errors");
    const verifier = vi.fn();
    const missing = await verifyCfAccessJwt(requestWithoutToken, accessEnv, verifier);
    expect(missing).toBeNull();
    expect(verifier).not.toHaveBeenCalled();

    const requestWithToken = new Request("https://workshop.example/api/client-errors", {
      headers: { "cf-access-jwt-assertion": "invalid" },
    });
    verifier.mockRejectedValue(new Error("invalid signature"));
    const invalid = await verifyCfAccessJwt(requestWithToken, accessEnv, verifier);
    expect(invalid).toBeNull();
  });

  it("returns claims only after verification", async () => {
    const request = new Request("https://workshop.example/api", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const verifier = vi.fn().mockResolvedValue({
      sub: "user-1", email: "person@example.com",
    });

    await expect(verifyCfAccessJwt(request, accessEnv, verifier)).resolves.toEqual({
      sub: "user-1", email: "person@example.com",
    });
  });
});

describe("Workshop Access boundary", () => {
  it.each([
    ["missing", {}],
    ["empty", { email: "" }],
    ["null", { email: null }],
    ["zero", { email: 0 }],
    ["false", { email: false }],
  ])("rejects a signed payload with %s email", async (_label, payload) => {
    expect((await workshopRequest(payload)).status).toBe(403);
  });

  it("passes a truthy non-canonical email string through without extra validation", async () => {
    expect((await workshopRequest({ email: "  Not An Email  " })).status).toBe(400);
  });
});

describe("accessRateLimitKey", () => {
  it("uses the verified subject and hashes email only as a fallback", async () => {
    await expect(accessRateLimitKey({ sub: "user-1", email: "person@example.com" }))
      .resolves.toBe("access-sub:user-1");
    const emailKey = await accessRateLimitKey({ email: "person@example.com" });
    expect(emailKey).toMatch(/^access-email:[0-9a-f]{64}$/);
    expect(emailKey).not.toContain("person@example.com");
  });
});
