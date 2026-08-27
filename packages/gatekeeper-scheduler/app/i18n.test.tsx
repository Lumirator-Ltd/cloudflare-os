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

describe("AppLanguageProvider", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    applyAppTheme({ mode: "light", accentColor: null, language: "en" });
    container?.remove();
  });

  it("reacts to host language updates", async () => {
    applyAppTheme({ mode: "light", accentColor: null, language: "en" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<AppLanguageProvider><Probe /></AppLanguageProvider>));
    expect(container.textContent).toBe("English:en");

    await act(async () => {
      applyAppTheme({ mode: "light", accentColor: null, language: "ja" });
    });

    await vi.waitFor(() => expect(container?.textContent).toBe("日本語:ja"));
  });
});
