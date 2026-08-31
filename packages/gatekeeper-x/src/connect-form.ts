const MAX_FORM_BYTES = 16 * 1024;
const MAX_CLIENT_ID_LENGTH = 512;
const MAX_CLIENT_SECRET_LENGTH = 4096;

export type XConnectLanguage = "en" | "ja";

const COPY = {
  en: {
    title: "Connect your X Developer App",
    introduction:
      "Use your own confidential X Web App. X API requests consume credits from your Developer App; Cloudflare OS never supplies or falls back to another app.",
    setup:
      "In X Developer Console, register the callback URL below, enable OAuth 2.0, purchase API credits, and set a spending limit before continuing.",
    callback: "Callback URL",
    clientId: "Client ID",
    clientSecret: "Client secret",
    secretHint: "Stored only with this connected account. It is never shown again.",
    submit: "Continue to X",
    error: "Could not validate the supplied X app.",
  },
  ja: {
    title: "X Developer App を接続",
    introduction:
      "ご自身の X の機密 Web App を使用します。X API のリクエストでは Developer App のクレジットが消費され、Cloudflare OS が別の App を提供したり代替したりすることはありません。",
    setup:
      "続行する前に、X Developer Console で下記のコールバック URL を登録し、OAuth 2.0 を有効にして、API クレジットと利用上限を設定してください。",
    callback: "コールバック URL",
    clientId: "クライアント ID",
    clientSecret: "クライアントシークレット",
    secretHint: "この接続済みアカウントにのみ保存され、再表示されることはありません。",
    submit: "X に進む",
    error: "入力された X App を検証できませんでした。",
  },
} satisfies Record<XConnectLanguage, Record<string, string>>;

function language(value: unknown): XConnectLanguage {
  return value === "ja" ? "ja" : "en";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function printable(value: string): boolean {
  return [...value].every(character => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127 && !(code >= 128 && code <= 159);
  });
}

async function readBoundedFormBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel();
      throw new TypeError("Form body is too large.");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function onlyOne(form: URLSearchParams, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1) throw new TypeError(`Invalid ${name} field.`);
  return values[0];
}

export function buildXConnectUrl(
  baseUrl: string,
  accountId: string,
  initiationNonce: string,
  requestedLanguage?: string,
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${accountId}/${initiationNonce}`);
  url.searchParams.set("language", language(requestedLanguage));
  return url.href;
}

export type XConnectFormRender = {
  response: Response;
  status: number;
  bodyText: string;
};

export function xConnectFormResponse(input: {
  actionUrl: string;
  callbackUrl: string;
  language?: string;
  error?: unknown;
}): XConnectFormRender {
  const resolved = language(input.language);
  const copy = COPY[resolved];
  const body = `<!DOCTYPE html>
<html lang="${resolved}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${copy.title}</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 32px 16px; background: #f6f4ef; color: #171717; }
main { box-sizing: border-box; max-width: 620px; margin: 0 auto; padding: 28px; border: 1px solid #d8d3c8; border-radius: 14px; background: #fff; }
h1 { margin: 0 0 12px; font-size: 24px; } p { line-height: 1.55; }
code { display: block; overflow-wrap: anywhere; padding: 10px; border-radius: 8px; background: #f1eee7; }
label { display: block; margin: 18px 0 6px; font-weight: 650; }
input { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid #aaa; border-radius: 8px; font: inherit; }
small { display: block; margin-top: 6px; color: #5f5f5f; }
button { width: 100%; margin-top: 22px; padding: 11px; border: 0; border-radius: 8px; background: #111; color: #fff; font: inherit; font-weight: 700; }
.error { color: #a00; font-weight: 650; }
@media (prefers-color-scheme: dark) { body { background: #171717; color: #eee; } main { background: #222; border-color: #444; } code { background: #303030; } small { color: #bbb; } button { background: #eee; color: #111; } }
</style></head><body><main>
<h1>${copy.title}</h1>
<p>${copy.introduction}</p>
<p>${copy.setup}</p>
${input.error === undefined ? "" : `<p class="error">${copy.error}</p>`}
<label>${copy.callback}</label><code>${escapeHtml(input.callbackUrl)}</code>
<form method="POST" action="${escapeHtml(input.actionUrl)}">
<input type="hidden" name="language" value="${resolved}">
<label for="clientId">${copy.clientId}</label>
<input id="clientId" name="clientId" autocomplete="off" required maxlength="${MAX_CLIENT_ID_LENGTH}">
<label for="clientSecret">${copy.clientSecret}</label>
<input id="clientSecret" name="clientSecret" type="password" autocomplete="new-password" required maxlength="${MAX_CLIENT_SECRET_LENGTH}">
<small>${copy.secretHint}</small>
<button type="submit">${copy.submit}</button>
</form></main></body></html>`;
  const status = input.error === undefined ? 200 : 400;
  const response = new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
  return { response, status, bodyText: body };
}

export async function parseXCredentialForm(request: Request): Promise<{
  clientId: string;
  clientSecret: string;
  language: XConnectLanguage;
}> {
  if (request.method !== "POST") throw new TypeError("Invalid form method.");
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) throw new TypeError("Invalid form origin.");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new TypeError("Invalid form content type.");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_FORM_BYTES)) {
    throw new TypeError("Form body is too large.");
  }

  const form = new URLSearchParams(await readBoundedFormBody(request));
  for (const name of form.keys()) {
    if (name !== "clientId" && name !== "clientSecret" && name !== "language") {
      throw new TypeError("Unexpected form field.");
    }
  }
  const clientId = onlyOne(form, "clientId");
  const clientSecret = onlyOne(form, "clientSecret");
  const submittedLanguage = form.getAll("language");
  if (submittedLanguage.length > 1) throw new TypeError("Invalid language field.");
  if (!clientId || clientId.length > MAX_CLIENT_ID_LENGTH || !printable(clientId)) {
    throw new TypeError("Invalid client id.");
  }
  if (!clientSecret || clientSecret.length > MAX_CLIENT_SECRET_LENGTH || !printable(clientSecret)) {
    throw new TypeError("Invalid client secret.");
  }
  return {
    clientId,
    clientSecret,
    language: language(submittedLanguage[0] ?? url.searchParams.get("language")),
  };
}
