import {
  XApiError,
  fetchXWithTimeout,
  readXBoundedJson,
  type XApiErrorKind,
  type XHttpOptions,
} from "./x-api";

const API_BASE_URL = "https://api.x.com";
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const ID_PATTERN = /^[0-9]{1,19}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const PAGINATION_TOKEN_PATTERN = /^[A-Za-z0-9._~:-]{1,1024}$/;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS = 20;
const MAX_SEARCH_LENGTH = 512;
const MAX_POST_TEXT_LENGTH = 25_000;

const USER_FIELDS = [
  "id",
  "name",
  "username",
  "description",
  "profile_image_url",
  "protected",
  "verified",
  "created_at",
  "public_metrics",
].join(",");

const POST_FIELDS = [
  "id",
  "text",
  "author_id",
  "created_at",
  "conversation_id",
  "in_reply_to_user_id",
  "referenced_tweets",
  "lang",
  "public_metrics",
].join(",");

const POST_EXPANSIONS = [
  "author_id",
  "in_reply_to_user_id",
  "referenced_tweets.id",
  "referenced_tweets.id.author_id",
].join(",");

type JsonObject = Record<string, unknown>;

export type XUser = {
  id: string;
  name: string;
  username: string;
  description?: string;
  profileImageUrl?: string;
  protected?: boolean;
  verified?: boolean;
  createdAt?: string;
  publicMetrics?: Record<string, number>;
};

export type XPost = {
  id: string;
  text: string;
  authorId?: string;
  createdAt?: string;
  conversationId?: string;
  inReplyToUserId?: string;
  lang?: string;
  referencedPosts?: Array<{ type: string; id: string }>;
  publicMetrics?: Record<string, number>;
};

export type XPageOptions = {
  maxResults?: number;
  nextToken?: string;
};

export type XPostPage = {
  data: XPost[];
  users: XUser[];
  nextToken?: string;
};

export type XUserPage = {
  data: XUser[];
  nextToken?: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(message: string): XApiError {
  return new XApiError({
    message: `X API returned ${message}.`,
    status: 502,
    kind: "invalid-response",
  });
}

function requireId(value: string, name = "id"): string {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} must be a numeric X id.`);
  return value;
}

function requireUsername(value: string): string {
  if (!USERNAME_PATTERN.test(value)) {
    throw new TypeError("username must be a valid X username.");
  }
  return value;
}

function requirePostText(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_POST_TEXT_LENGTH ||
      [...value].some(character => {
        const code = character.charCodeAt(0);
        return code === 0 || (code < 32 && character !== "\n" && character !== "\t");
      })) {
    throw new TypeError(`text must contain 1 to ${MAX_POST_TEXT_LENGTH} safe characters.`);
  }
  return value;
}

function requireSearchQuery(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SEARCH_LENGTH ||
      [...value].some(character => character.charCodeAt(0) < 32)) {
    throw new TypeError(`query must contain 1 to ${MAX_SEARCH_LENGTH} safe characters.`);
  }
  return value;
}

function pageOptions(options: XPageOptions = {}): { maxResults: number; nextToken?: string } {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults < DEFAULT_MAX_RESULTS ||
      maxResults > MAX_RESULTS) {
    throw new TypeError(`maxResults must be an integer from ${DEFAULT_MAX_RESULTS} to ${MAX_RESULTS}.`);
  }
  if (options.nextToken !== undefined && !PAGINATION_TOKEN_PATTERN.test(options.nextToken)) {
    throw new TypeError("nextToken is invalid.");
  }
  return { maxResults, ...(options.nextToken ? { nextToken: options.nextToken } : {}) };
}

function numericMetrics(value: unknown): Record<string, number> | undefined {
  if (!isObject(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "number" || !Number.isFinite(item)) return undefined;
    result[key] = item;
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseUser(value: unknown): XUser {
  if (!isObject(value) || typeof value.id !== "string" || !ID_PATTERN.test(value.id) ||
      typeof value.name !== "string" || typeof value.username !== "string" ||
      !USERNAME_PATTERN.test(value.username)) {
    throw invalidResponse("an invalid user");
  }
  return {
    id: value.id,
    name: value.name,
    username: value.username,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.profile_image_url === "string"
      ? { profileImageUrl: value.profile_image_url }
      : {}),
    ...(typeof value.protected === "boolean" ? { protected: value.protected } : {}),
    ...(typeof value.verified === "boolean" ? { verified: value.verified } : {}),
    ...(typeof value.created_at === "string" ? { createdAt: value.created_at } : {}),
    ...(numericMetrics(value.public_metrics)
      ? { publicMetrics: numericMetrics(value.public_metrics) }
      : {}),
  };
}

function parseReferences(value: unknown): Array<{ type: string; id: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidResponse("invalid referenced posts");
  return value.map(item => {
    if (!isObject(item) || typeof item.type !== "string" ||
        typeof item.id !== "string" || !ID_PATTERN.test(item.id)) {
      throw invalidResponse("invalid referenced posts");
    }
    return { type: item.type, id: item.id };
  });
}

function parsePost(value: unknown): XPost {
  if (!isObject(value) || typeof value.id !== "string" || !ID_PATTERN.test(value.id) ||
      typeof value.text !== "string") {
    throw invalidResponse("an invalid post");
  }
  const authorId = optionalString(value.author_id);
  const conversationId = optionalString(value.conversation_id);
  const inReplyToUserId = optionalString(value.in_reply_to_user_id);
  for (const [name, id] of [
    ["author_id", authorId],
    ["conversation_id", conversationId],
    ["in_reply_to_user_id", inReplyToUserId],
  ] as const) {
    if (id !== undefined && !ID_PATTERN.test(id)) throw invalidResponse(`an invalid ${name}`);
  }
  const references = parseReferences(value.referenced_tweets);
  const metrics = numericMetrics(value.public_metrics);
  return {
    id: value.id,
    text: value.text,
    ...(authorId ? { authorId } : {}),
    ...(typeof value.created_at === "string" ? { createdAt: value.created_at } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(inReplyToUserId ? { inReplyToUserId } : {}),
    ...(typeof value.lang === "string" ? { lang: value.lang } : {}),
    ...(references ? { referencedPosts: references } : {}),
    ...(metrics ? { publicMetrics: metrics } : {}),
  };
}

function nextToken(value: unknown): string | undefined {
  if (!isObject(value) || value.next_token === undefined) return undefined;
  if (typeof value.next_token !== "string" ||
      !PAGINATION_TOKEN_PATTERN.test(value.next_token)) {
    throw invalidResponse("an invalid pagination token");
  }
  return value.next_token;
}

function parsePostPage(value: JsonObject): XPostPage {
  if (!Array.isArray(value.data)) throw invalidResponse("an invalid post page");
  const includes = value.includes;
  let users: XUser[] = [];
  if (includes !== undefined) {
    if (!isObject(includes) || !Array.isArray(includes.users)) {
      throw invalidResponse("invalid post expansions");
    }
    users = includes.users.map(parseUser);
  }
  const token = nextToken(value.meta);
  return {
    data: value.data.map(parsePost),
    users,
    ...(token ? { nextToken: token } : {}),
  };
}

function parseUserPage(value: JsonObject): XUserPage {
  if (!Array.isArray(value.data)) throw invalidResponse("an invalid user page");
  const token = nextToken(value.meta);
  return {
    data: value.data.map(parseUser),
    ...(token ? { nextToken: token } : {}),
  };
}

function safeProviderCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
    ? value
    : undefined;
}

function providerCode(value: JsonObject | null): string | undefined {
  return safeProviderCode(value?.type) ?? safeProviderCode(value?.error) ??
    safeProviderCode(value?.title);
}

function apiError(response: Response, parsed: JsonObject | null): XApiError {
  const code = providerCode(parsed);
  const funding = response.status === 402 ||
    (response.status === 403 && !!code && /credit|usage|cap|fund|subscription/i.test(code));
  const kind: XApiErrorKind = response.status === 401
    ? "credentials-expired"
    : response.status === 429
    ? "rate-limited"
    : funding
    ? "funding"
    : "provider";
  const resetValue = response.headers.get("x-rate-limit-reset");
  const reset = resetValue && /^\d{1,12}$/.test(resetValue) ? Number(resetValue) : NaN;
  const rateLimitReset = Number.isSafeInteger(reset) && reset > 0
    ? new Date(reset * 1000)
    : undefined;
  return new XApiError({
    message: `X API request failed (status ${response.status}${code ? `, code ${code}` : ""}).`,
    status: response.status,
    kind,
    ...(code ? { providerCode: code } : {}),
    ...(rateLimitReset ? { rateLimitReset } : {}),
  });
}

function appendPostFields(url: URL): void {
  url.searchParams.set("tweet.fields", POST_FIELDS);
  url.searchParams.set("user.fields", USER_FIELDS);
  url.searchParams.set("expansions", POST_EXPANSIONS);
}

function appendUserFields(url: URL): void {
  url.searchParams.set("user.fields", USER_FIELDS);
}

function appendPage(url: URL, options: XPageOptions): void {
  const page = pageOptions(options);
  url.searchParams.set("max_results", String(page.maxResults));
  if (page.nextToken) url.searchParams.set("pagination_token", page.nextToken);
}

export class XApi {
  readonly #accessToken: string;
  readonly #userId?: string;
  readonly #options: XHttpOptions;

  constructor(options: {
    accessToken: string;
    userId?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    if (!options.accessToken) throw new TypeError("accessToken is required.");
    this.#accessToken = options.accessToken;
    this.#userId = options.userId === undefined
      ? undefined
      : requireId(options.userId, "userId");
    this.#options = {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    };
  }

  async #request(
    path: string,
    init: { method?: "GET" | "POST" | "DELETE"; body?: JsonObject } = {},
    configure?: (url: URL) => void,
  ): Promise<JsonObject> {
    const url = new URL(path, API_BASE_URL);
    if (url.origin !== API_BASE_URL) throw new TypeError("Invalid X API path.");
    configure?.(url);
    const response = await fetchXWithTimeout(url, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.#accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    }, this.#options);
    const parsed = await readXBoundedJson(response, MAX_API_RESPONSE_BYTES);
    if (!response.ok) throw apiError(response, parsed);
    if (!parsed) throw invalidResponse("an invalid response");
    return parsed;
  }

  #actorId(): string {
    if (!this.#userId) throw new TypeError("Authenticated X userId is required for this operation.");
    return this.#userId;
  }

  async getMe(): Promise<XUser> {
    const result = await this.#request("/2/users/me", {}, appendUserFields);
    return parseUser(result.data);
  }

  async getUser(input: { id?: string; username?: string }): Promise<XUser> {
    if ((input.id === undefined) === (input.username === undefined)) {
      throw new TypeError("Provide exactly one user id or username.");
    }
    const path = input.id !== undefined
      ? `/2/users/${requireId(input.id)}`
      : `/2/users/by/username/${requireUsername(input.username!)}`;
    const result = await this.#request(path, {}, appendUserFields);
    return parseUser(result.data);
  }

  async getPost(id: string): Promise<XPost> {
    const result = await this.#request(`/2/tweets/${requireId(id)}`, {}, appendPostFields);
    return parsePost(result.data);
  }

  #postPage(path: string, options: XPageOptions = {}, query?: string): Promise<XPostPage> {
    return this.#request(path, {}, url => {
      appendPostFields(url);
      appendPage(url, options);
      if (query !== undefined) url.searchParams.set("query", requireSearchQuery(query));
    }).then(parsePostPage);
  }

  listMyPosts(options: XPageOptions = {}): Promise<XPostPage> {
    return this.#postPage(`/2/users/${this.#actorId()}/tweets`, options);
  }

  listMentions(options: XPageOptions = {}): Promise<XPostPage> {
    return this.#postPage(`/2/users/${this.#actorId()}/mentions`, options);
  }

  listHomeTimeline(options: XPageOptions = {}): Promise<XPostPage> {
    return this.#postPage(
      `/2/users/${this.#actorId()}/timelines/reverse_chronological`,
      options,
    );
  }

  async searchRecent(query: string, options: XPageOptions = {}): Promise<XPostPage> {
    requireSearchQuery(query);
    return await this.#postPage("/2/tweets/search/recent", options, query);
  }

  listLikedPosts(options: XPageOptions = {}): Promise<XPostPage> {
    return this.#postPage(`/2/users/${this.#actorId()}/liked_tweets`, options);
  }

  listBookmarks(options: XPageOptions = {}): Promise<XPostPage> {
    return this.#postPage(`/2/users/${this.#actorId()}/bookmarks`, options);
  }

  #userPage(path: string, options: XPageOptions = {}): Promise<XUserPage> {
    return this.#request(path, {}, url => {
      appendUserFields(url);
      appendPage(url, options);
    }).then(parseUserPage);
  }

  listFollowers(options: XPageOptions = {}): Promise<XUserPage> {
    return this.#userPage(`/2/users/${this.#actorId()}/followers`, options);
  }

  listFollowing(options: XPageOptions = {}): Promise<XUserPage> {
    return this.#userPage(`/2/users/${this.#actorId()}/following`, options);
  }

  async createPost(text: string): Promise<void> {
    const result = await this.#request("/2/tweets", {
      method: "POST",
      body: { text: requirePostText(text) },
    });
    parsePost(result.data);
  }

  async reply(text: string, postId: string): Promise<void> {
    const result = await this.#request("/2/tweets", {
      method: "POST",
      body: {
        text: requirePostText(text),
        reply: { in_reply_to_tweet_id: requireId(postId, "postId") },
      },
    });
    parsePost(result.data);
  }

  async deletePost(postId: string): Promise<void> {
    const result = await this.#request(`/2/tweets/${requireId(postId, "postId")}`, {
      method: "DELETE",
    });
    this.#requireBooleanResult(result, "deleted", true);
  }

  async like(postId: string): Promise<void> {
    const result = await this.#request(`/2/users/${this.#actorId()}/likes`, {
      method: "POST",
      body: { tweet_id: requireId(postId, "postId") },
    });
    this.#requireBooleanResult(result, "liked", true);
  }

  async unlike(postId: string): Promise<void> {
    const result = await this.#request(
      `/2/users/${this.#actorId()}/likes/${requireId(postId, "postId")}`,
      { method: "DELETE" },
    );
    this.#requireBooleanResult(result, "liked", false);
  }

  async bookmark(postId: string): Promise<void> {
    const result = await this.#request(`/2/users/${this.#actorId()}/bookmarks`, {
      method: "POST",
      body: { tweet_id: requireId(postId, "postId") },
    });
    this.#requireBooleanResult(result, "bookmarked", true);
  }

  async removeBookmark(postId: string): Promise<void> {
    const result = await this.#request(
      `/2/users/${this.#actorId()}/bookmarks/${requireId(postId, "postId")}`,
      { method: "DELETE" },
    );
    this.#requireBooleanResult(result, "bookmarked", false);
  }

  async follow(userId: string): Promise<void> {
    const result = await this.#request(`/2/users/${this.#actorId()}/following`, {
      method: "POST",
      body: { target_user_id: requireId(userId, "userId") },
    });
    this.#requireBooleanResult(result, "following", true);
  }

  async unfollow(userId: string): Promise<void> {
    const result = await this.#request(
      `/2/users/${this.#actorId()}/following/${requireId(userId, "userId")}`,
      { method: "DELETE" },
    );
    this.#requireBooleanResult(result, "following", false);
  }

  #requireBooleanResult(result: JsonObject, key: string, expected: boolean): void {
    if (!isObject(result.data) || result.data[key] !== expected) {
      throw invalidResponse(`an invalid ${key} result`);
    }
  }
}
