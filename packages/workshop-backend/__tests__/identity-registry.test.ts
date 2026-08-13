import { describe, expect, it } from "vitest";
import { canonicalizeVerifiedEmail } from "../src/identity-registry.js";

describe("canonicalizeVerifiedEmail", () => {
  it("trims surrounding whitespace and lowercases the address", () => {
    expect(canonicalizeVerifiedEmail("  Mixed.Case+Tag@Example.COM\t"))
      .toBe("mixed.case+tag@example.com");
  });

  it("does not rewrite dots or plus suffixes", () => {
    expect(canonicalizeVerifiedEmail("First.Last+folder@gmail.com"))
      .toBe("first.last+folder@gmail.com");
  });
});
