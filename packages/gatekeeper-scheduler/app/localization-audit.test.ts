/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const VISIBLE_SOURCE_FILES = ["SchedulerPage.tsx", "ErrorBoundary.tsx", "format.ts"] as const;

export const VISIBLE_LITERAL_ALLOWLIST: readonly string[] = [
  "2-digit",
  "MO,TU,WE,TH,FR",
  "UTC",
  "en-US",
  "ja-JP",
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function visibleAsciiLiterals(source: string): string[] {
  const stripped = stripComments(source);
  const literals: string[] = [];
  for (const match of stripped.matchAll(/(["'`])((?:\\.|(?!\1)[^\n])*)\1/g)) {
    const literal = match[2].trim();
    if (/[A-Za-z]/.test(literal)) literals.push(literal);
  }
  for (const match of stripped.matchAll(/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)<\//g)) {
    literals.push(match[1].trim());
  }
  for (const line of stripped.split("\n")) {
    const literal = line.trim();
    if (/^[A-Z][A-Za-z’' ….,!?-]*[A-Za-z.…!?]$/.test(literal)) literals.push(literal);
  }
  return literals;
}

function looksLikeClassList(literal: string): boolean {
  const tokens = literal.split(/\s+/);
  return tokens.length > 1 && tokens.every((token) => /^[a-z0-9:[\]./%!_()-]+$/i.test(token));
}

function isTechnicalLiteral(literal: string): boolean {
  const staticText = literal.replace(/\$\{[^}]*\}/g, "");
  return (
    !/[A-Za-z]/.test(staticText) ||
    literal.startsWith("./") ||
    literal.startsWith("../") ||
    literal.startsWith("@") ||
    /^[a-z][A-Za-z0-9_:/.-]*$/.test(literal) ||
    /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+$/.test(literal) ||
    (literal.includes("${") && /^[A-Za-z0-9._${}]+$/.test(literal)) ||
    (literal.includes("${") && /(?:text-|bg-|rounded|flex|block|transition|sm:|px-|py-)/.test(literal)) ||
    looksLikeClassList(literal) ||
    VISIBLE_LITERAL_ALLOWLIST.includes(literal)
  );
}

describe("localization static audit", () => {
  it("keeps visible English literals out of localized application sources", () => {
    const directory = resolve(process.cwd(), "app");
    const findings = VISIBLE_SOURCE_FILES.flatMap((file) =>
      visibleAsciiLiterals(readFileSync(resolve(directory, file), "utf8"))
        .filter((literal) => !isTechnicalLiteral(literal))
        .map((literal) => `${file}: ${literal}`),
    );

    expect(findings).toEqual([]);
    expect(directory).toContain("gatekeeper-scheduler/app");
  });

  it("leaves the static HTML title empty for the language provider to own", () => {
    const html = readFileSync(resolve(process.cwd(), "app/index.html"), "utf8");
    expect(html).toMatch(/<title>\s*<\/title>/);
  });
});
