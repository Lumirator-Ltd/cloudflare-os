import { describe, expect, it, vi } from "vitest";
import {
  accessRateLimitKey,
  verifiedCfAccessIdentity,
  verifyCfAccessJwt,
} from "../src/access.js";

const joseMocks = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn().mockResolvedValue({ payload: { sub: "user-1" } }),
}));

vi.mock("jose", () => joseMocks);

const accessEnv = {
  CF_ACCESS_AUD: "workshop-audience",
  CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
};

describe("verifyCfAccessJwt", () => {
  it("passes the exact configured issuer and audience to JWT verification", async () => {
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

describe("verifiedCfAccessIdentity", () => {
  const now = Date.UTC(2026, 0, 1);
  const validClaims = {
    sub: "access-user-1",
    email: "Person@Example.com",
    exp: Math.floor(now / 1_000) + 60,
  };

  it("preserves only a complete verified Access identity context", () => {
    expect(verifiedCfAccessIdentity(validClaims, accessEnv, now)).toEqual({
      subject: validClaims.sub,
      email: validClaims.email,
      expiresAt: new Date(validClaims.exp * 1_000),
      issuer: accessEnv.CF_ACCESS_ISS,
      audience: accessEnv.CF_ACCESS_AUD,
    });
  });

  it.each([
    ["missing subject", { ...validClaims, sub: undefined }],
    ["blank subject", { ...validClaims, sub: "  " }],
    ["missing email", { ...validClaims, email: undefined }],
    ["blank email", { ...validClaims, email: "\t" }],
    ["missing expiry", { ...validClaims, exp: undefined }],
    ["non-numeric expiry", { ...validClaims, exp: "later" }],
    ["fractional expiry", { ...validClaims, exp: validClaims.exp + 0.5 }],
    ["infinite expiry", { ...validClaims, exp: Number.POSITIVE_INFINITY }],
    ["expiry outside the JavaScript Date range", { ...validClaims, exp: 8_640_000_000_001 }],
    ["expired assertion", { ...validClaims, exp: Math.floor(now / 1_000) }],
  ])("rejects a verified payload with %s", (_name, claims) => {
    expect(verifiedCfAccessIdentity(claims, accessEnv, now)).toBeNull();
  });

  it("rejects identity context without configured issuer and audience", () => {
    expect(verifiedCfAccessIdentity(validClaims, {
      CF_ACCESS_ISS: accessEnv.CF_ACCESS_ISS,
    }, now)).toBeNull();
    expect(verifiedCfAccessIdentity(validClaims, {
      CF_ACCESS_AUD: accessEnv.CF_ACCESS_AUD,
    }, now)).toBeNull();
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
