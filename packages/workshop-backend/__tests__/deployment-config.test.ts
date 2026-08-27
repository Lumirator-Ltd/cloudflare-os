import { describe, expect, it } from "vitest";
import { getServerConfig } from "../src/deployment-config.js";

function environment(defaultLanguage?: string): Cloudflare.Env {
  return {
    ...(defaultLanguage === undefined ? {} : { DEFAULT_LANGUAGE: defaultLanguage }),
    BLUEPRINTS: { get: async () => null },
  } as unknown as Cloudflare.Env;
}

describe("deployment language configuration", () => {
  it("defaults to English when DEFAULT_LANGUAGE is absent", async () => {
    await expect(getServerConfig(environment())).resolves.toMatchObject({
      defaultLanguage: "en",
    });
  });

  it.each(["en", "ja"])("accepts DEFAULT_LANGUAGE=%s", async defaultLanguage => {
    await expect(getServerConfig(environment(defaultLanguage))).resolves.toMatchObject({
      defaultLanguage,
    });
  });

  it("rejects an unsupported DEFAULT_LANGUAGE", async () => {
    await expect(getServerConfig(environment("fr"))).rejects.toThrow(
      'Unsupported DEFAULT_LANGUAGE "fr"; expected "en" or "ja".',
    );
  });
});
