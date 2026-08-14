import { RpcTarget } from "capnweb";
import type { ClerkSessionControl } from "@gadgets/workshop-shared/api";
import type { VerifiedClerkIdentity } from "./clerk-auth.js";
import type { IdentityResolution } from "./identity-registry.js";

const MAX_TIMEOUT_MILLISECONDS = 0x7fffffff;
const SESSION_EXPIRED = "Clerk session expired.";
const SESSION_CLOSED = "Clerk session is closed.";
const IDENTITY_CHANGED = "Clerk identity changed.";

type CreateClerkSessionOptions = {
  initialIdentity: VerifiedClerkIdentity;
  initialResolution: IdentityResolution;
  signupsEnabled: boolean;
  abortSession(reason: Error): void;
  verify(token: string): Promise<VerifiedClerkIdentity>;
  resolve(
    subject: string,
    email: string,
    signupsEnabled: boolean,
    initiatingSubscriberId: string,
  ): Promise<IdentityResolution>;
  register(
    subscriberId: string,
    identity: IdentityResolution,
    invalidate: () => void,
  ): Promise<void>;
  unregister(subscriberId: string, internalUserId: string): Promise<void>;
};

class ClerkSessionControlImpl extends RpcTarget implements ClerkSessionControl {
  constructor(private state: ClerkSessionState) {
    super();
  }

  refresh(token: string): Promise<Date> {
    return this.state.refresh(token);
  }

  async logout(): Promise<void> {
    this.state.logout();
  }

  // Releasing this one child capability must not revoke the sibling AuthenticatedApi or its socket.
  [Symbol.dispose](): void {}
}

class ClerkSessionState {
  readonly control: ClerkSessionControlImpl;
  readonly #subscriberId = crypto.randomUUID();
  #currentIdentity: VerifiedClerkIdentity;
  #currentResolution: IdentityResolution;
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #unregistered = false;

  constructor(private options: CreateClerkSessionOptions) {
    this.#currentIdentity = options.initialIdentity;
    this.#currentResolution = options.initialResolution;
    this.control = new ClerkSessionControlImpl(this);
  }

  async initialize(): Promise<void> {
    this.#requireUnexpired(this.#currentIdentity.expiresAt);
    this.#armDeadline(this.#currentIdentity.expiresAt);
    try {
      await this.options.register(
        this.#subscriberId,
        this.#currentResolution,
        () => this.#abort(new Error(IDENTITY_CHANGED)),
      );
      this.#requireOpenBeforeCurrentDeadline();
    } catch (error) {
      this.#abort(error instanceof Error ? error : new Error(SESSION_CLOSED));
      throw error;
    }
  }

  async refresh(token: string): Promise<Date> {
    try {
      this.#requireOpenBeforeCurrentDeadline();
      const verified = await this.options.verify(token);
      this.#requireOpenBeforeCurrentDeadline();
      this.#requireUnexpired(verified.expiresAt);
      if (verified.subject !== this.#currentIdentity.subject) {
        throw new Error(IDENTITY_CHANGED);
      }

      const resolved = await this.options.resolve(
        verified.subject,
        verified.email,
        this.options.signupsEnabled,
        this.#subscriberId,
      );
      this.#requireOpenBeforeCurrentDeadline();
      this.#requireUnexpired(verified.expiresAt);
      this.#validateReplacement(verified, resolved);

      // Registration validates the registry's current version. Only after that succeeds do we swap
      // the authoritative deadline and local identity snapshot.
      await this.options.register(
        this.#subscriberId,
        resolved,
        () => this.#abort(new Error(IDENTITY_CHANGED)),
      );
      this.#requireOpenBeforeCurrentDeadline();
      this.#requireUnexpired(verified.expiresAt);

      this.#armDeadline(verified.expiresAt);
      this.#currentIdentity = verified;
      this.#currentResolution = resolved;
      return new Date(verified.expiresAt.getTime());
    } catch (error) {
      this.#abort(error instanceof Error ? error : new Error(SESSION_CLOSED));
      throw error;
    }
  }

  logout(): void {
    this.#abort(new Error("Clerk session logged out."));
  }

  async dispose(): Promise<void> {
    if (this.#closed) {
      await this.#unregister();
      return;
    }
    this.#closed = true;
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    this.#timeout = undefined;
    await this.#unregister();
  }

  #validateReplacement(
      verified: VerifiedClerkIdentity, resolved: IdentityResolution): void {
    if (resolved.status !== "active" ||
        resolved.internalUserId !== this.#currentResolution.internalUserId) {
      throw new Error(IDENTITY_CHANGED);
    }
    const emailChanged =
      resolved.canonicalVerifiedEmail !== this.#currentResolution.canonicalVerifiedEmail;
    if (resolved.canonicalVerifiedEmail !== verified.email.trim().toLowerCase() ||
        (emailChanged
          ? resolved.identityVersion <= this.#currentResolution.identityVersion
          : resolved.identityVersion !== this.#currentResolution.identityVersion)) {
      throw new Error(IDENTITY_CHANGED);
    }
  }

  #requireUnexpired(expiresAt: Date): void {
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new Error(SESSION_EXPIRED);
    }
  }

  #requireOpenBeforeCurrentDeadline(): void {
    if (this.#closed) throw new Error(SESSION_CLOSED);
    if (this.#currentIdentity.expiresAt.getTime() <= Date.now()) {
      this.#abort(new Error(SESSION_EXPIRED));
      throw new Error(SESSION_EXPIRED);
    }
  }

  #armDeadline(expiresAt: Date): void {
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    const run = () => {
      if (this.#closed) return;
      const remaining = expiresAt.getTime() - Date.now();
      if (remaining <= 0) {
        this.#abort(new Error(SESSION_EXPIRED));
      } else {
        this.#timeout = setTimeout(run, Math.min(remaining, MAX_TIMEOUT_MILLISECONDS));
      }
    };
    const remaining = expiresAt.getTime() - Date.now();
    if (remaining <= 0) throw new Error(SESSION_EXPIRED);
    this.#timeout = setTimeout(run, Math.min(remaining, MAX_TIMEOUT_MILLISECONDS));
  }

  #abort(reason: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    this.#timeout = undefined;
    void this.#unregister().catch(() => {});
    this.options.abortSession(reason);
  }

  async #unregister(): Promise<void> {
    if (this.#unregistered) return;
    this.#unregistered = true;
    await this.options.unregister(
      this.#subscriberId,
      this.#currentResolution.internalUserId,
    );
  }
}

/** Creates one hard-expiring Clerk lifecycle shared by sibling capabilities on an API socket. */
export async function createClerkSession(options: CreateClerkSessionOptions) {
  const state = new ClerkSessionState(options);
  await state.initialize();
  return {
    control: state.control,
    dispose: () => state.dispose(),
  };
}
