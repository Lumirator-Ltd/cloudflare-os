import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript6";

const WORKSHOP_SOURCE_ROOT = "packages/workshop-frontend/src";
const EXCLUDED_DIRECTORIES = new Set(["__tests__", "mocks", "generated"]);
const EXCLUDED_FILES = new Set([
  "components/chat/AppPreview.tsx",
  "components/chat/ChatMessage.tsx",
  "components/chat/ConnectionConfigModal.tsx",
  "components/chat/DataTab.tsx",
  "components/chat/PermissionToast.tsx",
  "components/chat/ToolCallCard.tsx",
  "data/chat.ts",
  "data/sample.ts",
  "routeTree.gen.ts",
]);
const VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "description",
  "emptyText",
  "helperText",
  "label",
  "placeholder",
  "title",
]);
const VISIBLE_OBJECT_PROPERTIES = new Set([
  "description",
  "emptyText",
  "helperText",
  "label",
  "placeholder",
  "title",
]);

const SOURCE_LITERAL_ALLOWLIST = new Set([
  "AddModelModal.tsx::http://localhost:11434",
  "AddModelModal.tsx::https://...",
  "BlueprintLandingPage.tsx::&times;",
  "ChatInterface.tsx::self.",
  "SandboxedGatekeeperApp.tsx::Gatekeeper app",
  "SandboxedResourceConfigurator.tsx::Resource configurator",
  "components/AppShell/CommandPalette.tsx::ESC",
  "components/AppShell/CommandPalette.tsx::esc",
  "components/pickerRows.tsx::Tab",
]);

const CATALOG_EQUALITY_ALLOWLIST = {
  shell: new Set<string>(),
  workspace: new Set([
    "workspace.files.filenamePlaceholder",
    "workspace.presence.participant",
    "workspace.sharing.busy",
    "workspace.workpieces.tooltip",
  ]),
  context: new Set<string>(),
  scheduler: new Set<string>(),
};

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    const relativePath = relative(WORKSHOP_SOURCE_ROOT, path);
    if (!/\.(?:html|tsx?)$/.test(entry.name)) continue;
    if (/\.(?:test|spec)\./.test(entry.name)) continue;
    if (relativePath.startsWith("i18n/locales/")) continue;
    if (EXCLUDED_FILES.has(relativePath)) continue;
    files.push(path);
  }
  return files.toSorted();
}

function normalizedEnglish(value: string): string | null {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return /[A-Za-z]{2,}/.test(normalized) ? normalized : null;
}

function lineAt(source: string, position: number): number {
  return source.slice(0, position).split("\n").length;
}

function auditTypeScript(path: string, source: string): string[] {
  const relativePath = relative(WORKSHOP_SOURCE_ROOT, path);
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = new Set<string>();

  const add = (node: ts.Node, value: string) => {
    const normalized = normalizedEnglish(value);
    if (!normalized) return;
    const allowlistEntry = `${relativePath}::${normalized}`;
    if (SOURCE_LITERAL_ALLOWLIST.has(allowlistEntry)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.add(`${relativePath}:${line + 1}: ${JSON.stringify(normalized)}`);
  };

  const auditExpression = (expression: ts.Expression): void => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      add(expression, expression.text);
    } else if (ts.isTemplateExpression(expression)) {
      add(expression.head, expression.head.text);
      for (const span of expression.templateSpans) add(span.literal, span.literal.text);
    } else if (ts.isConditionalExpression(expression)) {
      auditExpression(expression.whenTrue);
      auditExpression(expression.whenFalse);
    } else if (ts.isBinaryExpression(expression)) {
      if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        auditExpression(expression.left);
        auditExpression(expression.right);
      }
    } else if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      auditExpression(expression.expression);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      add(node, node.text);
    } else if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.has(node.name.getText(sourceFile))) {
      const initializer = node.initializer;
      if (initializer && ts.isStringLiteral(initializer)) add(initializer, initializer.text);
      if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
        auditExpression(initializer.expression);
      }
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      auditExpression(node.expression);
    } else if (ts.isPropertyAssignment(node)) {
      const propertyName = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
        ? node.name.text
        : "";
      if (VISIBLE_OBJECT_PROPERTIES.has(propertyName)) auditExpression(node.initializer);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...findings].toSorted();
}

function auditHtml(path: string, source: string): string[] {
  const relativePath = relative(WORKSHOP_SOURCE_ROOT, path);
  const findings = new Set<string>();
  const add = (position: number, value: string) => {
    const normalized = normalizedEnglish(value);
    if (!normalized) return;
    const allowlistEntry = `${relativePath}::${normalized}`;
    if (SOURCE_LITERAL_ALLOWLIST.has(allowlistEntry)) return;
    findings.add(`${relativePath}:${lineAt(source, position)}: ${JSON.stringify(normalized)}`);
  };
  const maskBlock = (block: string) => block.replaceAll(/[^\n]/g, " ");
  const withoutCode = source
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi, maskBlock)
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi, maskBlock);
  for (const match of withoutCode.matchAll(/>([^<]+)</g)) add(match.index + 1, match[1]);
  const attributeNames = [...VISIBLE_ATTRIBUTES].join("|");
  const attributePattern = new RegExp(`\\b(?:${attributeNames})\\s*=\\s*["']([^"']*)["']`, "gi");
  for (const match of withoutCode.matchAll(attributePattern)) add(match.index, match[1]);
  return [...findings].toSorted();
}

function leafEntries(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    leafEntries(child, prefix ? `${prefix}.${key}` : key),
  );
}

async function loadTypeScriptExport(path: string, exportName: string): Promise<unknown> {
  const output = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
  }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`) as
    Record<string, unknown>;
  assert.ok(exportName in module, `${path} does not export ${exportName}`);
  return module[exportName];
}

function assertCatalogCoverage(
  name: keyof typeof CATALOG_EQUALITY_ALLOWLIST,
  english: unknown,
  japanese: unknown,
): void {
  const englishEntries = leafEntries(english).toSorted(([left], [right]) => left.localeCompare(right));
  const japaneseEntries = leafEntries(japanese).toSorted(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(
    japaneseEntries.map(([path]) => path),
    englishEntries.map(([path]) => path),
    `${name} catalog key parity changed`,
  );
  const englishByPath = new Map(englishEntries);
  const untranslated = japaneseEntries
    .filter(([path, value]) =>
      englishByPath.get(path) === value && !CATALOG_EQUALITY_ALLOWLIST[name].has(path),
    )
    .map(([path, value]) => `${path}: ${JSON.stringify(value)}`);
  assert.deepEqual(untranslated, [], `${name} Japanese catalog contains English-equal leaves`);
}

describe("frontend localization completion gate", () => {
  it("reports exact HTML lines after non-visible code blocks", () => {
    const source = "<script>\nconst hidden = 'English';\n</script>\n<button title=\"Button title\">Visible copy</button>";
    assert.deepEqual(auditHtml(`${WORKSHOP_SOURCE_ROOT}/fixture.html`, source), [
      "fixture.html:4: \"Button title\"",
      "fixture.html:4: \"Visible copy\"",
    ]);
  });

  it("finds no unlocalized visible Workshop production literals", () => {
    const findings = sourceFiles(WORKSHOP_SOURCE_ROOT).flatMap(path => {
      const source = readFileSync(path, "utf8");
      return path.endsWith(".html") ? auditHtml(path, source) : auditTypeScript(path, source);
    });
    assert.deepEqual(findings, []);
  });

  it("keeps shell and workspace Japanese catalogs complete and translated", async () => {
    const [enShell, jaShell, enWorkspace, jaWorkspace] = await Promise.all([
      loadTypeScriptExport("packages/workshop-frontend/src/i18n/locales/en/shell.ts", "enShell"),
      loadTypeScriptExport("packages/workshop-frontend/src/i18n/locales/ja/shell.ts", "jaShell"),
      loadTypeScriptExport("packages/workshop-frontend/src/i18n/locales/en/workspace.ts", "enWorkspace"),
      loadTypeScriptExport("packages/workshop-frontend/src/i18n/locales/ja/workspace.ts", "jaWorkspace"),
    ]);
    assertCatalogCoverage("shell", enShell, jaShell);
    assertCatalogCoverage("workspace", enWorkspace, jaWorkspace);
  });

  it("keeps Context Library Japanese catalog complete and translated", () => {
    const english = JSON.parse(readFileSync("packages/gatekeeper-context/app/locales/en.json", "utf8"));
    const japanese = JSON.parse(readFileSync("packages/gatekeeper-context/app/locales/ja.json", "utf8"));
    assertCatalogCoverage("context", english, japanese);
  });

  it("keeps Scheduled Tasks Japanese catalog complete and translated", async () => {
    const schedulerCatalogs = await loadTypeScriptExport(
      "packages/gatekeeper-scheduler/app/translations.ts",
      "catalogs",
    ) as { en: unknown; ja: unknown };
    assertCatalogCoverage("scheduler", schedulerCatalogs.en, schedulerCatalogs.ja);
  });
});
