import { describe, expect, it } from "vitest";
import { detectChatActivityLanguage } from "../src/chat-activity-language.js";

describe("detectChatActivityLanguage", () => {
  it("detects Kana as Japanese even when Latin text is also present", () => {
    expect(detectChatActivityLanguage("Reactで家計簿を作って")).toBe("ja");
  });

  it("detects meaningful Han text without Kana as Japanese", () => {
    expect(detectChatActivityLanguage("請求書 PDF 作成")).toBe("ja");
  });

  it("detects Latin text as English", () => {
    expect(detectChatActivityLanguage("Build a concise invoice tracker")).toBe("en");
  });

  it("returns undefined for neutral content", () => {
    expect(detectChatActivityLanguage("123 🎉 !!!")).toBeUndefined();
  });

  it("does not score URLs", () => {
    expect(detectChatActivityLanguage("https://example.com/日本語?q=かな")).toBeUndefined();
  });

  it("does not score fenced code", () => {
    expect(detectChatActivityLanguage("```ts\nconst 名前 = 'かな';\n```\nBuild it")).toBe("en");
    expect(detectChatActivityLanguage("~~~python\nprint('hello')\n~~~")).toBeUndefined();
  });

  it("does not score inline code", () => {
    expect(detectChatActivityLanguage("Explain `const 名前 = 'かな'` clearly")).toBe("en");
    expect(detectChatActivityLanguage("`日本語` https://example.com")).toBeUndefined();
  });
});
