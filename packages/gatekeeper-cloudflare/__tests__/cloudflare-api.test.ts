import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchIdentity } from "../src/cloudflare-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubIdentity(result: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result })));
}

describe("fetchIdentity", () => {
  it("returns the immutable Cloudflare user id and verified account email", async () => {
    stubIdentity({
      id: "stable-cloudflare-user-id",
      email: "person@example.com",
      first_name: "Person",
      last_name: "Example",
    });

    await expect(fetchIdentity("test-token")).resolves.toEqual({
      id: "stable-cloudflare-user-id",
      email: "person@example.com",
      displayName: "Person Example",
    });
  });

  it.each([
    [{ id: "", email: "person@example.com" }],
    [{ id: "   ", email: "person@example.com" }],
    [{ id: "stable-cloudflare-user-id", email: "" }],
    [{ id: "stable-cloudflare-user-id", email: "   " }],
  ])("rejects a missing or blank stable identity field", async (result) => {
    stubIdentity(result);
    await expect(fetchIdentity("test-token")).resolves.toBeNull();
  });
});
