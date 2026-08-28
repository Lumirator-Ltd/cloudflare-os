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

  it("defaults a legacy theme without language to English", () => {
    applyAppTheme({ mode: "dark", accentColor: "#3b82f6", language: "ja" });
    const listener = vi.fn();
    const unsubscribe = subscribeAppLanguage(listener);

    applyAppTheme({ mode: "light", accentColor: null });

    expect(document.documentElement.lang).toBe("en");
    expect(getAppLanguage()).toBe("en");
    expect(listener).toHaveBeenCalledWith("en");

    unsubscribe();
  });

  it("defaults an unknown live theme language to English", () => {
    applyAppTheme({ mode: "dark", accentColor: null, language: "ja" });
    const listener = vi.fn();
    const unsubscribe = subscribeAppLanguage(listener);

    applyAppTheme({ mode: "light", accentColor: null, language: "fr" as never });

    expect(document.documentElement.lang).toBe("en");
    expect(getAppLanguage()).toBe("en");
    expect(listener).toHaveBeenCalledWith("en");

    unsubscribe();
  });
});
