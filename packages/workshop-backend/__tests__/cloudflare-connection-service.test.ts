import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCreditBalance,
  listAccounts,
} from "../src/ai-gateway-billing/cloudflare/account-service.js";
import {
  listConnectedAccounts,
  refreshCachedBalance,
  resolveConnection,
  selectAccount,
} from "../src/ai-gateway-billing/cloudflare/connection-service.js";

vi.mock("../src/ai-gateway-billing/cloudflare/account-service.js", () => ({
  fetchCreditBalance: vi.fn(),
  listAccounts: vi.fn(),
}));

describe("resolveConnection balance cache", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not reuse an expired positive balance when refresh fails", async () => {
    const account = {
      getUsableAccessToken: vi.fn().mockResolvedValue("user-token"),
      [Symbol.dispose]: vi.fn(),
    };
    const userStub = {
      getCloudflareGatekeeperAccount: vi.fn().mockResolvedValue(account),
      getCloudflareBilling: vi.fn().mockResolvedValue({
        accountId: "account-id",
        creditsRemaining: 12.5,
        creditsUpdatedAt: 0,
      }),
      updateCloudflareCredits: vi.fn(),
    };
    vi.mocked(fetchCreditBalance).mockResolvedValue(null);

    const result = await resolveConnection(
      {} as Cloudflare.Env,
      userStub as unknown as DurableObjectStub<import("../src/user.js").UserDurableObject>,
    );

    expect(result.status).toMatchObject({
      connected: true,
      accountId: "account-id",
      balance: null,
    });
    expect(userStub.updateCloudflareCredits).not.toHaveBeenCalled();
  });

  it("excludes the platform account when auto-resolving and listing accounts", async () => {
    const account = {
      getUsableAccessToken: vi.fn().mockResolvedValue("user-token"),
      [Symbol.dispose]: vi.fn(),
    };
    const userStub = {
      getCloudflareGatekeeperAccount: vi.fn().mockResolvedValue(account),
      getCloudflareBilling: vi.fn().mockResolvedValue({
        accountId: "platform-account",
        accountName: "Platform",
        creditsRemaining: 99,
        creditsUpdatedAt: Date.now(),
      }),
      setCloudflareAccountSelection: vi.fn(),
      updateCloudflareCredits: vi.fn(),
    };
    vi.mocked(listAccounts).mockResolvedValue([
      { accountId: "platform-account", accountName: "Platform" },
      { accountId: "customer-account", accountName: "Customer" },
    ]);
    vi.mocked(fetchCreditBalance).mockResolvedValue(10);
    const env = { CF_AI_GATEWAY_ACCOUNT_ID: "platform-account" } as Cloudflare.Env;

    const resolved = await resolveConnection(
      env,
      userStub as unknown as DurableObjectStub<import("../src/user.js").UserDurableObject>,
    );
    const listed = await listConnectedAccounts(
      env,
      userStub as unknown as DurableObjectStub<import("../src/user.js").UserDurableObject>,
    );

    expect(resolved.status).toMatchObject({
      accountId: "customer-account",
      balance: 10,
    });
    expect(userStub.setCloudflareAccountSelection).toHaveBeenCalledWith(
      "customer-account",
      "Customer",
    );
    expect(listed).toEqual([
      { accountId: "customer-account", accountName: "Customer" },
    ]);
  });

  it("rejects manual selection of the platform account", async () => {
    const account = {
      getUsableAccessToken: vi.fn().mockResolvedValue("user-token"),
      [Symbol.dispose]: vi.fn(),
    };
    const userStub = {
      getCloudflareGatekeeperAccount: vi.fn().mockResolvedValue(account),
      setCloudflareAccountSelection: vi.fn(),
    };
    vi.mocked(listAccounts).mockResolvedValue([
      { accountId: "platform-account", accountName: "Platform" },
    ]);

    await expect(selectAccount(
      { CF_AI_GATEWAY_ACCOUNT_ID: "platform-account" } as Cloudflare.Env,
      userStub as unknown as DurableObjectStub<import("../src/user.js").UserDurableObject>,
      "platform-account",
    )).rejects.toThrow("platform Cloudflare account cannot fund user inference");
    expect(userStub.setCloudflareAccountSelection).not.toHaveBeenCalled();
  });

  it("invalidates a positive cache when required-mode refresh fails", async () => {
    const account = {
      getUsableAccessToken: vi.fn().mockResolvedValue("user-token"),
      [Symbol.dispose]: vi.fn(),
    };
    const userStub = {
      getCloudflareGatekeeperAccount: vi.fn().mockResolvedValue(account),
      getCloudflareBilling: vi.fn().mockResolvedValue({
        accountId: "customer-account",
        creditsRemaining: 10,
        creditsUpdatedAt: Date.now(),
      }),
      updateCloudflareCredits: vi.fn(),
    };
    vi.mocked(fetchCreditBalance).mockResolvedValue(null);

    await refreshCachedBalance(
      { REQUIRE_USER_FUNDED_AI: "true" } as Cloudflare.Env,
      userStub as unknown as DurableObjectStub<import("../src/user.js").UserDurableObject>,
    );

    expect(userStub.updateCloudflareCredits).toHaveBeenCalledWith(
      null,
      "customer-account",
    );
  });
});
