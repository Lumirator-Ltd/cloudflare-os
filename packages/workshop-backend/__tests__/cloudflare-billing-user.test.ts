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

  it("reconnects the Cloudflare account used by billing", async () => {
    const reconnectAccount = vi.fn().mockResolvedValue({ url: "https://connect.example" });
    const user = Object.assign(Object.create(UserDurableObject.prototype), {
      reconnectAccount,
      storage: {
        nextAccountId: { get: vi.fn().mockReturnValue(3) },
        connectedAccounts: {
          get: vi.fn((id: number) => id === 1
            ? { id, vendorId: "cloudflare" }
            : undefined),
        },
      },
    }) as UserDurableObject;

    await expect(user.reconnectCloudflareBillingAccount()).resolves.toEqual({
      url: "https://connect.example",
    });
    expect(reconnectAccount).toHaveBeenCalledWith(1);
  });
});
