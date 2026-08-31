import { describe, expect, it } from "vitest";
import {
  buildGadgetTitlePrompt,
  buildThreadTitlePrompt,
} from "../src/chat-activity-language.js";

describe("localized chat title prompts", () => {
  it("keeps the existing English thread-title guidance", () => {
    const prompt = buildThreadTitlePrompt("Build an invoice tracker", "en");

    expect(prompt).toContain("brief, descriptive title (2-8 words)");
    expect(prompt).toContain("Return only the title");
    expect(prompt).toContain("Build an invoice tracker");
  });

  it("requests a concise natural Japanese thread title without English word counts", () => {
    const prompt = buildThreadTitlePrompt("請求書を管理したい", "ja");

    expect(prompt).toContain("簡潔で自然な日本語のタイトル");
    expect(prompt).toContain("タイトルだけを返してください");
    expect(prompt).not.toMatch(/\bwords?\b/i);
    expect(prompt).toContain("請求書を管理したい");
  });

  it("keeps the existing English gadget-title guidance", () => {
    const prompt = buildGadgetTitlePrompt("[user]: Build a timer", "en");

    expect(prompt).toContain("short name (2-5 words)");
    expect(prompt).toContain("project name");
    expect(prompt).toContain("[user]: Build a timer");
  });

  it("requests a concise natural Japanese gadget title without English word counts", () => {
    const prompt = buildGadgetTitlePrompt("[user]: タイマーを作って", "ja");

    expect(prompt).toContain("簡潔で自然な日本語の名前");
    expect(prompt).toContain("名前だけを返してください");
    expect(prompt).not.toMatch(/\bwords?\b/i);
    expect(prompt).toContain("[user]: タイマーを作って");
  });
});
