// The one page this gatekeeper serves that asks the user something: which MCP server to connect.
// Lives here rather than in `@gadgets/mcp-shared/html` because the gateway connector, whose endpoint
// is a deployment setting, has no equivalent page.

import { escapeHtml, PAGE_STYLE } from "@gadgets/mcp-shared/html";

// Form controls, on top of the palette and page frame every connect page shares.
const FORM_STYLE = `
  label { display: block; font-size: 14px; font-weight: 600; color: var(--strong); margin: 0 0 6px; }
  p.hint { margin: 6px 0 0; font-size: 13px; color: var(--subtle); }

  input[type=url] { width: 100%; box-sizing: border-box; padding: 9px 11px; font: inherit;
                    background: var(--control); color: var(--text);
                    border: 1px solid var(--line); border-radius: 8px; }
  input[type=url]::placeholder { color: var(--subtle); }
  input[type=url]:focus { outline: 0; border-color: var(--brand);
                          box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 22%, transparent); }

  button { width: 100%; margin-top: 20px; padding: 10px; border: 0; border-radius: 8px;
           background: var(--contrast); color: var(--on-contrast); font: inherit; font-weight: 600;
           cursor: pointer; }
  button:hover { opacity: .9; }
`;

type ConnectFormLanguage = "en" | "ja";

type ConnectFormCopy = {
  title: string;
  introduction: string;
  serverUrl: string;
  placeholder: string;
  trustNotice: string;
  continue: string;
};

const CONNECT_FORM_COPY = {
  en: {
    title: "Connect an MCP server",
    introduction:
      "We will discover the server's tools and, if it requires authorization, take you through its sign-in.",
    serverUrl: "Server URL",
    placeholder: "https://example.com/mcp",
    trustNotice:
      "Only connect a server you trust. Its own annotations decide which of its tools run without " +
      "asking you and which wait for your approval, and an annotation is only as trustworthy as " +
      "the server that sent it.",
    continue: "Continue",
  },
  ja: {
    title: "MCP サーバーに接続",
    introduction:
      "サーバーのツールを検出し、認証が必要な場合はサインインへ進みます。",
    serverUrl: "サーバー URL",
    placeholder: "https://example.com/mcp",
    trustNotice:
      "信頼できるサーバーだけに接続してください。確認なしで実行するツールと承認待ちにする" +
      "ツールはサーバー自身のアノテーションで決まり、その信頼性は送信元のサーバーに依存します。",
    continue: "続行",
  },
} satisfies Record<ConnectFormLanguage, ConnectFormCopy>;

/**
 * Renders the endpoint prompt shown when the user starts connecting.
 *
 * `language` is the request-boundary localization contract: pass `"ja"` when the caller has the
 * user's preference. Omitted or unsupported values deterministically use English.
 */
export function connectFormHtml(path: string, error?: string, language?: string): string {
  const resolvedLanguage: ConnectFormLanguage = language === "ja" ? "ja" : "en";
  const copy = CONNECT_FORM_COPY[resolvedLanguage];
  return `<!DOCTYPE html>
<html lang="${resolvedLanguage}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${copy.title}</title><style>${PAGE_STYLE}${FORM_STYLE}</style></head>
<body><main>
  <h1>${copy.title}</h1>
  <p class="sub">${copy.introduction}</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="${escapeHtml(path)}">
    <label for="url">${copy.serverUrl}</label>
    <input id="url" type="url" name="url" placeholder="${copy.placeholder}" required autofocus>
    <p class="hint">${copy.trustNotice}</p>
    <button type="submit">${copy.continue}</button>
  </form>
</main></body></html>`;
}
