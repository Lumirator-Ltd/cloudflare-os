// @ts-expect-error Vitest provides Node.js, while the frontend tsconfig intentionally omits its types.
import { readFileSync } from "node:fs";
// @ts-expect-error Vitest provides Node.js, while the frontend tsconfig intentionally omits its types.
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import { enAdmin } from "./locales/en/admin";
import { jaAdmin } from "./locales/ja/admin";

function leafEntries(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    leafEntries(child, prefix ? `${prefix}.${key}` : key),
  );
}

function leafPaths(value: unknown): string[] {
  return leafEntries(value).map(([path]) => path);
}

const intentionalJapaneseEqualsEnglish = new Set<string>([
  "models.apiUrl",
]);

const adminProductionFiles = [
  "AddModelModal.tsx",
  "AdminConnectorsPage.tsx",
  "AdminPage.tsx",
  "BlueprintLandingPage.tsx",
  "BlueprintModal.tsx",
  "BlueprintsPage.tsx",
  "ConnectAccountModal.tsx",
  "GatekeeperAppPage.tsx",
  "GatekeeperModal.tsx",
  "ObserverConfigModal.tsx",
  "ResourceConfiguratorHost.tsx",
  "ResourcePicker.tsx",
  "SandboxedGatekeeperApp.tsx",
  "SandboxedResourceConfigurator.tsx",
  "SettingsPage.tsx",
  "components/BlueprintCard.tsx",
  "components/BlueprintList.tsx",
  "components/BlueprintPreviewImage.tsx",
  "components/ConnectConnectorModal.tsx",
  "components/billing/AccountSelectionModal.tsx",
  "components/billing/OutOfCreditsModal.tsx",
  "components/billing/ResetCountdown.tsx",
  "components/billing/UsageSettings.tsx",
  "components/format/AdminFormatsPanel.tsx",
  "components/format/NewFormatRow.tsx",
  "components/format/useOutputFormats.ts",
  "connectorReadiness.ts",
  "gatekeeper-modal/AccountChooser.tsx",
  "gatekeeper-modal/AgentSpawnerConfigForm.tsx",
  "gatekeeper-modal/AiModelConnectionConfig.tsx",
  "gatekeeper-modal/ConnectionConfigField.tsx",
  "routes/blueprints.tsx",
  "routes/context.tsx",
  "routes/gatekeepers.tsx",
  "routes/providers.tsx",
] as const;

const intentionalEnglishSourceLiterals = new Set([
  "AddModelModal.tsx::http://localhost:11434",
  "AddModelModal.tsx::https://...",
  "BlueprintLandingPage.tsx::&times;",
  "components/billing/OutOfCreditsModal.tsx::USD",
  "components/billing/UsageSettings.tsx::USD",
  "routes/gatekeepers.tsx::expired",
  "SandboxedGatekeeperApp.tsx::Gatekeeper app",
  "SandboxedGatekeeperApp.tsx::Invalid workspace title lookup.",
  "SandboxedResourceConfigurator.tsx::Resource configurator",
]);

const visibleAttributes = new Set([
  "alt",
  "aria-label",
  "aria-description",
  "description",
  "emptyText",
  "helperText",
  "label",
  "placeholder",
  "title",
]);

function englishText(value: string): boolean {
  return /[A-Za-z]{2}/.test(value);
}

function auditProductionEnglish(): string[] {
  const srcDirectory = fileURLToPath(new URL("../", import.meta.url));
  const englishValues = new Set(leafEntries(enAdmin).map(([, value]) => value));
  const findings = new Set<string>();

  for (const relativePath of adminProductionFiles) {
    const sourcePath = `${srcDirectory}${relativePath}`;
    const source = ts.createSourceFile(
      relativePath,
      readFileSync(sourcePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const addFinding = (node: ts.Node, value: string) => {
      const normalized = value.replace(/\s+/g, " ").trim();
      if (!englishText(normalized)) return;
      const allowlistKey = `${relativePath}::${normalized}`;
      if (intentionalEnglishSourceLiterals.has(allowlistKey)) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.add(`${relativePath}:${line + 1}: ${normalized}`);
    };

    const auditRenderedExpression = (node: ts.Expression) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        addFinding(node, node.text);
      } else if (ts.isTemplateExpression(node)) {
        addFinding(node.head, node.head.text);
        for (const span of node.templateSpans) addFinding(span.literal, span.literal.text);
      } else if (ts.isConditionalExpression(node)) {
        auditRenderedExpression(node.whenTrue);
        auditRenderedExpression(node.whenFalse);
      } else if (ts.isBinaryExpression(node)) {
        if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) auditRenderedExpression(node.left);
        auditRenderedExpression(node.right);
      } else if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node)
      ) {
        auditRenderedExpression(node.expression);
      }
    };

    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        addFinding(node, node.text);
      } else if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.getText(source))) {
        const initializer = node.initializer;
        if (initializer && ts.isStringLiteral(initializer)) {
          addFinding(initializer, initializer.text);
        } else if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
          auditRenderedExpression(initializer.expression);
        }
      } else if (
        ts.isJsxExpression(node) &&
        node.expression &&
        !ts.isJsxAttribute(node.parent)
      ) {
        auditRenderedExpression(node.expression);
      } else if (
        relativePath.endsWith(".tsx") &&
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        englishValues.has(node.text)
      ) {
        addFinding(node, node.text);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return [...findings].sort();
}

describe("Workshop admin and catalog localization", () => {
  it("keeps the Japanese admin catalog structurally complete", () => {
    expect(leafPaths(jaAdmin)).toEqual(leafPaths(enAdmin));
    expect(leafPaths(enAdmin).length).toBeGreaterThan(200);
  });

  it("has no unintended English fallback leaves in the Japanese catalog", () => {
    const englishLeaves = new Map(leafEntries(enAdmin));
    const untranslated = leafEntries(jaAdmin).filter(
      ([path, value]) => englishLeaves.get(path) === value && !intentionalJapaneseEqualsEnglish.has(path),
    );

    expect(untranslated).toEqual([]);
  });

  it("has no static visible English in the authorized admin production files", () => {
    expect(auditProductionEnglish()).toEqual([]);
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
