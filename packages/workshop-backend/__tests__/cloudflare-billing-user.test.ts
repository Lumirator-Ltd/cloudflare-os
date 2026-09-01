import { describe, expect, it, vi } from "vitest";
import { checkAgentUsageAndBalance } from "../src/overseer.js";
import { UserDurableObject } from "../src/user.js";

const USER_DO_ID = "a".repeat(64);

describe("user-funded billing route", () => {
  it("reconstructs the configured model provider's user from the canonical User DO ID", async () => {
    const user = {};
    const users = {
      idFromString: vi.fn().mockReturnValue("user-route"),
      idFromName: vi.fn(() => { throw new Error("presentation lookup used for persisted route"); }),
      get: vi.fn().mockReturnValue(user),
    };

    const result = await checkAgentUsageAndBalance({} as Cloudflare.Env, users as never, USER_DO_ID);

    expect(users.idFromString).toHaveBeenCalledExactlyOnceWith(USER_DO_ID);
    expect(users.idFromName).not.toHaveBeenCalled();
    expect(result.userStub).toBe(user);
    expect(result.usage.allowed).toBe(true);
  });
});

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
