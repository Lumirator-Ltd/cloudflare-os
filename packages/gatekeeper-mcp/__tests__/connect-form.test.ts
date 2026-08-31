import { describe, expect, it } from "vitest";
import {
  buildConnectUrl,
  connectFormHtml,
  resolveConnectFormLanguage,
} from "../src/connect-form";

describe("MCP connection form localization", () => {
  it.each(["en", "ja"])("builds a connect URL carrying only the %s language query", language => {
    const url = new URL(buildConnectUrl(
      "https://workshop.example/gatekeeper/mcp",
      "account-id",
      "initiation-nonce",
      language,
    ));

    expect(url.pathname).toBe("/gatekeeper/mcp/account-id/initiation-nonce");
    expect([...url.searchParams]).toEqual([["language", language]]);
  });

  it("renders Japanese HTML from the GET language query", () => {
    const requestUrl = buildConnectUrl(
      "https://workshop.example/gatekeeper/mcp",
      "account-id",
      "initiation-nonce",
      "ja",
    );
    const html = connectFormHtml(
      "/connect",
      undefined,
      resolveConnectFormLanguage(requestUrl),
    );

    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("MCP サーバーに接続");
    expect(html).toContain("サーバー URL");
    expect(html).toContain("続行");
    expect(html).not.toContain("Connect an MCP server");
  });

  it("uses the POST form language and preserves it in the hidden field", () => {
    const form = new FormData();
    form.set("language", "ja");
    const language = resolveConnectFormLanguage(
      "https://workshop.example/connect?language=en",
      form,
    );
    const html = connectFormHtml("/connect", undefined, language);

    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("MCP サーバーに接続");
    expect(html).toContain('type="hidden" name="language" value="ja"');
  });

  it("falls back to English for omitted or unsupported languages", () => {
    expect(resolveConnectFormLanguage("https://workshop.example/connect")).toBe("en");
    expect(resolveConnectFormLanguage(
      "https://workshop.example/connect?language=fr",
    )).toBe("en");

    const form = new FormData();
    form.set("language", "fr");
    const language = resolveConnectFormLanguage(
      "https://workshop.example/connect?language=ja",
      form,
    );
    const html = connectFormHtml("/connect", undefined, language);

    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Connect an MCP server");
  });

  it("redisplays escaped server errors in the submitted language", () => {
    const form = new FormData();
    form.set("language", "ja");
    const language = resolveConnectFormLanguage(
      "https://workshop.example/connect",
      form,
    );
    const html = connectFormHtml("/connect", "bad <endpoint>", language);

    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("MCP サーバーに接続");
    expect(html).toContain("bad &lt;endpoint&gt;");
    expect(html).toContain('type="hidden" name="language" value="ja"');
  });
});
