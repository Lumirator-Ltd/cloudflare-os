# Sign-in via authentication gatekeepers

Sign-in is provided by **authentication gatekeepers** — gatekeepers that advertise `providesAuth`
and can return a provider-stable subject plus provider-verified email. Each such gatekeeper uses a
single OAuth app for both
sign-in and (when the user later connects it) its capabilities, so there's only one OAuth app per
provider — no separate "login" vs. "gatekeeper" apps.

It's an optional, **additive** feature: for each allowlisted, auth-capable gatekeeper a "Continue
with …" button appears **alongside** the normal username/password form. Off by default — with an
empty allowlist the Workshop behaves as before (username/password, or Cloudflare Access).

The deployment opts gatekeepers into sign-in via the `AUTH_GATEKEEPERS` allowlist (comma-separated
vendor ids). Set `DISABLE_PASSWORD_AUTH=true` to hide username/password and offer gatekeeper sign-in
only (ignored unless the allowlist is non-empty, to avoid locking everyone out).

## Identity: stable internal ID resolved from verified authority

A provider-verified email is an identity claim, not a durable account key. The deployment-local
`IdentityRegistry` resolves Clerk subjects and Cloudflare Access subjects (scoped by configured
issuer and audience) to random opaque internal user IDs; `UserDurableObject` is addressed by
`idFromName(internalUserId)`. Every canonical email ever presented by a stable subject remains a
durable claim of that internal identity. A new stable subject cannot take over or silently merge
with a current or historical claim: authentication fails until an explicit linking or deployment
operator resolution flow exists. The owning subject may move back to one of its historical emails.
Session records capture the registry's exact canonical email and identity version so a moved or
collision-locked identity fails closed.

Authentication Gatekeepers resolve a provider-stable opaque subject scoped by vendor ID together
with its current provider-verified email. Email moves preserve the internal identity, tombstone the
old email, increment the identity version, and invalidate retained sessions. An unseen Gatekeeper
subject cannot claim a current or historical email owned by any Gatekeeper, Clerk, or Access identity.
It fails closed regardless of signup policy. A proof-based user linking UI and operator resolution
workflow remain future LUM-73 work; sign-in never invents an email-only merge while those flows are
absent.

Retained local Gatekeeper sessions have an absolute expiry at the earlier of the provider's valid
future credential expiry and a fixed one-hour local maximum. Missing or stale provider expiry uses
the one-hour maximum. Expired and legacy subjectless/unbounded records are rejected and removed, and
the complete capability graph is aborted at the retained session deadline.

Cloudflare Access WebSocket capability graphs have both one non-refreshable absolute deadline at the
assertion's verified `exp` and exact registry-authority invalidation. The browser must reconnect with
a fresh assertion after expiry.

## Incremental scopes

Sign-in requests only the **minimal scopes** needed to verify the user's email (e.g. GitHub
`read:user user:email`, Google `openid email profile`, Cloudflare `offline_access user-details.read`),
and the gatekeeper grant created for login is **transient** — it self-destructs shortly after the
email is read, so signing in never leaves a broad authorization lying around. The fuller capability
scopes (repos, Gmail/Docs, AI Gateway billing) are requested only later, when the user explicitly
**connects the gatekeeper** (`connectAccount(vendorId)` with the default `scopes: "full"`), which is
what persists a usable connected account. `GatekeeperVendor.connectAccount` takes
`{ scopes: "auth" | "full" }` to choose between the two.

## Sign-in flow

1. The client calls `PublicApi.startGatekeeperLogin(vendorId)`. The backend creates a short-lived
   `PendingLogin` DO, hands the gatekeeper a `LoginConnectCallbackImpl`, and returns the gatekeeper's
   OAuth `url` plus an `attempt` stub (a capability wrapping the `PendingLogin` DO — no login id is
   exposed to the client).
2. The client opens `url` in a pop-up (the gatekeeper's self-closing OAuth window) and calls
   `attempt.wait()`, which blocks on the `PendingLogin` DO.
3. When the gatekeeper finishes, it calls `complete(user)`. The callback reads
   `user.getAuthenticationIdentity()`, resolves the vendor-scoped stable subject and verified email,
   initializes its `UserDurableObject`, and mints an exact-version, bounded session. A missing,
   throwing, null, or blank stable identity fails sign-in without falling back to the deprecated
   email-only method. It delivers the
   `"<opaque-internal-id>:<secret>"` token to the `PendingLogin` DO, which resolves the awaiting RPC.
4. The client stores the token and authenticates as usual.

Sign-in does **not** persist a connected account: the minimal-scope grant is only used to read the
email and is then discarded by the gatekeeper. To use a gatekeeper's capabilities (repos, Gmail/Docs)
or Cloudflare AI Gateway billing, the user explicitly **connects** it afterward (which requests the
full scopes and persists the connection).

## Configuration

```
PUBLIC_BASE_URL=https://your-host
AUTH_GATEKEEPERS=cloudflare,google,github   # which gatekeepers may sign users in (order = button order)

# Optional: gatekeeper sign-in only (hide username/password).
DISABLE_PASSWORD_AUTH=true
```

OAuth app credentials live on the **gatekeeper Workers**, not the backend. Register each gatekeeper's
OAuth app with its own redirect URI:

- Google: `${PUBLIC_BASE_URL}/gatekeeper/google/oauth`
- GitHub: `${PUBLIC_BASE_URL}/gatekeeper/github/oauth`
- Cloudflare: `${PUBLIC_BASE_URL}/gatekeeper/cloudflare/oauth`

In local dev, `run-dev-server.js` seeds each gatekeeper's `CLIENT_ID`/`CLIENT_SECRET` from
`GOOGLE_*` / `GITHUB_*` / `CLOUDFLARE_OAUTH_*` shell vars.

## Storage / bindings

- `PendingLogin` (DO) — short-lived bridge between a gatekeeper login pop-up and the waiting browser,
  reached via `ctx.exports` (no explicit binding). Holds no durable storage: the in-flight
  `attempt.wait()` keeps it alive, and it's evicted once the login completes or the client disposes
  the `attempt` stub.

## Code layout

```
auth/
├── config.ts         # AUTH_GATEKEEPERS allowlist; password-auth toggle
├── auth-vendors.ts    # GATEKEEPER_<NAME> binding lookup helpers
└── login-flow.ts      # PendingLogin DO + LoginConnectCallbackImpl
```

Client-side: `ServerConfigContext` exposes `authVendors` and `passwordAuthEnabled`;
`components/auth/OAuthButtons` renders the sign-in options (pop-up + `attempt.wait()`).
