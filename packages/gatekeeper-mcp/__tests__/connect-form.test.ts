import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectFormHtml } from "../src/connect-form";
import * as mcpModule from "../src/mcp";

const worker = createExecutionContext().exports as unknown as {
  GatekeeperVendor(options: object): Fetcher & {
    connectAccount(callback: Fetcher, options?: { language?: string }): Promise<{ url: string }>;
  };
};

const render = connectFormHtml as (
  path: string,
  error?: string,
  language?: string,
) => string;

describe("MCP connection form localization", () => {
  it("returns a non-secret language query parameter from connectAccount", async () => {
    const vendor = worker.GatekeeperVendor({});
    const { url } = await vendor.connectAccount(vendor, { language: "ja" });

    expect(new URL(url).searchParams.get("language")).toBe("ja");
  });

  it("renders Japanese copy on GET and preserves it through POST errors", async () => {
    const handleConnectRequest = Reflect.get(
      mcpModule,
      "handleConnectRequest",
    ) as typeof mcpModule.handleConnectRequest;
    expect(handleConnectRequest).toBeTypeOf("function");
    const vendor = worker.GatekeeperVendor({});
    const { url: connectUrl } = await vendor.connectAccount(
      vendor,
      { language: "ja" },
    );
    const parsedConnectUrl = new URL(connectUrl);
    const account = {
      hasEndpoint: async () => false,
      isAwaitingSelection: async () => true,
      beginConnect: async () => { throw new Error("raw retry failure"); },
    };
    const env = {
      BASE_URL: "https://workshop.example/gatekeeper/mcp",
      MCP_ALLOW_INSECURE: "false",
    } as Env;

    const getResponse = await handleConnectRequest(
      new Request(connectUrl), account, "nonce", env, parsedConnectUrl.pathname,
    );
    const getHtml = await getResponse.text();
    expect(getHtml).toContain('<html lang="ja">');
    expect(getHtml).toContain("MCP サーバーに接続");
    expect(getHtml).toContain('type="hidden" name="language" value="ja"');

    const invalidResponse = await handleConnectRequest(
      new Request(parsedConnectUrl.origin + parsedConnectUrl.pathname, {
        method: "POST",
        body: new URLSearchParams({ url: "invalid", language: "ja" }),
      }),
      account,
      "nonce",
      env,
      parsedConnectUrl.pathname,
    );
    const invalidHtml = await invalidResponse.text();
    expect(invalidResponse.status).toBe(400);
    expect(invalidHtml).toContain('<html lang="ja">');
    expect(invalidHtml).toContain("MCP サーバーに接続");

    const retryResponse = await handleConnectRequest(
      new Request(parsedConnectUrl.origin + parsedConnectUrl.pathname, {
        method: "POST",
        body: new URLSearchParams({ url: "https://example.invalid/mcp", language: "ja" }),
      }),
      account,
      "nonce",
      env,
      parsedConnectUrl.pathname,
    );
    const retryHtml = await retryResponse.text();
    expect(retryResponse.status).toBe(502);
    expect(retryHtml).toContain('<html lang="ja">');
    expect(retryHtml).toContain("MCP サーバーに接続");
    expect(retryHtml).toContain("raw retry failure");
  });

  it("renders Japanese copy when requested through its language parameter", () => {
    const html = render("/connect", undefined, "ja");

    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("MCP サーバーに接続");
    expect(html).toContain("サーバー URL");
    expect(html).toContain("続行");
    expect(html).not.toContain("Connect an MCP server");
  });

  it("falls back to English for omitted or unsupported languages", () => {
    expect(render("/connect")).toContain('<html lang="en">');
    expect(render("/connect")).toContain("Connect an MCP server");
    expect(render("/connect", undefined, "fr")).toContain("Connect an MCP server");
  });

  it("preserves and escapes raw server errors in either language", () => {
    const html = render("/connect", "bad <endpoint>", "ja");

    expect(html).toContain("bad &lt;endpoint&gt;");
  });
});
