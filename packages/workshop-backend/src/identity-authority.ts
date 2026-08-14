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

/** Polls privileged authority with an absolute bound until failure or socket disposal. */
export function startIdentityAuthorityWatchdog(
    assertCurrent: () => Promise<void>,
    abort: (reason: Error) => void,
): { dispose(): void } {
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
    if (reason) abort(reason);
  };

  const schedule = () => {
    // Register the poll first. When it settles successfully at the bound, its microtask refreshes
    // the deadline before the second timer runs. If it hangs, the independent deadline still fires.
    pollTimer = setTimeout(poll, IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS);
    deadlineTimer = setTimeout(
      () => stop(new Error(CURRENT_IDENTITY_AUTHORITY_REQUIRED)),
      IDENTITY_AUTHORITY_WATCHDOG_INTERVAL_MS,
    );
  };

  const poll = async () => {
    pollTimer = undefined;
    try {
      await assertCurrent();
    } catch {
      stop(new Error(CURRENT_IDENTITY_AUTHORITY_REQUIRED));
      return;
    }
    if (!active) return;
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    schedule();
  };

  schedule();
  return { dispose: () => stop() };
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
