import { describe, expect, it } from "vitest";
import { formatDate, formatNumber, formatRelativeTime } from "./format";
import { resolveLanguage } from "./locale";

describe("resolveLanguage", () => {
  it.each(["en", "ja"] as const)("uses an explicit %s preference", preference => {
    expect(resolveLanguage(preference, preference === "en" ? "ja" : "en")).toBe(preference);
  });

  it.each(["en", "ja"] as const)("resolves auto to the %s deployment default", deploymentDefault => {
    expect(resolveLanguage("auto", deploymentDefault)).toBe(deploymentDefault);
  });

  it("uses English while the deployment default is unavailable", () => {
    expect(resolveLanguage("auto", undefined)).toBe("en");
  });
});

describe("locale formatters", () => {
  it("formats numbers with the requested locale", () => {
    const options = { style: "currency", currency: "JPY" } as const;

    expect(formatNumber(1234, "ja", options)).toBe(
      new Intl.NumberFormat("ja", options).format(1234),
    );
    expect(formatNumber(1234, "en", options)).toBe(
      new Intl.NumberFormat("en", options).format(1234),
    );
  });

  it("formats dates with the requested locale", () => {
    const date = new Date("2025-01-02T03:04:00Z");
    const options = { dateStyle: "long", timeZone: "UTC" } as const;

    expect(formatDate(date, "ja", options)).toBe(
      new Intl.DateTimeFormat("ja", options).format(date),
    );
    expect(formatDate(date, "en", options)).toBe(
      new Intl.DateTimeFormat("en", options).format(date),
    );
  });

  it("uses locale relative-time grammar", () => {
    expect(formatRelativeTime(-1, "day", "en", { numeric: "auto" })).toBe("yesterday");
    expect(formatRelativeTime(-1, "day", "ja", { numeric: "auto" })).toBe("昨日");
  });
});
