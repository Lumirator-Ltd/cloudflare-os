import { describe, expect, it } from "vitest";
import i18n from "./config";
import { en } from "./locales/en";
import { ja } from "./locales/ja";

function leafPaths(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "object" && child !== null ? leafPaths(child, path) : path;
  });
}

describe("translation catalogs", () => {
  it("keeps Japanese leaf keys in parity with English", () => {
    expect(leafPaths(ja).sort()).toEqual(leafPaths(en).sort());
  });

  it("looks up Japanese translations", () => {
    expect(i18n.t("common.save", { lng: "ja" })).toBe("保存");
  });

  it("falls back to English when a Japanese translation is missing", () => {
    i18n.addResource("en", "translation", "test.englishOnly", "English fallback");

    expect(i18n.t("test.englishOnly", { lng: "ja" })).toBe("English fallback");
  });
});
