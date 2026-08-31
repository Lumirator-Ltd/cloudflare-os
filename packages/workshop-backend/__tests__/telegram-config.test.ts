import { describe, expect, it, vi } from "vitest";
import { getServerConfig } from "../src/deployment-config.js";

function environment(overrides: Record<string, unknown> = {}): Cloudflare.Env {
  return {
    BLUEPRINTS: { get: vi.fn().mockResolvedValue(null) },
    ...overrides,
  } as unknown as Cloudflare.Env;
}

describe("Telegram deployment configuration", () => {
  it("enables Telegram only when both backend secrets are present", async () => {
    await expect(getServerConfig(environment())).resolves.toMatchObject({ telegramEnabled: false });
    await expect(getServerConfig(environment({ TELEGRAM_BOT_TOKEN: "token" })))
      .resolves.toMatchObject({ telegramEnabled: false });
    await expect(getServerConfig(environment({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WEBHOOK_SECRET: "secret",
    }))).resolves.toMatchObject({ telegramEnabled: true });
  });
});
