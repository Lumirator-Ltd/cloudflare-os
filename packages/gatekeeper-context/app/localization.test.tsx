// @vitest-environment jsdom
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ts from "typescript6";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextApi } from "../src/context-types";
import type { RpcStub } from "capnweb";
import { ContextApiProvider } from "./bridge";
import ContextLibraryPage from "./ContextLibraryPage";
import ErrorBoundary from "./ErrorBoundary";
import { AppLanguageProvider } from "./i18n";
import { applyAppTheme } from "./theme";

(globalThis as { React?: typeof React; IS_REACT_ACT_ENVIRONMENT?: boolean }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Catalog = { [key: string]: string | Catalog };

const appDir = process.cwd().endsWith("packages/gatekeeper-context")
  ? resolve(process.cwd(), "app")
  : resolve(process.cwd(), "packages/gatekeeper-context/app");
const catalogPath = (language: "en" | "ja") => `${appDir}/locales/${language}.json`;
const readCatalog = (language: "en" | "ja"): Catalog => {
  try {
    return JSON.parse(readFileSync(catalogPath(language), "utf8")) as Catalog;
  } catch {
    return {};
  }
};

function flattenCatalog(catalog: Catalog, prefix = ""): Map<string, string> {
  const leaves = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") leaves.set(path, value);
    else for (const [childKey, childValue] of flattenCatalog(value, path)) leaves.set(childKey, childValue);
  }
  return leaves;
}

const VISIBLE_ATTRIBUTES = new Set(["aria-label", "placeholder", "title"]);
const VISIBLE_OBJECT_PROPERTIES = new Set(["description", "label", "title"]);
export const VISIBLE_LITERAL_ALLOWLIST = ["file-name.md", "folder-name"] as const;

function literalText(expression: ts.Expression | undefined): string[] {
  if (!expression) return [];
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isConditionalExpression(expression)) {
    return [...literalText(expression.whenTrue), ...literalText(expression.whenFalse)];
  }
  if (ts.isParenthesizedExpression(expression)) return literalText(expression.expression);
  return [];
}

function visibleLiterals(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: string[] = [];
  const add = (text: string) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (/[A-Za-z]/.test(normalized) && !VISIBLE_LITERAL_ALLOWLIST.includes(normalized as never)) {
      findings.push(normalized);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text);
    if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.has(node.name.getText(file))) {
      if (node.initializer && ts.isStringLiteral(node.initializer)) add(node.initializer.text);
      if (node.initializer && ts.isJsxExpression(node.initializer)) {
        literalText(node.initializer.expression).forEach(add);
      }
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) {
      literalText(node.expression).forEach(add);
    }
    if (ts.isPropertyAssignment(node) && VISIBLE_OBJECT_PROPERTIES.has(node.name.getText(file))) {
      literalText(node.initializer).forEach(add);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(findings)].toSorted();
}

function FakeCrash(): never {
  throw new Error("test render failure");
}

function createContextApi(): RpcStub<ContextApi> {
  return {
    listEnabledContextCollections: async () => [],
  } as unknown as RpcStub<ContextApi>;
}

describe("Context Library localization catalogs", () => {
  it("keeps English and Japanese catalog leaves in exact parity", () => {
    const en = flattenCatalog(readCatalog("en"));
    const ja = flattenCatalog(readCatalog("ja"));

    expect(en.size).toBeGreaterThan(100);
    expect([...ja.keys()].toSorted()).toEqual([...en.keys()].toSorted());
  });

  it("provides whole-message singular and plural count templates", () => {
    const en = flattenCatalog(readCatalog("en"));

    expect([
      en.get("deleteDialog.withDocumentsDescription_one"),
      en.get("deleteDialog.withDocumentsDescription_other"),
      en.get("files.uploadResult_one"),
      en.get("files.uploadResult_other"),
    ]).toEqual([
      expect.stringContaining("document inside"),
      expect.stringContaining("documents inside"),
      expect.stringContaining("file"),
      expect.stringContaining("files"),
    ]);
  });

  it("has no Japanese entries falling back to English prose", () => {
    const en = flattenCatalog(readCatalog("en"));
    const ja = flattenCatalog(readCatalog("ja"));
    const identicalEnglish = [...en].filter(
      ([key, value]) => /[A-Za-z]/.test(value) && ja.get(key) === value,
    );
    const i18nSource = readFileSync(`${appDir}/i18n.tsx`, "utf8");

    expect(identicalEnglish).toEqual([]);
    expect(i18nSource).toContain("fallbackLng: false");
  });

  it("contains no unaudited static English visible literals", () => {
    const findings = [
      ...visibleLiterals(`${appDir}/ContextLibraryPage.tsx`),
      ...visibleLiterals(`${appDir}/ErrorBoundary.tsx`),
    ];
    const html = readFileSync(`${appDir}/index.html`, "utf8");
    const title = html.match(/<title>(.*?)<\/title>/s)?.[1].trim() ?? "";
    if (/[A-Za-z]/.test(title)) findings.push(title);

    expect(findings).toEqual([]);
  });
});

describe("Japanese app rendering", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    applyAppTheme({ mode: "light", accentColor: null, language: "en" });
    document.title = "";
    document.getElementById("root")?.removeAttribute("aria-label");
    container?.remove();
    vi.restoreAllMocks();
  });

  it("renders the empty library in Japanese and updates document metadata", async () => {
    applyAppTheme({ mode: "light", accentColor: null, language: "ja" });
    container = document.createElement("div");
    container.id = "root";
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(
      <AppLanguageProvider>
        <ContextApiProvider value={createContextApi()}>
          <ContextLibraryPage />
        </ContextApiProvider>
      </AppLanguageProvider>,
    ));

    await vi.waitFor(() => expect(container?.textContent).toContain("コンテキストとスキル"));
    expect(container.textContent).toContain("コレクションはまだありません");
    expect(container.textContent).not.toContain("No collections yet");
    expect(document.title).toBe("コンテキストライブラリ");
    expect(container.getAttribute("aria-label")).toBe("コンテキストライブラリ");
  });

  it("renders the fatal error recovery UI in Japanese", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    applyAppTheme({ mode: "light", accentColor: null, language: "ja" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(
      <AppLanguageProvider>
        <ErrorBoundary><FakeCrash /></ErrorBoundary>
      </AppLanguageProvider>,
    ));

    await vi.waitFor(() => expect(container?.textContent).toContain("問題が発生しました"));
    expect(container.textContent).toContain("再読み込み");
    expect(container.textContent).not.toContain("Something went wrong");
  });
});
