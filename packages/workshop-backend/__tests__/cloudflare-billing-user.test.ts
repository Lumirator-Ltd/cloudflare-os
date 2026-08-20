import { describe, expect, it, vi } from "vitest";
import { UserDurableObject } from "../src/user.js";

describe("UserDurableObject Cloudflare credit cache", () => {
  it("does not update credits after the selected account changes", async () => {
    const put = vi.fn();
    const user = Object.assign(Object.create(UserDurableObject.prototype), {
      storage: {
        cloudflareBilling: {
          get: vi.fn().mockReturnValue({
            accountId: "account-b",
            accountName: "Account B",
            creditsRemaining: 10,
            creditsUpdatedAt: Date.now(),
          }),
          put,
        },
      },
    }) as UserDurableObject;

    await user.updateCloudflareCredits(null, "account-a");

    expect(put).not.toHaveBeenCalled();
  });
});
