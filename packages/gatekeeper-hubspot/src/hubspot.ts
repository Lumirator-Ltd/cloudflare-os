import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  staticOauthConnectorConfiguration,
  stripTrailingSlashes,
  type AccountDescription,
  type ActionKind,
  type ApprovalQueue,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorInterface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  HUBSPOT_OAUTH_SCOPES,
  HubSpotApi,
  HubSpotApiError,
  buildHubSpotAuthorizationUrl,
  exchangeHubSpotAuthorizationCode,
  generateHubSpotOAuthState,
  refreshHubSpotAccessToken,
} from "./hubspot-api";
import type {
  HubSpotCompany,
  HubSpotCompanyProperties,
  HubSpotContact,
  HubSpotContactProperties,
  HubSpotDeal,
  HubSpotDealProperties,
  HubSpotMutationResult,
  HubSpotMutationTicket,
  HubSpotSearchPage,
  HubSpotSearchPaging,
  HubSpotSession,
} from "./types";
import TYPES_CODE from "./types.txt";
import HUBSPOT_LOGO_SVG from "./hubspot-logo.svg";
import HUBSPOT_ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";
import type { HubSpotAccountConfiguratorRpc } from "./configurator/account-configurator-types";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

type GatekeeperUserImplProps = {
  userObjectId: string;
};

type HubSpotGatekeeperImplProps = {
  userObjectId: string;
};

const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;
const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;
const HUBSPOT_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(HUBSPOT_LOGO_SVG)}`;
const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: "https://app.hubspot.com/contacts/:hubId",
  title: "HubSpot account",
  description: "Whole-account access to contacts, companies, and deals in the connected HubSpot CRM.",
  icon: { url: HUBSPOT_LOGO_URL },
};
const SUPPORTED_RESOURCES = [ACCOUNT_RESOURCE];
const INVALID_FLOW_MESSAGE = "This HubSpot authorization link is invalid or has expired. Start again from Cloudflare OS.";
const PROVIDER_ERROR_MESSAGE = "HubSpot authorization failed or was denied. Start again from Cloudflare OS.";
const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.</p>
  </body>
</html>`;

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

function userError(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/hubspot");
}

function getBasePath(env: Env): string {
  const pathname = new URL(getBaseUrl(env)).pathname;
  return pathname === "/" ? "" : pathname;
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
}

function requireOAuthConfiguration(env: Env): asserts env is Env & {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
} {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("The HubSpot connector is not configured.");
  }
}

function accountUrl(hubId: number): string {
  return `https://app.hubspot.com/contacts/${hubId}`;
}

/** Returns whether a URL is the canonical URL for a connected HubSpot account. */
export function isHubSpotAccountUrl(url: string, hubId: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname === "app.hubspot.com" &&
    !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
    parsed.pathname === `/contacts/${hubId}`;
}

/** Returns HubSpot vendor metadata for the supplied deployment configuration. */
export function hubSpotVendorDescription(
  env: { CLIENT_ID?: string; CLIENT_SECRET?: string },
): VendorDescription {
  return {
    displayName: "HubSpot",
    url: "https://www.hubspot.com",
    logo: { url: HUBSPOT_LOGO_URL },
    color: "#ff7a59",
    tagline: "Search and manage CRM contacts, companies, and deals",
    description:
      "Connect a HubSpot account so Cloudflare OS can work with contacts, companies, and deals " +
      "across the connected CRM portal.",
    configuration: staticOauthConnectorConfiguration(env),
  };
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
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return userError("The HubSpot connector is not configured.", 503);
      }
      try {
        const id = ctx.exports.UserAccount.idFromString(initiation[1]);
        const begun = await ctx.exports.UserAccount.get(id).beginOAuthFlow(initiation[2]);
        if (!begun) return userError(INVALID_FLOW_MESSAGE);
        return Response.redirect(buildHubSpotAuthorizationUrl({
          clientId: env.CLIENT_ID,
          redirectUri: `${getBaseUrl(env)}/oauth`,
          state: `${initiation[1]}:${begun.oauthNonce}`,
        }), 302);
      } catch {
        return userError(INVALID_FLOW_MESSAGE);
      }
    }

    if (relativePath === "/oauth") {
      const state = url.searchParams.get("state");
      const parsedState = state?.match(/^([0-9a-f]{64}):([A-Za-z0-9_-]{43})$/);
      if (!parsedState) return userError(INVALID_FLOW_MESSAGE);

      let account: DurableObjectStub<UserAccount>;
      try {
        account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(parsedState[1]));
      } catch {
        return userError(INVALID_FLOW_MESSAGE);
      }

      if (url.searchParams.has("error")) {
        if (!await account.consumeOAuthError(parsedState[2])) {
          return userError(INVALID_FLOW_MESSAGE);
        }
        return userError(PROVIDER_ERROR_MESSAGE);
      }

      const code = url.searchParams.get("code");
      if (!code) return userError(INVALID_FLOW_MESSAGE);
      try {
        if (!await account.acceptAuthCode(code, parsedState[2])) {
          return userError(INVALID_FLOW_MESSAGE);
        }
        return html(SELF_CLOSING_HTML);
      } catch {
        return userError(PROVIDER_ERROR_MESSAGE);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env>
  implements GatekeeperVendorInterface {
  async describe(): Promise<VendorDescription> {
    return hubSpotVendorDescription(this.env);
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateHubSpotOAuthState();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  async setCallback(
    callback: Fetcher<GatekeeperConnectCallback>,
    initiationNonce: string,
  ): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
      !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateHubSpotOAuthState();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    return { oauthNonce };
  }

  async consumeOAuthError(oauthNonce: string): Promise<boolean> {
    return this.#consumeOAuthNonce(oauthNonce);
  }

  #consumeOAuthNonce(oauthNonce: string): boolean {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
      !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");
    return true;
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    if (!this.#consumeOAuthNonce(oauthNonce)) return false;
    try {
      requireOAuthConfiguration(this.env);
      const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) return false;

      const grant = await exchangeHubSpotAuthorizationCode({
        code,
        redirectUri: `${getBaseUrl(this.env)}/oauth`,
        clientId: this.env.CLIENT_ID,
        clientSecret: this.env.CLIENT_SECRET,
      });
      this.ctx.storage.kv.put("accessToken", grant.accessToken);
      this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
      this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
      this.ctx.storage.kv.put("hubId", grant.hubId);
      this.ctx.storage.kv.put("scopes", grant.scopes ?? [...HUBSPOT_OAUTH_SCOPES]);
      this.ctx.storage.kv.put("expiredNotified", false);

      const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting") ?? false;
      if (reconnecting) {
        this.ctx.storage.kv.delete("reconnecting");
        await callback.credentialsRestored();
      } else {
        try {
          const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
          await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
        } catch (error) {
          this.#deleteCredentials();
          throw error;
        }
      }
      await this.ctx.storage.deleteAlarm();
      return true;
    } catch {
      return false;
    }
  }

  #deleteCredentials(): void {
    for (const key of [
      "accessToken",
      "refreshToken",
      "accessTokenExpiresAt",
      "hubId",
      "scopes",
      "expiredNotified",
    ]) {
      this.ctx.storage.kv.delete(key);
    }
  }

  async getAccessToken(): Promise<string> {
    const accessToken = this.ctx.storage.kv.get<string>("accessToken");
    const expiresAt = this.ctx.storage.kv.get<number>("accessTokenExpiresAt") ?? 0;
    if (accessToken && Date.now() < expiresAt - ACCESS_TOKEN_SAFETY_MS) return accessToken;

    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) throw new Error("HubSpot credentials are unavailable. Reconnect the account.");
    requireOAuthConfiguration(this.env);

    try {
      const grant = await refreshHubSpotAccessToken({
        refreshToken,
        clientId: this.env.CLIENT_ID,
        clientSecret: this.env.CLIENT_SECRET,
      });
      this.ctx.storage.kv.put("accessToken", grant.accessToken);
      this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
      if (grant.refreshToken) this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
      return grant.accessToken;
    } catch (error) {
      if (error instanceof HubSpotApiError &&
        (error.isCredentialExpired || error.status === 400)) {
        await this.notifyCredentialsExpired();
        throw new Error(
          "HubSpot credentials have expired or been revoked. Please reconnect the account.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async notifyCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return;
    try {
      await callback.credentialsExpired();
    } catch {
      return;
    }
  }

  async getHubId(): Promise<number> {
    const hubId = this.ctx.storage.kv.get<number>("hubId");
    if (!Number.isFinite(hubId)) throw new Error("HubSpot account identity is unavailable.");
    return hubId as number;
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
  implements GatekeeperUser {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
  }

  async describe(): Promise<AccountDescription> {
    const hubId = await this.#account().getHubId();
    return {
      displayName: `HubSpot account ${hubId}`,
      uniqueName: String(hubId),
      avatar: { url: HUBSPOT_LOGO_URL },
    };
  }

  async getAuthenticatedEmail(): Promise<null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<HubSpotSession>>;
    resource: SupportedResource;
  }> {
    const hubId = await this.#account().getHubId();
    if (!isHubSpotAccountUrl(url, hubId)) {
      throw new Error(`Unsupported HubSpot URL: ${url}`);
    }
    const props: HubSpotGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId };
    return {
      class: this.ctx.exports.HubSpotGatekeeperImpl({ props }),
      resource: ACCOUNT_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== ACCOUNT_RESOURCE.urlPattern) {
      throw new Error(`Unsupported HubSpot resource configurator: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: HUBSPOT_ACCOUNT_CONFIGURATOR_HTML,
      ui: new RpcStub(new HubSpotAccountConfiguratorUI(this.#account())),
    };
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateHubSpotOAuthState();
    await this.#account().prepareReconnect(initiationNonce);
    return {
      url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}`,
    };
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.HubSpotVerifier({});
  }
}

@validateRpc()
export class HubSpotVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

class HubSpotAccountConfiguratorUI extends RpcTarget implements HubSpotAccountConfiguratorRpc {
  readonly #account: DurableObjectStub<UserAccount>;

  constructor(account: DurableObjectStub<UserAccount>) {
    super();
    this.#account = account;
  }

  async resourceUrl(): Promise<string> {
    return accountUrl(await this.#account.getHubId());
  }
}

@validateRpc()
export class HubSpotGatekeeperImpl extends DurableObject<Env, HubSpotGatekeeperImplProps>
  implements Gatekeeper<HubSpotSession> {
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
  }

  async describe(): Promise<ResourceDescription> {
    const hubId = await this.#account().getHubId();
    return {
      url: accountUrl(hubId),
      title: `HubSpot account ${hubId}`,
      snippet: "Whole-account HubSpot CRM access to contacts, companies, and deals.",
      suggestedBindingName: "HUBSPOT",
      tsType: "HubSpotSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<HubSpotSession> {
    const account = this.#account();
    const portalId = await account.getHubId();
    const api = new HubSpotApi({ getAccessToken: () => account.getAccessToken() });
    return new HubSpotSessionImpl(
      api,
      portalId,
      approvalQueue.dup(),
      () => account.notifyCredentialsExpired(),
    );
  }

  async applyAction(_action: number): Promise<void> {
    throw new Error("HubSpot CRM actions are not available yet.");
  }

  async rejectAction(_action: number): Promise<void> {
    throw new Error("HubSpot CRM actions are not available yet.");
  }

  async revertAction(_action: number): Promise<void> {
    throw new Error("HubSpot CRM actions are not available yet.");
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "HubSpot CRM data cannot be shared with other users. This whole-account connection may " +
      "only be observed by its owner.",
    );
  }

  async removeObserver(_id: string): Promise<void> {}
}

const HUBSPOT_MUTATIONS_UNAVAILABLE = "HubSpot CRM mutations are not available yet.";
const MAX_OBSERVATION_QUERY_LENGTH = 200;

function boundedQuery(query: string): string {
  const normalized = [...query]
    .map(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= MAX_OBSERVATION_QUERY_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_OBSERVATION_QUERY_LENGTH - 3)}...`;
}

@validateRpc()
export class HubSpotSessionImpl extends RpcTarget implements HubSpotSession {
  readonly #api: HubSpotApi;
  readonly #portalId: number;
  readonly #approvalQueue: RpcStub<ApprovalQueue>;
  readonly #notifyCredentialsExpired: () => Promise<void>;

  constructor(
    api: HubSpotApi,
    portalId: number,
    approvalQueue: RpcStub<ApprovalQueue>,
    notifyCredentialsExpired: () => Promise<void>,
  ) {
    super();
    this.#api = api;
    this.#portalId = portalId;
    this.#approvalQueue = approvalQueue;
    this.#notifyCredentialsExpired = notifyCredentialsExpired;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async #read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof HubSpotApiError) || !error.isCredentialExpired) throw error;
      try {
        await this.#notifyCredentialsExpired();
      } catch {}
      throw new Error(
        "HubSpot credentials have expired or been revoked. Please reconnect the account.",
        { cause: error },
      );
    }
  }

  async #search<T extends "contacts" | "companies" | "deals">(
    type: T,
    query: string,
    paging?: HubSpotSearchPaging,
  ): Promise<HubSpotSearchPage<
    T extends "contacts" ? HubSpotContact : T extends "companies" ? HubSpotCompany : HubSpotDeal
  >> {
    const page = await this.#read(() => this.#api.search(type, {
      query,
      limit: paging?.limit,
      after: paging?.after === undefined ? undefined : String(paging.after),
    }));
    await this.#approvalQueue.authorizeObservation({
      title: `Search HubSpot ${type} (${page.results.length} result(s))`,
      description:
        `Portal ID: ${this.#portalId}; object type: ${type}; query: "${boundedQuery(query)}"; ` +
        `returned count: ${page.results.length}.`,
    });
    return {
      results: page.results,
      total: page.total,
      ...(page.nextAfter === undefined ? {} : { nextAfter: Number(page.nextAfter) }),
    } as HubSpotSearchPage<
      T extends "contacts" ? HubSpotContact : T extends "companies" ? HubSpotCompany : HubSpotDeal
    >;
  }

  async #get<T extends "contacts" | "companies" | "deals">(
    type: T,
    id: string,
  ): Promise<
    T extends "contacts" ? HubSpotContact : T extends "companies" ? HubSpotCompany : HubSpotDeal
  > {
    const record = await this.#read(() => this.#api.get(type, id));
    await this.#approvalQueue.authorizeObservation({
      title: `Get HubSpot ${type} record`,
      description:
        `Portal ID: ${this.#portalId}; object type: ${type}; record ID: ${id}; returned count: 1.`,
    });
    return record as T extends "contacts"
      ? HubSpotContact
      : T extends "companies"
      ? HubSpotCompany
      : HubSpotDeal;
  }

  searchContacts(query: string, paging?: HubSpotSearchPaging): Promise<HubSpotSearchPage<HubSpotContact>> {
    return this.#search("contacts", query, paging);
  }

  getContact(id: string): Promise<HubSpotContact> {
    return this.#get("contacts", id);
  }

  searchCompanies(query: string, paging?: HubSpotSearchPaging): Promise<HubSpotSearchPage<HubSpotCompany>> {
    return this.#search("companies", query, paging);
  }

  getCompany(id: string): Promise<HubSpotCompany> {
    return this.#get("companies", id);
  }

  searchDeals(query: string, paging?: HubSpotSearchPaging): Promise<HubSpotSearchPage<HubSpotDeal>> {
    return this.#search("deals", query, paging);
  }

  getDeal(id: string): Promise<HubSpotDeal> {
    return this.#get("deals", id);
  }

  async createContact(_properties: HubSpotContactProperties): Promise<HubSpotMutationTicket> {
    throw new Error(HUBSPOT_MUTATIONS_UNAVAILABLE);
  }

  async updateContact(
    _id: string,
    _properties: HubSpotContactProperties,
  ): Promise<HubSpotMutationTicket> {
    throw new Error(HUBSPOT_MUTATIONS_UNAVAILABLE);
  }

  async createCompany(_properties: HubSpotCompanyProperties): Promise<HubSpotMutationTicket> {
    throw new Error(HUBSPOT_MUTATIONS_UNAVAILABLE);
  }

  async updateCompany(
    _id: string,
    _properties: HubSpotCompanyProperties,
  ): Promise<HubSpotMutationTicket> {
    throw new Error(HUBSPOT_MUTATIONS_UNAVAILABLE);
  }

  async createDeal(_properties: HubSpotDealProperties): Promise<HubSpotMutationTicket> {
    throw new Error(HUBSPOT_MUTATIONS_UNAVAILABLE);
  }

  async updateDeal(
    _id: string,
    _properties: HubSpotDealProperties,
  ): Promise<HubSpotMutationTicket> {
    throw new Error(HUBSPOT_MUTATIONS_UNAVAILABLE);
  }

  async getMutationResult(_ticket: HubSpotMutationTicket): Promise<HubSpotMutationResult> {
    throw new Error(HUBSPOT_MUTATIONS_UNAVAILABLE);
  }
}
