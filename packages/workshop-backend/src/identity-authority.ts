import type { IdentityRegistry } from "./identity-registry.js";

/** Registry authority captured when a verified external identity authenticates. */
export type VerifiedAuthorityContext = {
  canonicalVerifiedEmail: string;
  identityVersion: number;
};

/** Bounded error returned when retained registry authority is no longer current. */
export const CURRENT_IDENTITY_AUTHORITY_REQUIRED =
  "Current identity authority is no longer valid.";

/** Maximum stale privileged-authority window if the registry's live callback is lost. */
export const IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS = 30_000;

/** Bounded error used when retained local Gatekeeper bearer authority is no longer exact. */
export const CURRENT_GATEKEEPER_SESSION_REQUIRED =
  "Current Gatekeeper session is no longer valid.";

/** Maximum stale-token window when a User Durable Object's live revocation callback is lost. */
export const GATEKEEPER_SESSION_WATCHDOG_INTERVAL_MS = 30_000;

type IdentityAuthorityReader = Pick<DurableObjectStub<IdentityRegistry>, "getIdentity">;

/** Requires an identity to remain active at its exact captured version and canonical email. */
export async function assertCurrentIdentityAuthority(
    registry: IdentityAuthorityReader,
    internalUserId: string,
    authority: VerifiedAuthorityContext,
): Promise<void> {
  try {
    const current = await registry.getIdentity(internalUserId);
    if (current?.status === "active" &&
        current.identityVersion === authority.identityVersion &&
        current.canonicalVerifiedEmail === authority.canonicalVerifiedEmail) {
      return;
    }
  } catch {
    // Registry availability is part of authorization, so reads fail closed below.
  }
  throw new Error(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
}

function startRetainedAuthorityWatchdog(options: {
  assertCurrent: () => Promise<void>;
  abort: (reason: Error) => void;
  intervalMs: number;
  errorMessage: string;
}): { dispose(): void } {
  let active = true;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason?: Error) => {
    if (!active) return;
    active = false;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    pollTimer = undefined;
    deadlineTimer = undefined;
    if (reason) options.abort(reason);
  };

  const schedule = (observationEpoch: number) => {
    // Renew from when the poll started, not when it completed. Time spent waiting on the authority
    // read therefore consumes the next lease, and an overdue poll or deadline runs immediately.
    const elapsed = Date.now() - observationEpoch;
    pollTimer = setTimeout(poll, Math.max(0, options.intervalMs / 2 - elapsed));
    deadlineTimer = setTimeout(
      () => stop(new Error(options.errorMessage)),
      Math.max(0, options.intervalMs - elapsed),
    );
  };

  const poll = async () => {
    pollTimer = undefined;
    const observationEpoch = Date.now();
    try {
      await options.assertCurrent();
    } catch {
      stop(new Error(options.errorMessage));
      return;
    }
    if (!active) return;
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    schedule(observationEpoch);
  };

  schedule(Date.now());
  return { dispose: () => stop() };
}

/** Polls privileged authority with an absolute bound until failure or socket disposal. */
export function startIdentityAuthorityWatchdog(
    assertCurrent: () => Promise<void>,
    abort: (reason: Error) => void,
): { dispose(): void } {
  return startRetainedAuthorityWatchdog({
    assertCurrent,
    abort,
    intervalMs: IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS,
    errorMessage: CURRENT_IDENTITY_AUTHORITY_REQUIRED,
  });
}

/** Polls exact durable Gatekeeper token authority until failure or owning-socket disposal. */
export function startGatekeeperSessionWatchdog(
    assertCurrent: () => Promise<void>,
    abort: (reason: Error) => void,
): { dispose(): void } {
  return startRetainedAuthorityWatchdog({
    assertCurrent,
    abort,
    intervalMs: GATEKEEPER_SESSION_WATCHDOG_INTERVAL_MS,
    errorMessage: CURRENT_GATEKEEPER_SESSION_REQUIRED,
  });
}

/** Mints a local token only if its captured registry authority is still exact after minting. */
export async function mintCurrentIdentitySessionToken(options: {
  mint: () => Promise<string>;
  revoke: (token: string) => Promise<void>;
  assertCurrent: () => Promise<void>;
}): Promise<string> {
  const token = await options.mint();
  try {
    await options.assertCurrent();
    return token;
  } catch {
    try {
      await options.revoke(token);
    } catch {
      // Never return an unverified token, even if best-effort cleanup fails.
    }
    throw new Error(CURRENT_IDENTITY_AUTHORITY_REQUIRED);
  }
}
