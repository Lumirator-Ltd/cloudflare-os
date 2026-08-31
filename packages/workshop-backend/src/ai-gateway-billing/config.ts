// Configuration for optional free-tier and required-user-funding AI Gateway billing modes.

import { MINIMUM_CLOUDFLARE_BALANCE } from "@gadgets/workshop-shared/limits";

// Parse a positive-number env var (USD amount / count), falling back to a default.
function readNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

/** Minimum connected-account balance (USD) required to proceed via BYOK. */
export function getMinimumCloudflareBalance(env: Cloudflare.Env): number {
  return readNumber(env.MINIMUM_CLOUDFLARE_BALANCE, MINIMUM_CLOUDFLARE_BALANCE);
}

/**
 * Whether the AI Gateway billing flow (free-tier limits + Cloudflare-connect top-up) is enabled.
 * Disabled by default; when off, usage is unlimited and no balance checks occur (self-hosted).
 */
export function isCloudflareLimitsEnabled(env: Cloudflare.Env): boolean {
  return env.ENABLE_CLOUDFLARE_LIMITS === "true";
}

/** Returns whether every platform-gateway inference request must use a funded user account. */
export function isUserFundedAiRequired(env: Cloudflare.Env): boolean {
  return env.REQUIRE_USER_FUNDED_AI === "true";
}

/** Returns whether the deployment exposes Cloudflare account billing controls. */
export function isCloudflareBillingEnabled(env: Cloudflare.Env): boolean {
  return isCloudflareLimitsEnabled(env) || isUserFundedAiRequired(env);
}
