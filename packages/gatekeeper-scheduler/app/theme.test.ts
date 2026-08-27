import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAppTheme,
  getAppLanguage,
  subscribeAppLanguage,
} from "./theme";

describe("applyAppTheme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-mode");
    document.documentElement.removeAttribute("lang");
    document.documentElement.removeAttribute("style");
  });

  it("applies the host mode and accent and can restore the base accent", () => {
    applyAppTheme({ mode: "dark", accentColor: "#3b82f6", language: "ja" });

    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(document.documentElement.lang).toBe("ja");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--color-kumo-brand"))
      .toContain("#3b82f6");

    applyAppTheme({ mode: "light", accentColor: null, language: "en" });

    expect(document.documentElement.dataset.mode).toBe("light");
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--color-kumo-brand")).toBe("");
  });

  it("defaults a legacy theme without language to English", () => {
    applyAppTheme({ mode: "dark", accentColor: null, language: "ja" });
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
