import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshCachedBalance } from "../src/ai-gateway-billing/cloudflare/connection-service.js";
import { getRequiredUserGatewayRouting } from "../src/ai-gateway-billing/limits/usage-checker.js";
import { completeText } from "../src/ai-invoke.js";
import { LanguageModelGatekeeper } from "../src/ai-models.js";

vi.mock("../src/ai-gateway-billing/cloudflare/connection-service.js", () => ({
  refreshCachedBalance: vi.fn(),
}));

vi.mock("../src/ai-gateway-billing/limits/usage-checker.js", () => ({
  getRequiredUserGatewayRouting: vi.fn(),
}));

vi.mock("../src/ai-invoke.js", () => ({
  completeText: vi.fn().mockResolvedValue("result"),
}));

describe("LanguageModelGatekeeper required user funding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts a funded model binding through the user's gateway", async () => {
    const userStub = {};
    const users = {
      idFromString: vi.fn().mockReturnValue("durable-user-id"),
      get: vi.fn().mockReturnValue(userStub),
    };
    vi.mocked(getRequiredUserGatewayRouting).mockResolvedValue({
      accountId: "account-id",
      apiKey: "user-token",
    });

    const gatekeeper = Object.assign(Object.create(LanguageModelGatekeeper.prototype), {
      env: {
        REQUIRE_USER_FUNDED_AI: "true",
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "platform-account",
        CF_AI_GATEWAY_API_TOKEN: "platform-token",
      },
      ctx: {
        props: {
          userId: "user-do-id",
          displayName: "Claude",
          config: {
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            apiToken: "ignored",
          },
          initiator: { type: "gadget", id: "profile-id", name: "Gadget" },
          metadata: { source: "model-binding", gadgetId: "gadget-id" },
        },
        exports: { UserDurableObject: users },
      },
    }) as LanguageModelGatekeeper;

    const binding = await gatekeeper.startSession({} as never);
    await expect(binding.run({ prompt: "hello" })).resolves.toBe("result");
    expect(users.idFromString).toHaveBeenCalledWith("user-do-id");
    expect(getRequiredUserGatewayRouting).toHaveBeenCalledWith(
      expect.objectContaining({ REQUIRE_USER_FUNDED_AI: "true" }),
      userStub,
    );
    expect(refreshCachedBalance).toHaveBeenCalledWith(
      expect.objectContaining({ REQUIRE_USER_FUNDED_AI: "true" }),
      userStub,
    );
  });

  it("revalidates funding before every run in a reusable session", async () => {
    const userStub = {};
    const users = {
      idFromString: vi.fn().mockReturnValue("durable-user-id"),
      get: vi.fn().mockReturnValue(userStub),
    };
    vi.mocked(getRequiredUserGatewayRouting)
      .mockResolvedValueOnce({ accountId: "account-id", apiKey: "user-token" })
      .mockRejectedValueOnce(new Error("Add AI Gateway credits to continue."));

    const gatekeeper = Object.assign(Object.create(LanguageModelGatekeeper.prototype), {
      env: { REQUIRE_USER_FUNDED_AI: "true", CF_AI_GATEWAY: "platform-gateway" },
      ctx: {
        props: {
          userId: "user-do-id",
          displayName: "Claude",
          config: { provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "ignored" },
          initiator: { type: "gadget", id: "profile-id", name: "Gadget" },
        },
        exports: { UserDurableObject: users },
      },
    }) as LanguageModelGatekeeper;

    const binding = await gatekeeper.startSession({} as never);
    await expect(binding.run({ prompt: "first" })).resolves.toBe("result");
    await expect(binding.run({ prompt: "second" }))
      .rejects.toThrow("Add AI Gateway credits to continue.");
    expect(getRequiredUserGatewayRouting).toHaveBeenCalledTimes(2);
    expect(completeText).toHaveBeenCalledTimes(1);
  });

  it("resolves legacy model bindings through the initiator profile", async () => {
    const userStub = {};
    const users = {
      idFromName: vi.fn().mockReturnValue("legacy-user-id"),
      get: vi.fn().mockReturnValue(userStub),
    };
    vi.mocked(getRequiredUserGatewayRouting).mockResolvedValue({
      accountId: "account-id",
      apiKey: "user-token",
    });

    const gatekeeper = Object.assign(Object.create(LanguageModelGatekeeper.prototype), {
      env: {
        REQUIRE_USER_FUNDED_AI: "true",
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "platform-account",
        CF_AI_GATEWAY_API_TOKEN: "platform-token",
      },
      ctx: {
        props: {
          displayName: "Claude",
          config: {
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            apiToken: "ignored",
          },
          initiator: { type: "gadget", id: "legacy-profile-id", name: "Gadget" },
        },
        exports: { UserDurableObject: users },
      },
    }) as LanguageModelGatekeeper;

    const binding = await gatekeeper.startSession({} as never);
    await expect(binding.run({ prompt: "hello" })).resolves.toBe("result");
    expect(users.idFromName).toHaveBeenCalledWith("legacy-profile-id");
    expect(getRequiredUserGatewayRouting).toHaveBeenCalledWith(
      expect.objectContaining({ REQUIRE_USER_FUNDED_AI: "true" }),
      userStub,
    );
  });
});
