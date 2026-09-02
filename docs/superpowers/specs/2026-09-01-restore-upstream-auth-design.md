# Restore Upstream Authentication Design

## Context

The fork introduced Clerk authentication and an `IdentityRegistry` that maps verified external identities to random internal user IDs. Existing deployments already stored user state in email-keyed `UserDurableObject`s, matching upstream `cloudflare/cloudflare-os`. When the registry build was deployed to vlightup staging, the same Cloudflare Access user was routed to a new random-ID User Durable Object and appeared to lose their profile, onboarding state, model providers, and workspaces.

The original email-keyed User Durable Object still contains that state. The recovery must route authentication back to it without copying, merging, or deleting user data.

Current upstream commit `af56a9d` is the source of truth for authentication behavior. The fork target is `0d614a1`. They diverged from merge base `bd0aa2d`; upstream has 43 commits not present in the fork and the fork has 230 commits not present upstream. Authentication behavior must therefore be ported surgically. A wholesale merge, revert, or file restoration is out of scope.

## Goals

- Match upstream authentication provider contracts and account routing.
- Route a verified Cloudflare Access email to `UserDurableObject.idFromName(email)` so the original vlightup profile becomes reachable again.
- Route authentication Gatekeepers by their provider-verified email, using upstream session-token behavior.
- Preserve upstream password authentication behavior.
- Remove Clerk from active code, public contracts, dependencies, configuration, tests, and documentation.
- Remove every active authentication, authorization, sharing, admin, and messaging dependency on `IdentityRegistry`.
- Preserve all non-auth fork features and their existing tests, including user-funded AI, Telegram, X, Japanese localization, connector configuration, sharing hardening, and managed deployment support.
- Keep deployed Durable Object migration history safe during phase 1.

## Non-goals

- Migrating or merging data from random-ID User Durable Objects. The user confirmed no valuable state was created after the identity cutover.
- Preserving fork-only Access or Gatekeeper session-expiry/watchdog behavior. MVP authentication should match upstream.
- Supporting Clerk as an optional provider.
- Deleting the deployed `IdentityRegistry` namespace in phase 1.
- Deploying beyond vlightup staging.

## Authentication Behavior

### Cloudflare Access

Use upstream behavior:

1. Verify the Access JWT with the configured issuer and audience.
2. Require the signed payload's `email` claim to be truthy, matching upstream. Workshop does not add type, trim, canonicalization, or email-shape checks beyond that boundary.
3. Resolve the user with `UserDurableObject.idFromName(email)`.
4. Call `authenticateFromCfAccess(email, signupsEnabled)` on that object.
5. Return `AuthenticatedApiImpl` for that exact User Durable Object.

No canonicalization or registry lookup occurs. This intentionally uses the same email representation as upstream and the pre-registry deployment, making the existing profile and provider settings reachable without a data migration.

### Authentication Gatekeepers

Use upstream behavior:

1. Require the deployment allowlist and `providesAuth` declaration.
2. Match upstream sign-in discovery, password-availability, and start behavior without using the fork's connector-readiness gate. Connector configuration/readiness remains available for non-auth connector and admin UI flows.
3. Request `full` with `resourceUrlPatterns: []` for Cloudflare sign-in and persist that account for billing; request transient `auth` scope for other providers.
4. Obtain the email through `GatekeeperUser.getAuthenticatedEmail()`. Workshop trusts a non-null result exactly as upstream does; each Gatekeeper implementation remains responsible for returning only its provider-verified email.
5. Resolve `UserDurableObject.idFromName(email)`.
6. Call `loginOrCreateViaGatekeeper(email, signupsEnabled)`.
7. Deliver the upstream `<email>:<secret>` session token.

Remove stable-provider-subject authentication contracts, registry resolution, collision locking, identity-version checks, retained authority watchers, Gatekeeper logout/revocation, and bounded Gatekeeper-session machinery. Match upstream retained-session behavior: local session tokens are not assigned the fork's absolute expiry, and an established Access WebSocket capability is not terminated by a local expiry watchdog. Admin matching also returns to upstream's raw account-route comparison without fork canonicalization.

### Password Authentication

Keep upstream username-keyed password login, signup, and local session-token behavior. Password usernames remain separate from verified email accounts according to upstream validation.

### Clerk Removal

Remove:

- Clerk verification and retained-session implementations outside the quarantined compatibility class described below.
- `authenticateWithClerk()` and Clerk RPC types.
- Clerk deployment config and environment declarations.
- Clerk development-variable forwarding.
- `@clerk/backend` and lockfile entries.
- Clerk-specific tests and design documentation.

The deployment workflow must continue to emit no Clerk configuration. Removing code does not mutate any vendor-side Clerk application or cloud secret; those control-plane artifacts are outside this phase.

## IdentityRegistry Phase 1 Quarantine

`IdentityRegistry` was added through Durable Object migration `v3`, followed by `TelegramChannel` in `v4`. Cloudflare Durable Object class deletion is irreversible and prevents rollback before the lifecycle change.

Phase 1 therefore:

- Retains the historical `v3` and `v4` migration entries unchanged.
- Retains the `IdentityRegistry` class export and implementation only as unreachable migration compatibility.
- Retains focused registry storage tests needed to ensure the compatibility class still builds.
- Removes every production caller of the registry.
- Adds no `deleted_classes` migration.

The retained implementation is not storage-inert by itself: its constructor may finish the existing email-claim backfill, and an already-scheduled alarm may delete expired link tokens/receipts and reschedule bounded cleanup. Phase 1 makes no new calls that mutate identity mappings. Existing identity records and random-ID User Durable Objects are not merged or deleted. The unreachable class temporarily retains its legacy `resolveClerkIdentity` method and labels because changing the deployed compatibility implementation is unnecessary phase-1 risk; this is the sole permitted Clerk-code exception. No Clerk verifier, dependency, public RPC, configuration, or caller remains. A later phase may delete the class only after staging verification, inventory, backup or explicit destruction approval, and a separate deployment approval.

## Telegram Without IdentityRegistry

Telegram transport identity must not rely on a caller- or Telegram-supplied email. Linking remains initiated by an already-authenticated Workshop capability.

### Route identity

`AuthenticatedApiImpl` already holds the server-derived `DurableObjectId` for the current user. Telegram linking stores `userId.toString()`, not an email, username, profile ID, or registry internal ID. This supports Access, authentication Gatekeepers, and password accounts uniformly while avoiding new identity-provider logic.

On message delivery, backend-private code reconstructs the exact user route with `UserDurableObject.idFromString(storedUserDurableObjectId)`. The ID is accepted only from TelegramChannel's durable server-owned link map; no browser API, Telegram update, shared external-gateway contract, or caller-controlled entrypoint props can supply it.

### Link storage

Move Telegram-specific link state into `TelegramChannel` storage through a focused internal link-store module. Preserve the current guarantees:

- Cryptographically random link tokens.
- Only token digests are persisted.
- Ten-minute expiry.
- Latest token wins for one Workshop user.
- One-to-one mapping between a Workshop User Durable Object and Telegram user ID.
- Atomic, single-use completion.
- Idempotent retry receipts keyed by Telegram update ID.
- Unlink removes the mapping and pending token.
- Completion receipts retain the current 24-hour TTL.
- Expired token and receipt cleanup remains alarm-driven and deletes at most 100 records per bounded pass.
- TelegramChannel remains the single alarm coordinator. It schedules the earliest deadline across queued messages, retries, tombstones, pending link tokens, and completion receipts; link cleanup must not overwrite a message retry deadline.

Persisted records map:

- token digest to pending Workshop User Durable Object ID and expiry;
- Workshop User Durable Object ID to Telegram user ID;
- Telegram user ID to Workshop User Durable Object ID;
- completion operation key to a bounded idempotency receipt.

The public `AuthenticatedApi` Telegram methods keep their existing argument-free signatures:

- `getTelegramLinkStatus()`
- `startTelegramLink()`
- `unlinkTelegram()`

### Message routing

Remove `linkedExternalSubject` and User Durable Object ID selection from the shared `ExternalMessageGateway` RPC contract. Route Telegram through a backend-private helper that accepts an actual `DurableObjectId`, not a caller-controlled identity string:

1. `TelegramChannel` authenticates the webhook and parses Telegram's stable numeric user ID.
2. It resolves that subject through its own durable link map.
3. It reconstructs the stored User Durable Object ID with `idFromString()` inside backend-private code.
4. The `DurableObjectId` object stays inside an ordinary backend function and is used to obtain the User Durable Object stub. Only the stub capability or canonical `userId.toString()` crosses a backend-private RPC boundary; `DurableObjectId` itself is not treated as an RPC value.
5. Overseer receives the canonical ID string through a backend-only method/input, reconstructs it with `idFromString()`, stores `userId.toString()` as caller/owner identity, and applies its existing workspace ownership/collaboration checks.

The shared `ExternalMessageGateway` keeps its existing `trustedEmail` mode, attachments, chat path, and durable callback support. Tests must prove that a trusted-email gateway, browser, Telegram payload, or caller-selected entrypoint mode cannot submit a User Durable Object ID.

### Existing Telegram links

Phase 1 does not read registry link mappings. For vlightup staging, the deployment gate first inspects the active Worker settings and deployment artifacts for Telegram bot/webhook secrets and configuration. If Telegram has never been configured since `v4`, a link could not have completed and the expected mapping count is zero; the evidence report records the active version, configuration absence, and this conclusion without invoking the Durable Object.

If Telegram is or was configured, phase 1 deployment is blocked because the current class exposes no read-only inventory RPC. A separate reviewed inspection change and mutation approval are required to deploy a narrowly scoped aggregate-count method, invoke it through an operator-only path, and record the count without exposing subjects or user IDs. A nonzero count requires explicit approval for mandatory relinking or a separately designed migration. The MVP does not infer absence or silently discard configured links.

## Other Upstream Identity Semantics

- Sharing discovery returns to upstream direct username/email User Durable Object lookup. Supplying a share target never authenticates as that target.
- Admin authority returns to upstream raw named User Durable Object route behavior: exact, case-sensitive `ADMINS.includes(userId.name)` with JSON-array parsing, no trim/canonicalization, no profile lookup, and rejection of non-array configuration.
- Persisted routing references use upstream Durable Object identity representation: owner/client/callback/billing routes use `userId.toString()` and reconstruct with `idFromString()` where upstream does. Route names such as email or username are used at authentication and discovery boundaries.
- Presentation identity remains distinct: `AiChatAuthorInfo.id`, collaborator `profile.id`, and chat-author snapshots retain the email/username route-name profile ID rather than the canonical Durable Object ID string.
- Profiles, avatars, collaborator discovery, analytics, and observability use the upstream email-keyed/password-keyed account behavior while preserving fork-only features.
- Gatekeeper providers keep fork-only connector features but expose upstream `getAuthenticatedEmail()` authentication semantics.
- X remains a connector and is not removed.

## Data Recovery

No data copy is required for the confirmed vlightup case:

- Before the registry deployment, Access routed the verified email to an email-keyed User Durable Object containing the configured profile and providers.
- The registry deployment routed the same user to a new random-ID object.
- Phase 1 restores the former route.

The recovery deliberately does not initialize, merge, or delete either object. If the Access email representation does not exactly match the legacy key, staging verification fails closed and deployment is not promoted.

## Testing

Follow TDD with focused tests before implementation changes.

### Authentication

- Access verified email resolves with `idFromName(email)` and reaches seeded legacy state.
- Access requests with a missing/falsy signed `email` claim fail; Workshop adds no shape/canonicalization checks not present upstream.
- Gatekeeper login calls only `getAuthenticatedEmail()`, creates/loads the email-keyed user, and emits `<email>:<secret>`.
- A null Gatekeeper email fails at Workshop; provider tests reject unverified provider data before `getAuthenticatedEmail()` returns it.
- Password login remains username-keyed.
- Cloudflare authentication Gatekeeper requests upstream `full` scope with empty resource patterns and persists the billing account; other providers request `auth`.
- Sign-in discovery exposes no `configured` field. Password availability depends only on upstream `DISABLE_PASSWORD_AUTH` and whether the raw auth-vendor allowlist is nonempty, even if every listed vendor is unbound, unconfigured, or fails `describe()`. `startGatekeeperLogin()` never invokes connector-readiness assertions.
- Local Gatekeeper tokens, Access WebSocket lifetime, admin matching, and absence of logout/revocation match upstream behavior.
- Admin tests cover exact case sensitivity, no trim/canonicalization, profile changes having no effect, JSON-string array parsing, and non-array rejection.
- Public/shared contracts contain no Clerk method or stable-subject auth contract.

### Telegram

- An authenticated user can start, inspect, and remove a link without passing identity input.
- Raw link tokens are never stored.
- Expired, superseded, replayed, malformed, and cross-user tokens fail.
- Concurrent completion binds one Telegram subject to one Workshop user.
- Completion retries with the same update ID are idempotent.
- Unlinked Telegram subjects are rejected.
- Linked messages resolve with `idFromString()` to the exact user object through backend-private code.
- Telegram-controlled username/profile data and browser input cannot choose another User Durable Object ID or email.
- One-alarm interaction tests prove token/receipt cleanup cannot clobber queued-message, retry, or tombstone deadlines.
- Existing attachment, queue, callback, retry, and frontend Telegram tests continue to pass.

### Regression and static scope

- Seeded pre-registry data proves the recovered user can list/open/edit a workspace, use its configured model/provider billing route, and share it; newly created phase-1 workspaces preserve the same `userId.toString()` representation.
- Persisted routing references that upstream models as User Durable Object IDs round-trip through `toString()` and `idFromString()`, while profile/chat-author IDs remain email/username values.
- Sharing uses upstream direct User Durable Object lookup.
- X and other connector tests remain passing.
- `IdentityRegistry` has no active callers outside its compatibility source/tests/export.
- Migration `v3`/`v4` and the class export remain compatible and no deletion migration exists; tests acknowledge the retained constructor/alarm cleanup behavior.
- No Clerk dependency, environment variable, runtime config, RPC type, implementation, test fixture, or active documentation remains.

## Deployment and Verification

Implementation proceeds through reviewed runtime and starter/deployment PRs. No deployment mutation occurs without a new explicit approval.

For vlightup staging:

1. Run all repository tests, lint, type checks, builds, generated manifest checks, and deployment dry-runs.
2. Capture the current active Worker versions, bindings, Access configuration, and Durable Object migration state.
3. Prove Telegram was never configured from active Worker settings and deployment artifacts. If it was configured, stop and obtain approval for the separate aggregate inspection build; do not infer a zero mapping count.
4. Deploy phase 1 only after approval.
5. Authenticate through Access/Google and verify the original profile, onboarding-complete state, preferred model, provider settings, workspaces, and homepage model list.
6. Verify recovered workspaces can be listed, opened, edited, billed through the configured model/provider route, and shared.
7. Verify no new onboarding or random identity is created.
8. Verify Telegram behavior if configured; otherwise verify the feature remains disabled and does not affect auth.
9. Keep the phase-1 artifact available as the only supported rollback baseline. Do not roll back to the registry-routing build after users resume writing data to the recovered email-keyed account.

## Phase 2 Gate

Phase 2 is a separate design, PR, and deployment approval. It may add a later `deleted_classes: ["IdentityRegistry"]` migration only after:

- no active source path references the registry;
- registry and random-ID account disposition is documented;
- Telegram links have been migrated or confirmed absent;
- required backups or explicit destruction approval exist;
- phase 1 has completed a defined staging soak;
- the irreversible lifecycle change is validated with the pinned Wrangler/deployment path.
