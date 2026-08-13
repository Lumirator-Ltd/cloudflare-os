# Clerk Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace built-in password authentication with Clerk email/password and Google while retaining Gatekeeper and Cloudflare Access sign-in, converging all verified identities on stable internal users, and shipping CI/local verification plus automatic PR merge.

**Architecture:** A singleton Identity Registry Durable Object atomically maps Clerk subjects and canonical verified emails to random stable internal user IDs. Clerk tokens are verified by the Worker and authenticate a revocable Cap'n Web session whose descendants share one identity-version guard; Gatekeeper and Access flows resolve the same registry by verified email. The React SPA receives the Clerk publishable key at runtime, renders Clerk within the existing unified login surface, and never persists Clerk tokens locally.

**Tech Stack:** TypeScript, Cloudflare Workers/Durable Objects, Cap'n Web, Clerk React/current backend SDK, React 19, Vite, Vitest/Workers pool, Playwright/browser verification, pnpm, Wrangler/workerd, GitHub Actions/CLI.

**Design spec:** `docs/superpowers/specs/2026-08-13-clerk-authentication-design.md`

---

## File structure and boundaries

- `packages/workshop-backend/src/identity-registry.ts`: identity canonicalization, indexes, collision state, versions, and active-session invalidation subscribers only.
- `packages/workshop-backend/src/clerk-auth.ts`: Clerk configuration, token verification, Backend API profile loading, exact-origin checks, and verified-identity result.
- `packages/workshop-backend/src/clerk-session.ts`: whole-WebSocket Clerk token deadline, refresh timer replacement, registry subscriber registration, and abort lifecycle.
- `packages/workshop-backend/src/server.ts`: compose auth mechanisms into `AuthenticatedApi`; keep orchestration thin.
- `packages/workshop-backend/src/user.ts`: stable internal user initialization and retained Gatekeeper local sessions; remove password storage/methods.
- `packages/workshop-shared/src/api.ts`: minimal documented RPC/config changes only.
- `packages/workshop-frontend/src/ClerkAuthProvider.tsx`: runtime Clerk initialization boundary.
- `packages/workshop-frontend/src/useAuth.ts`: Clerk token/lease refresh plus retained local Gatekeeper and Access paths.
- `packages/workshop-frontend/src/LoginPage.tsx`: unified Clerk/Gatekeeper surface.
- `scripts/release/*`: deployment manifest inputs/placeholders and golden coverage.
- `.github/workflows/ci.yml`: separate build, unit, and integration checks.
- `AGENTS.md`: repository-local autonomous delivery rules requested by the user.

Keep commits reviewable by concern. Shared API/backend kernel commits must not be mixed with frontend visual work or release/CI changes.

### Task 1: Record autonomous delivery workflow and split CI checks

**Files:**
- Modify: `AGENTS.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `packages/workshop-backend/package.json`
- Create: `scripts/run-unit-tests.mjs`
- Create: `scripts/run-integration-tests.mjs`
- Create: `scripts/ci-test-scripts.test.js`
- Test: `.github/workflows/ci.yml`

- [ ] **Step 1: Add failing script-contract tests**

Add a root script test that asserts `test:unit` excludes `packages/workshop-backend/__integration__` and `test:integration` executes backend/integration packages explicitly.

- [ ] **Step 2: Run the script test and verify failure**

Run: `node --test scripts/ci-test-scripts.test.js`  
Expected: FAIL because split scripts do not exist.

- [ ] **Step 3: Add exact unit/integration runners and root scripts**

Add backend `test:unit` as `node build-browser-runtime.mjs && node scripts/build-format-blueprints.mjs && vitest run`; change backend `test` to `pnpm test:unit && pnpm test:integration`. Root `test:unit` runs root Node tests and `pnpm --recursive --if-present --filter '!@gadgets/integration-tests' --filter '!@gadgets/workshop-backend' test`, then backend `test:unit`. Root `test:integration` runs backend `test:integration` and `pnpm --filter @gadgets/integration-tests test`. The runners execute these exact commands with inherited stdio and fail on the first non-zero exit.

- [ ] **Step 4: Split GitHub Actions jobs**

Keep `Lint`; add independently visible `Build`, `Unit tests`, and `Integration tests` jobs, all using frozen pnpm installs and pinned Node. Do not require Clerk secrets for hermetic tests; tests use local fakes/fixtures.

- [ ] **Step 5: Add repository workflow instructions**

Append a clearly marked section to `AGENTS.md`: feature branch only; TDD; commit each small concern; run unit/integration/build/lint; create PR to `main`; enable GitHub auto-merge without asking once CI passes; never bypass failed checks or force-push; report blockers if repository settings prevent auto-merge.

- [ ] **Step 6: Verify CI files and scripts**

Run: `node --test scripts/ci-test-scripts.test.js && pnpm test:unit && pnpm test:integration`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md .github/workflows/ci.yml package.json packages/workshop-backend/package.json scripts/ci-test-scripts.test.js scripts/run-unit-tests.mjs scripts/run-integration-tests.mjs
git commit -m "ci: split unit and integration checks"
```

### Task 2: Add identity registry model

**Files:**
- Create: `packages/workshop-backend/src/identity-registry.ts`
- Create: `packages/workshop-backend/__tests__/identity-registry.test.ts`
- Create: `packages/workshop-backend/__integration__/identity-registry.test.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Modify: `packages/workshop-backend/src/user.ts`
- Modify: `packages/workshop-backend/src/env.d.ts`
- Modify: `packages/workshop-backend/wrangler.jsonc`

- [ ] **Step 1: Write failing canonicalization and resolution tests**

Cover trim/lowercase only, first creation, subject-first Clerk resolution, verified-email convergence, disabled signup, concurrent first sign-in, and idempotent initialization retry.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/identity-registry.test.ts`  
Expected: FAIL because `IdentityRegistry` is missing.

- [ ] **Step 3: Implement minimal registry storage, API, and user initialization**

Use typed storage/SQLite state in one singleton DO. Export and document all externally visible members. Generate random opaque internal IDs. Keep index mutation atomic inside the registry only. Add `UserDurableObject.initializeIdentity(internalUserId, verifiedEmail)` now: it is idempotent, never overwrites a customized display name, and contains no password state. Registry mapping survives an initialization failure; authentication returns no capability until a retry succeeds.

- [ ] **Step 4: Add collision/version tests**

Test successful Clerk email move, stale alias removal, other user's mapping untouched, `collisionLocked`, subject retention, denied auth, and monotonic versions.

- [ ] **Step 5: Implement collision/version behavior**

Add `active | collisionLocked`, canonical email, version, and verified resolution result types. Do not add recovery RPCs.

- [ ] **Step 6: Add DO migration/export and integration tests**

Add the next Wrangler migration tag and prove the registry resolves serial concurrent requests and survives DO restart with durable indexes.

- [ ] **Step 7: Run backend tests/typecheck**

Run: `pnpm --filter @gadgets/workshop-backend test && pnpm --filter @gadgets/workshop-backend types:check`  
Expected: PASS.

- [ ] **Step 8: Commit registry and initialization separately**

```bash
git add packages/workshop-backend/src/identity-registry.ts packages/workshop-backend/src/user.ts packages/workshop-backend/__tests__/identity-registry.test.ts packages/workshop-backend/__integration__/identity-registry.test.ts packages/workshop-backend/src/server.ts packages/workshop-backend/src/env.d.ts packages/workshop-backend/wrangler.jsonc
git commit -m "feat: add stable identity registry"
pnpm --filter @gadgets/workshop-backend types:check
```

### Task 3: Move human application identity to stable internal IDs

**Files:**
- Modify: `packages/workshop-backend/src/user.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Modify: `packages/workshop-backend/src/overseer.ts`
- Modify: `packages/workshop-backend/src/sharing.ts`
- Modify: `packages/workshop-backend/src/ai-models.ts`
- Modify: `packages/workshop-backend/src/analytics.ts`
- Audit frontend human-ID consumers in `packages/workshop-frontend/src/ChatInterface.tsx`, `components/Avatar.tsx`, `components/PersonAvatar.tsx`, `avatarUtils.ts`, `ShareModal.tsx:197-213,560-570,807-808,954-968`, and profile/workspace routes; code changes only where they display/parse a stable ID as an email
- Modify: `packages/workshop-shared/src/api.ts`
- Test: `packages/workshop-backend/__tests__/sharing.test.ts`
- Create: `packages/workshop-backend/__tests__/stable-user-identity.test.ts`

- [ ] **Step 1: Write failing stable-ID regression tests**

Assert human `AiChatAuthorInfo.id`, collaborator graph entries, cached owner profiles, avatars, blueprint ownership, presence, output indexes, profile routes, analytics identity, and Gatekeeper Workshop-user context use the internal ID. Assert sharing discovery accepts email but persists only resolved ID.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/stable-user-identity.test.ts __tests__/sharing.test.ts`  
Expected: FAIL on current email/DO-name semantics.

- [ ] **Step 3: Convert user/profile and direct routing identity**

Update `user.ts:189-193` profile initialization, `server.ts:218-219` open-workspace identity, Gatekeeper props at `user.ts:1129-1131`, and all auth routing to use `idFromName(internalUserId)` as required by the spec rather than `idFromName(email)`. Persist/pass the opaque `internalUserId` for every human owner, collaborator, blueprint owner, and profile reference; derive the User Durable Object route with `idFromName(internalUserId)` at lookup time. Never persist `DurableObjectId.toString()` as a human identity. Serialized DO IDs remain only where the referenced entity is itself a non-human DO such as an Overseer/workspace. Keep model IDs (`user.ts:155,527`) unchanged because they are agent/model identities.

- [ ] **Step 4: Convert sharing and collaborator references**

Update `sharing.ts:87,128-130,250-316,451,549-552`, `overseer.ts:319-321,889-890,1014-1015,5973-5995,6244-6246`, share-link creator IDs, collaborator removal/retention, and shared-workspace cached owner profiles. Email is accepted only at the discovery boundary and resolved through Identity Registry before persistence.

- [ ] **Step 5: Convert workspace, blueprint, output, avatar, presence, and analytics references**

Update `server.ts:267,287,409,418,540`, `user.ts:813,971,1130`, `overseer.ts:1919,3495,3562,5459,5678-5682,5994,6361-6362,7343,7470,8337,8651-8653,9101,9288,9356`, avatar KV keys/API docs, blueprint owner IDs, output/presence indexes, and analytics source unions. Preserve workspace/Overseer DO IDs (`ctx.id.toString()`) where they identify workspaces rather than humans. Update frontend/tests only where they parse human IDs as email.

- [ ] **Step 6: Run backend and shared checks**

Run: `pnpm --filter @gadgets/workshop-backend test && pnpm --filter @gadgets/workshop-backend types:check && pnpm --filter @gadgets/workshop-shared types:check`  
Expected: PASS.

- [ ] **Step 7: Commit by kernel concern**

```bash
git add packages/workshop-backend/src/user.ts packages/workshop-backend/src/server.ts packages/workshop-backend/__tests__/stable-user-identity.test.ts packages/workshop-shared/src/api.ts
git commit -m "refactor: use stable profile identities"
git add packages/workshop-backend/src/sharing.ts packages/workshop-backend/src/overseer.ts packages/workshop-backend/__tests__/sharing.test.ts
git commit -m "refactor: stabilize sharing identities"
git add packages/workshop-backend/src/ai-models.ts packages/workshop-backend/src/analytics.ts packages/workshop-backend/src/overseer.ts packages/workshop-backend/src/user.ts packages/workshop-frontend/src
git commit -m "refactor: stabilize user reference indexes"
```

### Task 4: Add Clerk backend verification

**Files:**
- Modify: `packages/workshop-backend/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/workshop-backend/src/clerk-auth.ts`
- Modify: `packages/workshop-shared/src/api.ts`
- Modify: `packages/workshop-backend/src/deployment-config.ts`
- Create: `packages/workshop-backend/__tests__/clerk-auth.test.ts`
- Create: `packages/workshop-backend/__integration__/clerk-auth.test.ts`
- Modify: `packages/workshop-backend/src/env.d.ts`
- Modify: `run-dev-server.js`

- [ ] **Step 1: Audit and add current Clerk packages**

Follow the external-code audit skill before installing. Add current `@clerk/backend`; inspect package scripts and lockfile diff before executing installation lifecycle scripts.

- [ ] **Step 2: Write failing unit and JWKS integration tests before implementation**

Unit tests cover issuer derived from publishable key, exact `PUBLIC_BASE_URL` authorized party, local-only `CLERK_DEV_AUTHORIZED_PARTIES`, optional exact audience, missing config, missing/unverified primary email, no token/profile logging, and `ServerConfig.clerkPublishableKey` present only in normal Clerk mode (undefined in Access mode). Integration tests start a local JWKS fixture and cover valid JWT plus expiry/not-before/signature/issuer/audience/`azp` rejection.

- [ ] **Step 3: Run both focused test sets and verify failure**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/clerk-auth.test.ts && pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.integration.config.ts __integration__/clerk-auth.test.ts`  
Expected: FAIL because verifier is missing.

- [ ] **Step 4: Implement Clerk verifier**

Use Clerk backend SDK APIs; inject/fake SDK boundaries in tests. Load the primary email through trusted backend data and require verified status. Return only bounded provider subject/email/token-expiry data. Add the documented optional `ServerConfig.clerkPublishableKey` and serve it from backend runtime env outside Access mode so the later frontend commit independently type-checks; do not add release/deploy inputs yet. Make both RED suites pass.

- [ ] **Step 5: Pass local Clerk vars through dev config**

Allow `.dev.vars` values without writing them into tracked configs or logs. Change local backend config generation so environment-provided `ADMINS` (JSON array string or existing array) is preserved; use `["admin"]` only when `ADMINS` is unset. Add a focused config-generation test proving the E2E verified-email admin survives into generated Wrangler vars.

- [ ] **Step 6: Run package checks**

Run: `pnpm --filter @gadgets/workshop-backend test && pnpm --filter @gadgets/workshop-backend types:check`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/workshop-backend/package.json pnpm-lock.yaml packages/workshop-shared/src/api.ts packages/workshop-backend/src/clerk-auth.ts packages/workshop-backend/src/deployment-config.ts packages/workshop-backend/__tests__/clerk-auth.test.ts packages/workshop-backend/__integration__/clerk-auth.test.ts packages/workshop-backend/src/env.d.ts run-dev-server.js
git commit -m "feat: verify Clerk identities"
```

### Task 5: Add hard-expiring Clerk WebSocket sessions

**Files:**
- Create: `packages/workshop-backend/src/clerk-session.ts`
- Create: `packages/workshop-backend/__tests__/clerk-session.test.ts`
- Create: `packages/integration-tests/__tests__/clerk-session.test.ts`
- Modify: `packages/integration-tests/src/harness.ts`
- Modify: `packages/integration-tests/fixtures/gatekeeper-test/*` for configurator/app UI and session fixture capabilities
- Modify: `packages/workshop-backend/src/server.ts`
- Modify: `packages/workshop-backend/src/identity-registry.ts`
- Modify: `packages/workshop-shared/src/api.ts`

**Capability graph to test:** `AuthenticatedApi` returns `Overseer`, connected-account subscription, `ResourceConfiguratorFrame`, `GatekeeperUiFrame`, and `AdminApi`; `Overseer` returns metadata/presence/workpiece/code/action/chat/log subscriptions, `GadgetClient`, and `GatekeeperClient`; `GadgetClient` returns a dynamic-Worker gadget stub and `GatekeeperClient`; `GatekeeperClient.openSession()` returns a session; UI frames contain nested UI RPC stubs. All are invalidated together by disposing the Cap'n Web WebSocket session, not wrapped individually.

- [ ] **Step 1: Write all lease, descendant, and two-session integration tests before implementation**

Use fake timers and real Cap'n Web WebSockets. Cover hard close exactly at accepted token `exp`; successful refresh replacing—not extending beyond—the new verified `exp`; refresh 15-second client contract; invalid subject/user/version/status refresh; explicit logout; eager registry broadcast; two active sessions where one retains `AdminApi`/`Overseer` and the other changes email; and missed broadcast after registry restart. In the missed-broadcast case, directly invoke retained `AdminApi`, `Overseer`, `GadgetClient`, `GatekeeperClient`, opened session, subscription, and UI-frame child before and after expiry: before expiry remains valid by design, after expiry every stub fails because the whole WebSocket was disposed; stale refresh fails.

- [ ] **Step 2: Run unit and integration RED tests**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/clerk-session.test.ts && pnpm --filter @gadgets/integration-tests exec vitest run __tests__/clerk-session.test.ts`  
Expected: FAIL because Clerk session lifecycle is missing.

- [ ] **Step 3: Add exact RPC session-control contract**

Add these documented public API members:

```ts
export interface ClerkSessionControl extends RpcTarget {
  refresh(token: string): Promise<Date>;
  logout(): Promise<void>;
}

export type ClerkAuthentication = {
  api: RpcStub<AuthenticatedApi>;
  session: RpcStub<ClerkSessionControl>;
  expiresAt: Date;
};

export interface PublicApi extends RpcTarget {
  authenticateWithClerk(token: string): Promise<ClerkAuthentication>;
}
```

`PublicApiImpl` creates one private `ClerkSessionState` owned by the current WebSocket's abort controller. `api` and `session` share that state. `refresh()` is callable only through that same returned session capability, fully verifies the replacement token/subject/internal user/version, atomically replaces the timer, and returns the new verified expiry for client scheduling. `logout()` aborts the whole WebSocket before resolving; the client treats expected connection disposal as successful logout. Disposing only the `session` stub does not authenticate/revoke the user; explicit `logout()` or whole WebSocket close does. Preserve promise pipelining and keep retained `authenticate()` for Gatekeeper local tokens and `authenticateFromCfAccess()`.

- [ ] **Step 4: Implement non-extendable session expiry timer**

At successful Clerk auth, install a Worker timer/abort controller for verified `exp`. On expiry call the existing `abortSession`, which disposes the Cap'n Web session and all local/remote descendant stubs. A refresh completes full token verification and registry version/status resolution before atomically cancelling the old timer and installing the exact new deadline. Failure aborts immediately; no per-descendant wrapper is required.

- [ ] **Step 5: Implement eager registry broadcasts**

Register/unregister abort callbacks for currently live sessions. Email/status change broadcasts eagerly. Treat subscriber loss as acceptable only because the hard token deadline and refresh revalidation are authoritative.

- [ ] **Step 6: Make complete capability-graph tests pass**

Enhance `integration-tests/src/harness.ts` to patch Workshop Clerk/Access vars and bind the fixture Gatekeeper. Extend the fixture vendor/account/Gatekeeper to expose real configurator frame, app UI frame, and session methods. Use the integration harness's real cross-worker paths from `AuthenticatedApiImpl`, `Overseer`, `GadgetClient` (dynamic gadget), and `GatekeeperClient`, not representative mock wrappers. Confirm nested dynamic-Worker/session/UI stubs fail when the parent WebSocket closes.

- [ ] **Step 7: Run backend integration/type checks**

Run: `pnpm --filter @gadgets/workshop-backend test && pnpm --filter @gadgets/workshop-backend types:check`  
Expected: PASS.

- [ ] **Step 8: Commit by lifecycle concern**

```bash
git add packages/workshop-shared/src/api.ts packages/workshop-backend/src/clerk-session.ts packages/workshop-backend/src/server.ts packages/workshop-backend/__tests__/clerk-session.test.ts
git commit -m "feat: expire Clerk RPC sessions"
git add packages/workshop-backend/src/identity-registry.ts packages/integration-tests/src/harness.ts packages/integration-tests/fixtures/gatekeeper-test packages/integration-tests/__tests__/clerk-session.test.ts
git commit -m "feat: invalidate changed Clerk identities"
```

### Task 6: Converge retained Gatekeeper and Access authentication

**Files:**
- Modify: `packages/workshop-backend/src/auth/login-flow.ts`
- Modify: `packages/workshop-backend/src/access.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Modify: `packages/workshop-backend/src/user.ts`
- Create: `packages/integration-tests/__tests__/auth-convergence.test.ts`
- Modify: `packages/integration-tests/src/harness.ts`
- Modify: `packages/integration-tests/fixtures/gatekeeper-test/*`

- [ ] **Step 1: Write failing convergence and authorization tests**

Assert Clerk, Gatekeeper, and Access verified emails converge to one internal ID; disabled signup rejects unknown identities but permits existing identities; Gatekeeper local sessions retain current semantics; Access logout/auth remains intact; canonicalized `ADMINS` grants only matching active verified email; non-admin is denied; and stale admin sessions follow Task 5's eager/hard-expiry behavior.

- [ ] **Step 2: Run integration tests and verify failure**

Run: `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/auth-convergence.test.ts`  
Expected: FAIL on email-keyed routing.

- [ ] **Step 3: Route Gatekeeper and Access through registry**

Use registry resolution, stable user initialization, and canonical email. Keep Gatekeeper grants/transient behavior and Access JWT checks unchanged.

- [ ] **Step 4: Update admin resolution**

Compare canonical current verified email against `ADMINS`; keep provider config env-controlled and `signupsEnabled` in `AdminConfig`.

- [ ] **Step 5: Run auth/backend suite**

Run: `pnpm --filter @gadgets/workshop-backend test`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-backend/src/auth/login-flow.ts packages/workshop-backend/src/access.ts packages/workshop-backend/src/server.ts packages/workshop-backend/src/user.ts packages/integration-tests/src/harness.ts packages/integration-tests/fixtures/gatekeeper-test packages/integration-tests/__tests__/auth-convergence.test.ts
git commit -m "feat: converge verified sign-in identities"
```

### Task 7: Remove built-in password backend

**Files:**
- Modify: `packages/workshop-shared/src/api.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Modify: `packages/workshop-backend/src/user.ts`
- Delete/modify: `packages/workshop-backend/src/auth/config.ts`
- Create: `packages/workshop-backend/__tests__/password-auth-removed.test.ts`
- Modify: existing auth tests

- [ ] **Step 1: Write executable contract test for removed password surfaces**

Read/parse the shared API, backend env/storage declarations, and server implementation. Assert no password login/create-account/change methods, no password digest storage, and no `DISABLE_PASSWORD_AUTH`, while Gatekeeper `authenticate(token)` remains.

- [ ] **Step 2: Run executable RED test**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/password-auth-removed.test.ts`  
Expected: FAIL listing current password surfaces.

- [ ] **Step 3: Remove password RPC/storage/config**

Delete only password-specific sessions; retain Gatekeeper local sessions. Update every exported API doc comment.

- [ ] **Step 4: Run shared/backend suites**

Run: `pnpm --filter @gadgets/workshop-backend test && pnpm --filter @gadgets/workshop-shared types:check`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-shared/src/api.ts packages/workshop-backend
git commit -m "refactor: remove built-in password auth"
```

### Task 8: Integrate Clerk React and unified login UI

**Files:**
- Modify: `packages/workshop-frontend/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/workshop-frontend/src/ClerkAuthProvider.tsx`
- Create: `packages/workshop-frontend/src/ClerkAuthProvider.test.tsx`
- Create: `packages/workshop-frontend/src/useAuth.test.tsx`
- Create/modify: `packages/workshop-frontend/src/LoginPage.test.tsx`
- Create/modify: `packages/workshop-frontend/src/SettingsPage.test.tsx`
- Create: `packages/workshop-frontend/src/password-auth-removed.test.ts`
- Modify: `packages/workshop-frontend/src/main.tsx`
- Modify: `packages/workshop-frontend/src/useAuth.ts`
- Modify: `packages/workshop-frontend/src/LoginPage.tsx`
- Modify: `packages/workshop-frontend/src/components/auth/OAuthButtons.tsx`
- Modify: `packages/workshop-frontend/src/SettingsPage.tsx`
- Modify: `packages/workshop-frontend/src/routes/__root.tsx`
- Delete: `packages/workshop-frontend/src/routes/signup.tsx`
- Delete: `packages/workshop-frontend/src/SignupPage.tsx`
- Delete: `packages/workshop-frontend/src/passwordHash.ts`
- Delete/modify: password hash, LoginPage, SignupPage, SettingsPage, main/useAuth, and route tests

- [ ] **Step 1: Audit and add current Clerk React package**

Follow external-code audit instructions. Add current `@clerk/react`; remove `hash-wasm` after password code is gone.

- [ ] **Step 2: Write failing provider/auth hook tests**

Cover runtime key, Access mode bypass, Clerk loading/signed-out/signed-in/error, no localStorage token, token refresh at `exp - 15s`, refresh failure, server abort, disposal, and logout.

- [ ] **Step 3: Write failing unified-card and password-removal tests**

Render Clerk's prebuilt `<SignIn routing="virtual" signUpUrl="/login?mode=signup" />` and `<SignUp routing="virtual" signInUrl="/login" />` behind an in-card login/signup state switch; only one is mounted at a time. Cover email/password signup/sign-in and Google, retained non-Google Gatekeepers below separator, Google Gatekeeper suppression, Google connector unaffected outside login, no password forms in `SettingsPage`, no `devAutoLogin`, no `/signup` route, and no password-hash module.

- [ ] **Step 4: Run focused tests and verify failure**

Run: `pnpm --filter @gadgets/workshop-frontend exec vitest run src/ClerkAuthProvider.test.tsx src/useAuth.test.tsx src/LoginPage.test.tsx src/SettingsPage.test.tsx src/password-auth-removed.test.ts`  
Expected: FAIL before implementation.

- [ ] **Step 5: Implement runtime Clerk provider and auth state**

Initialize only after runtime config is available and only outside Access mode. Wrap RPC stubs in state objects and dispose them in effect cleanup.

- [ ] **Step 6: Implement unified login card**

Use Clerk's prebuilt `<SignIn>`/`<SignUp>` virtual-routing components behind the card's state switch, configured in Clerk for email/password and Google. Keep Gatekeeper popup flow. Remove `SettingsPage` password-change section, `main.tsx` `devAutoLogin`, `/signup` registration/imports, `SignupPage`, `passwordHash`, local `authToken` handling for Clerk, and all obsolete tests.

- [ ] **Step 7: Run frontend suite/build**

Run: `pnpm --filter @gadgets/workshop-frontend test && pnpm --filter @gadgets/workshop-frontend build`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/workshop-frontend pnpm-lock.yaml
git commit -m "feat: add Clerk sign-in experience"
```

### Task 9: Add runtime config and release/deploy inputs

**Files:**
- Modify: `packages/workshop-shared/src/api.ts`
- Modify: `packages/workshop-backend/src/deployment-config.ts`
- Modify: `packages/workshop-backend/src/env.d.ts`
- Modify: `packages/workshop-backend/wrangler.jsonc`
- Modify: `packages/router/wrangler.jsonc` only if the variant contract requires metadata
- Modify: `run-dev-server.js`
- Create: `packages/workshop-backend/deploy-inputs.json`
- Modify: `scripts/release/build-release.mjs`
- Modify: `scripts/release/manifest-lib.mjs`
- Modify: `scripts/release-manifest.test.js`
- Create: `scripts/release-clerk-assets.test.js`
- Modify: release golden manifest
- Modify: deployment docs and deploy-service contract documentation in `scripts/release/`

- [ ] **Step 1: Write failing manifest and artifact tests before implementation**

Assert `MANIFEST_VERSION` becomes 2; publishable key is runtime `ServerConfig`; backend inputs include required `CLERK_PUBLISHABLE_KEY` text and `CLERK_SECRET_KEY` secret plus optional audience; the secret becomes `$SECRET(CLERK_SECRET_KEY)` while non-secrets are deployment vars; local dev origins never enter production manifest; non-Access missing config fails clearly; both `clerk` and `access` asset variants exist; Access does not initialize Clerk; sentinel secret/customer runtime key strings are absent from all built assets; and the exact top-level `authModes` contract below is present.

- [ ] **Step 2: Run both release RED tests**

Run: `node --test scripts/release-manifest.test.js scripts/release-clerk-assets.test.js`  
Expected: FAIL because backend inputs and Clerk asset variant are missing.

- [ ] **Step 3: Implement backend deploy input contract**

Bump `MANIFEST_VERSION` from 1 to 2 and add this exact top-level manifest contract:

```json
{
  "authModes": {
    "clerk": {
      "assetVariant": "clerk",
      "requiredBackendInputs": ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"],
      "optionalBackendInputs": ["CLERK_JWT_AUDIENCE"],
      "forbiddenBackendVars": ["CF_ACCESS_AUD", "CF_ACCESS_ISS"]
    },
    "access": {
      "assetVariant": "access",
      "requiredBackendVars": ["CF_ACCESS_AUD", "CF_ACCESS_ISS"],
      "forbiddenBackendInputs": ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "CLERK_JWT_AUDIENCE"]
    }
  }
}
```

Extend `manifest-lib.mjs` so backend `deploy-inputs.json` is intentional and supported, rather than gatekeeper-only. Declare Clerk inputs and map secret inputs to pass-through `secret_text`; keep `PUBLIC_BASE_URL` templated and deployment instance state (`ADMINS`, Access settings) deploy-service injected. Document that the external deploy service must reject unknown manifest version, select exactly one auth mode, choose its asset variant, and enforce required/forbidden fields. This repository defines/tests the versioned contract; it does not pretend to modify an external deploy service.

- [ ] **Step 4: Build both immutable frontend variants**

Change `build-release.mjs` to build `clerk` with no customer-specific key compiled (runtime key from `ServerConfig`) and `access` with `VITE_CF_ACCESS_MODE=true`. Collect both manifests/blobs under `assetsConfig.variants`. Never compile customer-specific keys. Use `PUBLIC_BASE_URL` as production authorized party and keep secrets out of logs/config responses.

- [ ] **Step 5: Regenerate and inspect golden file**

Run: `UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js`  
Expected: PASS with reviewed Clerk input placeholders and both variants.

- [ ] **Step 6: Make artifact test pass**

Build both variants with sentinel environment values, recursively scan output blobs, and assert secret and customer-specific runtime key are absent while both variant manifests are present.

- [ ] **Step 7: Run release/package checks**

Run: `node --test scripts/*.test.js && pnpm build`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/workshop-shared/src/api.ts packages/workshop-backend packages/workshop-frontend scripts/release scripts/release-manifest.test.js run-dev-server.js docs
git commit -m "feat: configure Clerk deployments"
```

### Task 10: Create and configure Clerk development app

**Files:**
- Local-only: `.dev.vars`, `/tmp/clerk-*.json`
- Potential CLI metadata: only commit if Clerk CLI documents it as non-secret project linkage

- [ ] **Step 1: Verify exact Clerk CLI and host health**

Run under Node 22:

```bash
clerk --version
clerk doctor --json > /tmp/clerk-doctor-before.json || true
node -e 'const d=require("/tmp/clerk-doctor-before.json"); if(!Array.isArray(d)) throw Error("unexpected doctor JSON"); const bad=d.filter(x=>x.status==="fail" && x.name!=="Project linked"); console.log(d.map(({name,status})=>({name,status}))); if(bad.length) process.exit(1); const link=d.find(x=>x.name==="Project linked"); if(link && link.status!=="fail" && link.status!=="pass") process.exit(1)'
```

Expected: Clerk CLI 3.x/current and host/auth checks pass. If the host-execution warning appears, rerun the same command from the host shell before trusting auth/link failures.

- [ ] **Step 2: Create and link the approved new app noninteractively**

`apps create` has no dry-run flag; creation itself is the user-approved mutation. Capture output without echoing credentials:

```bash
clerk apps create "Cloudflare OS Development" --json > /tmp/clerk-app.json
APP_ID=$(node -e 'const d=require("/tmp/clerk-app.json"); process.stdout.write(d.app_id ?? d.id)')
test -n "$APP_ID"
clerk link --app "$APP_ID"
```

- [ ] **Step 3: Discover config schema and prepare minimal auth patch**

```bash
clerk config schema --app "$APP_ID" --instance dev --output /tmp/clerk-schema.json
clerk config pull --app "$APP_ID" --instance dev --output /tmp/clerk-config-before.json
```

Derive `/tmp/clerk-auth-patch.json` from the schema's actual current keys—email/password enabled, email verification-code flow enabled for test mode, and Google social connection enabled. Validate every patch key against `/tmp/clerk-schema.json`; do not guess unsupported fields.

- [ ] **Step 4: Dry-run and apply exactly that patch**

```bash
clerk config patch --app "$APP_ID" --instance dev --file /tmp/clerk-auth-patch.json --dry-run
clerk config patch --app "$APP_ID" --instance dev --file /tmp/clerk-auth-patch.json --yes
clerk config pull --app "$APP_ID" --instance dev --output /tmp/clerk-config-after.json
```

Compare only relevant booleans/provider names; do not print secret-bearing config.

- [ ] **Step 5: Pull keys to a temporary file and map them into backend dev vars**

```bash
clerk env pull --app "$APP_ID" --instance dev --file /tmp/clerk.env
```

Parse `VITE_CLERK_PUBLISHABLE_KEY`/`CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` without printing values. Write root `.dev.vars` entries `CLERK_PUBLISHABLE_KEY=...`, `CLERK_SECRET_KEY=...`, `PUBLIC_BASE_URL=http://localhost:8787`, `CLERK_DEV_AUTHORIZED_PARTIES=http://localhost:8787,http://localhost:3000`, and `ADMINS=["admin+clerk_test@example.com"]`; preserve unrelated existing `.dev.vars` values. Create/ensure that reserved test-mode email in Clerk with the local `E2E_CLERK_PASSWORD` during E2E setup, and authenticate it through Clerk before calling the Workshop admin API. Set Playwright process env from the same temporary values. Confirm `.dev.vars` is ignored.

- [ ] **Step 6: Verify project health and secret hygiene**

```bash
clerk doctor --json > /tmp/clerk-doctor-after.json
node -e 'const d=require("/tmp/clerk-doctor-after.json"); if(!Array.isArray(d)||d.some(x=>x.status==="fail")) process.exit(1); console.log(d.map(({name,status})=>({name,status})))'
git check-ignore .dev.vars
git status --short
git diff --check
rm -f /tmp/clerk.env /tmp/clerk-auth-patch.json /tmp/clerk-config-before.json /tmp/clerk-config-after.json /tmp/clerk-schema.json /tmp/clerk-app.json
```

Expected: linked/config/env checks pass and no secrets are tracked. If no safe linkage metadata is created, make no commit for this task.

### Task 11: Full verification and local browser acceptance

**Files:**
- Create: `packages/e2e/package.json`
- Create: `packages/e2e/playwright.config.ts`
- Create: `packages/e2e/tests/clerk.setup.ts`
- Create: `packages/e2e/tests/clerk-auth.spec.ts`
- Create: `packages/e2e/tests/auth-policy.spec.ts`
- Modify: `pnpm-workspace.yaml` only if the existing `packages/*` glob does not already include it
- Modify: `pnpm-lock.yaml`
- Create: `scripts/start-e2e-server.mjs`

**Local E2E env contract:** `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `E2E_CLERK_PASSWORD` are required process variables loaded from gitignored local storage; `E2E_CLERK_PASSWORD` must be a generated test-only password and is never committed or printed.

- [ ] **Step 1: Run static and automated verification**

Run:

```bash
pnpm lint
pnpm build
pnpm test:unit
pnpm test:integration
```

Expected: all PASS.

- [ ] **Step 2: Audit and install exact E2E dependencies**

Following the external-code audit skill, add exact pinned dev dependencies `@playwright/test` and `@clerk/testing` to `packages/e2e`; install Chromium with `pnpm --filter @gadgets/e2e exec playwright install chromium`. Configure project-based setup (not `globalSetup`): setup project runs `clerkSetup()`, Chromium project depends on it, each auth test calls `setupClerkTestingToken({ page })`, `baseURL` is `http://localhost:8787`, and no `--disable-web-security` flag is used.

- [ ] **Step 3: Write browser tests before final run**

Use reserved `user+clerk_test_<runid>@example.com`, password from `E2E_CLERK_PASSWORD`, and Clerk verification code `424242`. The setup project also ensures/signs in `admin+clerk_test@example.com`, whose verified email is listed in local `ADMINS`; use that authenticated Workshop `AdminApi` to toggle `signupsEnabled`, then sign back as the tested user. Test prebuilt virtual signup, workspace access, logout/sign-in, no Clerk token in localStorage, Google button present, Google Gatekeeper button absent, Google connector present post-login, disabled signup/existing login, Clerk primary-email update through Clerk test/backend API, same workspace after reconnect, old alias denial, refresh/expiry, and stale WebSocket close. Automated tests use Clerk test keys only.

- [ ] **Step 4: Add Playwright-managed server lifecycle**

Create `scripts/start-e2e-server.mjs` that spawns `pnpm run-local` with inherited Node 22/env, forwards logs, handles SIGTERM/SIGINT, and kills the full child process tree. Configure Playwright `webServer.command` as `node ../../scripts/start-e2e-server.mjs`, `url` as `http://localhost:8787/cdn-cgi/local/explorer/api/local/workers`, `timeout: 120_000`, and `reuseExistingServer: false`; Playwright owns readiness polling and guaranteed teardown. The launcher must exit when its child exits and leave no listener on 8787.

- [ ] **Step 5: Run exact Playwright command**

Export `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from the gitignored temporary/local dev source without printing them, then run:

```bash
pnpm --filter @gadgets/e2e exec playwright test --project=chromium --reporter=line
```

Expected: email/password and policy/lifecycle tests PASS. Google OAuth itself is verified manually in a headed browser because Google blocks/flags automated credential entry; Playwright still asserts the Clerk Google strategy/button and duplicate Gatekeeper suppression.

- [ ] **Step 6: Manually verify Clerk Google locally**

Open `http://localhost:8787` in the real browser, select Clerk Google, complete OAuth with a development Google account, reach the existing workspace/internal identity, verify Google Gatekeeper login is hidden, and verify the Google connector remains available. Record result in the PR; never store Google credentials in fixtures.

- [ ] **Step 7: Run retained auth/convergence checks**

Configure one non-Google auth-capable Gatekeeper in `.dev.vars` if credentials already exist; exercise matching verified email and assert same internal ID. Independently run hermetic Gatekeeper convergence integration tests. Run Access integration coverage; if a valid Cloudflare Access assertion cannot be issued locally, explicitly mark only the live Access browser check environment-limited while requiring its Worker integration suite to pass.

- [ ] **Step 8: Scan artifacts/logs and verify teardown**

Assert no Clerk secret/runtime customer key in built assets and no token/profile payloads in logs. After Playwright exits (including a deliberate failing-test smoke run), confirm `lsof -iTCP:8787 -sTCP:LISTEN` returns no process, proving `webServer`/launcher cleanup.

- [ ] **Step 9: Commit acceptance tests/fixes**

```bash
git add packages/e2e scripts/start-e2e-server.mjs pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "test: cover Clerk authentication flows"
```

### Task 12: Review, push, PR, and automatic merge

**Files:**
- No product files unless review finds defects

- [ ] **Step 1: Run final clean verification**

Run `pnpm lint && pnpm build && pnpm test:unit && pnpm test:integration`.  
Expected: PASS with fresh output.

- [ ] **Step 2: Request code and security review**

Dispatch code-quality and security reviewers with the spec, plan, and diff. Fix blockers in small targeted commits and rerun relevant tests.

- [ ] **Step 3: Push feature branch**

```bash
git push -u origin feature/clerk-authentication
```

- [ ] **Step 4: Open PR to `main`**

Create a complete PR description with architecture/security decisions, local browser results, exact test commands, and any explicit environment limitation. Query and report PR number/status/URL.

- [ ] **Step 5: Enable automatic merge without asking**

Run `gh pr merge <PR> --auto --squash --delete-branch` (or repository-supported merge method). This must wait for GitHub CI checks; never bypass failures. If auto-merge is unavailable because repository plan/settings or required-check protection cannot be enabled, report the platform blocker and keep the verified PR open—do not direct-push or manually bypass CI.

- [ ] **Step 6: Monitor CI and repair failures**

Watch checks, inspect failed logs, fix root causes in small commits, push, and let auto-merge proceed. Do not ask for merge permission.

- [ ] **Step 7: Verify merged state**

Confirm PR state `MERGED`, `origin/main` contains the result, CI is green on main, and report the PR URL and merge commit.
