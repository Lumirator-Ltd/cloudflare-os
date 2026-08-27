import { describe, expect, it } from "vitest";
import { connectFormHtml } from "../src/connect-form";

const render = connectFormHtml as (
  path: string,
  error?: string,
  language?: string,
) => string;

describe("MCP connection form localization", () => {
  it("renders Japanese copy when requested through its language parameter", () => {
    const html = render("/connect", undefined, "ja");

    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("MCP サーバーに接続");
    expect(html).toContain("サーバー URL");
    expect(html).toContain("続行");
    expect(html).not.toContain("Connect an MCP server");
  });

  it("falls back to English for omitted or unsupported languages", () => {
    expect(render("/connect")).toContain("Connect an MCP server");
    expect(render("/connect", undefined, "fr")).toContain("Connect an MCP server");
  });

  it("preserves and escapes raw server errors in either language", () => {
    const html = render("/connect", "bad <endpoint>", "ja");

    expect(html).toContain("bad &lt;endpoint&gt;");
  });
});
