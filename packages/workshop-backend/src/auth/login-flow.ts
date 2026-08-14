// Sign-in via authentication gatekeepers.
//
// Unlike the normal connect-account flow (which runs for an already-logged-in user), login happens
// before we know who the user is. The PublicApi starts a gatekeeper connect flow (in "auth" scope
// mode) with a `LoginConnectCallbackImpl` as the callback and a `PendingLogin` DO to bridge the
// result back to the waiting browser:
//
//   1. PublicApi.startGatekeeperLogin(vendorId) creates a PendingLogin DO (keyed by a random DO id),
//      hands the gatekeeper a LoginConnectCallbackImpl, and returns {url, attempt}, where `attempt`
//      is an RpcStub wrapping the DO (so the client awaits via a capability, never a guessable id).
//   2. The browser opens `url` (the gatekeeper's self-closing OAuth popup) and calls
//      `attempt.wait()`, which blocks on the PendingLogin DO.
//   3. When the gatekeeper finishes, it calls LoginConnectCallbackImpl.complete(user). We read the
//      stable provider subject and verified email, resolve its internal identity, mint a bounded
//      local Workshop session, and
//      deliver the token to the PendingLogin DO, which resolves the awaiting RPC.
//
// Sign-in only requests minimal scopes and the gatekeeper grant is transient (it self-destructs
// shortly after we read the email) — so login does NOT create a persistent connected account.
// Capability access (repos, docs, billing) is granted later when the user explicitly connects the
// gatekeeper, which requests the full scopes and persists the connection.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { GatekeeperConnectCallback, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "../observability";
import { readAdminConfig } from "../admin-config.js";
import { recordAnalytics } from "../analytics.js";
import type { IdentityResolution } from "../identity-registry.js";
import {
  assertCurrentIdentityAuthority,
  mintCurrentIdentitySessionToken,
} from "../identity-authority.js";

const logger = createWorkshopLogger("workshop.auth");

const SIGNUPS_DISABLED = "New sign-ups are currently disabled on this deployment.";
const EXPLICIT_LINK_REQUIRED =
  "Identity ownership requires explicit linking or deployment operator resolution.";

type PendingResult = { token: string } | { error: string };

// Bridges a login result from the (separate) OAuth-callback invocation back to the waiting browser.
//
// This DO holds no durable storage: a login normally completes within seconds, and the in-flight
// awaitResult() request keeps the DO alive so the in-memory waiter is reachable when deliver()/fail()
// fire. If the attempt is abandoned, the client disposes the awaiting RPC (the `attempt` stub) and
// the DO is simply evicted — no alarm or cleanup needed.
export class PendingLogin extends DurableObject<Cloudflare.Env> {
  // Awaiters from in-flight awaitResult() calls, resolved/rejected when the result arrives.
  #waiters: { resolve: (token: string) => void; reject: (err: Error) => void }[] = [];
  // Stash for the rare case deliver()/fail() arrives before awaitResult() registers a waiter.
  #result?: PendingResult;

  // Block until the login completes (or fails).
  async awaitResult(): Promise<string> {
    if (this.#result) {
      const result = this.#result;
      this.#result = undefined;  // one-time use
      if ("token" in result) return result.token;
      throw new Error(result.error);
    }
    return await new Promise<string>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  // Called by LoginConnectCallbackImpl on success: resolve the awaiter (or stash the token if none
  // is waiting yet).
  async deliver(token: string): Promise<void> {
    if (this.#waiters.length > 0) {
      for (const w of this.#waiters) w.resolve(token);
      this.#waiters = [];
    } else {
      this.#result = { token };
    }
  }

  async fail(reason: string): Promise<void> {
    if (this.#waiters.length > 0) {
      for (const w of this.#waiters) w.reject(new Error(reason));
      this.#waiters = [];
    } else {
      this.#result = { error: reason };
    }
  }
}

type LoginCallbackProps = { pendingId: string; vendorId: string };
type AuthenticationAccountStub = Required<Pick<GatekeeperUser, "getAuthenticationIdentity">>;

export class LoginConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, LoginCallbackProps>
    implements GatekeeperConnectCallback {
  #pending() {
    const id = this.ctx.exports.PendingLogin.idFromString(this.ctx.props.pendingId);
    return this.ctx.exports.PendingLogin.get(id);
  }

  async complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<void> {
    const loginLogger = logger.with({
      operation: "gatekeeper.login",
      vendorId: this.ctx.props.vendorId,
    });
    const pending = this.#pending();
    // `account` is a call parameter, so Cap'n Web disposes it automatically when this method
    // returns — no explicit disposal needed. Sign-in exclusively reads the provider's stable
    // subject plus verified email; the legacy email-only method is never an authentication fallback.
    try {
      // RPC stubs cannot report optional-method presence. The providesAuth declaration says the
      // method exists; viewing that derived interface as required lets invocation itself fail closed
      // for a custom vendor that violates the declaration.
      const providerIdentity = await (account as unknown as AuthenticationAccountStub)
        .getAuthenticationIdentity();
      if (!providerIdentity || typeof providerIdentity.subject !== "string" ||
          providerIdentity.subject.trim().length === 0 ||
          typeof providerIdentity.verifiedEmail !== "string" ||
          providerIdentity.verifiedEmail.trim().length === 0) {
        throw new Error("Authentication Gatekeeper returned an invalid identity.");
      }
      // Signup policy is read at the Workshop trust boundary before the verified provider identity
      // is resolved. The registry canonicalizes the email and initializes the stable User DO.
      const signupsEnabled = (await readAdminConfig(this.env)).signupsEnabled;
      const registry = this.ctx.exports.IdentityRegistry.getByName("");
      let identity: IdentityResolution;
      try {
        identity = await registry.resolveGatekeeperIdentity(
          this.ctx.props.vendorId,
          providerIdentity.subject,
          providerIdentity.verifiedEmail,
          signupsEnabled,
        );
      } catch (error) {
        if (error instanceof Error && error.message === SIGNUPS_DISABLED) {
          loginLogger.info("gatekeeper login finished", {
            event: "gatekeeper.login.finished", outcome: "signups_disabled",
          });
          await pending.fail(SIGNUPS_DISABLED);
          return;
        }
        if (error instanceof Error && error.message === EXPLICIT_LINK_REQUIRED) {
          loginLogger.info("gatekeeper login finished", {
            event: "gatekeeper.login.finished", outcome: "explicit_link_required",
          });
          await pending.fail(EXPLICIT_LINK_REQUIRED);
          return;
        }
        throw error;
      }
      const userStub = this.ctx.exports.UserDurableObject.get(
        this.ctx.exports.UserDurableObject.idFromName(identity.internalUserId));
      const authority = {
        canonicalVerifiedEmail: identity.canonicalVerifiedEmail,
        identityVersion: identity.identityVersion,
      };
      const assertCurrent = () => assertCurrentIdentityAuthority(
        registry, identity.internalUserId, authority);
      // Close the issuance race: a Clerk update may move or collision-lock this identity after its
      // email resolution but before the local token is ready. Re-read exact durable authority and
      // revoke the just-created token rather than delivering stale authority.
      const secret = await mintCurrentIdentitySessionToken({
        mint: () => userStub.createGatekeeperSession(
          identity, this.ctx.props.vendorId, providerIdentity.subject, expiresAt,
        ),
        revoke: token => userStub.revokeGatekeeperSession(token),
        assertCurrent,
      });
      // Session tokens remain "<doName>:<secret>"; the opaque record also retains this exact
      // registry version/email so a post-check delivery race cannot upgrade it on reconnect.
      await pending.deliver(`${identity.internalUserId}:${secret}`);
      if (identity.created) {
        recordAnalytics(this.ctx, this.env, {
          event_name: "account_created",
          user_id: identity.internalUserId,
          source: "gatekeeper",
        });
      }
      loginLogger.info("gatekeeper login finished", {
        event: "gatekeeper.login.finished", outcome: "ok",
      });
    } catch (err) {
      loginLogger.error("gatekeeper login failed", {
        event: "gatekeeper.login.failed", error: err,
      });
      loginLogger.info("gatekeeper login finished", {
        event: "gatekeeper.login.finished", outcome: "error",
      });
      await pending.fail("Sign-in failed. Please try again.");
    }
  }

  // No-ops: transient sign-in grants do not create connected-account credential state.
  async credentialsExpired(): Promise<void> {}
  async credentialsRestored(_expiresAt?: Date): Promise<void> {}
}
