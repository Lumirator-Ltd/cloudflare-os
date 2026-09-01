# Restore Upstream Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development by default to implement this plan task-by-task. Run independent, safely isolated tasks in parallel; sequence tasks that share state or dependencies. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore upstream email-/username-keyed authentication so vlightup reaches its pre-registry profile and workspace state while preserving every non-auth fork feature.

**Architecture:** Surgically port authentication behavior from `cloudflare/main@af56a9d` onto fork commit `0d614a1`; do not merge or restore whole mixed-purpose files. Quarantine the deployed `IdentityRegistry` class and migrations without active callers, and replace Telegram registry links with a server-owned link store inside `TelegramChannel` plus backend-private User Durable Object routing.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, Cap'n Web RPC, Vitest, pnpm 11, Wrangler, Node.js test runner.

**Design:** `docs/superpowers/specs/2026-09-01-restore-upstream-auth-design.md`

**Source of truth:** `cloudflare/main@af56a9d` for auth behavior; `origin/main@0d614a1` for retained fork features.

---

## File Structure and Boundaries

### Restore exactly where safe

- `packages/workshop-backend/src/access.ts` — upstream Access JWT verification/rate-limit behavior.
- `packages/workshop-backend/src/auth/login-flow.ts` — upstream provider-email login callback and token delivery.
- `packages/workshop-backend/src/analytics.ts` — upstream route identity semantics where no fork event is lost.
- `packages/workshop-backend/src/observability.ts` — upstream route identity semantics where no fork field is lost.
- `docs/oauth-signin.md` — upstream auth semantics, then retain fork connector sections only where still valid.

Before copying any whole file, compare it with `git diff cloudflare/main -- <path>` and preserve unrelated fork behavior. `server.ts`, `user.ts`, `overseer.ts`, provider implementations, and shared contracts must be adapted rather than restored wholesale.

### New focused modules

- `packages/workshop-backend/src/telegram/link-store.ts` — token hashing, pending links, one-to-one subject mappings, idempotency receipts, and link cleanup deadlines.
- `packages/workshop-backend/__tests__/telegram-link-store.test.ts` — pure durable-storage contract for the link store.
- `packages/workshop-backend/src/external-message-routing.ts` — backend-private message delivery accepting a resolved User Durable Object stub/ID; shared `ExternalMessageGateway` never accepts a caller-supplied User Durable Object ID.

### Retain as compatibility only

- `packages/workshop-backend/src/identity-registry.ts`
- `packages/workshop-backend/__tests__/identity-registry.test.ts`
- `packages/workshop-backend/__integration__/identity-registry.test.ts`
- `packages/workshop-backend/wrangler.jsonc` migrations `v3` and `v4`
- `IdentityRegistry` export/type/golden-manifest entries required by the deployed class

No new code may call the retained registry.

---

### Task 1: Establish a Clean Baseline

**Files:**
- Verify only; no source changes.

- [ ] **Step 1: Materialize committed dependencies without network or lifecycle scripts**

Run:

```bash
export PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH
pnpm install --offline --frozen-lockfile --ignore-scripts
```

Expected: exit 0; lockfile unchanged; no lifecycle scripts run.

Build the workspace package whose exports point to generated `dist` files:

```bash
pnpm --filter @gadgets/typed-storage build
pnpm --filter @gadgets/workshop-backend exec node build-browser-runtime.mjs
pnpm --filter @gadgets/workshop-backend exec node scripts/build-format-blueprints.mjs
```

Expected: exit 0 and ignored workspace/generated build artifacts exist for direct Vitest imports.

- [ ] **Step 2: Run focused auth/Telegram baseline tests**

Run:

```bash
export PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/access.test.ts \
  __tests__/login-flow.test.ts \
  __tests__/admin-authority.test.ts \
  __tests__/auth-readiness.test.ts \
  __tests__/telegram-channel.test.ts \
  __tests__/telegram-store.test.ts
```

Expected: all selected baseline tests pass.

- [ ] **Step 3: Run the complete baseline suite**

Run in a background terminal:

```bash
export PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH
pnpm test
```

Expected: exit 0. If it fails, stop and classify the failure as baseline/environmental before changing code.

- [ ] **Step 4: Confirm the branch contains documentation only**

Run:

```bash
git status --short
git diff origin/main --stat
```

Expected: only the committed design/plan documentation differs; no generated or dependency files changed.

### Task 2: Establish Direct Provider-Verified Email Paths

**Files:**
- Inspect only: `packages/workshop-shared/src/gatekeeper.ts` (contract removal is deferred to Task 8)
- Modify: `packages/gatekeeper-cloudflare/src/cloudflare.ts`
- Modify: `packages/gatekeeper-cloudflare/src/cloudflare-api.ts`
- Modify: `packages/gatekeeper-cloudflare/__tests__/cloudflare-api.test.ts`
- Modify: `packages/gatekeeper-google/src/google.ts`
- Modify: `packages/gatekeeper-google/src/google-api.ts`
- Modify: `packages/gatekeeper-google/__tests__/google-api.test.ts`
- Modify: `packages/gatekeeper-github/src/github.ts`
- Modify: `packages/gatekeeper-github/src/github-api.ts`
- Modify: `packages/gatekeeper-github/__tests__/github-auth.test.ts`
- Modify: `packages/integration-tests/fixtures/gatekeeper-test/src/test-gatekeeper.ts`

- [ ] **Step 1: Write failing provider-contract tests**

Add assertions that each auth-capable Gatekeeper exposes `getAuthenticatedEmail()` directly and rejects unverified provider data before returning an email. Keep connector/account-read tests unchanged. Retain the stable-subject method temporarily so the current backend remains functional until the atomic cleanup in Task 8.

Representative assertion:

```ts
expect(await account.getAuthenticatedEmail()).toBe("verified@example.com");
```

For Google and GitHub, include negative fixtures for `email_verified: false` or non-primary/unverified email. For Cloudflare, preserve its upstream `/user` identity boundary.

- [ ] **Step 2: Run provider tests and verify failure**

Run:

```bash
pnpm --filter @gadgets/cloudflare-gatekeeper exec vitest run __tests__/cloudflare-api.test.ts
pnpm --filter @gadgets/google-gatekeeper exec vitest run __tests__/google-api.test.ts
pnpm --filter @gadgets/github-gatekeeper exec vitest run __tests__/github-auth.test.ts
```

Expected: FAIL where `getAuthenticatedEmail()` is only a wrapper around the stable-subject method or provider verification is not covered directly.

- [ ] **Step 3: Adapt each provider without restoring whole files**

Implement the provider-verified email path directly:

```ts
async getAuthenticatedEmail(): Promise<string | null> {
  return await this.#withApi(api => api.getAuthenticatedEmail());
}
```

Keep the existing stable-subject method as temporary compatibility until Task 8. Keep GitHub code browsing/account-wide features, Google connector behavior, Cloudflare connector readiness, X, and all configurators unchanged.

- [ ] **Step 4: Run provider tests**

Run:

```bash
pnpm --filter @gadgets/cloudflare-gatekeeper test:run
pnpm --filter @gadgets/google-gatekeeper test:run
pnpm --filter @gadgets/github-gatekeeper test:run
```

Expected: all pass and the current backend contract remains buildable.

- [ ] **Step 5: Commit**

```bash
git add packages/gatekeeper-cloudflare packages/gatekeeper-google packages/gatekeeper-github \
  packages/integration-tests/fixtures/gatekeeper-test/src/test-gatekeeper.ts
git commit -m "refactor: expose provider-verified auth emails"
```

### Task 3: Restore Email-Keyed Access and Gatekeeper Login

**Files:**
- Modify: `packages/workshop-backend/__tests__/access.test.ts`
- Modify: `packages/workshop-backend/__tests__/login-flow.test.ts`
- Replace/rewrite: `packages/workshop-backend/__tests__/stable-user-identity.test.ts`
- Modify: `packages/workshop-backend/src/access.ts`
- Modify: `packages/workshop-backend/src/auth/login-flow.ts`
- Modify: `packages/workshop-backend/src/user.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Inspect only: `packages/workshop-shared/src/api.ts` (contract removal is deferred to Task 8)
- Modify: `packages/integration-tests/__tests__/gatekeeper-signin.test.ts`
- Delete: `packages/integration-tests/__tests__/auth-convergence.test.ts`

- [ ] **Step 1: Write failing legacy-profile routing tests**

Seed a `UserDurableObject` addressed by `idFromName("owner@example.com")` with a customized profile and model/provider state. Add a truthy non-canonical Access email fixture and assert Workshop passes it through unchanged, matching upstream rather than adding shape/trim/canonicalization checks. Add a username/password fixture proving local password login remains username-keyed. Assert:

```ts
const api = await publicApi.authenticateFromCfAccess();
expect(await api.whoami()).toEqual(existingProfile);
expect(users.idFromName).toHaveBeenCalledWith("owner@example.com");
expect(identityRegistry.getByName).not.toHaveBeenCalled();
```

Add equivalent Gatekeeper coverage: `complete()` calls only `getAuthenticatedEmail()`, calls `loginOrCreateViaGatekeeper(email, signupsEnabled)`, and delivers `${email}:${secret}`. Test null Gatekeeper email and falsy Access email failure at Workshop. Add a red Cloudflare case proving `full` scope with `resourceUrlPatterns: []` and billing-account persistence; prove non-Cloudflare providers use `auth`.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/access.test.ts \
  __tests__/login-flow.test.ts \
  __tests__/stable-user-identity.test.ts
```

Expected: FAIL because current auth routes through `IdentityRegistry` random IDs.

- [ ] **Step 3: Restore upstream Access verification behavior**

Port `cloudflare/main@af56a9d:packages/workshop-backend/src/access.ts` exactly unless a current fork-only non-auth use is demonstrated. Keep signed issuer/audience verification and upstream truthy email handling; remove Access identity/session-deadline wrappers.

- [ ] **Step 4: Restore upstream Gatekeeper login flow**

Port `cloudflare/main@af56a9d:packages/workshop-backend/src/auth/login-flow.ts`. Preserve current logging imports only if behavior remains identical. Cloudflare sign-in must request:

```ts
{ scopes: "full", resourceUrlPatterns: [] }
```

Other providers request:

```ts
{ scopes: "auth" }
```

- [ ] **Step 5: Adapt UserDurableObject to upstream session behavior**

Restore `loginOrCreateViaGatekeeper(email, allowCreate)`, generic `#newSessionToken()`, and upstream `authenticate(secret)` semantics. Remove random identity initialization/session metadata from active User methods. Preserve localization, connected accounts, models, ambient agents, user-funded AI, and connector methods.

New Gatekeeper account initialization remains:

```ts
this.storage.profile.put({
  type: "user",
  name: email.split("@")[0],
  id: email,
});
```

- [ ] **Step 6: Adapt PublicApiImpl to upstream routing**

In `server.ts`, restore upstream `authenticate()`, `authenticateFromCfAccess()`, login, signup, and Gatekeeper start behavior while preserving Telegram methods and fork-only APIs. The core routes are:

```ts
const userId = this.users.idFromName(tokenPrefix);
await this.users.get(userId).authenticate(secret);
```

and:

```ts
const email = this.accessPayload.email as string;
const userId = this.users.idFromName(email);
await this.users.get(userId).authenticateFromCfAccess(email, signupsEnabled);
```

Remove active registry resolution, stable identity authority, and Access/Gatekeeper watchdogs. Do not yet delete unused source files; Task 8 performs cleanup after behavior is green.

Keep the existing Clerk/logout contracts and isolated implementation temporarily so intermediate commits remain buildable. Task 8 removes them atomically after all replacement paths are green.

- [ ] **Step 7: Run focused backend and integration tests**

Run:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/access.test.ts \
  __tests__/login-flow.test.ts \
  __tests__/stable-user-identity.test.ts
pnpm --filter @gadgets/integration-tests exec vitest run __tests__/gatekeeper-signin.test.ts
```

Expected: pass with Access/Gatekeeper email-keyed routes; temporary Clerk/Telegram compatibility paths may still use the registry until Tasks 7–8.

- [ ] **Step 8: Run affected source builds**

Run:

```bash
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build:worker
```

Expected: pass with temporary compatibility contracts still present.

- [ ] **Step 9: Commit**

```bash
git add packages/workshop-backend/src/access.ts \
  packages/workshop-backend/src/auth/login-flow.ts \
  packages/workshop-backend/src/user.ts \
  packages/workshop-backend/src/server.ts \
  packages/workshop-backend/__tests__/access.test.ts \
  packages/workshop-backend/__tests__/login-flow.test.ts \
  packages/workshop-backend/__tests__/stable-user-identity.test.ts \
  packages/integration-tests
git commit -m "fix: restore upstream email-keyed authentication"
```

### Task 4: Restore Upstream Auth Configuration, Session, and Admin Semantics

**Files:**
- Modify: `packages/workshop-backend/__tests__/auth-readiness.test.ts`
- Modify: `packages/workshop-backend/__tests__/deployment-config.test.ts`
- Modify: `packages/workshop-backend/__tests__/admin-authority.test.ts`
- Modify or replace: `packages/workshop-backend/__integration__/access-retained-authority.test.ts`
- Modify: `packages/workshop-backend/src/deployment-config.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Modify: `packages/workshop-backend/src/admin-settings.ts`
- Modify: `packages/workshop-backend/src/analytics.ts`
- Modify: `packages/workshop-backend/src/observability.ts`

- [ ] **Step 1: Write failing upstream-parity tests**

Cover:

- sign-in options expose no `configured` field;
- password availability depends only on `DISABLE_PASSWORD_AUTH` and whether the raw auth allowlist is nonempty, including unbound/unconfigured/failing vendors;
- `startGatekeeperLogin()` never calls connector-readiness assertion;
- established Access capability is not locally aborted at JWT expiry;
- Gatekeeper local token has no fork absolute deadline/logout endpoint;
- admin check is exact case-sensitive `ADMINS.includes(userId.name)`;
- no trim/canonicalization or profile lookup affects admin status;
- JSON string arrays parse and non-array `ADMINS` fails.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/auth-readiness.test.ts \
  __tests__/deployment-config.test.ts \
  __tests__/admin-authority.test.ts
pnpm --filter @gadgets/workshop-backend exec vitest run \
  --config vitest.integration.config.ts \
  __integration__/access-retained-authority.test.ts
```

Expected: FAIL against fork readiness/watchdog/admin behavior.

- [ ] **Step 3: Port upstream deployment/auth presentation behavior**

Remove Clerk publishable key and auth readiness from sign-in discovery while retaining connector readiness/configuration for admin and connector flows. Preserve language, billing, Telegram, and user-funded AI fields.

- [ ] **Step 4: Port upstream admin and telemetry identity behavior**

Remove registry revalidation and canonical email admin logic. Adapt mixed-purpose files surgically; preserve connector control-plane, admin bootstrap, localization, and telemetry events not present upstream.

- [ ] **Step 5: Run focused tests**

Run the commands from Step 2.

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-backend/src/deployment-config.ts \
  packages/workshop-backend/src/server.ts \
  packages/workshop-backend/src/admin-settings.ts \
  packages/workshop-backend/src/analytics.ts \
  packages/workshop-backend/src/observability.ts \
  packages/workshop-backend/__tests__/auth-readiness.test.ts \
  packages/workshop-backend/__tests__/deployment-config.test.ts \
  packages/workshop-backend/__tests__/admin-authority.test.ts \
  packages/workshop-backend/__integration__/access-retained-authority.test.ts
git commit -m "refactor: match upstream auth policy semantics"
```

### Task 5: Restore Canonical Durable Object Route Persistence

**Files:**
- Modify: `packages/workshop-backend/src/server.ts`
- Modify: `packages/workshop-backend/src/user.ts`
- Modify: `packages/workshop-backend/src/admin-settings.ts`
- Modify: `packages/workshop-backend/src/overseer.ts`
- Modify: `packages/workshop-backend/__tests__/stable-user-identity.test.ts`
- Modify: `packages/workshop-backend/__tests__/overseer-sharing-policy.test.ts`
- Add or modify: focused user-funded billing/workspace tests near existing coverage

- [ ] **Step 1: Write failing pre-registry workspace recovery tests**

Seed an email-keyed user with a pre-registry workspace whose owner/client routes use `userId.toString()`. Verify the authenticated user can:

- list the workspace;
- open and edit it;
- use the existing model/provider billing route;
- share it;
- create a new workspace with the same canonical route representation.

Also assert presentation IDs remain email/username:

```ts
expect(profile.id).toBe("owner@example.com");
expect(workspaceOwnerRoute).toBe(userId.toString());
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/stable-user-identity.test.ts \
  __tests__/overseer-sharing-policy.test.ts
```

Expected: FAIL where the fork stores route names/random internal names instead of canonical DO ID strings.

- [ ] **Step 3: Port upstream route-reference behavior surgically**

Use `userId.toString()` for persisted owner/client/callback/billing routes and `idFromString()` for reconstruction where upstream does. Audit owner, client, initiator, blueprint owner, output index, callback, and user-funded billing paths. Do not convert `AiChatAuthorInfo.id`, collaborator `profile.id`, or chat-author snapshots; those remain email/username presentation IDs.

- [ ] **Step 4: Restore direct sharing discovery**

Replace registry email lookup with upstream `UserDurableObject.idFromName(input)` probing. Keep sharing authorization hardening and localized UI behavior.

- [ ] **Step 5: Run focused and related tests**

Run:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/stable-user-identity.test.ts \
  __tests__/overseer-sharing-policy.test.ts \
  __tests__/cloudflare-billing-user.test.ts
```

Expected: all pass; recovered and new workspaces use canonical DO ID strings.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-backend/src/server.ts \
  packages/workshop-backend/src/user.ts \
  packages/workshop-backend/src/admin-settings.ts \
  packages/workshop-backend/src/overseer.ts \
  packages/workshop-backend/__tests__
git commit -m "fix: restore upstream durable object route references"
```

### Task 6: Add the TelegramChannel-Owned Link Store

**Files:**
- Create: `packages/workshop-backend/src/telegram/link-store.ts`
- Create: `packages/workshop-backend/__tests__/telegram-link-store.test.ts`
- Modify: `packages/workshop-backend/src/telegram/channel.ts`
- Modify: `packages/workshop-backend/__tests__/telegram-channel.test.ts`

- [ ] **Step 1: Write failing link-store tests**

Define the focused contract:

```ts
class TelegramLinkStore {
  start(userDurableObjectId: string, now?: number): Promise<{ token: string; expiresAt: Date }>;
  complete(token: string, telegramUserId: string, operationKey: string, now?: number): Promise<string | null>;
  status(userDurableObjectId: string, now?: number): { connected: boolean };
  unlink(userDurableObjectId: string, now?: number): void;
  findUserDurableObjectId(telegramUserId: string): string | null;
  cleanup(now?: number, limit?: number): { nextAlarmAt: number | null };
  nextAlarmAt(): number | null;
}
```

Tests must cover token digest-only storage, ten-minute expiry, latest-only token, malformed tokens, one-to-one reverse mapping, atomic single use, replay, cross-user collision, concurrent completion with exactly one owner, idempotent same-operation retry, mismatched retry rejection, unlink, 24-hour receipt TTL, and maximum 100 cleanup records.

- [ ] **Step 2: Run the new test and verify failure**

Run:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/telegram-link-store.test.ts
```

Expected: FAIL because `link-store.ts` does not exist.

- [ ] **Step 3: Implement minimal durable link storage**

Reuse the token hashing/key strategy from `identity-registry.ts` without importing or calling the registry. Store only canonical User Durable Object ID strings supplied by authenticated backend code. Keep the module independent from Telegram API/network code.

- [ ] **Step 4: Keep the store unreferenced until routing is atomic**

Do not switch authenticated Telegram methods yet. The current registry-backed Telegram path remains functional at this commit; Task 7 wires link creation, completion, status, unlink, and message routing together.

- [ ] **Step 5: Run link-store tests**

Run:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/telegram-link-store.test.ts
```

Expected: all standalone link lifecycle tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-backend/src/telegram/link-store.ts \
  packages/workshop-backend/__tests__/telegram-link-store.test.ts
git commit -m "feat: move Telegram links into channel storage"
```

### Task 7: Route Telegram Messages Through Backend-Private User Authority

**Files:**
- Create: `packages/workshop-backend/src/external-message-routing.ts`
- Modify: `packages/workshop-backend/src/external-message-gateway.ts`
- Modify: `packages/workshop-backend/src/telegram/channel.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Modify: `packages/workshop-backend/src/overseer.ts`
- Modify: `packages/workshop-shared/src/external-message-gateway.ts`
- Modify: `packages/workshop-backend/__integration__/external-message-gateway.test.ts`
- Modify: `packages/workshop-backend/__tests__/telegram-channel.test.ts`
- Modify: `packages/workshop-backend/__tests__/telegram-store.test.ts`

- [ ] **Step 1: Write failing trust-boundary tests**

Prove:

- the argument-free authenticated API passes only its server-owned `userId.toString()` into TelegramChannel for link start/status/unlink;
- linked Telegram subject resolves to the stored User Durable Object ID;
- backend code reconstructs it with `idFromString()`;
- unlinked subject is rejected;
- trusted-email gateway still works;
- trusted-email callers, browser inputs, Telegram payload fields, and entrypoint props cannot select a User Durable Object ID;
- no shared input type contains `internalUserId`, `linkedExternalSubject`, or equivalent caller ID.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/telegram-channel.test.ts
pnpm --filter @gadgets/workshop-backend exec vitest run \
  --config vitest.integration.config.ts \
  __integration__/external-message-gateway.test.ts
```

Expected: FAIL because routing still resolves through `IdentityRegistry`.

- [ ] **Step 3: Extract backend-private delivery helper**

Create an ordinary TypeScript function that accepts a resolved User Durable Object ID/stub and normalized message data. Keep `DurableObjectId` inside ordinary backend code. Only a stub capability or canonical `userId.toString()` may cross the backend-private Overseer RPC boundary.

Representative boundary:

```ts
export async function submitExternalMessageForUser(
  ctx: ExecutionContext<Cloudflare.Env>,
  userId: DurableObjectId,
  source: string,
  input: ExternalMessageContent,
): Promise<SubmitExternalMessageResult>;
```

Do not export this through Cap'n Web or the shared package.

- [ ] **Step 4: Restore shared gateway to trusted-email identity**

Remove `linkedExternalSubject` and internal-ID variants from `packages/workshop-shared/src/external-message-gateway.ts`. Preserve attachments, `chatPath`, response target, and durable callback types. `ExternalMessageGateway` resolves trusted email to a User DO internally, then invokes the private helper.

- [ ] **Step 5: Switch the complete Telegram lifecycle atomically**

Change `AuthenticatedApiImpl` link start/status/unlink to pass its own server-owned `userId.toString()` to `TelegramChannel`, while preserving the public argument-free signatures. `TelegramChannel` completes links in the new store, finds the stored canonical ID for messages, reconstructs it through `UserDurableObject.idFromString()`, and invokes the private helper. Telegram usernames/profile data never participate in Workshop identity selection.

- [ ] **Step 6: Coordinate the single Telegram alarm**

Make `#scheduleAlarm()` choose the earliest deadline across message queue/retry/tombstone state and link token/receipt cleanup. Add separate interaction tests for queued-message, retry, and tombstone deadlines versus token/receipt cleanup; assert the earliest alarm is preserved and each category eventually processes.

- [ ] **Step 7: Run focused tests**

Run the commands from Step 2 plus:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/telegram-link-store.test.ts \
  __tests__/telegram-store.test.ts
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/workshop-backend/src/external-message-routing.ts \
  packages/workshop-backend/src/external-message-gateway.ts \
  packages/workshop-backend/src/telegram/channel.ts \
  packages/workshop-backend/src/server.ts \
  packages/workshop-backend/src/overseer.ts \
  packages/workshop-shared/src/external-message-gateway.ts \
  packages/workshop-backend/__integration__/external-message-gateway.test.ts \
  packages/workshop-backend/__tests__/telegram-channel.test.ts \
  packages/workshop-backend/__tests__/telegram-store.test.ts
git commit -m "refactor: route Telegram without the identity registry"
```

### Task 8: Remove Clerk and Fork-Only Active Identity Machinery

**Files:**
- Delete: `packages/workshop-backend/src/clerk-auth.ts`
- Delete: `packages/workshop-backend/src/clerk-session.ts`
- Delete: `packages/workshop-backend/src/testing/clerk-test-server.ts`
- Delete: `packages/workshop-backend/src/identity-authority.ts`
- Delete: `packages/workshop-backend/src/absolute-deadline.ts`
- Delete: `packages/workshop-backend/src/gatekeeper-session-logout.ts`
- Delete Clerk/authority tests listed below
- Create: `scripts/auth-source-scope.test.ts`
- Modify: `packages/workshop-backend/package.json`
- Modify: `packages/workshop-backend/src/env.d.ts`
- Modify: `scripts/dev-server-config.ts`
- Modify: `scripts/dev-server-config.test.ts`
- Modify: `scripts/release/manifest-lib.test.ts`
- Modify: `pnpm-lock.yaml`
- Retain: `packages/workshop-backend/src/identity-registry.ts` and focused tests

- [ ] **Step 1: Add failing static scope checks**

In existing script/config tests, assert:

- no `CLERK_*` forwarding/config;
- release manifest contains no Clerk binding/config;
- shared `PublicApi` has no Clerk RPC;
- providers and the test Gatekeeper no longer expose `getAuthenticationIdentity()`;
- no active source imports registry/identity-authority/session helpers;
- the only permitted Clerk-labelled source exception is `identity-registry.ts` and its compatibility tests;
- `IdentityRegistry` remains exported and migration `v3`/`v4` remains unchanged.

- [ ] **Step 2: Run static/config tests and verify failure**

Run:

```bash
node --test scripts/auth-source-scope.test.ts scripts/dev-server-config.test.ts scripts/release/manifest-lib.test.ts
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/deployment-config.test.ts \
  __tests__/identity-registry.test.ts
```

Expected: FAIL while Clerk/config/session files remain.

Implement `scripts/auth-source-scope.test.ts` as a recursive production-source scan with an explicit allowlist for `identity-registry.ts`, its compatibility tests, the `server.ts` class export, generated type, migration config, and release golden. Match registry imports/bindings/identifiers/method names and Clerk/authority/session machinery; fail on every non-allowlisted occurrence.

- [ ] **Step 3: Remove shared/provider compatibility contracts and delete obsolete implementations/tests**

Atomically remove `GatekeeperAuthenticationIdentity`/`getAuthenticationIdentity()` from shared types, providers, and the test fixture. Remove Clerk/logout RPCs from `packages/workshop-shared/src/api.ts` and `PublicApiImpl` at the same time as their implementation files/tests so the commit remains buildable.

Delete:

```text
packages/workshop-backend/__integration__/clerk-auth.test.ts
packages/workshop-backend/__integration__/stable-user-identity.test.ts
packages/workshop-backend/__tests__/absolute-deadline.test.ts
packages/workshop-backend/__tests__/access-session.test.ts
packages/workshop-backend/__tests__/clerk-auth.test.ts
packages/workshop-backend/__tests__/clerk-session.test.ts
packages/workshop-backend/__tests__/identity-authority.test.ts
packages/workshop-backend/__tests__/server-gatekeeper-session.test.ts
packages/workshop-backend/__tests__/server-identity-authority.test.ts
packages/integration-tests/__tests__/clerk-session.test.ts
```

Retain/rewrite tests that now verify upstream behavior rather than deleting useful coverage.

- [ ] **Step 4: Remove Clerk dependency/config and regenerate the lockfile locally**

Remove `@clerk/backend`, `CLERK_*` environment types, dev forwarding, and manifest assertions. Then run:

```bash
pnpm install --offline --lockfile-only --ignore-scripts
```

Expected: only Clerk importer/transitive entries disappear; X and Telegram dependencies remain.

- [ ] **Step 5: Prove no active callers remain**

Run:

```bash
node --test scripts/auth-source-scope.test.ts
rg -n 'IdentityRegistry|IDENTITY_REGISTRY|identity-registry|getAuthenticationIdentity|resolveClerkIdentity|resolveAccessIdentity|resolveGatekeeperIdentity|findInternalUserIdByExternalSubject|identity-authority|clerk-auth|clerk-session|gatekeeper-session-logout|linkedExternalSubject' \
  packages/workshop-backend/src packages/workshop-shared/src packages/gatekeeper-*/src
```

Expected: the automated allowlist test passes; manual output is limited to the compatibility source/class export and documented exceptions.

- [ ] **Step 6: Run config, compatibility, provider, and source builds**

Run the commands from Step 2, then:

```bash
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build:worker
pnpm --filter @gadgets/cloudflare-gatekeeper test:run
pnpm --filter @gadgets/google-gatekeeper test:run
pnpm --filter @gadgets/github-gatekeeper test:run
```

Expected: pass; compatibility tests remain green and the atomic contract removal leaves every consumer buildable.

- [ ] **Step 7: Commit**

```bash
git add -A packages/workshop-backend packages/workshop-shared \
  packages/integration-tests scripts pnpm-lock.yaml
git commit -m "refactor: remove Clerk and active identity registry machinery"
```

### Task 9: Update Frontend Wording, Documentation, and Generated Artifacts

**Files:**
- Modify: `packages/workshop-frontend/src/ShareModal.tsx`
- Modify: `packages/workshop-frontend/src/ShareModal.test.tsx`
- Modify: `docs/public-server.md`
- Modify: `docs/oauth-signin.md`
- Modify: `docs/superpowers/plans/2026-08-31-telegram-integration.md`
- Modify: `docs/superpowers/specs/2026-08-31-telegram-integration-design.md`
- Delete: `docs/superpowers/plans/2026-08-13-clerk-authentication.md`
- Delete: `docs/superpowers/specs/2026-08-13-clerk-authentication-design.md`
- Modify: `AGENTS.md`
- Modify/regenerate: `packages/workshop-backend/worker-configuration.d.ts`
- Modify/regenerate: `scripts/release/testdata/golden-manifest.json`

- [ ] **Step 1: Write/update frontend sharing tests**

Assert the input accepts upstream username/email account keys, while preserving localization and IME behavior. Remove stable-internal-ID wording.

- [ ] **Step 2: Run the frontend test and verify failure**

Run:

```bash
pnpm --filter @gadgets/workshop-frontend exec vitest run src/ShareModal.test.tsx
```

Expected: FAIL until wording/behavior returns to direct account lookup.

- [ ] **Step 3: Update docs and repository guidance**

Document upstream email-/username-keyed identity, TelegramChannel-owned links, phase-1 registry compatibility, and no Clerk support. Keep non-auth feature documentation. Remove claims that Gatekeepers authenticate with stable provider subjects or that a registry internal ID is the universal user key.

- [ ] **Step 4: Regenerate Worker types and release golden**

Run:

```bash
pnpm types:generate
UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts
```

Expected: `IdentityRegistry` class/migration compatibility remains; Clerk variables/types disappear; Telegram/X remain.

- [ ] **Step 5: Run focused tests and static searches**

Run:

```bash
pnpm --filter @gadgets/workshop-frontend exec vitest run src/ShareModal.test.tsx
node --test scripts/release/manifest-lib.test.ts
rg -n -i 'Clerk|stable internal user|stable provider subject' AGENTS.md docs packages scripts \
  -g '!packages/workshop-backend/src/identity-registry.ts' \
  -g '!packages/workshop-backend/{__tests__,__integration__}/identity-registry.test.ts' \
  -g '!docs/superpowers/specs/2026-09-01-restore-upstream-auth-design.md' \
  -g '!docs/superpowers/plans/2026-09-01-restore-upstream-auth.md'
```

Expected: no active stale claims; historical compatibility exceptions are explicit.

- [ ] **Step 6: Commit**

```bash
git add -A AGENTS.md docs packages/workshop-frontend \
  packages/workshop-backend/worker-configuration.d.ts \
  scripts/release/testdata/golden-manifest.json
git commit -m "docs: align identity guidance with upstream auth"
```

### Task 10: Full Verification and Review

**Files:**
- Verify all changed files; no feature work.

- [ ] **Step 1: Run auth and Telegram focused suites**

Run:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/access.test.ts \
  __tests__/login-flow.test.ts \
  __tests__/admin-authority.test.ts \
  __tests__/auth-readiness.test.ts \
  __tests__/deployment-config.test.ts \
  __tests__/stable-user-identity.test.ts \
  __tests__/overseer-sharing-policy.test.ts \
  __tests__/identity-registry.test.ts \
  __tests__/telegram-link-store.test.ts \
  __tests__/telegram-channel.test.ts \
  __tests__/telegram-store.test.ts
pnpm --filter @gadgets/workshop-backend test:integration
pnpm --filter @gadgets/integration-tests test:run
```

Expected: all pass.

- [ ] **Step 2: Run every affected package suite**

Run:

```bash
pnpm --filter @gadgets/cloudflare-gatekeeper test:run
pnpm --filter @gadgets/google-gatekeeper test:run
pnpm --filter @gadgets/github-gatekeeper test:run
pnpm --filter @gadgets/workshop-frontend test:run
pnpm --filter @gadgets/workshop-backend test:run
```

Expected: all pass.

- [ ] **Step 3: Run repository verification**

Run in background terminals as appropriate:

```bash
pnpm test
pnpm lint
pnpm build
```

Expected: all exit 0.

- [ ] **Step 4: Verify migration and feature preservation**

Run:

```bash
git diff origin/main -- packages/workshop-backend/wrangler.jsonc
rg -n 'IdentityRegistry|TelegramChannel' packages/workshop-backend/wrangler.jsonc \
  packages/workshop-backend/src/server.ts \
  packages/workshop-backend/worker-configuration.d.ts \
  scripts/release/testdata/golden-manifest.json
rg -n 'gatekeeper-x|telegram|REQUIRE_USER_FUNDED_AI' package.json packages scripts
```

Expected: no migration deletion/change; compatibility export remains; X, Telegram, and user-funded AI remain represented.

- [ ] **Step 5: Inspect the complete diff**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
```

Expected: no whitespace errors or uncommitted generated artifacts.

- [ ] **Step 6: Request independent code and security review**

Dispatch reviewers from separate worktrees. Require exact file/line findings and explicit verification of:

- no untrusted identity input;
- legacy profile/workspace route recovery;
- exact upstream MVP auth semantics;
- no active registry caller;
- no destructive Durable Object migration;
- non-auth feature preservation.

- [ ] **Step 7: Fix findings with TDD and rerun affected/full checks**

Expected: reviewers return PASS/approved and fresh verification remains green.

- [ ] **Step 8: Commit final verification-only corrections if needed**

```bash
git add -A
git commit -m "test: verify upstream auth restoration"
```

Skip this commit if there are no corrections.

- [ ] **Step 9: Prepare the runtime PR**

Use `git-pull-request`. State that phase 1 retains the historical `IdentityRegistry` class/migration but has no active caller. Do not deploy or update the starter pin yet.

---

## Downstream Staging Gate

After the runtime PR is reviewed and merged, create a separate starter/deployment worktree and plan. Before any mutation:

1. Pin the reviewed runtime commit.
2. Run starter tests, builds, type checks, release-manifest validation, and deployment dry-runs.
3. Capture live Workshop version, bindings, Access configuration, and migration state.
4. Prove from active Worker settings and deployment artifacts that Telegram has never been configured; otherwise stop for the separate aggregate inspection design/approval.
5. Present the exact Worker mutations and request explicit approval.
6. Deploy only vlightup staging.
7. Verify the original profile, onboarding completion, preferred model, provider configuration, model list, recovered workspaces, billing path, and sharing.
8. Confirm no random identity/new onboarding is created.
9. Retain the exact phase-1 Worker artifact/version as the supported rollback baseline before users resume writes.
10. Document that rollback to the registry-routing build is forbidden after writes resume on the recovered email-keyed account.

No phase-2 `deleted_classes` migration belongs in this implementation.
