import type {
  HubSpotCompany,
  HubSpotCompanyProperties,
  HubSpotContact,
  HubSpotContactProperties,
  HubSpotDeal,
  HubSpotDealProperties,
} from "./types";

const AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const TOKEN_URL = "https://api.hubapi.com/oauth/2026-03/token";
const API_BASE_URL = "https://api.hubapi.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_CRM_RESPONSE_BYTES = 1024 * 1024;
const MAX_SEARCH_QUERY_LENGTH = 3000;

export const MAX_HUBSPOT_PROPERTY_VALUE_LENGTH = 16_384;

export const HUBSPOT_CRM_PROPERTIES = {
  contacts: [
    "email",
    "firstname",
    "lastname",
    "phone",
    "mobilephone",
    "jobtitle",
    "company",
    "website",
    "lifecyclestage",
  ],
  companies: [
    "name",
    "domain",
    "phone",
    "website",
    "city",
    "state",
    "country",
    "industry",
    "lifecyclestage",
  ],
  deals: [
    "dealname",
    "amount",
    "closedate",
    "pipeline",
    "dealstage",
    "description",
    "dealtype",
  ],
} as const;

export const HUBSPOT_OAUTH_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
] as const;

export type HubSpotApiErrorKind =
  | "credentials-expired"
  | "rate-limited"
  | "provider"
  | "invalid-response"
  | "timeout"
  | "network";

export class HubSpotApiError extends Error {
  readonly status: number;
  readonly category?: string;
  readonly correlationId?: string;
  readonly kind: HubSpotApiErrorKind;
  readonly isCredentialExpired: boolean;
  readonly isRateLimited: boolean;

  constructor(options: {
    message: string;
    status: number;
    kind: HubSpotApiErrorKind;
    category?: string;
    correlationId?: string;
  }) {
    super(options.message);
    this.name = "HubSpotApiError";
    this.status = options.status;
    this.kind = options.kind;
    this.category = options.category;
    this.correlationId = options.correlationId;
    this.isCredentialExpired = options.kind === "credentials-expired";
    this.isRateLimited = options.kind === "rate-limited";
  }
}

export type HubSpotOAuthGrant = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  hubId: number;
  scopes?: string[];
};

export type HubSpotRefreshGrant = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
};

export type HubSpotHttpOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<JsonObject | null> {
  if (!response.body) return null;

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

function safeMetadata(value: unknown, sensitiveValues: readonly string[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return undefined;
  if (sensitiveValues.some(sensitive => sensitive.length > 0 && value.includes(sensitive))) {
    return undefined;
  }
  return value;
}

function sensitiveResponseValues(parsed: JsonObject | null): string[] {
  if (!parsed) return [];
  return [parsed.access_token, parsed.refresh_token, parsed.client_secret]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function providerError(
  status: number,
  parsed: JsonObject | null,
  sensitiveValues: readonly string[],
  prefix = "HubSpot API request failed",
): HubSpotApiError {
  const category = safeMetadata(parsed?.category ?? parsed?.error, sensitiveValues);
  const correlationId = safeMetadata(
    parsed?.correlationId ?? parsed?.correlation_id,
    sensitiveValues,
  );
  const details = [
    `status ${status}`,
    category ? `category ${category}` : undefined,
    correlationId ? `correlationId ${correlationId}` : undefined,
  ].filter((value): value is string => value !== undefined).join(", ");
  const kind: HubSpotApiErrorKind = status === 401
    ? "credentials-expired"
    : status === 429
    ? "rate-limited"
    : "provider";
  return new HubSpotApiError({
    message: `${prefix} (${details})`,
    status,
    kind,
    category,
    correlationId,
  });
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  options: HubSpotHttpOptions,
): Promise<Response> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await (options.fetch ?? fetch)(input, { ...init, signal });
  } catch {
    if (signal.aborted) {
      throw new HubSpotApiError({
        message: "HubSpot request timed out",
        status: 0,
        kind: "timeout",
      });
    }
    throw new HubSpotApiError({
      message: "HubSpot request failed before receiving a response",
      status: 0,
      kind: "network",
    });
  }
}

export function generateHubSpotOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function buildHubSpotAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", HUBSPOT_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function postToken(
  fields: Record<string, string>,
  sensitiveValues: readonly string[],
  options: HubSpotHttpOptions,
): Promise<JsonObject> {
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  }, options);
  const parsed = await readBoundedJson(response, MAX_OAUTH_RESPONSE_BYTES);
  if (!response.ok) {
    throw providerError(
      response.status,
      parsed,
      [...sensitiveValues, ...sensitiveResponseValues(parsed)],
      "HubSpot OAuth request failed",
    );
  }
  if (!parsed) {
    throw new HubSpotApiError({
      message: "HubSpot OAuth returned an invalid response",
      status: response.status,
      kind: "invalid-response",
    });
  }
  return parsed;
}

function requireString(parsed: JsonObject, field: string): string {
  const value = parsed[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new HubSpotApiError({
      message: `HubSpot OAuth response has invalid ${field}`,
      status: 200,
      kind: "invalid-response",
    });
  }
  return value;
}

function requireExpiresIn(parsed: JsonObject): number {
  const value = parsed.expires_in;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HubSpotApiError({
      message: "HubSpot OAuth response has invalid expires_in",
      status: 200,
      kind: "invalid-response",
    });
  }
  return value;
}

function optionalScopes(parsed: JsonObject): string[] | undefined {
  if (parsed.scopes === undefined) return undefined;
  if (!Array.isArray(parsed.scopes) || parsed.scopes.length > 64 ||
    parsed.scopes.some(scope => typeof scope !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(scope))) {
    throw new HubSpotApiError({
      message: "HubSpot OAuth response has invalid scopes",
      status: 200,
      kind: "invalid-response",
    });
  }
  return [...new Set(parsed.scopes)];
}

export async function exchangeHubSpotAuthorizationCode(
  input: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  },
  options: HubSpotHttpOptions = {},
): Promise<HubSpotOAuthGrant> {
  const parsed = await postToken({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  }, [input.clientSecret, input.code], options);
  const hubId = parsed.hub_id;
  if (typeof hubId !== "number" || !Number.isFinite(hubId)) {
    throw new HubSpotApiError({
      message: "HubSpot OAuth response has invalid hub_id",
      status: 200,
      kind: "invalid-response",
    });
  }
  const scopes = optionalScopes(parsed);
  return {
    accessToken: requireString(parsed, "access_token"),
    refreshToken: requireString(parsed, "refresh_token"),
    expiresIn: requireExpiresIn(parsed),
    hubId,
    ...(scopes === undefined ? {} : { scopes }),
  };
}

export async function refreshHubSpotAccessToken(
  input: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  },
  options: HubSpotHttpOptions = {},
): Promise<HubSpotRefreshGrant> {
  const parsed = await postToken({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  }, [input.clientSecret, input.refreshToken], options);
  const replacement = parsed.refresh_token;
  if (replacement !== undefined && (typeof replacement !== "string" || replacement.length === 0)) {
    throw new HubSpotApiError({
      message: "HubSpot OAuth response has invalid refresh_token",
      status: 200,
      kind: "invalid-response",
    });
  }
  return {
    accessToken: requireString(parsed, "access_token"),
    ...(replacement === undefined ? {} : { refreshToken: replacement }),
    expiresIn: requireExpiresIn(parsed),
  };
}

export type HubSpotCrmObjectType = keyof typeof HUBSPOT_CRM_PROPERTIES;

export type HubSpotPropertiesByObjectType = {
  contacts: HubSpotContactProperties;
  companies: HubSpotCompanyProperties;
  deals: HubSpotDealProperties;
};

export type HubSpotRecordByObjectType = {
  contacts: HubSpotContact;
  companies: HubSpotCompany;
  deals: HubSpotDeal;
};

export type HubSpotSearchOptions = {
  query: string;
  limit?: number;
  after?: string;
};

export type HubSpotSearchPage<T extends HubSpotCrmObjectType> = {
  results: HubSpotRecordByObjectType[T][];
  total: number;
  nextAfter?: string;
};

export type HubSpotApiOptions = HubSpotHttpOptions & {
  getAccessToken: () => Promise<string>;
};

function assertObjectType(value: unknown): asserts value is HubSpotCrmObjectType {
  if (value !== "contacts" && value !== "companies" && value !== "deals") {
    throw new TypeError("Unsupported HubSpot CRM object type");
  }
}

export function validateHubSpotRecordId(id: unknown): string {
  if (typeof id !== "string" || !/^[1-9]\d*$/.test(id)) {
    throw new TypeError("HubSpot record ID must be a positive integer string");
  }
  return id;
}

type ValidatedSearchOptions = {
  query: string;
  limit: number;
  after?: string;
};

function assertSearchOptions(options: HubSpotSearchOptions): ValidatedSearchOptions {
  if (typeof options.query !== "string" || options.query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new TypeError(`HubSpot search query must not exceed ${MAX_SEARCH_QUERY_LENGTH} characters`);
  }
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("HubSpot search limit must be an integer from 1 through 100");
  }
  if (options.after !== undefined && (
    typeof options.after !== "string" || !/^\d+$/.test(options.after)
  )) {
    throw new TypeError("HubSpot search after cursor must be an integer string");
  }
  return { query: options.query, limit, after: options.after };
}

function curatedPropertyNames(type: HubSpotCrmObjectType): readonly string[] {
  return HUBSPOT_CRM_PROPERTIES[type];
}

export function validateHubSpotProperties<T extends HubSpotCrmObjectType>(
  type: T,
  input: unknown,
): HubSpotPropertiesByObjectType[T] {
  if (!isJsonObject(input)) {
    throw new TypeError("HubSpot CRM properties must be an object");
  }
  const allowed = new Set<string>(curatedPropertyNames(type));
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) {
      throw new TypeError(`Unsupported HubSpot ${type} property`);
    }
    if (typeof value !== "string") {
      throw new TypeError(`HubSpot ${type} property values must be strings`);
    }
    if (value.length > MAX_HUBSPOT_PROPERTY_VALUE_LENGTH) {
      throw new TypeError(`HubSpot ${type} property value exceeds the maximum length`);
    }
    output[key] = value;
  }
  if (Object.keys(output).length === 0) {
    throw new TypeError(`HubSpot ${type} properties must not be empty`);
  }
  return output;
}

function invalidCrmResponse(status: number): HubSpotApiError {
  return new HubSpotApiError({
    message: "HubSpot CRM returned an invalid response",
    status,
    kind: "invalid-response",
  });
}

function crmRecord<T extends HubSpotCrmObjectType>(
  type: T,
  value: unknown,
  status: number,
): HubSpotRecordByObjectType[T] {
  if (!isJsonObject(value)
    || typeof value.id !== "string"
    || !/^[1-9]\d*$/.test(value.id)
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
    || !isJsonObject(value.properties)) {
    throw invalidCrmResponse(status);
  }

  const properties: Record<string, string> = {};
  for (const key of curatedPropertyNames(type)) {
    const property = value.properties[key];
    if (property === undefined || property === null) continue;
    if (typeof property !== "string") throw invalidCrmResponse(status);
    properties[key] = property;
  }
  return {
    id: value.id,
    properties,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  } as HubSpotRecordByObjectType[T];
}

export class HubSpotApi {
  readonly #getAccessToken: () => Promise<string>;
  readonly #httpOptions: HubSpotHttpOptions;

  constructor(options: HubSpotApiOptions) {
    this.#getAccessToken = options.getAccessToken;
    this.#httpOptions = { fetch: options.fetch, timeoutMs: options.timeoutMs };
  }

  async #request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    sensitiveValues: readonly string[],
  ): Promise<{ parsed: JsonObject; status: number }> {
    let token: string;
    try {
      token = await this.#getAccessToken();
    } catch (error) {
      if (error instanceof HubSpotApiError) throw error;
      throw new HubSpotApiError({
        message: "HubSpot credentials are unavailable",
        status: 0,
        kind: "credentials-expired",
      });
    }
    if (!token) {
      throw new HubSpotApiError({
        message: "HubSpot credentials are unavailable",
        status: 0,
        kind: "credentials-expired",
      });
    }

    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    });
    let payload: string | undefined;
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      payload = JSON.stringify(body);
    }
    const response = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: payload,
    }, this.#httpOptions);
    const parsed = await readBoundedJson(response, MAX_CRM_RESPONSE_BYTES);
    if (!response.ok) {
      throw providerError(response.status, parsed, [token, ...sensitiveValues]);
    }
    if (!parsed) throw invalidCrmResponse(response.status);
    return { parsed, status: response.status };
  }

  async search<T extends HubSpotCrmObjectType>(
    type: T,
    options: HubSpotSearchOptions,
  ): Promise<HubSpotSearchPage<T>> {
    assertObjectType(type);
    const bounded = assertSearchOptions(options);
    const body = {
      query: bounded.query,
      limit: bounded.limit,
      ...(bounded.after === undefined ? {} : { after: bounded.after }),
      properties: curatedPropertyNames(type),
    };
    const { parsed, status } = await this.#request(
      "POST",
      `/crm/objects/2026-03/${type}/search`,
      body,
      [bounded.query],
    );
    if (!Array.isArray(parsed.results)
      || parsed.results.length > 100
      || typeof parsed.total !== "number"
      || !Number.isInteger(parsed.total)
      || parsed.total < 0) {
      throw invalidCrmResponse(status);
    }

    let nextAfter: string | undefined;
    if (parsed.paging !== undefined) {
      if (!isJsonObject(parsed.paging)
        || !isJsonObject(parsed.paging.next)
        || typeof parsed.paging.next.after !== "string"
        || !/^\d+$/.test(parsed.paging.next.after)) {
        throw invalidCrmResponse(status);
      }
      nextAfter = parsed.paging.next.after;
    }
    return {
      results: parsed.results.map(result => crmRecord(type, result, status)),
      total: parsed.total,
      ...(nextAfter === undefined ? {} : { nextAfter }),
    };
  }

  async get<T extends HubSpotCrmObjectType>(
    type: T,
    id: string,
  ): Promise<HubSpotRecordByObjectType[T]> {
    assertObjectType(type);
    validateHubSpotRecordId(id);
    const properties = new URLSearchParams({
      properties: curatedPropertyNames(type).join(","),
    });
    const { parsed, status } = await this.#request(
      "GET",
      `/crm/objects/2026-03/${type}/${id}?${properties}`,
      undefined,
      [],
    );
    return crmRecord(type, parsed, status);
  }

  async create<T extends HubSpotCrmObjectType>(
    type: T,
    properties: HubSpotPropertiesByObjectType[T],
  ): Promise<HubSpotRecordByObjectType[T]> {
    assertObjectType(type);
    const bounded = validateHubSpotProperties(type, properties);
    const { parsed, status } = await this.#request(
      "POST",
      `/crm/objects/2026-03/${type}`,
      { properties: bounded },
      Object.values(bounded),
    );
    return crmRecord(type, parsed, status);
  }

  async update<T extends HubSpotCrmObjectType>(
    type: T,
    id: string,
    properties: HubSpotPropertiesByObjectType[T],
  ): Promise<HubSpotRecordByObjectType[T]> {
    assertObjectType(type);
    validateHubSpotRecordId(id);
    const bounded = validateHubSpotProperties(type, properties);
    const { parsed, status } = await this.#request(
      "PATCH",
      `/crm/objects/2026-03/${type}/${id}`,
      { properties: bounded },
      Object.values(bounded),
    );
    return crmRecord(type, parsed, status);
  }
}
