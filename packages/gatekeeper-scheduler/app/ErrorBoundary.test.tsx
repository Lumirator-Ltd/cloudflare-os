import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";
import { AppLanguageProvider } from "./i18n";
import { applyAppTheme } from "./theme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function BrokenView(): React.ReactNode {
  throw new Error("raw render failure");
}

describe("ErrorBoundary", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    applyAppTheme({ mode: "light", accentColor: null, language: "en" });
    container?.remove();
    vi.restoreAllMocks();
  });

  it("renders its recovery UI in Japanese without exposing the raw error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    applyAppTheme({ mode: "light", accentColor: null, language: "ja" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container, { onCaughtError: () => {} });

    await act(async () => {
      root!.render(
        <AppLanguageProvider>
          <ErrorBoundary>
            <BrokenView />
          </ErrorBoundary>
        </AppLanguageProvider>,
      );
    });

    expect(container.textContent).toContain("問題が発生しました");
    expect(container.textContent).toContain("再読み込み");
    expect(container.textContent).not.toContain("raw render failure");
  });
});
