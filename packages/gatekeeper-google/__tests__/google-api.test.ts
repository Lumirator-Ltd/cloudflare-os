import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGoogleAuthenticationIdentity,
  getGoogleVerifiedEmail,
} from "../src/google-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubUserInfo(body: unknown): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("getGoogleVerifiedEmail", () => {
  it("returns a provider-verified email without requiring a stable subject", async () => {
    stubUserInfo({
      email: "verified@example.com",
      email_verified: true,
    });

    expect(await getGoogleVerifiedEmail("test-token")).toBe("verified@example.com");
  });

  it("rejects an email Google reports as unverified", async () => {
    stubUserInfo({
      email: "unverified@example.com",
      email_verified: false,
    });

    await expect(getGoogleVerifiedEmail("test-token")).resolves.toBeNull();
  });
});

describe("getGoogleAuthenticationIdentity", () => {
  it("returns the stable Google subject and verified email from one userinfo fetch", async () => {
    const fetch = stubUserInfo({
      sub: "stable-google-subject",
      email: "person@example.com",
      email_verified: true,
      name: "Mutable display name",
    });

    await expect(getGoogleAuthenticationIdentity("test-token")).resolves.toEqual({
      subject: "stable-google-subject",
      verifiedEmail: "person@example.com",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ email: "person@example.com", email_verified: true }],
    [{ sub: "", email: "person@example.com", email_verified: true }],
    [{ sub: "   ", email: "person@example.com", email_verified: true }],
    [{ sub: "stable-google-subject", email: "", email_verified: true }],
    [{ sub: "stable-google-subject", email: "   ", email_verified: true }],
    [{ sub: "stable-google-subject", email: "person@example.com", email_verified: false }],
    [{ sub: "stable-google-subject", email: "person@example.com" }],
  ])("rejects an incomplete or unverified userinfo identity", async (body) => {
    stubUserInfo(body);
    await expect(getGoogleAuthenticationIdentity("test-token")).resolves.toBeNull();
  });
});
