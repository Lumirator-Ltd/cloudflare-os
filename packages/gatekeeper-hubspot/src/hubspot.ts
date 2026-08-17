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
  validateHubSpotProperties,
  validateHubSpotRecordId,
} from "./hubspot-api";
import type {
  HubSpotCompany,
  HubSpotCompanyProperties,
  HubSpotContact,
  HubSpotContactProperties,
  HubSpotDeal,
  HubSpotDealProperties,
  HubSpotMutationOperation,
  HubSpotMutationResult,
  HubSpotMutationTicket,
  HubSpotObjectType,
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
  expectedHubId: number;
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
  #refreshPromise?: Promise<string>;

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
    const consumed = this.#consumeOAuthNonce(oauthNonce);
    if (consumed) this.ctx.storage.kv.delete("reconnecting");
    return consumed;
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
    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting") ?? false;
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
      if (reconnecting && grant.hubId !== this.ctx.storage.kv.get<number>("hubId")) {
        throw new Error("HubSpot reconnect portal does not match the connected account.");
      }
      this.ctx.storage.kv.put("accessToken", grant.accessToken);
      this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
      this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
      this.ctx.storage.kv.put("hubId", grant.hubId);
      this.ctx.storage.kv.put("scopes", grant.scopes ?? [...HUBSPOT_OAUTH_SCOPES]);
      this.ctx.storage.kv.put("expiredNotified", false);

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
      if (reconnecting) this.ctx.storage.kv.delete("reconnecting");
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

    if (!this.#refreshPromise) {
      const refresh = this.#refreshAccessToken();
      this.#refreshPromise = refresh;
      void refresh.then(
        () => {
          if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
        },
        () => {
          if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
        },
      );
    }
    return this.#refreshPromise;
  }

  async #refreshAccessToken(): Promise<string> {
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
      if (error instanceof HubSpotApiError && error.isCredentialExpired) {
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

  async assertHubId(expectedHubId: number): Promise<void> {
    if (await this.getHubId() !== expectedHubId) {
      throw new Error("HubSpot portal authority no longer matches this binding.");
    }
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
    const props: HubSpotGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      expectedHubId: hubId,
    };
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
  readonly #activeApplications = new Set<number>();

  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
  }

  protected expectedHubId(): number {
    return this.ctx.props.expectedHubId;
  }

  protected assertExpectedHubId(): Promise<void> {
    return this.#account().assertHubId(this.expectedHubId());
  }

  async describe(): Promise<ResourceDescription> {
    await this.assertExpectedHubId();
    const hubId = this.expectedHubId();
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

  protected mutationApi(): HubSpotApi {
    const account = this.#account();
    return new HubSpotApi({ getAccessToken: () => account.getAccessToken() });
  }

  protected notifyCredentialsExpired(): Promise<void> {
    return this.#account().notifyCredentialsExpired();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<HubSpotSession> {
    await this.assertExpectedHubId();
    const account = this.#account();
    return new HubSpotSessionImpl(
      this.mutationApi(),
      this.expectedHubId(),
      approvalQueue.dup(),
      () => account.notifyCredentialsExpired(),
      this.ctx.storage.kv,
      () => this.assertExpectedHubId(),
      action => this.#activeApplications.has(action),
    );
  }

  async applyAction(action: number): Promise<void> {
    const id = validateMutationActionId(action);
    await this.assertExpectedHubId();
    if (this.#activeApplications.has(id)) {
      throw new Error(`HubSpot mutation ${id} is actively applying`);
    }
    const store = new HubSpotMutationStore(this.ctx.storage.kv);
    const existing = store.getResult(id);
    if (existing) throw mutationResultError(id, existing.outcome);
    const pending = store.getPending(id);
    if (!pending || pending.id !== id) throw new Error(`Unknown HubSpot mutation: ${id}`);
    if (pending.applying) {
      throw mutationResultError(id, store.recoverStaleApplying(id, pending));
    }

    this.#activeApplications.add(id);
    const claimed = store.claimPending(id);
    let writeAttempted = false;
    try {
      await this.assertExpectedHubId();
      if (claimed.expectedHubId !== this.expectedHubId()) {
        throw new Error("HubSpot mutation portal authority does not match this binding.");
      }
      writeAttempted = true;
      const record = await performHubSpotMutation(this.mutationApi(), claimed);
      store.putResult(id, claimed, {
        status: "ready",
        objectType: claimed.objectType,
        recordId: record.id,
      });
      store.removePending(id);
    } catch (error) {
      if (error instanceof HubSpotApiError && error.isCredentialExpired) {
        try {
          await this.notifyCredentialsExpired();
        } catch {}
      }
      const outcome = mutationFailure(error, writeAttempted);
      store.putResult(id, claimed, outcome);
      store.removePending(id);
      throw mutationResultError(id, outcome);
    } finally {
      this.#activeApplications.delete(id);
    }
  }

  async rejectAction(action: number): Promise<void> {
    const id = validateMutationActionId(action);
    await this.assertExpectedHubId();
    if (this.#activeApplications.has(id)) {
      throw new Error(`HubSpot mutation ${id} is actively applying`);
    }
    const store = new HubSpotMutationStore(this.ctx.storage.kv);
    const existing = store.getResult(id);
    if (existing) throw mutationResultError(id, existing.outcome);
    const pending = store.getPending(id);
    if (!pending || pending.id !== id) throw new Error(`Unknown HubSpot mutation: ${id}`);
    if (pending.applying) {
      throw mutationResultError(id, store.recoverStaleApplying(id, pending));
    }
    store.removePending(id);
    store.putResult(id, pending, { status: "rejected" });
  }

  async revertAction(_action: number): Promise<{ message: string }> {
    return {
      message:
        "HubSpot CRM mutations cannot be reverted automatically. Review the record in HubSpot " +
        "and apply any needed correction manually.",
    };
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "HubSpot CRM data cannot be shared with other users. This whole-account connection may " +
      "only be observed by its owner.",
    );
  }

  async removeObserver(_id: string): Promise<void> {}
}

const MAX_OBSERVATION_QUERY_LENGTH = 200;
const MAX_RETAINED_MUTATION_RESULTS = 100;
const STALE_MUTATION_MESSAGE =
  "HubSpot mutation outcome is uncertain after an interrupted application. Inspect the record manually before submitting another mutation.";

type MutationKv = Pick<DurableObjectStorage["kv"], "delete" | "get" | "put">;

type StoredPendingMutation = HubSpotMutationTicket & {
  applying?: true;
  expectedHubId: number;
  properties: Record<string, string>;
  recordId?: string;
};

type StoredMutationResult = HubSpotMutationTicket & {
  outcome: HubSpotMutationResult;
};

function pendingMutationKey(id: number): string {
  return `mutation:pending:${id}`;
}

function mutationResultKey(id: number): string {
  return `mutation:result:${id}`;
}

function validateMutationActionId(id: unknown): number {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new TypeError("HubSpot mutation action ID must be a positive safe integer");
  }
  return id;
}

function validateMutationTicket(ticket: unknown): HubSpotMutationTicket {
  if (typeof ticket !== "object" || ticket === null || Array.isArray(ticket)) {
    throw new TypeError("Invalid HubSpot mutation ticket");
  }
  const candidate = ticket as Record<string, unknown>;
  const id = validateMutationActionId(candidate.id);
  const objectType = candidate.objectType;
  if (objectType !== "contact" && objectType !== "company" && objectType !== "deal") {
    throw new TypeError("Invalid HubSpot mutation ticket object type");
  }
  const operation = candidate.operation;
  if (operation !== "create" && operation !== "update") {
    throw new TypeError("Invalid HubSpot mutation ticket operation");
  }
  return { id, objectType, operation };
}

function sameMutation(
  stored: Pick<HubSpotMutationTicket, "id" | "objectType" | "operation">,
  ticket: HubSpotMutationTicket,
): boolean {
  return stored.id === ticket.id && stored.objectType === ticket.objectType &&
    stored.operation === ticket.operation;
}

class HubSpotMutationStore {
  readonly #kv: MutationKv;

  constructor(kv: MutationKv) {
    this.#kv = kv;
  }

  submit(mutation: Omit<StoredPendingMutation, "id">): HubSpotMutationTicket {
    const id = this.#kv.get<number>("mutation:nextId") ?? 1;
    validateMutationActionId(id);
    if (id === Number.MAX_SAFE_INTEGER) {
      throw new Error("HubSpot mutation action ID space is exhausted");
    }
    const pending = { ...mutation, id };
    this.#kv.put("mutation:nextId", id + 1);
    this.#kv.put(pendingMutationKey(id), pending);
    return { id, objectType: mutation.objectType, operation: mutation.operation };
  }

  getPending(id: number): StoredPendingMutation | undefined {
    return this.#kv.get<StoredPendingMutation>(pendingMutationKey(validateMutationActionId(id)));
  }

  requirePending(id: number): StoredPendingMutation {
    const pending = this.getPending(id);
    if (!pending || pending.id !== id || pending.applying) {
      throw new Error(`Unknown or applying HubSpot mutation: ${id}`);
    }
    return pending;
  }

  claimPending(id: number): StoredPendingMutation {
    const pending = this.requirePending(id);
    const claimed: StoredPendingMutation = { ...pending, applying: true };
    this.#kv.put(pendingMutationKey(id), claimed);
    return claimed;
  }

  removePending(id: number): void {
    this.#kv.delete(pendingMutationKey(validateMutationActionId(id)));
  }

  recoverStaleApplying(
    id: number,
    pending: StoredPendingMutation,
  ): Extract<HubSpotMutationResult, { status: "failed" }> {
    const outcome = { status: "failed" as const, message: STALE_MUTATION_MESSAGE };
    this.putResult(id, pending, outcome);
    this.removePending(id);
    return outcome;
  }

  getResult(id: number): StoredMutationResult | undefined {
    return this.#kv.get<StoredMutationResult>(mutationResultKey(validateMutationActionId(id)));
  }

  putResult(
    id: number,
    mutation: Pick<StoredPendingMutation, "objectType" | "operation">,
    outcome: HubSpotMutationResult,
  ): void {
    const boundedId = validateMutationActionId(id);
    this.#kv.put<StoredMutationResult>(mutationResultKey(boundedId), {
      id: boundedId,
      objectType: mutation.objectType,
      operation: mutation.operation,
      outcome,
    });
    const existing = this.#kv.get<number[]>("mutation:resultIds") ?? [];
    const retained = [...existing.filter(candidate => candidate !== boundedId), boundedId]
      .slice(-MAX_RETAINED_MUTATION_RESULTS);
    this.#kv.put("mutation:resultIds", retained);
    for (const evicted of existing) {
      if (!retained.includes(evicted)) this.#kv.delete(mutationResultKey(evicted));
    }
  }
}

function mutationResultError(id: number, outcome: HubSpotMutationResult): Error {
  if (outcome.status === "failed" || outcome.status === "uncertain") {
    return new Error(outcome.message);
  }
  return new Error(`HubSpot mutation ${id} is already ${outcome.status}`);
}

function mutationFailure(
  error: unknown,
  writeAttempted: boolean,
): Extract<HubSpotMutationResult, { status: "failed" | "uncertain" }> {
  const status = writeAttempted ? "uncertain" as const : "failed" as const;
  if (error instanceof HubSpotApiError) {
    const message = error.isCredentialExpired
      ? "HubSpot credentials expired while applying the CRM mutation. Reconnect and inspect the record before submitting another mutation."
      : error.isRateLimited
      ? "HubSpot rate-limited the CRM mutation. Inspect the record before submitting another mutation."
      : "HubSpot could not confirm the CRM mutation. Inspect the record before submitting another mutation.";
    return { status, message };
  }
  return {
    status,
    message: writeAttempted
      ? "HubSpot could not confirm the CRM mutation. Inspect the record before submitting another mutation."
      : "HubSpot rejected the CRM mutation before remote application. Inspect the connection before submitting another mutation.",
  };
}

async function performHubSpotMutation(
  api: HubSpotApi,
  mutation: StoredPendingMutation,
): Promise<HubSpotContact | HubSpotCompany | HubSpotDeal> {
  if (mutation.operation === "update") {
    const id = validateHubSpotRecordId(mutation.recordId);
    switch (mutation.objectType) {
      case "contact":
        return api.update("contacts", id, mutation.properties);
      case "company":
        return api.update("companies", id, mutation.properties);
      case "deal":
        return api.update("deals", id, mutation.properties);
    }
  }
  switch (mutation.objectType) {
    case "contact":
      return api.create("contacts", mutation.properties);
    case "company":
      return api.create("companies", mutation.properties);
    case "deal":
      return api.create("deals", mutation.properties);
  }
}

function requiredCreateProperties(
  objectType: HubSpotObjectType,
  properties: Record<string, string>,
): void {
  const nonEmpty = (name: string) => properties[name]?.trim().length > 0;
  if (objectType === "contact" && !["email", "firstname", "lastname"].some(nonEmpty)) {
    throw new TypeError("A HubSpot contact requires a non-empty email, firstname, or lastname");
  }
  if (objectType === "company" && !["name", "domain"].some(nonEmpty)) {
    throw new TypeError("A HubSpot company requires a non-empty name or domain");
  }
  if (objectType === "deal" && !["dealname", "pipeline", "dealstage"].every(nonEmpty)) {
    throw new TypeError("A HubSpot deal requires non-empty dealname, pipeline, and dealstage");
  }
}

function mutationDescription(portalId: number, mutation: StoredPendingMutation): string {
  const properties = JSON.stringify(mutation.properties, null, 2)
    .split("\n")
    .map(line => `    ${line}`)
    .join("\n");
  return [
    `**Portal ID:** \`${portalId}\``,
    `**Object type:** \`${mutation.objectType}\``,
    `**Operation:** \`${mutation.operation}\``,
    mutation.recordId === undefined ? undefined : `**Record ID:** \`${mutation.recordId}\``,
    `**Properties:**\n\n${properties}`,
  ].filter((line): line is string => line !== undefined).join("\n\n");
}

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
  readonly #mutationKv?: MutationKv;
  readonly #assertExpectedHubId: () => Promise<void>;
  readonly #isMutationActive: (id: number) => boolean;

  constructor(
    api: HubSpotApi,
    portalId: number,
    approvalQueue: RpcStub<ApprovalQueue>,
    notifyCredentialsExpired: () => Promise<void>,
    mutationKv?: MutationKv,
    assertExpectedHubId: () => Promise<void> = async () => {},
    isMutationActive: (id: number) => boolean = () => false,
  ) {
    super();
    this.#api = api;
    this.#portalId = portalId;
    this.#approvalQueue = approvalQueue;
    this.#notifyCredentialsExpired = notifyCredentialsExpired;
    this.#mutationKv = mutationKv;
    this.#assertExpectedHubId = assertExpectedHubId;
    this.#isMutationActive = isMutationActive;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async #read<T>(operation: () => Promise<T>): Promise<T> {
    await this.#assertExpectedHubId();
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
      after: paging?.after,
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
      ...(page.nextAfter === undefined ? {} : { nextAfter: page.nextAfter }),
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

  #mutationStore(): HubSpotMutationStore {
    if (!this.#mutationKv) throw new Error("HubSpot mutation storage is unavailable");
    return new HubSpotMutationStore(this.#mutationKv);
  }

  async #submitMutation(
    objectType: HubSpotObjectType,
    operation: HubSpotMutationOperation,
    propertiesInput: unknown,
    recordIdInput?: unknown,
  ): Promise<HubSpotMutationTicket> {
    await this.#assertExpectedHubId();
    const apiObjectType = objectType === "contact"
      ? "contacts"
      : objectType === "company"
      ? "companies"
      : "deals";
    const properties = validateHubSpotProperties(apiObjectType, propertiesInput);
    if (operation === "create") requiredCreateProperties(objectType, properties);
    const recordId = operation === "update"
      ? validateHubSpotRecordId(recordIdInput)
      : undefined;
    const pending: Omit<StoredPendingMutation, "id"> = {
      objectType,
      expectedHubId: this.#portalId,
      operation,
      properties,
      ...(recordId === undefined ? {} : { recordId }),
    };
    const store = this.#mutationStore();
    const ticket = store.submit(pending);
    try {
      await this.#approvalQueue.submitAction(ticket.id, {
        title: operation === "create"
          ? `Create HubSpot ${objectType}`
          : `Update HubSpot ${objectType} ${recordId}`,
        description: mutationDescription(this.#portalId, { ...pending, id: ticket.id }),
        implementsRevert: false,
        awaitDecision: true,
      });
    } catch (error) {
      store.removePending(ticket.id);
      throw error;
    }
    return ticket;
  }

  createContact(properties: HubSpotContactProperties): Promise<HubSpotMutationTicket> {
    return this.#submitMutation("contact", "create", properties);
  }

  updateContact(
    id: string,
    properties: HubSpotContactProperties,
  ): Promise<HubSpotMutationTicket> {
    return this.#submitMutation("contact", "update", properties, id);
  }

  createCompany(properties: HubSpotCompanyProperties): Promise<HubSpotMutationTicket> {
    return this.#submitMutation("company", "create", properties);
  }

  updateCompany(
    id: string,
    properties: HubSpotCompanyProperties,
  ): Promise<HubSpotMutationTicket> {
    return this.#submitMutation("company", "update", properties, id);
  }

  createDeal(properties: HubSpotDealProperties): Promise<HubSpotMutationTicket> {
    return this.#submitMutation("deal", "create", properties);
  }

  updateDeal(
    id: string,
    properties: HubSpotDealProperties,
  ): Promise<HubSpotMutationTicket> {
    return this.#submitMutation("deal", "update", properties, id);
  }

  async getMutationResult(ticketInput: HubSpotMutationTicket): Promise<HubSpotMutationResult> {
    const ticket = validateMutationTicket(ticketInput);
    await this.#assertExpectedHubId();
    const store = this.#mutationStore();
    let result = store.getResult(ticket.id);
    const pending = result === undefined ? store.getPending(ticket.id) : undefined;
    const stored = result ?? pending;
    if (!stored) throw new Error(`Unknown HubSpot mutation ticket: ${ticket.id}`);
    if (!sameMutation(stored, ticket)) {
      throw new Error(`HubSpot mutation ticket does not match action ${ticket.id}`);
    }
    if (pending && pending.expectedHubId !== this.#portalId) {
      throw new Error("HubSpot mutation portal authority does not match this session.");
    }
    if (pending?.applying && !this.#isMutationActive(ticket.id)) {
      const outcome = store.recoverStaleApplying(ticket.id, pending);
      result = { ...ticket, outcome };
    }
    const outcome = result?.outcome ?? { status: "pending" as const };
    await this.#approvalQueue.authorizeObservation({
      title: `Read HubSpot mutation result #${ticket.id}`,
      description:
        `HubSpot ${ticket.objectType} ${ticket.operation} mutation #${ticket.id} is ` +
        `**${outcome.status}**.`,
    });
    return outcome;
  }
}
