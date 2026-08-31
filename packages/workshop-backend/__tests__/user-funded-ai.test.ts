import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConnectionStatus,
  resolveConnection,
} from "../src/ai-gateway-billing/cloudflare/connection-service.js";
import {
  checkUsageAndBalance,
  getUsageInfo,
} from "../src/ai-gateway-billing/limits/usage-checker.js";
import { getServerConfig } from "../src/deployment-config.js";
import {
  checkAgentUsageAndBalance,
  rejectCallbacksOnUsageBlock,
} from "../src/overseer.js";

vi.mock("../src/ai-gateway-billing/cloudflare/connection-service.js", () => ({
  getConnectionStatus: vi.fn(),
  resolveConnection: vi.fn(),
}));

const requiredEnv = {
  REQUIRE_USER_FUNDED_AI: "true",
} as Cloudflare.Env;

const userStub = {
  checkDailyLlmCount: vi.fn(),
  consumeDailyLlmCall: vi.fn(),
} as unknown as DurableObjectStub<import("../src/user.js").UserDurableObject>;

describe("required user funding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userStub.checkDailyLlmCount).mockResolvedValue({
      withinLimits: true,
      remaining: 100,
      limit: 100,
      used: 0,
      resetAt: "2026-08-21T00:00:00.000Z",
    });
  });

  it("blocks without consuming a platform allowance", async () => {
    vi.mocked(resolveConnection).mockResolvedValue({
      status: { connected: false, balance: null },
    });

    const result = await checkUsageAndBalance(requiredEnv, userStub);

    expect(result.allowed).toBe(false);
    expect(result.shouldUseByok).toBe(true);
    expect(userStub.consumeDailyLlmCall).not.toHaveBeenCalled();
  });

  it("reports that user funding is required without reading a daily quota", async () => {
    vi.mocked(getConnectionStatus).mockResolvedValue({ connected: false, balance: null });

    const result = await getUsageInfo(requiredEnv, userStub);

    expect(result.cloudflareLimitsEnabled).toBe(true);
    expect(result.userFundingRequired).toBe(true);
    expect(result.dailyLimit).toBe(0);
    expect(userStub.checkDailyLlmCount).not.toHaveBeenCalled();
  });

  it("checks funding against the agent initiator rather than the workspace owner", async () => {
    const initiatorStub = {
      checkDailyLlmCount: vi.fn(),
      consumeDailyLlmCall: vi.fn(),
    } as unknown as DurableObjectStub<import("../src/user.js").UserDurableObject>;
    const users = {
      idFromString: vi.fn().mockReturnValue("initiator-id"),
      get: vi.fn().mockReturnValue(initiatorStub),
    };
    vi.mocked(resolveConnection).mockResolvedValue({
      status: { connected: true, accountId: "account-id", balance: 10 },
      accessToken: "user-token",
      accountId: "account-id",
    });

    const result = await checkAgentUsageAndBalance(
      requiredEnv,
      users as unknown as DurableObjectNamespace<import("../src/user.js").UserDurableObject>,
      "initiator-user-do-id",
    );

    expect(result.usage.allowed).toBe(true);
    expect(users.idFromString).toHaveBeenCalledWith("initiator-user-do-id");
    expect(users.get).toHaveBeenCalledWith("initiator-id");
  });

  it("rejects active callbacks when a continuation is blocked", () => {
    const rejectAllAgentCallbacks = vi.fn();

    rejectCallbacksOnUsageBlock(
      true,
      "Connect and fund your account.",
      rejectAllAgentCallbacks,
    );

    expect(rejectAllAgentCallbacks).toHaveBeenCalledWith(
      "Connect and fund your account.",
    );
  });

  it("enables billing controls in the public server config", async () => {
    const env = {
      REQUIRE_USER_FUNDED_AI: "true",
      BLUEPRINTS: { get: vi.fn().mockResolvedValue(null) },
    } as unknown as Cloudflare.Env;

    const result = await getServerConfig(env);

    expect(result.cloudflareLimitsEnabled).toBe(true);
  });
});
