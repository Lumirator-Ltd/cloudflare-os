import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionDescription,
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorInterface,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  XApiError,
  buildXAuthorizationUrl,
  exchangeXAuthorizationCode,
  generateXOAuthState,
  generateXPkceVerifier,
  refreshXAccessToken,
  xPkceChallenge,
} from "./x-api";
import {
  XApi,
  type XPageOptions,
  type XPost,
  type XPostPage,
  type XUser,
  type XUserPage,
} from "./x-api-client";
import type { XAccountSession } from "./types";
import {
  XActionStore,
  queueXAction,
  type XWriteOperation,
  type XWriteResult,
} from "./x-actions";
import {
  buildXConnectUrl,
  parseXCredentialForm,
  xConnectFormResponse,
  type XConnectLanguage,
} from "./connect-form";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env & { BASE_URL?: string };

type XGatekeeperUserProps = { userObjectId: string };
type XGatekeeperProps = { userObjectId: string };

type ConnectionAttempt = {
  nonce: string;
  expiresAt: number;
  reconnecting: boolean;
  language: XConnectLanguage;
};

type OAuthAttempt = {
  nonce: string;
  verifier: string;
  expiresAt: number;
  reconnecting: boolean;
  generation: number;
  language: XConnectLanguage;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
};

export type XReadOperation =
  | { type: "getMe" }
  | { type: "getUser"; input: { id?: string; username?: string } }
  | { type: "getPost"; id: string }
  | { type: "listMyPosts"; options?: XPageOptions }
  | { type: "listMentions"; options?: XPageOptions }
  | { type: "listHomeTimeline"; options?: XPageOptions }
  | { type: "searchRecent"; query: string; options?: XPageOptions }
  | { type: "listLikedPosts"; options?: XPageOptions }
  | { type: "listBookmarks"; options?: XPageOptions }
  | { type: "listFollowers"; options?: XPageOptions }
  | { type: "listFollowing"; options?: XPageOptions };

type StoredCredentials = {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  generation: number;
  language: XConnectLanguage;
  user: XUser;
};

const CONNECTION_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_LIFETIME_MS = 10 * 60 * 1000;
const ABANDONED_ACCOUNT_LIFETIME_MS = 60 * 60 * 1000;
const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;
const MAX_AUTHORIZATION_CODE_LENGTH = 4096;

const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "X Account",
  description:
    "Whole-account access to profiles, posts, timelines, mentions, search, likes, bookmarks, and follows.",
  workspaceAccess: "owner-only",
};

const SUPPORTED_RESOURCES = [ACCOUNT_RESOURCE];

function getBaseUrl(env: Env): string {
  const value = env.BASE_URL?.replace(/\/+$/, "");
  if (!value) throw new Error("X gatekeeper BASE_URL is not configured.");
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("X gatekeeper BASE_URL is invalid.");
  }
  return value;
}

function getBasePath(env: Env): string {
  const pathname = new URL(getBaseUrl(env)).pathname.replace(/\/+$/, "");
  return pathname === "/" ? "" : pathname;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function connectedAccountUrl(user: XUser): string {
  return `https://x.com/${user.username}`;
}

export function isConnectedAccountUrl(value: string, user: XUser): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "x.com" &&
      !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === `/${user.username}` || url.pathname === `/${user.username}/`);
  } catch {
    return false;
  }
}

function safeErrorResponse(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function completedResponse(): Response {
  const body = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Connected</title></head>" +
    "<body><p>Connection complete. You can close this tab.</p></body></html>";
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const basePath = getBasePath(env);
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return new Response("Not Found", { status: 404 });
    }
    const relativePath = url.pathname.slice(basePath.length);
    const initiation = relativePath.match(/^\/([0-9a-f]{64})\/([A-Za-z0-9_-]{43})$/);

    if (initiation) {
      let account: DurableObjectStub<UserAccount>;
      try {
        account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(initiation[1]));
      } catch {
        return safeErrorResponse("This connection link is invalid or expired.");
      }

      if (request.method === "GET") {
        const attempt = await account.readConnectionAttempt(initiation[2]);
        if (!attempt) return safeErrorResponse("This connection link is invalid or expired.");
        return xConnectFormResponse({
          actionUrl: request.url,
          callbackUrl: `${getBaseUrl(env)}/oauth`,
          language: attempt.language,
        }).response;
      }

      if (request.method === "POST") {
        let form;
        try {
          form = await parseXCredentialForm(request);
        } catch {
          return safeErrorResponse("Invalid X Developer App form.");
        }
        try {
          const authorizationUrl = await account.beginOAuth({
            initiationNonce: initiation[2],
            clientId: form.clientId,
            clientSecret: form.clientSecret,
            redirectUri: `${getBaseUrl(env)}/oauth`,
          });
          if (!authorizationUrl) {
            return safeErrorResponse("This connection link is invalid or expired.");
          }
          return Response.redirect(authorizationUrl, 302);
        } catch {
          return xConnectFormResponse({
            actionUrl: request.url,
            callbackUrl: `${getBaseUrl(env)}/oauth`,
            language: form.language,
            error: true,
          }).response;
        }
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    if (relativePath === "/oauth" && request.method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      const match = state.match(/^([0-9a-f]{64})\.([A-Za-z0-9_-]{43})$/);
      if (!match) return safeErrorResponse("This authorization response is invalid or expired.");
      let account: DurableObjectStub<UserAccount>;
      try {
        account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(match[1]));
      } catch {
        return safeErrorResponse("This authorization response is invalid or expired.");
      }

      if (url.searchParams.has("error")) {
        await account.rejectOAuth(match[2]);
        return safeErrorResponse("X authorization was denied. Start the connection again.");
      }
      const code = url.searchParams.get("code");
      if (!code || code.length > MAX_AUTHORIZATION_CODE_LENGTH) {
        await account.rejectOAuth(match[2]);
        return safeErrorResponse("This authorization response is invalid or expired.");
      }
      try {
        if (!await account.acceptAuthCode(code, match[2])) {
          return safeErrorResponse("This authorization response is invalid or expired.");
        }
        return completedResponse();
      } catch {
        return safeErrorResponse("Could not finish connecting X. Start the connection again.");
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env>
  implements GatekeeperVendorInterface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "X",
      url: "https://x.com/",
      tagline: "Read and manage your X account with approval-gated writes",
      description:
        "Connect your own funded X Developer App and X account. Reads consume your API credits; every write waits for your approval.",
      providesAuth: false,
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    if (options?.resourceUrlPatterns !== undefined &&
        (options.resourceUrlPatterns.length !== 1 ||
          options.resourceUrlPatterns[0] !== ACCOUNT_RESOURCE.urlPattern)) {
      throw new Error("X supports only its whole-account resource.");
    }
    const accountId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateXOAuthState();
    const resolvedLanguage = options?.language === "ja" ? "ja" : "en";
    await this.ctx.exports.UserAccount.get(accountId).setCallback(
      callback,
      nonce,
      resolvedLanguage,
    );
    return {
      url: buildXConnectUrl(
        getBaseUrl(this.env),
        accountId.toString(),
        nonce,
        resolvedLanguage,
      ),
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  #credentialUpdate: Promise<void> = Promise.resolve();

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#credentialUpdate;
    let release!: () => void;
    this.#credentialUpdate = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async setCallback(
    callback: Fetcher<GatekeeperConnectCallback>,
    nonce: string,
    language: XConnectLanguage,
  ): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + ABANDONED_ACCOUNT_LIFETIME_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<ConnectionAttempt>("connectionAttempt", {
      nonce,
      expiresAt: Date.now() + CONNECTION_LIFETIME_MS,
      reconnecting: false,
      language,
    });
  }

  readConnectionAttempt(nonce: string): { language: XConnectLanguage } | null {
    const attempt = this.ctx.storage.kv.get<ConnectionAttempt>("connectionAttempt");
    if (!attempt || Date.now() >= attempt.expiresAt ||
        !constantTimeEqual(attempt.nonce, nonce)) return null;
    return { language: attempt.language };
  }

  async prepareReconnect(nonce: string): Promise<XConnectLanguage> {
    const credentials = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!credentials) throw new Error("X credentials are unavailable. Reconnect the account.");
    this.ctx.storage.kv.put<ConnectionAttempt>("connectionAttempt", {
      nonce,
      expiresAt: Date.now() + CONNECTION_LIFETIME_MS,
      reconnecting: true,
      language: credentials.language,
    });
    return credentials.language;
  }

  async beginOAuth(input: {
    initiationNonce: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<string | null> {
    const connection = this.ctx.storage.kv.get<ConnectionAttempt>("connectionAttempt");
    if (!connection || Date.now() >= connection.expiresAt ||
        !constantTimeEqual(connection.nonce, input.initiationNonce)) return null;

    this.ctx.storage.kv.delete("connectionAttempt");
    const nonce = generateXOAuthState();
    const verifier = generateXPkceVerifier();
    const credentials = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    const attempt: OAuthAttempt = {
      nonce,
      verifier,
      expiresAt: Date.now() + OAUTH_LIFETIME_MS,
      reconnecting: connection.reconnecting,
      generation: credentials?.generation ?? 0,
      language: connection.language,
      redirectUri: input.redirectUri,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    };
    this.ctx.storage.kv.put("oauthAttempt", attempt);
    try {
      const codeChallenge = await xPkceChallenge(verifier);
      const current = this.ctx.storage.kv.get<OAuthAttempt>("oauthAttempt");
      if (!current || !constantTimeEqual(current.nonce, nonce)) return null;
      return buildXAuthorizationUrl({
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        state: `${this.ctx.id.toString()}.${nonce}`,
        codeChallenge,
      });
    } catch (error) {
      const current = this.ctx.storage.kv.get<OAuthAttempt>("oauthAttempt");
      if (current && constantTimeEqual(current.nonce, nonce)) {
        this.ctx.storage.kv.delete("oauthAttempt");
      }
      throw error;
    }
  }

  rejectOAuth(nonce: string): boolean {
    const attempt = this.ctx.storage.kv.get<OAuthAttempt>("oauthAttempt");
    if (!attempt || Date.now() >= attempt.expiresAt ||
        !constantTimeEqual(attempt.nonce, nonce)) return false;
    this.ctx.storage.kv.delete("oauthAttempt");
    return true;
  }

  async acceptAuthCode(code: string, nonce: string): Promise<boolean> {
    return await this.#serialized(async () => {
      const attempt = this.ctx.storage.kv.get<OAuthAttempt>("oauthAttempt");
      if (!attempt || Date.now() >= attempt.expiresAt ||
          !constantTimeEqual(attempt.nonce, nonce)) return false;
      this.ctx.storage.kv.delete("oauthAttempt");

      const previous = this.ctx.storage.kv.get<StoredCredentials>("credentials");
      if ((previous?.generation ?? 0) !== attempt.generation) {
        throw new Error("X authorization was superseded by a credential change.");
      }
      const grant = await exchangeXAuthorizationCode({
        clientId: attempt.clientId,
        clientSecret: attempt.clientSecret,
        code,
        codeVerifier: attempt.verifier,
        redirectUri: attempt.redirectUri,
      });
      const user = await new XApi({ accessToken: grant.accessToken }).getMe();
      if (attempt.reconnecting && previous && user.id !== previous.user.id) {
        throw new Error("X reconnect must authorize the originally connected account.");
      }
      const next: StoredCredentials = {
        clientId: attempt.clientId,
        clientSecret: attempt.clientSecret,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        accessTokenExpiresAt: Date.now() + grant.expiresIn * 1000,
        generation: attempt.generation + 1,
        language: attempt.language,
        user,
      };
      this.ctx.storage.kv.put("credentials", next);
      this.ctx.storage.kv.put("expiredNotified", false);

      const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) {
        if (previous) this.ctx.storage.kv.put("credentials", previous);
        else this.ctx.storage.kv.delete("credentials");
        throw new Error("X connection callback expired.");
      }
      try {
        if (attempt.reconnecting) {
          await callback.credentialsRestored();
        } else {
          const exportsObject = Reflect.get(this.ctx, "exports") as object;
          const createUser = Reflect.get(exportsObject, "XGatekeeperUser") as (
            options: { props: XGatekeeperUserProps },
          ) => Fetcher<GatekeeperUser>;
          await callback.complete(createUser({
            props: { userObjectId: this.ctx.id.toString() },
          }));
        }
      } catch (error) {
        if (previous) this.ctx.storage.kv.put("credentials", previous);
        else this.ctx.storage.kv.delete("credentials");
        throw error;
      }
      await this.ctx.storage.deleteAlarm();
      return true;
    });
  }

  getProfile(): XUser {
    const credentials = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!credentials) throw new Error("X credentials are unavailable. Reconnect the account.");
    return credentials.user;
  }

  getCredentialGeneration(): number {
    const credentials = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!credentials) throw new Error("X credentials are unavailable. Reconnect the account.");
    return credentials.generation;
  }

  async #getAccessToken(): Promise<string> {
    const cached = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!cached) throw new Error("X credentials are unavailable. Reconnect the account.");
    if (cached.accessTokenExpiresAt > Date.now() + ACCESS_TOKEN_SAFETY_MS) {
      return cached.accessToken;
    }

    return await this.#serialized(async () => {
      const current = this.ctx.storage.kv.get<StoredCredentials>("credentials");
      if (!current) throw new Error("X credentials are unavailable. Reconnect the account.");
      if (current.accessTokenExpiresAt > Date.now() + ACCESS_TOKEN_SAFETY_MS) {
        return current.accessToken;
      }
      try {
        const grant = await refreshXAccessToken({
          clientId: current.clientId,
          clientSecret: current.clientSecret,
          refreshToken: current.refreshToken,
        });
        const latest = this.ctx.storage.kv.get<StoredCredentials>("credentials");
        if (!latest || latest.generation !== current.generation) {
          throw new Error("X token refresh was superseded by a credential change.");
        }
        const refreshed: StoredCredentials = {
          ...latest,
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken,
          accessTokenExpiresAt: Date.now() + grant.expiresIn * 1000,
        };
        this.ctx.storage.kv.put("credentials", refreshed);
        return refreshed.accessToken;
      } catch (error) {
        if (error instanceof XApiError && error.kind === "credentials-expired") {
          await this.#noteCredentialsExpired();
          throw new Error("X credentials have expired. Reconnect the account.", { cause: error });
        }
        if (error instanceof XApiError && error.kind === "invalid-client") {
          throw new Error("The X Developer App credentials were rejected. Reconnect the account.", {
            cause: error,
          });
        }
        throw error;
      }
    });
  }

  async performWrite(
    operation: XWriteOperation,
    expectedGeneration: number,
  ): Promise<XWriteResult> {
    const before = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!before || before.generation !== expectedGeneration) return { status: "stale" };

    let accessToken: string;
    try {
      accessToken = await this.#getAccessToken();
    } catch {
      return {
        status: "failed",
        message: "X credentials are unavailable. Reconnect the account before trying again.",
      };
    }
    const credentials = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!credentials || credentials.generation !== expectedGeneration) return { status: "stale" };
    const api = new XApi({ accessToken, userId: credentials.user.id });

    try {
      switch (operation.type) {
        case "createPost": await api.createPost(operation.text); break;
        case "reply": await api.reply(operation.text, operation.postId); break;
        case "deletePost": await api.deletePost(operation.postId); break;
        case "like": await api.like(operation.postId); break;
        case "unlike": await api.unlike(operation.postId); break;
        case "bookmark": await api.bookmark(operation.postId); break;
        case "removeBookmark": await api.removeBookmark(operation.postId); break;
        case "follow": await api.follow(operation.userId); break;
        case "unfollow": await api.unfollow(operation.userId); break;
      }
      return { status: "applied" };
    } catch (error) {
      if (error instanceof XApiError && error.kind === "credentials-expired") {
        await this.#noteCredentialsExpired();
      }
      if (error instanceof XApiError && error.status >= 400 && error.status < 500) {
        return {
          status: "failed",
          message: "X rejected the approved action. Review the account, permissions, and credits before trying a new action.",
        };
      }
      return {
        status: "outcome-unknown",
        message: "X may have applied the approved action, but Cloudflare OS could not confirm the result. Check X before taking another action.",
      };
    }
  }

  async performRead(operation: XReadOperation): Promise<unknown> {
    const accessToken = await this.#getAccessToken();
    const credentials = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!credentials) throw new Error("X credentials are unavailable. Reconnect the account.");
    const api = new XApi({
      accessToken,
      userId: credentials.user.id,
    });
    try {
      switch (operation.type) {
        case "getMe": return await api.getMe();
        case "getUser": return await api.getUser(operation.input);
        case "getPost": return await api.getPost(operation.id);
        case "listMyPosts": return await api.listMyPosts(operation.options);
        case "listMentions": return await api.listMentions(operation.options);
        case "listHomeTimeline": return await api.listHomeTimeline(operation.options);
        case "searchRecent": return await api.searchRecent(operation.query, operation.options);
        case "listLikedPosts": return await api.listLikedPosts(operation.options);
        case "listBookmarks": return await api.listBookmarks(operation.options);
        case "listFollowers": return await api.listFollowers(operation.options);
        case "listFollowing": return await api.listFollowing(operation.options);
      }
    } catch (error) {
      if (error instanceof XApiError && error.kind === "credentials-expired") {
        await this.#noteCredentialsExpired();
        throw new Error("X credentials have expired. Reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  async #noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  async revoke(): Promise<void> {
    await this.#serialized(async () => {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.deleteAll();
    }
  }
}

@validateRpc()
export class XGatekeeperUser extends WorkerEntrypoint<Env, XGatekeeperUserProps>
  implements GatekeeperUser {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
  }

  async describe(): Promise<AccountDescription> {
    const user = await this.#account().getProfile();
    return {
      displayName: `${user.name} (@${user.username})`,
      uniqueName: `x:${user.id}`,
      avatar: user.profileImageUrl ? { url: user.profileImageUrl } : undefined,
      grantedResourceUrlPatterns: [ACCOUNT_RESOURCE.urlPattern],
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<XAccountSession>>;
    resource: SupportedResource;
  }> {
    const user = await this.#account().getProfile();
    if (!isConnectedAccountUrl(url, user)) throw new Error("Unsupported X account URL.");
    return {
      class: this.ctx.exports.XAccountGatekeeperImpl({
        props: { userObjectId: this.ctx.props.userObjectId } satisfies XGatekeeperProps,
      }),
      resource: ACCOUNT_RESOURCE,
    };
  }

  async startResourceConfigurator(
    resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== ACCOUNT_RESOURCE.urlPattern) {
      throw new Error("Unsupported X resource configurator.");
    }
    return {
      iframeHtml: "<!DOCTYPE html><html><body></body></html>",
      ui: new RpcStub(new XAccountConfigurator(this.#account())),
    };
  }

  async reconnect(): Promise<{ url: string }> {
    const nonce = generateXOAuthState();
    const resolvedLanguage = await this.#account().prepareReconnect(nonce);
    return {
      url: buildXConnectUrl(
        getBaseUrl(this.env),
        this.ctx.props.userObjectId,
        nonce,
        resolvedLanguage,
      ),
    };
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async getAuthenticatedEmail(): Promise<null> {
    return null;
  }

  async getVerifier(): Promise<any> {
    return this.ctx.exports.XVerifier({});
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

@validateRpc()
export class XVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

class XAccountConfigurator extends RpcTarget {
  constructor(private readonly account: DurableObjectStub<UserAccount>) {
    super();
  }

  async resourceUrl(): Promise<string> {
    return connectedAccountUrl(await this.account.getProfile());
  }
}

type XReadAccount = {
  performRead(operation: XReadOperation): Promise<unknown>;
};

type XActionHost = {
  queueAction(
    queue: RpcStub<ApprovalQueue>,
    operation: XWriteOperation,
    description: ActionDescription,
  ): Promise<void>;
};

const X_ACTION_TEXT_LIMIT = 4000;
const X_ACTION_ID_PATTERN = /^[0-9]{1,19}$/;

function xActionId(value: string): string {
  if (!X_ACTION_ID_PATTERN.test(value)) throw new TypeError("id must be a numeric X id.");
  return value;
}

function xActionText(value: string): string {
  if (!value || value.length > X_ACTION_TEXT_LIMIT || [...value].some(character => {
    const code = character.charCodeAt(0);
    return code === 0 || (code < 32 && character !== "\n" && character !== "\t");
  })) {
    throw new TypeError(`text must contain 1 to ${X_ACTION_TEXT_LIMIT} safe characters.`);
  }
  return value;
}

function inertText(value: string): string {
  return value.split("\n").map(line => `    ${line}`).join("\n");
}

function countedTitle(count: number, singular: string, plural: string): string {
  return `Read ${count} ${count === 1 ? singular : plural}`;
}

@validateRpc()
export class XAccountSessionImpl extends RpcTarget implements XAccountSession {
  constructor(
    private readonly account: XReadAccount,
    private readonly approvalQueue: RpcStub<ApprovalQueue>,
    private readonly actionHost?: XActionHost,
  ) {
    super();
  }

  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]();
  }

  async #read<T>(
    operation: XReadOperation,
    describe: (result: T) => { title: string; description: string },
  ): Promise<T> {
    const result = await this.account.performRead(operation) as T;
    await this.approvalQueue.authorizeObservation(describe(result));
    return result;
  }

  getMe(): Promise<XUser> {
    return this.#read<XUser>({ type: "getMe" }, () => ({
      title: "Read X account profile",
      description: "Read the connected X account's current profile.",
    }));
  }

  getUser(input: { id?: string; username?: string }): Promise<XUser> {
    return this.#read<XUser>({ type: "getUser", input }, result => ({
      title: `Read X profile @${result.username}`,
      description: `Read public profile metadata for X user ${result.id}.`,
    }));
  }

  getPost(id: string): Promise<XPost> {
    return this.#read<XPost>({ type: "getPost", id }, result => ({
      title: `Read X post ${result.id}`,
      description: `Read post ${result.id} from X.`,
    }));
  }

  listMyPosts(options?: XPageOptions): Promise<XPostPage> {
    return this.#postPage({ type: "listMyPosts", options }, "X post");
  }

  listMentions(options?: XPageOptions): Promise<XPostPage> {
    return this.#postPage({ type: "listMentions", options }, "X mention");
  }

  listHomeTimeline(options?: XPageOptions): Promise<XPostPage> {
    return this.#postPage({ type: "listHomeTimeline", options }, "X timeline post");
  }

  searchRecent(query: string, options?: XPageOptions): Promise<XPostPage> {
    return this.#postPage({ type: "searchRecent", query, options }, "recent X search result");
  }

  listLikedPosts(options?: XPageOptions): Promise<XPostPage> {
    return this.#postPage({ type: "listLikedPosts", options }, "liked X post");
  }

  listBookmarks(options?: XPageOptions): Promise<XPostPage> {
    return this.#postPage({ type: "listBookmarks", options }, "X bookmark");
  }

  listFollowers(options?: XPageOptions): Promise<XUserPage> {
    return this.#userPage({ type: "listFollowers", options }, "X follower");
  }

  listFollowing(options?: XPageOptions): Promise<XUserPage> {
    return this.#userPage({ type: "listFollowing", options }, "followed X account");
  }

  #postPage(operation: XReadOperation, label: string): Promise<XPostPage> {
    return this.#read<XPostPage>(operation, result => ({
      title: countedTitle(result.data.length, label, `${label}s`),
      description: `Read one bounded page containing ${result.data.length} ${label}${result.data.length === 1 ? "" : "s"}.`,
    }));
  }

  #userPage(operation: XReadOperation, label: string): Promise<XUserPage> {
    return this.#read<XUserPage>(operation, result => ({
      title: countedTitle(result.data.length, label, `${label}s`),
      description: `Read one bounded page containing ${result.data.length} ${label}${result.data.length === 1 ? "" : "s"}.`,
    }));
  }

  async #queue(operation: XWriteOperation, description: ActionDescription): Promise<void> {
    if (!this.actionHost) throw new Error("X action host is unavailable.");
    await this.actionHost.queueAction(this.approvalQueue, operation, description);
  }

  async createPost(text: string): Promise<void> {
    const normalized = xActionText(text);
    await this.#queue({ type: "createPost", text: normalized }, {
      title: "Create X post",
      description: `Create this text-only X post using the connected account:\n\n${inertText(normalized)}`,
      implementsRevert: false,
      awaitDecision: true,
    });
  }

  async reply(text: string, postId: string): Promise<void> {
    const normalized = xActionText(text);
    const target = xActionId(postId);
    await this.#queue({ type: "reply", text: normalized, postId: target }, {
      title: `Reply to X post ${target}`,
      description: `Reply to X post ${target} with this text:\n\n${inertText(normalized)}`,
      implementsRevert: false,
      awaitDecision: true,
    });
  }

  async deletePost(postId: string): Promise<void> {
    const target = xActionId(postId);
    await this.#queue({ type: "deletePost", postId: target }, {
      title: `Delete X post ${target}`,
      description: `Permanently delete X post ${target} from the connected account.`,
      implementsRevert: false,
      awaitDecision: true,
    });
  }

  async like(postId: string): Promise<void> {
    const target = xActionId(postId);
    await this.#queue({ type: "like", postId: target }, {
      title: `Like X post ${target}`,
      description: `Like X post ${target} using the connected account.`,
      implementsRevert: false,
      awaitDecision: true,
    });
  }

  async unlike(postId: string): Promise<void> {
    const target = xActionId(postId);
    await this.#queue({ type: "unlike", postId: target }, {
      title: `Unlike X post ${target}`,
      description: `Remove the connected account's like from X post ${target}.`,
      implementsRevert: false,
      awaitDecision: true,
    });
  }

  async bookmark(postId: string): Promise<void> {
    const target = xActionId(postId);
    await this.#queue({ type: "bookmark", postId: target }, {
      title: `Bookmark X post ${target}`,
      description: `Add X post ${target} to the connected account's bookmarks.`,
      implementsRevert: false,
      awaitDecision: true,
    });
  }

  async removeBookmark(postId: string): Promise<void> {
    const target = xActionId(postId);
    await this.#queue({ type: "removeBookmark", postId: target }, {
      title: `Remove X bookmark ${target}`,
      description: `Remove X post ${target} from the connected account's bookmarks.`,
      implementsRevert: false,
      awaitDecision: true,
    });
  }

  async follow(userId: string): Promise<void> {
    const target = xActionId(userId);
    await this.#queue({ type: "follow", userId: target }, {
      title: `Follow X user ${target}`,
      description: `Follow X user ${target} using the connected account.`,
      implementsRevert: false,
      awaitDecision: true,
    });
  }

  async unfollow(userId: string): Promise<void> {
    const target = xActionId(userId);
    await this.#queue({ type: "unfollow", userId: target }, {
      title: `Unfollow X user ${target}`,
      description: `Unfollow X user ${target} using the connected account.`,
      implementsRevert: false,
      awaitDecision: true,
    });
  }
}

@validateRpc()
export class XAccountGatekeeperImpl extends DurableObject<Env, XGatekeeperProps>
  implements Gatekeeper<XAccountSession> {
  readonly #actions = new XActionStore(this.ctx.storage.kv);

  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
  }

  async describe(): Promise<ResourceDescription> {
    const user = await this.#account().getProfile();
    return {
      url: connectedAccountUrl(user),
      title: `${user.name} (@${user.username})`,
      snippet: "Whole-account X access funded by the connected user's Developer App.",
      suggestedBindingName: "X_ACCOUNT",
      tsType: "XAccountSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<XAccountSession> {
    return new XAccountSessionImpl(
      this.#account(),
      approvalQueue.dup(),
      {
        queueAction: async (queue, operation, description) => {
          await queueXAction(this.#actions, this.#account(), queue, operation, description);
        },
      },
    );
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("X account connections are owner-only and cannot be shared.");
  }

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    const account = this.#account();
    await this.#actions.apply(action, async ({ operation, generation }) =>
      await account.performWrite(operation, generation));
  }

  async rejectAction(action: number): Promise<void> {
    this.#actions.reject(action);
  }

  async revertAction(_action: number): Promise<void> {
    throw new Error("X actions cannot be reverted automatically.");
  }
}
