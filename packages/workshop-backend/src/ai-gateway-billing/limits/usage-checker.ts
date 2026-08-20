// Usage checker: combines the daily free-tier counter with the BYOK/balance logic to decide
// whether a user's request may proceed, and whose credentials to use.
//
// Billing rules (see canProceedWithRequest):
//   - Connected + balance >= minimum -> billed to the user's own gateway with no daily cap.
//   - Required user funding without sufficient balance -> blocked without consuming a daily quota.
//   - Otherwise, unfunded users consume the platform free tier until it is exhausted.

import { canProceedWithRequest, hasMinimumBalance, LimitWindowKind } from "@gadgets/workshop-shared/limits";
import { CloudflareUsageInfo } from "@gadgets/workshop-shared/api";
import {
  getMinimumCloudflareBalance,
  isCloudflareBillingEnabled,
  isUserFundedAiRequired,
} from "../config.js";
import { getDailyLlmCallLimit } from "./config.js";
import { getConnectionStatus, resolveConnection, ByokGatewayRouting } from "../cloudflare/connection-service.js";
import type { UserDurableObject } from "../../user.js";

export interface UsageCheckResult {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** Guidance/reason when blocked. */
  reason?: string;
  /** Whether to serve the request using the user's own gateway/keys rather than the platform's. */
  shouldUseByok: boolean;
  /** Whether the user is within their free-tier limit. */
  withinLimits: boolean;
  /** Calls remaining in the current window (Infinity when limits are disabled). */
  remaining: number;
  /** The configured limit (Infinity when limits are disabled). */
  limit: number;
  /** Window kind and reset time (omitted when unlimited). */
  windowKind?: LimitWindowKind;
  resetAt?: string;
  /** The user's Cloudflare AI Gateway balance, or null if unknown / not connected. */
  balance: number | null;
  /** Whether the user has connected a Cloudflare account with a usable token. */
  hasUserToken: boolean;
  /**
   * Routing to bill the user's own account, present only when shouldUseByok is true. Resolved here
   * (reusing the connection lookup) so the caller needn't decrypt the token a second time.
   */
  byokRouting?: ByokGatewayRouting;
}

// Result used when limits are disabled (self-hosted / unlimited).
function unlimitedResult(): UsageCheckResult {
  return {
    allowed: true,
    shouldUseByok: false,
    withinLimits: true,
    remaining: Infinity,
    limit: Infinity,
    balance: null,
    hasUserToken: false,
  };
}

/** Resolves required-mode routing or throws the user-facing reason inference is blocked. */
export async function getRequiredUserGatewayRouting(
  env: Cloudflare.Env,
  userStub: DurableObjectStub<UserDurableObject>,
): Promise<ByokGatewayRouting | undefined> {
  if (!isUserFundedAiRequired(env)) return undefined;

  const usage = await checkUsageAndBalance(env, userStub);
  if (!usage.allowed || !usage.byokRouting) {
    throw new Error(usage.reason ?? "A funded Cloudflare account is required for AI inference.");
  }
  return usage.byokRouting;
}

/**
 * Check whether the user may proceed with an LLM-backed request.
 *
 * When billing controls are disabled, always allows without touching the user object. Otherwise,
 * funded users bill their own gateway; required-user-funding mode blocks everyone else, while the
 * free-tier mode consumes a platform-funded allowance.
 */
export async function checkUsageAndBalance(
  env: Cloudflare.Env,
  userStub: DurableObjectStub<UserDurableObject>,
): Promise<UsageCheckResult> {
  if (!isCloudflareBillingEnabled(env)) {
    return unlimitedResult();
  }

  const requireUserFunding = isUserFundedAiRequired(env);
  const limit = getDailyLlmCallLimit(env);
  const minimumBalance = getMinimumCloudflareBalance(env);

  // Resolve the connected-account status up front: it determines billing even within the free tier
  // (connected + funded users always bill their own gateway). `balance` is null when not connected
  // or when the balance can't be read — treated as "not funded" so we fall back to the free tier
  // rather than attempting a BYOK call that would fail.
  let hasUserToken = false;
  let balance: number | null = null;
  // Routing to bill the user's own account, derivable only when connected with a resolved account.
  let byokRouting: ByokGatewayRouting | undefined;
  const conn = await resolveConnection(env, userStub);
  hasUserToken = conn.status.connected;
  balance = conn.status.balance;
  if (conn.accessToken && conn.accountId) {
    byokRouting = { accountId: conn.accountId, apiKey: conn.accessToken };
  }

  // Connected + funded -> bill their gateway; don't touch the daily free-tier counter.
  if (hasUserToken && hasMinimumBalance(balance, minimumBalance)) {
    return {
      allowed: true,
      shouldUseByok: true,
      withinLimits: true,
      remaining: Infinity,
      limit: Infinity,
      balance,
      hasUserToken,
      byokRouting,
    };
  }

  if (requireUserFunding) {
    const decision = canProceedWithRequest({
      withinLimits: false,
      hasUserToken,
      balance,
      minimumBalance,
      requireUserFunding: true,
    });
    return {
      ...decision,
      withinLimits: false,
      remaining: 0,
      limit: 0,
      balance,
      hasUserToken,
    };
  }

  // Otherwise draw on the platform free tier. consumeDailyLlmCall() only increments while within
  // the limit (it no-ops once `used >= limit`), so a blocked request never counts.
  const quota = await userStub.consumeDailyLlmCall(limit);

  const decision = canProceedWithRequest({
    withinLimits: quota.withinLimits,
    hasUserToken,
    balance,
    minimumBalance,
  });

  return {
    ...decision,
    withinLimits: quota.withinLimits,
    remaining: quota.remaining,
    limit: quota.limit,
    windowKind: "daily",
    resetAt: quota.resetAt,
    balance,
    hasUserToken,
    byokRouting: decision.shouldUseByok ? byokRouting : undefined,
  };
}

/**
 * Read the user's current usage + connection status WITHOUT counting a call. Used by the UI to
 * render the usage banner. Returns an "unlimited" snapshot when limits are disabled.
 */
export async function getUsageInfo(
  env: Cloudflare.Env,
  userStub: DurableObjectStub<UserDurableObject>,
): Promise<CloudflareUsageInfo> {
  if (!isCloudflareBillingEnabled(env)) {
    return {
      cloudflareLimitsEnabled: false,
      unlimited: true,
      userFundingRequired: false,
      dailyUsed: 0,
      dailyLimit: 0,
      remaining: 0,
      connected: false,
      balance: null,
    };
  }

  if (isUserFundedAiRequired(env)) {
    const status = await getConnectionStatus(env, userStub);
    return {
      cloudflareLimitsEnabled: true,
      unlimited: false,
      userFundingRequired: true,
      dailyUsed: 0,
      dailyLimit: 0,
      remaining: 0,
      connected: status.connected,
      balance: status.balance,
      accountId: status.accountId,
      accountName: status.accountName,
      needsAccountSelection: status.needsAccountSelection,
      needsReconnect: status.needsReconnect,
      accountDiscoveryFailed: status.accountDiscoveryFailed,
    };
  }

  const limit = getDailyLlmCallLimit(env);
  // These two reads are independent — run them together to halve latency on this UI polling path.
  const [quota, status] = await Promise.all([
    userStub.checkDailyLlmCount(limit),
    getConnectionStatus(env, userStub),
  ]);

  return {
    cloudflareLimitsEnabled: true,
    unlimited: false,
    userFundingRequired: false,
    dailyUsed: quota.used,
    dailyLimit: quota.limit,
    remaining: quota.remaining,
    resetAt: quota.resetAt,
    connected: status.connected,
    balance: status.balance,
    accountId: status.accountId,
    accountName: status.accountName,
    needsAccountSelection: status.needsAccountSelection,
    needsReconnect: status.needsReconnect,
    accountDiscoveryFailed: status.accountDiscoveryFailed,
  };
}
