import { describe, expect, it } from "vitest";
import { enAdmin } from "./locales/en/admin";
import { jaAdmin } from "./locales/ja/admin";

function leafPaths(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("Workshop admin and catalog localization", () => {
  it("keeps the Japanese admin catalog structurally complete", () => {
    expect(leafPaths(jaAdmin)).toEqual(leafPaths(enAdmin));
    expect(leafPaths(enAdmin).length).toBeGreaterThan(200);
  });

  it("provides Japanese copy for every requested UI surface", () => {
    expect(jaAdmin.settings.profile.title).toBe("プロフィール");
    expect(jaAdmin.admin.title).toBe("管理");
    expect(jaAdmin.adminConnectors.title).toBe("コネクター設定");
    expect(jaAdmin.models.add.title).toBe("AI モデルを追加");
    expect(jaAdmin.blueprints.explore.title).toBe("探索");
    expect(jaAdmin.formats.admin.title).toBe("標準フォーマット");
    expect(jaAdmin.billing.usage.freeAllowance).toBe("1 日の無料利用枠");
    expect(jaAdmin.gatekeepers.page.title).toBe("ゲートキーパー");
    expect(jaAdmin.providers.title).toBe("AI プロバイダー");
    expect(jaAdmin.context.title).toBe("コンテキストとスキル");
    expect(jaAdmin.sandbox.resourceConfiguratorTitle).toBe("リソース設定ツール");
  });

  it("uses whole-message templates for Japanese count and status grammar", () => {
    expect(jaAdmin.blueprints.landing.configureRemaining).toBe("残り {{count}} 件の接続を設定");
    expect(jaAdmin.admin.validation.tooLongBy).toBe("{{count}} 文字超過しています");
    expect(jaAdmin.billing.reset.daysHours).toBe("{{days}}日 {{hours}}時間後にリセット");
  });
});
