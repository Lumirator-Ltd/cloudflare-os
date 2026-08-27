import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppLanguageProvider, useAppLanguage } from "./i18n";
import { applyAppTheme } from "./theme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const { t } = useTranslation();
  const language = useAppLanguage();
  return <span>{t("test.language")}:{language}</span>;
}

function CatalogProbe({ inspect }: { inspect: (catalogs: Record<string, unknown>, fallback: unknown) => void }) {
  const { i18n } = useTranslation();
  inspect(i18n.options.resources as Record<string, unknown>, i18n.options.fallbackLng);
  return null;
}

function catalogLeaves(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    catalogLeaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("AppLanguageProvider", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    applyAppTheme({ mode: "light", accentColor: null, language: "en" });
    document.title = "";
    container?.remove();
  });

  it("reacts to host language updates and synchronizes document metadata", async () => {
    applyAppTheme({ mode: "light", accentColor: null, language: "en" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<AppLanguageProvider><Probe /></AppLanguageProvider>));
    expect(container.textContent).toBe("English:en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Scheduled tasks");

    await act(async () => {
      applyAppTheme({ mode: "light", accentColor: null, language: "ja" });
    });

    await vi.waitFor(() => expect(container?.textContent).toBe("日本語:ja"));
    expect(document.documentElement.lang).toBe("ja");
    expect(document.title).toBe("スケジュールされたタスク");
  });

  it("keeps complete English and Japanese catalogs in parity without English fallback", async () => {
    let resources: Record<string, unknown> = {};
    let fallback: unknown;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <AppLanguageProvider>
          <CatalogProbe inspect={(value, configuredFallback) => {
            resources = value;
            fallback = configuredFallback;
          }} />
        </AppLanguageProvider>,
      ),
    );

    const english = catalogLeaves((resources.en as { translation: unknown }).translation).sort();
    const japanese = catalogLeaves((resources.ja as { translation: unknown }).translation).sort();
    expect(japanese).toEqual(english);
    expect(english).toHaveLength(85);
    expect(fallback).toBe(false);
  });
});
