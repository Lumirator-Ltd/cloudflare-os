// Resolves AI Gateway billing state for a user's connected Cloudflare account.
//
// The OAuth tokens live in the connected Cloudflare *gatekeeper* account; we obtain a usable access
// token from it (getUsableAccessToken), then resolve which account to bill and read the credit
// balance (with a short cache). Connected-user inference is routed through the account's auto-created
// "default" AI Gateway (see ai-models.ts), billed via Unified Billing.
//
// Operates against a UserDurableObject stub so it can be called from the overseer (usage checks) and
// from the RPC layer (status display).

import { listAccounts, fetchCreditBalance } from "./account-service.js";
import { isUserFundedAiRequired } from "../config.js";
import type { UserDurableObject } from "../../user.js";

// Treat a cached balance as fresh for this long.
const CREDITS_CACHE_TTL_MS = 5 * 60 * 1000;

type UserStub = DurableObjectStub<UserDurableObject>;

function excludesPlatformAccount(env: Cloudflare.Env, accountId: string): boolean {
  return accountId === env.CF_AI_GATEWAY_ACCOUNT_ID?.trim();
}

function customerAccounts(
  env: Cloudflare.Env,
  accounts: CloudflareAccountOption[],
): CloudflareAccountOption[] {
  return accounts.filter(account => !excludesPlatformAccount(env, account.accountId));
}

/** Public-safe connection status for display and for the usage decision. */
export interface CloudflareConnectionStatus {
  connected: boolean;
  accountId?: string;
  accountName?: string;
  balance: number | null;
  /**
   * True when connected but no eligible billing account is selected. The client must load the
   * eligible accounts and offer selection or reconnection when the list is empty.
   */
  needsAccountSelection?: boolean;
  /** True when the connected OAuth grant is unusable and must be re-authenticated. */
  needsReconnect?: boolean;
  /** True when Cloudflare account discovery failed and the client should offer a retry. */
  accountDiscoveryFailed?: boolean;
}

/** A Cloudflare account the connected grant can access. */
export interface CloudflareAccountOption {
  accountId: string;
  accountName: string;
}

/**
 * Routing details to bill a user's own Cloudflare account for inference (BYOK path once the free
 * tier is spent). Inference is routed through the account's "default" AI Gateway.
 */
export interface ByokGatewayRouting {
  accountId: string;
  /** The user's Cloudflare access token, used as the authorization. */
  apiKey: string;
}

/**
 * Connection resolution result. `accessToken`/`accountId` are present only when connected with a
 * resolved account; `accessToken` is sensitive (never send it to the client).
 */
export interface ResolvedConnection {
  status: CloudflareConnectionStatus;
  accessToken?: string;
  accountId?: string;
}

// Get a usable access token from the connected Cloudflare gatekeeper account, or null if the user
// hasn't connected Cloudflare or the connection is broken/expired.
async function getUsableAccessToken(userStub: UserStub): Promise<string | null> {
  // The returned stub is a server-side RPC stub (not an auto-disposed call parameter), so it must be
  // disposed to avoid leaking on every call (this runs on the hot path — see resolveConnection).
  using account = await userStub.getCloudflareGatekeeperAccount();
  if (!account) return null;
  return await account.getUsableAccessToken();
}

/**
 * Resolve connection status + balance (cached when fresh), auto-selecting the account when exactly
 * one is accessible. Also surfaces the usable access token + resolved account id so a hot-path
 * caller can derive BYOK routing without re-reading. Never throws; returns a safe default.
 */
export async function resolveConnection(
  env: Cloudflare.Env, userStub: UserStub,
): Promise<ResolvedConnection> {
  try {
    // Dispose the connected-account stub at the end of this call (it's a returned RPC stub, not an
    // auto-disposed parameter). This runs on every agent turn and UI refresh.
    using account = await userStub.getCloudflareGatekeeperAccount();
    if (!account) return { status: { connected: false, balance: null } };

    const accessToken = await account.getUsableAccessToken();
    if (!accessToken) {
      return { status: { connected: true, balance: null, needsReconnect: true } };
    }

    const billing = await userStub.getCloudflareBilling();
    let accountId = billing?.accountId;
    let accountName = billing?.accountName;
    if (accountId && excludesPlatformAccount(env, accountId)) {
      accountId = undefined;
      accountName = undefined;
    }

    let needsAccountSelection = false;
    let accountDiscoveryFailed = false;
    if (!accountId) {
      const discovered = await listAccounts(accessToken);
      if (discovered === null) {
        needsAccountSelection = true;
        accountDiscoveryFailed = true;
      } else {
        const accounts = customerAccounts(env, discovered);
        if (accounts.length === 1) {
          accountId = accounts[0].accountId;
          accountName = accounts[0].accountName;
          await userStub.setCloudflareAccountSelection(accountId, accountName);
        } else {
          needsAccountSelection = true;
        }
      }
    }

    const base = {
      connected: true as const,
      accountId,
      accountName,
      needsAccountSelection,
      accountDiscoveryFailed,
    };
    const extra = { accessToken, accountId };

    // Serve a fresh cached balance without hitting the API.
    const cacheAge = billing?.creditsUpdatedAt ? Date.now() - billing.creditsUpdatedAt : Infinity;
    if (billing && billing.accountId === accountId && cacheAge < CREDITS_CACHE_TTL_MS &&
        billing.creditsRemaining !== undefined) {
      return { status: { ...base, balance: billing.creditsRemaining ?? null }, ...extra };
    }

    let balance: number | null = null;
    if (accountId) {
      const fresh = await fetchCreditBalance(accessToken, accountId);
      if (fresh !== null) {
        balance = fresh;
        await userStub.updateCloudflareCredits(fresh, accountId);
      }
    }
    return { status: { ...base, balance }, ...extra };
  } catch {
    return { status: { connected: false, balance: null } };
  }
}

/** Public-safe connection status for display and the usage decision (drops the access token). */
export async function getConnectionStatus(
  env: Cloudflare.Env, userStub: UserStub,
): Promise<CloudflareConnectionStatus> {
  return (await resolveConnection(env, userStub)).status;
}

/**
 * Force-refresh the cached credit balance from Cloudflare, bypassing the TTL. Best effort. Call
 * after a BYOK inference so the next billing decision reflects the spend just incurred.
 */
export async function refreshCachedBalance(env: Cloudflare.Env, userStub: UserStub): Promise<void> {
  const invalidateOnFailure = isUserFundedAiRequired(env);
  let accountId: string | undefined;
  try {
    const billing = await userStub.getCloudflareBilling();
    accountId = billing?.accountId;
    if (!accountId || excludesPlatformAccount(env, accountId)) {
      if (invalidateOnFailure && accountId) {
        await userStub.updateCloudflareCredits(null, accountId);
      }
      return;
    }

    const token = await getUsableAccessToken(userStub);
    if (!token) {
      if (invalidateOnFailure) await userStub.updateCloudflareCredits(null, accountId);
      return;
    }
    const fresh = await fetchCreditBalance(token, accountId);
    if (fresh !== null) {
      await userStub.updateCloudflareCredits(fresh, accountId);
    } else if (invalidateOnFailure) {
      await userStub.updateCloudflareCredits(null, accountId);
    }
  } catch {
    if (invalidateOnFailure && accountId) {
      try {
        await userStub.updateCloudflareCredits(null, accountId);
      } catch {
        // The user object is unavailable too; the next uncached resolution still fails closed.
      }
    }
  }
}

/** Runs user-gateway inference and refreshes its balance afterward, including on failure. */
export async function runWithUserGatewayBalanceRefresh<T>(
  env: Cloudflare.Env,
  userStub: UserStub,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    await refreshCachedBalance(env, userStub);
  }
}

/** List the Cloudflare accounts the connected grant can access. Empty if not connected/usable. */
export async function listConnectedAccounts(
  env: Cloudflare.Env, userStub: UserStub,
): Promise<CloudflareAccountOption[]> {
  let token: string | null;
  try {
    token = await getUsableAccessToken(userStub);
  } catch {
    return [];
  }
  if (!token) return [];
  const accounts = await listAccounts(token);
  if (accounts === null) throw new Error("Cloudflare account discovery is unavailable.");
  return customerAccounts(env, accounts);
}

/** Select which Cloudflare account to bill. Validates it's accessible by the connected grant. */
export async function selectAccount(
  env: Cloudflare.Env, userStub: UserStub, accountId: string,
): Promise<void> {
  if (excludesPlatformAccount(env, accountId)) {
    throw new Error("The platform Cloudflare account cannot fund user inference.");
  }
  const token = await getUsableAccessToken(userStub);
  if (!token) throw new Error("No usable Cloudflare connection.");
  const accounts = await listAccounts(token);
  if (accounts === null) throw new Error("Cloudflare account discovery is unavailable.");
  const found = accounts.find(a => a.accountId === accountId);
  if (!found) throw new Error("That Cloudflare account was not found in the connected grant.");
  await userStub.setCloudflareAccountSelection(found.accountId, found.accountName);
}
