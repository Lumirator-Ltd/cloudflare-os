import { afterEach, describe, expect, it, vi } from "vitest";
import { getGoogleAuthenticationIdentity } from "../src/google-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubUserInfo(body: unknown): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

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
