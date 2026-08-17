# HubSpot Gatekeeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development by default to implement this plan task-by-task. Run independent, safely isolated tasks in parallel; sequence tasks that share state or dependencies. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a current HubSpot Developer Platform OAuth Gatekeeper with bounded CRM read/search and approval-gated contact/company/deal create/update, then install it in the default managed connector fleet and Vlightup staging.

**Architecture:** A static-OAuth Worker stores each HubSpot installation's refresh/access credentials in a `UserAccount` Durable Object and exposes one private whole-portal resource. A per-Gadget `HubSpotGatekeeperImpl` authorizes every observation and persists every mutation until the approval queue invokes `applyAction()`. A thin API client targets HubSpot's 2026-03 OAuth and CRM endpoints with curated properties and bounded responses.

**Tech Stack:** TypeScript 7, Cloudflare Workers/Durable Objects/RPC, capnweb validation, Vitest, Wrangler 4.120, pnpm 11.17, HubSpot OAuth 2.0 and CRM 2026-03 APIs.

---

### Task 1: Scaffold the HubSpot package and release contract

**Files:**
- Create: `packages/gatekeeper-hubspot/package.json`
- Create: `packages/gatekeeper-hubspot/tsconfig.json`
- Create: `packages/gatekeeper-hubspot/vite.config.ts`
- Create: `packages/gatekeeper-hubspot/vitest.config.ts`
- Create: `packages/gatekeeper-hubspot/wrangler.jsonc`
- Create: `packages/gatekeeper-hubspot/src/text-modules.d.ts`
- Create: `packages/gatekeeper-hubspot/src/hubspot-logo.svg`
- Create: `packages/gatekeeper-hubspot/src/types.d.ts`
- Create: `packages/gatekeeper-hubspot/src/types.txt`
- Create: `packages/gatekeeper-hubspot/src/configurator/account-configurator-types.d.ts`
- Create: `packages/gatekeeper-hubspot/src/configurator/account-configurator-types.txt`
- Create: `packages/gatekeeper-hubspot/src/configurator/account-configurator-ui.tsx`
- Create: `scripts/testdata/fixture-bundles/gatekeeper-hubspot/hubspot.js`
- Modify: `pnpm-lock.yaml`
- Test: `scripts/release-manifest.test.js`

- [ ] **Step 1: Add the fixture package expectation and run the release manifest test**

Create the fixture bundle and package config with Worker main `hubspot.ts`, `BASE_URL`, static OAuth readiness, and SQLite classes `UserAccount` / `HubSpotGatekeeperImpl`.

Run: `mise exec node@24.13.0 -- node --test scripts/release-manifest.test.js`

Expected: FAIL because the golden manifest does not include `gatekeeper-hubspot`.

- [ ] **Step 2: Add package metadata and minimal exported placeholder classes**

Declare only workspace dependencies already used by other OAuth Gatekeepers. Set current repository compatibility settings and observability. Keep all credentials out of `wrangler.jsonc`.

- [ ] **Step 3: Generate package installation and Worker types**

Run:

```bash
mise exec node@24.13.0 -- pnpm install
mise exec node@24.13.0 -- pnpm --filter @gadgets/hubspot-gatekeeper exec wrangler types
```

Expected: lockfile and `worker-configuration.d.ts` include the new package without unrelated upgrades.

- [ ] **Step 4: Regenerate and verify the release golden**

Run:

```bash
UPDATE_GOLDEN=1 mise exec node@24.13.0 -- node --test scripts/release-manifest.test.js
mise exec node@24.13.0 -- node --test scripts/release-manifest.test.js
```

Expected: PASS and installable HubSpot entry with `CLIENT_ID`, `CLIENT_SECRET`, `$PUBLIC_BASE_URL/gatekeeper/hubspot`, and both Durable Object migrations.

- [ ] **Step 5: Commit**

```bash
git add packages/gatekeeper-hubspot pnpm-lock.yaml scripts/testdata
git commit -m "feat: scaffold HubSpot gatekeeper"
```

### Task 2: Implement and test the bounded HubSpot API client

**Files:**
- Create: `packages/gatekeeper-hubspot/src/hubspot-api.ts`
- Create: `packages/gatekeeper-hubspot/__tests__/hubspot-api.test.ts`

- [ ] **Step 1: Write failing OAuth tests**

Cover authorization URL query encoding, 2026-03 authorization-code exchange, refresh-token exchange and revocation, required response fields, redacted OAuth errors, and request timeouts. Assert secrets/tokens never appear in URLs or thrown messages.

Run: `mise exec node@24.13.0 -- pnpm --dir packages/gatekeeper-hubspot exec vitest run __tests__/hubspot-api.test.ts`

Expected: FAIL because the API helpers do not exist.

- [ ] **Step 2: Implement OAuth helpers**

Use `https://app.hubspot.com/oauth/authorize`, form-encoded `https://api.hubspot.com/oauth/2026-03/token`, and form-encoded `https://api.hubapi.com/oauth/2026-03/token/revoke`. Require `access_token`, `refresh_token` for initial exchange, positive `expires_in`, and numeric `hub_id`. If a token response includes scopes, require every configured OAuth scope before storing it. Persist a refresh token returned during refresh and preserve the prior token only when HubSpot omits a replacement. Revoke with `client_id`, `client_secret`, `token`, and `token_type_hint=refresh_token`, accepting the documented empty success response and bounding/redacting failures.

- [ ] **Step 3: Write failing CRM client tests**

Cover only:

```text
POST /crm/objects/2026-03/{type}/search
GET  /crm/objects/2026-03/{type}/{id}
POST /crm/objects/2026-03/{type}
PATCH /crm/objects/2026-03/{type}/{id}
```

Assert bearer auth, curated properties, 32-digit record-ID and digit-string cursor bounds, no DELETE/batch/association endpoint, bounded provider errors, and no automatic write retry.

- [ ] **Step 4: Implement the CRM client**

Use one injected `fetch`, one async token provider, and `https://api.hubapi.com` for the CRM routes. Parse only bounded JSON object responses. Classify CRM `401` as credential expiry, `429` as rate limiting, and other non-2xx responses by status/category/correlation ID without including CRM values or raw bodies. For OAuth responses, only documented `invalid_grant` is credential expiry.

- [ ] **Step 5: Verify and commit**

Run the focused test and `pnpm --filter @gadgets/hubspot-gatekeeper build`.

```bash
git add packages/gatekeeper-hubspot/src/hubspot-api.ts packages/gatekeeper-hubspot/__tests__
git commit -m "feat: add bounded HubSpot API client"
```

### Task 3: Implement OAuth lifecycle and whole-account binding

**Files:**
- Create: `packages/gatekeeper-hubspot/src/hubspot.ts`
- Create: `packages/gatekeeper-hubspot/__tests__/hubspot-oauth.test.ts`
- Modify: `packages/gatekeeper-hubspot/src/types.d.ts`
- Modify: `packages/gatekeeper-hubspot/src/types.txt`

- [ ] **Step 1: Write failing metadata/readiness tests**

Assert `VendorDescription` uses `staticOauthConnectorConfiguration`, returns HubSpot branding and account resource metadata, and remains visible while unconfigured.

- [ ] **Step 2: Write failing nonce/OAuth tests**

Assert initiation and OAuth state nonces are cryptographically random, one-time, constant-time compared, expiry-bound, and rejected when malformed/replayed. Assert callback completion happens only after token exchange and identity storage.

- [ ] **Step 3: Implement HTTP entrypoint, vendor, and UserAccount**

Follow the current Gatekeeper OAuth lifecycle. Store callback, tokens, scopes, Hub ID, and user/domain identity only in the Durable Object. Persist a bounded credential generation so refresh results are discarded after reconnect or revoke. Single-flight refresh per instance, notify credential expiry once only for a current OAuth `invalid_grant`, and support reconnect through the existing account capability only when the new grant has the original Hub ID. Disconnect enters a fail-closed revoking state before provider I/O, deletes locally only after refresh-token revoke succeeds, and preserves reconnectable credentials on provider failure.

- [ ] **Step 4: Implement connected-account RPC and configurator**

Return account description `HubSpot account <hubId>`, whole-account resource URL `https://app.hubspot.com/contacts/<hubId>`, and reject URLs for any other portal ID or hostname. Pin the selected Hub ID into Gatekeeper capability props and re-check it before descriptions, sessions, provider calls, pending mutation use, and result lookup. Use a no-input configurator.

- [ ] **Step 5: Verify and commit**

Run focused OAuth tests, package typecheck/build, and `wrangler deploy --dry-run` with placeholder local secrets omitted.

```bash
git add packages/gatekeeper-hubspot
git commit -m "feat: add HubSpot OAuth account lifecycle"
```

### Task 4: Implement observation-authorized CRM reads

**Files:**
- Modify: `packages/gatekeeper-hubspot/src/hubspot.ts`
- Modify: `packages/gatekeeper-hubspot/src/types.d.ts`
- Modify: `packages/gatekeeper-hubspot/src/types.txt`
- Create: `packages/gatekeeper-hubspot/__tests__/hubspot-session.test.ts`

- [ ] **Step 1: Write failing read authorization tests**

For contacts, companies, and deals, prove the remote fetch result is withheld until `authorizeObservation()` resolves, authorization rejection propagates, page size is capped at 100, cursor/query/ID validation is enforced, and response properties are curated.

- [ ] **Step 2: Implement explicit read APIs**

Add `searchContacts/getContact`, `searchCompanies/getCompany`, and `searchDeals/getDeal`. Share private generic helpers internally but expose explicit typed methods to agents.

- [ ] **Step 3: Implement private-only observer behavior**

`addObserver()` always throws an actionable whole-account privacy error; `removeObserver()` is idempotent; the verifier is a valid capability but cannot weaken the policy.

- [ ] **Step 4: Verify and commit**

Run session/API tests and package build.

```bash
git add packages/gatekeeper-hubspot
git commit -m "feat: add HubSpot CRM observations"
```

### Task 5: Implement approval-gated CRM mutations

**Files:**
- Modify: `packages/gatekeeper-hubspot/src/hubspot.ts`
- Modify: `packages/gatekeeper-hubspot/src/types.d.ts`
- Modify: `packages/gatekeeper-hubspot/src/types.txt`
- Modify: `packages/gatekeeper-hubspot/__tests__/hubspot-session.test.ts`

- [ ] **Step 1: Write failing input-policy tests**

Assert object-specific property allowlists, contact/company/deal creation requirements, string-only bounded values, unknown-key rejection, and no delete/batch/association method.

- [ ] **Step 2: Write failing approval tests**

Assert create/update stores a pending mutation and calls `submitAction()` without fetching HubSpot. Assert action descriptions disclose object, record ID for updates, and every changed property. Assert no auto-approval/revert and `awaitDecision: true`.

- [ ] **Step 3: Implement pending mutation storage and session methods**

Add explicit create/update methods for all three objects plus `getMutationResult`. Use sequential integer IDs in Gatekeeper storage. Never persist tokens or arbitrary provider responses in action descriptions.

- [ ] **Step 4: Implement apply/reject/result lifecycle**

`applyAction()` moves pending state to applying before one POST/PATCH. It stores ready only for confirmed success; all application failures store a redacted terminal failed/uncertain result, remove pending state, and throw. Active duplicates fail without disturbing the first application. A stale applying state becomes terminal failed with outcome-uncertain/manual-inspection guidance and no fetch, including during result lookup or rejection. Normal pending rejection stores rejected with no fetch. Writes are never retried. `revertAction()` returns a manual-remediation message. Result reads require authority re-check and observation authorization.

- [ ] **Step 5: Verify and commit**

Run package tests/typecheck/build.

```bash
git add packages/gatekeeper-hubspot
git commit -m "feat: add approved HubSpot CRM mutations"
```

### Task 6: Add setup documentation and Admin readiness

**Files:**
- Create: `packages/gatekeeper-hubspot/README.md`
- Create: `packages/gatekeeper-hubspot/deploy-inputs.json`
- Modify: `packages/workshop-backend/src/connector-configuration.ts`
- Modify: `packages/workshop-backend/__tests__/admin-connector-configuration.test.ts`
- Modify: `scripts/admin-connector-readiness.test.js`
- Modify: `run-dev-server.js`
- Modify: `README.md`
- Modify: `docs/observers.md`
- Modify: `docs/superpowers/specs/2026-08-17-admin-connector-configuration-design.md`

- [ ] **Step 1: Write failing readiness/static tests**

Add HubSpot to expected immutable Admin schemas and static readiness coverage. Assert server-owned setup URL, HTTPS guide, local README, `CLIENT_ID`/`CLIENT_SECRET`, and ignored Gatekeeper-supplied inputs/links.

- [ ] **Step 2: Implement Admin and local-development integration**

Add `hubspot` to the server allowlists/setup guides and local environment credential map. Do not add it to authentication Gatekeepers.

- [ ] **Step 3: Add current provider setup guide**

Document Developer Platform OAuth app creation, private vs marketplace distribution, exact callback template, required scopes, install permissions, unverified-app behavior, credential installation, provider-side disconnect revocation, manual-uninstall incident fallback, and verification steps.

- [ ] **Step 4: Verify and commit**

Run package tests, backend connector tests, static readiness test, release manifest test, and documentation link checks.

```bash
git add packages/gatekeeper-hubspot README.md run-dev-server.js scripts packages/workshop-backend docs

git commit -m "feat: integrate HubSpot connector setup"
```

### Task 7: Repository verification and review

**Files:**
- Modify only files required by discovered failures.

- [ ] **Step 1: Run complete verification**

```bash
mise exec node@24.13.0 -- pnpm --filter @gadgets/typed-storage build
mise exec node@24.13.0 -- pnpm test
mise exec node@24.13.0 -- pnpm types:check
mise exec node@24.13.0 -- pnpm lint:check
mise exec node@24.13.0 -- pnpm --filter @gadgets/hubspot-gatekeeper build
mise exec node@24.13.0 -- pnpm --filter @gadgets/workshop-frontend build
git diff --check
```

Expected: all tests/builds/typechecks pass and lint has zero errors.

- [ ] **Step 2: Review trust-boundary invariants**

Inspect OAuth state, token redaction/storage/refresh, portal ID validation, observation ordering, approval-before-write, no write retries, action payload bounds, private-only observer enforcement, and secret-free manifests/logs.

- [ ] **Step 3: Commit verification fixes**

```bash
git add <only required files>
git commit -m "fix: harden HubSpot connector boundaries"
```

Skip this commit if no fixes are needed.

### Task 8: PR, merge, default staging deployment

**Files in `Lumirator-Ltd/cloudflare-os`:** PR only after Task 7.

**Files in starter staging worktree:**
- Modify: `cloudflare-os` gitlink
- Modify privately: `deployment.jsonc` (never commit)
- Generate privately: `cloudflare-os/packages/gatekeeper-hubspot/wrangler.vlightup.jsonc` (never commit)
- Modify generated private Router/Workshop bindings (never commit)

- [ ] **Step 1: Push and open a normal PR against fork `main`**

Include provider contracts, security boundaries, exact verification, and deferred scope. Wait for all required checks and merge only when green.

- [ ] **Step 2: Repin starter staging to the merge commit**

Commit only the gitlink. Preserve `deployment.jsonc` and every generated config as uncommitted/private.

- [ ] **Step 3: Add HubSpot to default staging connector data**

Add worker `vlightup-os-staging-gk-hubspot`, Workshop/Router service bindings, and Admin connector metadata. Do not install credentials yet.

- [ ] **Step 4: Deploy sequentially**

Build and deploy HubSpot first, then Workshop and Router. Stop on first failure. Verify no existing Worker secret changed.

- [ ] **Step 5: Authenticated smoke test**

Verify HubSpot appears on `/admin/connectors` with callback URL and setup guide, status Needs setup, two empty write-only fields, and on `/gatekeepers` disabled with `Ask an administrator to configure this connector.` Existing configured GitHub and all Admin controls must remain unchanged.

- [ ] **Step 6: Report setup handoff**

Provide the exact HubSpot callback and scope list. Ask the administrator to create the HubSpot app and enter credentials through `/admin/connectors`; never request credentials in chat.
