// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAppTheme,
  getAppLanguage,
  subscribeAppLanguage,
} from "./theme";

describe("applyAppTheme", () => {
  afterEach(() => {
    applyAppTheme({ mode: "light", accentColor: null, language: "en" });
    document.documentElement.removeAttribute("data-mode");
    document.documentElement.removeAttribute("lang");
    document.documentElement.removeAttribute("style");
  });

  it("applies and publishes the host language", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppLanguage(listener);

    applyAppTheme({ mode: "dark", accentColor: "#3b82f6", language: "ja" });

    expect(document.documentElement.lang).toBe("ja");
    expect(getAppLanguage()).toBe("ja");
    expect(listener).toHaveBeenCalledWith("ja");

    unsubscribe();
  });
});
