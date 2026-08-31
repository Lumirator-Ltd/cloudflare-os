const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;

export const X_OAUTH_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "follows.read",
  "follows.write",
  "like.read",
  "like.write",
  "bookmark.read",
  "bookmark.write",
  "offline.access",
] as const;

export type XApiErrorKind =
  | "credentials-expired"
  | "invalid-client"
  | "funding"
  | "rate-limited"
  | "provider"
  | "invalid-response"
  | "timeout"
  | "network";

export class XApiError extends Error {
  readonly status: number;
  readonly kind: XApiErrorKind;
  readonly providerCode?: string;
  readonly rateLimitReset?: Date;

  constructor(options: {
    message: string;
    status: number;
    kind: XApiErrorKind;
    providerCode?: string;
    rateLimitReset?: Date;
  }) {
    super(options.message);
    this.name = "XApiError";
    this.status = options.status;
    this.kind = options.kind;
    this.providerCode = options.providerCode;
    this.rateLimitReset = options.rateLimitReset;
  }
}

export type XOAuthGrant = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
};

export type XHttpOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function basicCredentials(clientId: string, clientSecret: string): string {
  const bytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function readXBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  if (!response.body) return null;
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeProviderCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
    ? value
    : undefined;
}

function tokenError(status: number, parsed: JsonObject | null): XApiError {
  const providerCode = safeProviderCode(parsed?.error);
  const kind: XApiErrorKind = providerCode === "invalid_grant"
    ? "credentials-expired"
    : providerCode === "invalid_client"
    ? "invalid-client"
    : status === 429
    ? "rate-limited"
    : status === 402 || status === 403
    ? "funding"
    : "provider";
  return new XApiError({
    message: `X authorization request failed (status ${status}${providerCode ? `, code ${providerCode}` : ""}).`,
    status,
    kind,
    providerCode,
  });
}

export async function fetchXWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  options: XHttpOptions,
): Promise<Response> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await (options.fetch ?? fetch)(input, { ...init, signal, redirect: "error" });
  } catch {
    throw new XApiError({
      message: signal.aborted
        ? "X request timed out before receiving a response."
        : "X request failed before receiving a response.",
      status: 0,
      kind: signal.aborted ? "timeout" : "network",
    });
  }
}

function parseScopes(value: unknown): string[] {
  if (typeof value !== "string") {
    throw new XApiError({
      message: "X authorization returned an invalid scope set.",
      status: 502,
      kind: "invalid-response",
    });
  }
  const scopes = value.split(/\s+/).filter(Boolean);
  const granted = new Set(scopes);
  const expected = new Set<string>(X_OAUTH_SCOPES);
  const missing = X_OAUTH_SCOPES.filter(scope => !granted.has(scope));
  const unexpected = [...granted].filter(scope => !expected.has(scope));
  if (missing.length > 0 || unexpected.length > 0) {
    const detail = [
      missing.length > 0 ? "missing required scopes" : undefined,
      unexpected.length > 0 ? "unexpected scopes" : undefined,
    ].filter(Boolean).join(" and ");
    throw new XApiError({
      message: `X authorization returned ${detail}.`,
      status: 403,
      kind: "provider",
    });
  }
  return [...X_OAUTH_SCOPES];
}

function parseGrant(parsed: JsonObject | null, currentRefreshToken?: string): XOAuthGrant {
  const accessToken = parsed?.access_token;
  const refreshToken = typeof parsed?.refresh_token === "string"
    ? parsed.refresh_token
    : currentRefreshToken;
  const expiresIn = parsed?.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0 ||
      typeof refreshToken !== "string" || refreshToken.length === 0 ||
      typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new XApiError({
      message: "X authorization returned an invalid token grant.",
      status: 502,
      kind: "invalid-response",
    });
  }
  return {
    accessToken,
    refreshToken,
    expiresIn,
    scopes: parseScopes(parsed?.scope),
  };
}

async function requestToken(
  fields: Record<string, string>,
  clientId: string,
  clientSecret: string,
  options: XHttpOptions,
  currentRefreshToken?: string,
): Promise<XOAuthGrant> {
  const response = await fetchXWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${basicCredentials(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  }, options);
  const parsed = await readXBoundedJson(response, MAX_OAUTH_RESPONSE_BYTES);
  if (!response.ok) throw tokenError(response.status, parsed);
  if (!parsed) {
    throw new XApiError({
      message: "X authorization returned an invalid response.",
      status: 502,
      kind: "invalid-response",
    });
  }
  return parseGrant(parsed, currentRefreshToken);
}

export function generateXOAuthState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function generateXPkceVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function xPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function buildXAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", X_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function exchangeXAuthorizationCode(
  input: {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  options: XHttpOptions = {},
): Promise<XOAuthGrant> {
  return requestToken({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  }, input.clientId, input.clientSecret, options);
}

export function refreshXAccessToken(
  input: { clientId: string; clientSecret: string; refreshToken: string },
  options: XHttpOptions = {},
): Promise<XOAuthGrant> {
  return requestToken({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  }, input.clientId, input.clientSecret, options, input.refreshToken);
}

