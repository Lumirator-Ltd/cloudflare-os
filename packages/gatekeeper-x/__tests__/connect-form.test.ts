import { describe, expect, it } from "vitest";
import {
  buildXConnectUrl,
  parseXCredentialForm,
  xConnectFormResponse,
} from "../src/connect-form";

const BASE_URL = "https://workshop.example/gatekeeper/x";
const ACCOUNT_ID = "a".repeat(64);
const NONCE = "b".repeat(64);
const CALLBACK_URL = `${BASE_URL}/oauth`;

describe("X credential connection form", () => {
  it.each([
    ["en", "Connect your X Developer App", "Client secret", "Continue to X"],
    ["ja", "X Developer App を接続", "クライアントシークレット", "X に進む"],
  ])("renders complete %s setup copy and exact callback", (language, title, secretLabel, submit) => {
    const actionUrl = buildXConnectUrl(BASE_URL, ACCOUNT_ID, NONCE, language);
    const response = xConnectFormResponse({ actionUrl, callbackUrl: CALLBACK_URL, language });
    const html = response.bodyText;

    expect(response.status).toBe(200);
    expect(html).toContain(`<html lang="${language}">`);
    expect(html).toContain(title);
    expect(html).toContain(secretLabel);
    expect(html).toContain(submit);
    expect(html).toContain(CALLBACK_URL);
    expect(html).toContain('name="clientId"');
    expect(html).toContain('name="clientSecret"');
    expect(html).toContain('type="password"');
    expect(html).toContain('method="POST"');
    expect(html).toContain(`action="${actionUrl.replaceAll("&", "&amp;")}"`);
    expect(html).toMatch(/credits|クレジット/);
    expect(html).toMatch(/spending limit|利用上限/);
    expect(html).not.toContain("<script");
  });

  it("falls back to English and never renders submitted secrets", () => {
    const actionUrl = buildXConnectUrl(BASE_URL, ACCOUNT_ID, NONCE, "unsupported");
    const secret = "never-render-this-secret";
    const response = xConnectFormResponse({
      actionUrl,
      callbackUrl: CALLBACK_URL,
      language: "unsupported",
      error: `Could not validate ${secret}`,
    });

    expect(response.bodyText).toContain('<html lang="en">');
    expect(response.bodyText).toContain("Could not validate the supplied X app.");
    expect(response.bodyText).not.toContain(secret);
  });

  it("sets strict security and no-cache headers", () => {
    const response = xConnectFormResponse({
      actionUrl: buildXConnectUrl(BASE_URL, ACCOUNT_ID, NONCE, "en"),
      callbackUrl: CALLBACK_URL,
      language: "en",
    }).response;

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("parses one bounded same-origin form without exposing credentials in a URL", async () => {
    const url = buildXConnectUrl(BASE_URL, ACCOUNT_ID, NONCE, "ja");
    const body = new URLSearchParams({
      language: "ja",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    const request = new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(url).origin,
        "content-length": String(body.toString().length),
      },
      body,
    });

    await expect(parseXCredentialForm(request)).resolves.toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      language: "ja",
    });
    expect(url).not.toContain("client-id");
    expect(url).not.toContain("client-secret");
  });

  it.each([
    [new Request(buildXConnectUrl(BASE_URL, ACCOUNT_ID, NONCE, "en"), { method: "GET" }), "method"],
    [new Request(buildXConnectUrl(BASE_URL, ACCOUNT_ID, NONCE, "en"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://workshop.example" },
      body: "{}",
    }), "content type"],
    [new Request(buildXConnectUrl(BASE_URL, ACCOUNT_ID, NONCE, "en"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: "clientId=a&clientSecret=b",
    }), "origin"],
    [new Request(buildXConnectUrl(BASE_URL, ACCOUNT_ID, NONCE, "en"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://workshop.example",
        "content-length": "20000",
      },
      body: "clientId=a&clientSecret=b",
    }), "large"],
  ])("rejects an invalid form boundary: %s", async (request, message) => {
    await expect(parseXCredentialForm(request)).rejects.toThrow(new RegExp(message, "i"));
  });

  it.each([
    [{ clientId: "", clientSecret: "secret" }, "client id"],
    [{ clientId: "client", clientSecret: "" }, "client secret"],
    [{ clientId: "client\nheader", clientSecret: "secret" }, "client id"],
    [{ clientId: "client", clientSecret: "x".repeat(4097) }, "client secret"],
  ])("rejects invalid credential fields", async (fields, message) => {
    const url = buildXConnectUrl(BASE_URL, ACCOUNT_ID, NONCE, "en");
    const request = new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(url).origin,
      },
      body: new URLSearchParams({ language: "en", ...fields }),
    });

    await expect(parseXCredentialForm(request)).rejects.toThrow(new RegExp(message, "i"));
  });
});
