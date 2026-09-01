import { afterEach, describe, expect, it, vi } from "vitest";
import { getGoogleVerifiedEmail } from "../src/google-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubUserInfo(body: unknown): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("getGoogleVerifiedEmail", () => {
  it("returns a provider-verified email", async () => {
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
