import { describe, expect, it } from "vitest";
import i18n from "./config";
import { en } from "./locales/en";
import { enAdmin } from "./locales/en/admin";
import { enChat } from "./locales/en/chat";
import { enCommon } from "./locales/en/common";
import { enShell } from "./locales/en/shell";
import { enWorkspace } from "./locales/en/workspace";
import { ja } from "./locales/ja";
import { jaAdmin } from "./locales/ja/admin";
import { jaChat } from "./locales/ja/chat";
import { jaCommon } from "./locales/ja/common";
import { jaShell } from "./locales/ja/shell";
import { jaWorkspace } from "./locales/ja/workspace";

const enDomains = [enCommon, enChat, enShell, enWorkspace, enAdmin];
const jaDomains = [jaCommon, jaChat, jaShell, jaWorkspace, jaAdmin];

function leafPaths(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "object" && child !== null ? leafPaths(child, path) : path;
  });
}

describe("translation catalogs", () => {
  it("composes each locale from matching domain catalogs", () => {
    expect(en).toEqual(Object.assign({}, ...enDomains));
    expect(ja).toEqual(Object.assign({}, ...jaDomains));
  });

  it("keeps Japanese leaf keys in parity with English", () => {
    expect(leafPaths(ja).toSorted()).toEqual(leafPaths(en).toSorted());

    for (const [index, enDomain] of enDomains.entries()) {
      expect(leafPaths(jaDomains[index]).toSorted()).toEqual(leafPaths(enDomain).toSorted());
    }
  });

  it("looks up Japanese translations", () => {
    expect(i18n.t("common.save", { lng: "ja" })).toBe("保存");
  });

  it("falls back to English when a Japanese translation is missing", () => {
    i18n.addResource("en", "translation", "test.englishOnly", "English fallback");

    expect(i18n.t("test.englishOnly", { lng: "ja" })).toBe("English fallback");
  });
});
