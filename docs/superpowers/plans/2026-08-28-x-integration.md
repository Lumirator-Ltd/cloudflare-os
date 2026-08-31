# User-Funded X Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development by default to implement this plan task-by-task. Run independent, safely isolated tasks in parallel; sequence tasks that share state or dependencies. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a whole-account X gatekeeper funded by each end user's own X Developer App, enforce owner-only workspace use and manual writes, then deploy it to vlightup staging.

**Architecture:** A new `gatekeeper-x` Worker stores each user's app credentials and OAuth tokens in a per-account Durable Object, exposes only fixed X API v2 operations, and queues every mutation through the existing approval system with an at-most-once action state machine. A reusable owner-only resource policy in the Workshop core prevents collaborators from binding, viewing, sharing, or resolving actions for the account. The release declares no deployment X credentials; downstream deployment adds a fifteenth connector Worker and its service bindings.

**Tech Stack:** TypeScript, Cloudflare Workers and SQLite Durable Objects, Cap'n Web RPC, Vitest, i18next catalogs, Wrangler 4, pnpm 11, managed deployment CLI.

**Design:** `docs/superpowers/specs/2026-08-28-x-integration-design.md`

---

## Execution constraints

- Use Node 22 for `cloudflare-os` and `company_os_starter`:

  ```bash
  export PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH
  ```

- Use the repository lockfile. Do not add a third-party package; native `fetch`, Web Crypto, and existing workspace libraries are sufficient.
- Follow strict TDD for every behavior: write one test, run it and confirm the expected failure, implement the minimum behavior, rerun it, then refactor.
- Do not put an X credential, token, callback code, funded account identifier, or tenant-specific topology into git.
- Use zero comments by default. Retain only external-contract or security-invariant comments that code cannot express.
- Do not call X during unit tests. Inject `fetch` and use exact request/response fixtures.
- X requests must never retry or follow redirects.
- Runtime tasks share core types, generated files, and package-manager state; execute Tasks 1–7 sequentially in the feature worktree.
- Downstream tasks depend on the runtime merge and are also sequential: starter pin first, managed deployment second.

## Task 1: Add the reusable owner-only resource policy

**Files:**
- Modify: `packages/workshop-shared/src/gatekeeper.ts`
- Modify: `packages/workshop-backend/src/user.ts`
- Modify: `packages/workshop-backend/src/overseer.ts`
- Modify: `packages/workshop-frontend/src/components/ConnectConnectorModal.tsx`
- Modify: `packages/workshop-frontend/src/i18n/locales/en/admin.ts`
- Modify: `packages/workshop-frontend/src/i18n/locales/ja/admin.ts`
- Test: `packages/workshop-backend/__tests__/overseer-sharing-policy.test.ts`
- Test: `packages/workshop-backend/__tests__/owner-only-gatekeeper.test.ts`
- Test: `packages/workshop-frontend/src/components/ConnectConnectorModal.test.tsx`
- Test: `packages/workshop-frontend/src/i18n/admin-localization.test.ts`

- [ ] **Step 1: Write failing contract tests for policy propagation**

Add `workspaceAccess?: "owner-only"` to the wished-for `SupportedResource` fixture and assert `UserDurableObject.getGatekeeperClassFor()` returns that policy with the class, vendor ID, and type URL pattern.

Run:

```bash
pnpm --dir packages/workshop-backend exec vitest run __tests__/owner-only-gatekeeper.test.ts
```

Expected: FAIL because `workspaceAccess` is not returned or enforced.

- [ ] **Step 2: Implement the shared policy metadata and propagation**

Use a closed union, not a boolean with undefined semantics:

```ts
export type WorkspaceAccessPolicy = "owner-only";

export type SupportedResource = {
  // existing fields
  workspaceAccess?: WorkspaceAccessPolicy;
};
```

Return `workspaceAccess` from `getGatekeeperClassFor()` without trusting browser input; it must come from the connected gatekeeper's `SupportedResource`.

- [ ] **Step 3: Write failing private-workspace creation tests**

Cover:

- owner + no shares succeeds and stores `ownerOnly: true` on the internal gatekeeper record;
- collaborator creation fails;
- owner creation with a collaborator or active share link fails;
- creation racing collaborator/share-link redemption fails closed;
- failed gatekeeper description removes the provisional owner-only record/transition.

Expected server message should be stable and provider-neutral, for example:

```text
Owner-only connections can only be added by the workspace owner to an unshared workspace.
```

Run the focused backend test and confirm it fails for missing enforcement.

- [ ] **Step 4: Implement atomic owner-only binding creation**

Add an internal `ownerOnly?: true` field to `GatekeeperRecord`. Add an owner-only creation transition counter analogous to the existing sharing-lockdown transitions. Before the first await in owner-only creation:

1. require `clientUserId === impl.ownerId`;
2. reject active access-granting sharing transitions;
3. register owner-only creation;
4. check `SharingManager.hasAnyShares()`;
5. persist the policy on the gatekeeper record;
6. unregister the transition in `finally`.

Do not add owner IDs to `GatekeeperCreationSpec` or blueprint exports.

- [ ] **Step 5: Write failing sharing/open race tests**

Assert that while any owner-only record or creation transition exists:

- `addCollaborator()` fails;
- `createShareLink()` and `newShareLinkKey()` fail;
- share-key redemption and non-owner `open()` fail;
- removing the final owner-only gatekeeper re-enables sharing;
- owner actions and `getWebFetchEnv()` remain available.

Run:

```bash
pnpm --dir packages/workshop-backend exec vitest run \
  __tests__/owner-only-gatekeeper.test.ts \
  __tests__/overseer-sharing-policy.test.ts
```

Expected: FAIL only for the new policy cases.

- [ ] **Step 6: Implement sharing and open enforcement**

Extend the single access-grant chokepoint to reject when owner-only state exists. Deny non-owner opens before resolving collaborators. Keep `prohibitAllSharing` behavior unchanged and separate: owner-only must not disable actions or web fetch.

- [ ] **Step 7: Write failing manual/automatic action authorization tests**

Cover:

- owner can approve and reject an owner-only action;
- non-owner cannot resolve it even with a stale build client;
- `listPreApprovableActions()` omits owner-only gatekeepers;
- setting or draining an auto-approval rule rejects owner-only gatekeepers.

- [ ] **Step 8: Implement action authorization defense in depth**

Before approve/reject/apply and auto-approval paths, load the action's gatekeeper record. For owner-only records require the resolving user to equal the workspace owner and require `autoApproved === false`.

- [ ] **Step 9: Write failing English/Japanese owner-only UI tests**

When the selected resource has `workspaceAccess: "owner-only"`, the modal must replace shared-user verification copy with localized text explaining that the workspace cannot be shared until the connection is removed.

- [ ] **Step 10: Implement localized UI and catalog parity**

Add whole-message English/Japanese catalog keys and render from `ConnectConnectorModal.tsx`. Keep provider/resource names dynamic and untranslated.

- [ ] **Step 11: Run focused owner-policy verification**

```bash
pnpm --dir packages/workshop-backend exec vitest run \
  __tests__/owner-only-gatekeeper.test.ts \
  __tests__/overseer-sharing-policy.test.ts
pnpm --dir packages/workshop-frontend exec vitest run \
  src/components/ConnectConnectorModal.test.tsx \
  src/i18n/admin-localization.test.ts
```

Expected: all focused files pass.

- [ ] **Step 12: Commit**

```bash
git add packages/workshop-shared/src/gatekeeper.ts \
  packages/workshop-backend/src/user.ts \
  packages/workshop-backend/src/overseer.ts \
  packages/workshop-backend/__tests__/owner-only-gatekeeper.test.ts \
  packages/workshop-backend/__tests__/overseer-sharing-policy.test.ts \
  packages/workshop-frontend/src/components/ConnectConnectorModal.tsx \
  packages/workshop-frontend/src/components/ConnectConnectorModal.test.tsx \
  packages/workshop-frontend/src/i18n/locales/en/admin.ts \
  packages/workshop-frontend/src/i18n/locales/ja/admin.ts \
  packages/workshop-frontend/src/i18n/admin-localization.test.ts
git commit -m "feat: enforce owner-only gatekeeper resources"
```

## Task 2: Build the fixed-origin X API client

**Files:**
- Create: `packages/gatekeeper-x/package.json`
- Create: `packages/gatekeeper-x/src/x-api.ts`
- Create: `packages/gatekeeper-x/src/types.d.ts`
- Create: `packages/gatekeeper-x/__tests__/x-api.test.ts`

- [ ] **Step 1: Write failing OAuth request tests**

Specify wished-for pure functions/classes that:

- build `https://x.com/i/oauth2/authorize` with exact callback, exact scope set, state, PKCE challenge, and `S256`;
- exchange and refresh only at `https://api.x.com/2/oauth2/token`;
- use confidential-client Basic authentication without placing the secret in URL/body/error output;
- set `redirect: "error"`;
- require exact returned scopes, access token, refresh token on initial exchange, and expiry.

Run:

```bash
pnpm --dir packages/gatekeeper-x exec vitest run __tests__/x-api.test.ts
```

Expected: FAIL because the package/client does not exist.

- [ ] **Step 2: Implement OAuth helpers and safe errors**

Use Web Crypto and native base64url conversion. Keep constants private except those needed for exact tests. Bound token responses before JSON parsing. Redact raw, URL-encoded, and Basic-encoded credentials from every surfaced error.

- [ ] **Step 3: Write failing exact-operation read tests**

Cover one request each for:

- `/users/me`;
- user by ID and username;
- post by ID;
- own posts, mentions, home timeline;
- recent search;
- liked posts and bookmarks;
- followers and following.

Assert stored actor ID is used for actor-scoped methods, `max_results` defaults to 10 and caps at 20, pagination is explicit, and fields/expansions use closed constants.

- [ ] **Step 4: Write failing input/egress tests**

Reject before fetch:

- arbitrary URL/host/method;
- decimal IDs with separators, encoded slashes, `..`, or excess length;
- invalid/oversized username, search, token, and page size;
- 3xx responses;
- oversized/malformed success payloads.

- [ ] **Step 5: Implement the typed X API operation boundary**

Expose only named methods or a discriminated operation union. Do not accept raw URLs. Implement bounded streaming JSON parsing and runtime validation that maps provider payloads into the exported `XUser`, `XPost`, `XPostPage`, and `XUserPage` types.

- [ ] **Step 6: Write failing mutation request tests**

Assert exact requests for create/reply/delete, like/unlike, bookmark/remove, and follow/unfollow. Ensure actor paths always use the stored authenticated X user ID.

- [ ] **Step 7: Implement mutation requests with no retries**

Each method dispatches once, rejects redirects, and validates the success payload/status. Do not add retry/backoff logic.

- [ ] **Step 8: Write and implement provider error classification**

Test 401/`invalid_grant`, `invalid_client`, funding/plan 402/403, scope 403, 429 reset, 5xx, transport failure, and malformed errors. Return stable bounded categories without provider bodies or credentials.

- [ ] **Step 9: Run package tests and commit**

```bash
pnpm --dir packages/gatekeeper-x exec vitest run __tests__/x-api.test.ts
```

```bash
git add packages/gatekeeper-x/package.json \
  packages/gatekeeper-x/src/x-api.ts \
  packages/gatekeeper-x/src/types.d.ts \
  packages/gatekeeper-x/__tests__/x-api.test.ts \
  pnpm-lock.yaml
git commit -m "feat: add fixed-origin X API client"
```

## Task 3: Implement secure per-user X OAuth and account lifecycle

**Files:**
- Create: `packages/gatekeeper-x/src/connect-form.ts`
- Create: `packages/gatekeeper-x/src/x.ts`
- Create: `packages/gatekeeper-x/__tests__/connect-form.test.ts`
- Create: `packages/gatekeeper-x/__tests__/x-auth.test.ts`
- Create: `packages/gatekeeper-x/wrangler.jsonc`
- Generate: `packages/gatekeeper-x/worker-configuration.d.ts`

- [ ] **Step 1: Write failing localized credential-form tests**

Assert English/Japanese forms contain:

- exact callback URL;
- confidential Web App, credits, spending-limit, and scope guidance;
- client ID and password-type client-secret inputs;
- same-origin POST action;
- no script, stored secret, or query credential;
- no-store, CSP, referrer, and nosniff headers;
- English fallback for invalid language.

- [ ] **Step 2: Implement the no-JavaScript bounded form**

Escape all dynamic HTML. Limit POST content type and bytes before parsing. Do not use Workshop/admin connector configuration.

- [ ] **Step 3: Write failing vendor/initiation tests**

Assert `GatekeeperVendor`:

- reports vendor ID/display `X`, `providesAuth: false`, and no deployment configuration;
- advertises exactly one `X Account` resource with `https://*` and `workspaceAccess: "owner-only"`;
- creates unique account DOs and 256-bit initiation nonces;
- persists resolved language and abandonment alarm;
- returns only the nonce-bearing gatekeeper URL.

- [ ] **Step 4: Implement vendor and HTTP initiation routing**

Require the Worker request path to match `BASE_URL`. Accept only exact GET/POST initiation shapes and GET `/oauth`; reject all other methods/routes.

- [ ] **Step 5: Write failing nonce/PKCE/callback tests**

Cover:

- one claimant among concurrent credential POSTs;
- expired/replayed initiation nonce;
- independent state and verifier;
- exact S256 challenge;
- callback state consumed before exchange;
- callback replay reaches token exchange once;
- malformed DO IDs/state, wrong method, denial, and expired callback fail closed;
- candidate credentials are removed on failure.

- [ ] **Step 6: Implement the transactional OAuth state machine**

Persist only in the account DO. Consume replay material synchronously before network I/O and recheck attempt generation after awaits.

- [ ] **Step 7: Write failing initial completion tests**

Require exact scopes and `/users/me`; cache the profile; use `x:<id>` as `uniqueName`; store credentials/tokens before callback; ensure `describe()` makes no extra fetch; erase all credentials if Workshop completion rejects a duplicate account.

- [ ] **Step 8: Implement account completion and cached description**

`ctx.props` may contain only the account DO ID/capability and non-secret resource metadata. Never return credentials or tokens from account RPC.

- [ ] **Step 9: Write failing reconnect/refresh race tests**

Cover:

- reconnect requires credential re-entry without returning the old secret;
- same immutable X user ID succeeds and increments generation;
- different X user ID or incomplete scopes preserve old credentials;
- concurrent refresh is single-flight;
- rotated refresh token is committed before waiters resume;
- stale callback/refresh cannot overwrite a newer generation;
- invalid grant notifies expiry once;
- transport/funding errors do not mark credentials expired.

- [ ] **Step 10: Implement serialized credential updates**

Serialize refresh, reconnect, and revoke. Generation-check every candidate commit. Retain old usable credentials until a replacement grant and identity have fully validated.

- [ ] **Step 11: Write failing revoke/alarm tests**

Assert disconnect deletes callback, client ID/secret, access/refresh token, profile, state, verifier, pending candidates, and alarms. Abandoned incomplete accounts self-delete. Do not invent an unsupported X revocation endpoint.

- [ ] **Step 12: Implement unconditional local cleanup**

Return user guidance in README/UI for provider-side revocation from X settings.

- [ ] **Step 13: Generate Wrangler types and run focused tests**

```bash
pnpm --dir packages/gatekeeper-x exec wrangler types
pnpm --dir packages/gatekeeper-x exec vitest run \
  __tests__/connect-form.test.ts \
  __tests__/x-auth.test.ts
```

Expected: all pass and generated `Env` contains `BASE_URL` only, with no X credential binding.

- [ ] **Step 14: Commit**

```bash
git add packages/gatekeeper-x/src/connect-form.ts \
  packages/gatekeeper-x/src/x.ts \
  packages/gatekeeper-x/__tests__/connect-form.test.ts \
  packages/gatekeeper-x/__tests__/x-auth.test.ts \
  packages/gatekeeper-x/wrangler.jsonc \
  packages/gatekeeper-x/worker-configuration.d.ts
git commit -m "feat: add per-user X OAuth connection"
```

## Task 4: Expose whole-account X reads with observation authorization

**Files:**
- Modify: `packages/gatekeeper-x/src/x.ts`
- Modify: `packages/gatekeeper-x/src/types.d.ts`
- Create: `packages/gatekeeper-x/__tests__/x-session.test.ts`

- [ ] **Step 1: Write failing resource/session tests**

Assert canonical account description uses cached profile, suggested binding `X_ACCOUNT`, type `XAccountSession`, owner-only policy, and no custom resource configurator.

- [ ] **Step 2: Implement the whole-account gatekeeper facet**

Mint the facet with only account DO identity in props. `getAutoApprovableActions()` returns `[]`.

- [ ] **Step 3: Write one failing test per read method**

For every method in the design, assert:

1. input validation occurs before account RPC;
2. account RPC makes one X request;
3. `authorizeObservation()` completes before data is returned;
4. a rejected authorization exposes no data;
5. observation descriptions contain bounded safe metadata, not full posts/searches.

- [ ] **Step 4: Implement session reads and explicit pagination**

Return provider-neutral normalized data and `nextToken`; never loop pages. Duplicate the authorizer capability only when required by the existing RPC pattern and dispose temporary stubs correctly.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --dir packages/gatekeeper-x exec vitest run \
  __tests__/x-api.test.ts \
  __tests__/x-auth.test.ts \
  __tests__/x-session.test.ts
```

```bash
git add packages/gatekeeper-x/src/x.ts \
  packages/gatekeeper-x/src/types.d.ts \
  packages/gatekeeper-x/__tests__/x-session.test.ts
git commit -m "feat: expose authorized X account reads"
```

## Task 5: Add crash-safe manually approved X mutations

**Files:**
- Create: `packages/gatekeeper-x/src/x-actions.ts`
- Modify: `packages/gatekeeper-x/src/x.ts`
- Modify: `packages/gatekeeper-x/src/x-api.ts`
- Modify: `packages/gatekeeper-x/src/types.d.ts`
- Create: `packages/gatekeeper-x/__tests__/x-actions.test.ts`

- [ ] **Step 1: Write failing action-store state tests**

Specify `staged -> pending -> applying -> applied` and terminal `rejected`, `failed`, `stale`, `outcome-unknown` states. Test synchronous claim before await, concurrent apply, DO re-instantiation during `applying`, and payload minimization.

- [ ] **Step 2: Implement the typed action store**

Persist normalized actions in the facet DO. Never treat `applying` as retryable. Allocate IDs monotonically and place reasonable caps on retained terminal records.

- [ ] **Step 3: Write failing queue-before-I/O tests for every mutation**

Assert each session mutation:

- validates IDs/text;
- captures current credential generation;
- persists staged action;
- calls `submitAction()` before any X fetch;
- uses `awaitDecision: true`;
- omits `autoApprovable` and `actionKind`;
- safely fences/caps untrusted text in approval descriptions;
- makes no optimistic read simulation.

- [ ] **Step 4: Implement action staging and descriptions**

Descriptions include every approval-relevant target and post text while excluding credentials and provider internals. Keep titles bounded.

- [ ] **Step 5: Write failing apply/reject tests**

Cover:

- one X request for two concurrent applies;
- owner approval success;
- rejected action performs no request and removes private payload;
- generation mismatch becomes stale before request;
- definite 4xx is terminal failed;
- network/5xx/malformed dispatched result becomes outcome unknown;
- no automatic or same-action retry;
- all write paths use stored actor ID.

- [ ] **Step 6: Implement at-most-once application**

Claim `pending -> applying` before account RPC. Pass expected generation to the account DO. Minimize payload after every terminal state.

- [ ] **Step 7: Run all X tests and commit**

```bash
pnpm --dir packages/gatekeeper-x exec vitest run
```

```bash
git add packages/gatekeeper-x/src/x-actions.ts \
  packages/gatekeeper-x/src/x.ts \
  packages/gatekeeper-x/src/x-api.ts \
  packages/gatekeeper-x/src/types.d.ts \
  packages/gatekeeper-x/__tests__/x-actions.test.ts
git commit -m "feat: queue crash-safe X mutations"
```

## Task 6: Integrate X into dev, release, docs, and localization gates

**Files:**
- Create: `packages/gatekeeper-x/deploy-inputs.json`
- Create: `packages/gatekeeper-x/README.md`
- Modify: `README.md`
- Modify: `scripts/run-dev-server.ts`
- Modify: `scripts/dev-server-config.test.ts`
- Modify: `scripts/release/testdata/golden-manifest.json`
- Modify: `scripts/release/manifest.test.ts`
- Modify: `scripts/build-gatekeeper-configurator.test.ts` if package discovery requires it
- Modify: `packages/workshop-backend/worker-configuration.d.ts` via generated config only if required
- Modify: `packages/router/worker-configuration.d.ts` via generated config only if required

- [ ] **Step 1: Write failing no-deployment-credentials manifest test**

Assert the generated X entry is installable with:

```json
{"inputs": []}
```

and has only templated `BASE_URL`; no X `CLIENT_ID`, `CLIENT_SECRET`, bearer token, or secret binding exists anywhere in the entry.

- [ ] **Step 2: Add empty deploy inputs and regenerate the release golden manifest**

Create exactly:

```json
[]
```

Run the repository's manifest generator/test update path, inspect the X entry, and never manually paste hashes that the generator can produce.

- [ ] **Step 3: Write failing dev-server topology tests**

Assert package discovery launches `gatekeeper-x`, and backend/router receive `GATEKEEPER_X` service bindings without reading any `X_CLIENT_ID` or `X_CLIENT_SECRET` environment variable.

- [ ] **Step 4: Implement generic discovery integration only where needed**

Prefer existing package discovery. Do not add X to the deployment-admin credential descriptor map.

- [ ] **Step 5: Add English/Japanese completion tests for the X form/policy**

Ensure connection form dictionaries have structural parity and Japanese does not equal English for visible prose. Preserve `X`, URLs, scopes, IDs, and user content.

- [ ] **Step 6: Write package and root documentation**

Document app creation, exact callback, confidential Web App selection, exact scopes, pay-per-use credits, spending limits, owner-only workspaces, approval behavior, pagination caps, reconnect, local disconnect, and X-side revocation. Do not include real IDs or credentials.

- [ ] **Step 7: Run release/dev/documentation checks**

```bash
pnpm --dir packages/gatekeeper-x exec wrangler types --check
pnpm --dir packages/gatekeeper-x exec vitest run
node --test scripts/dev-server-config.test.ts scripts/release/manifest.test.ts
pnpm test
```

If the loaded host causes an unchanged five-second test timeout, reproduce that exact test sequentially before classifying it as environmental. Do not increase global timeouts as a shortcut.

- [ ] **Step 8: Commit**

```bash
git add packages/gatekeeper-x/deploy-inputs.json \
  packages/gatekeeper-x/README.md README.md \
  scripts/run-dev-server.ts scripts/dev-server-config.test.ts \
  scripts/release/testdata/golden-manifest.json \
  scripts/release/manifest.test.ts \
  scripts/build-gatekeeper-configurator.test.ts \
  packages/workshop-backend/worker-configuration.d.ts \
  packages/router/worker-configuration.d.ts
git commit -m "feat: ship the X gatekeeper"
```

Only add generated/configuration files that actually changed.

## Task 7: Verify and review the runtime branch

**Files:**
- Review all changes since `049d83df166de61f8e047a8d824edabc904262d2`

- [ ] **Step 1: Run focused security invariant searches**

```bash
rg -n 'X_CLIENT|CLIENT_SECRET|CLIENT_ID|accessToken|refreshToken' \
  packages/gatekeeper-x scripts/release/testdata/golden-manifest.json
```

Manually confirm every hit is a local storage key, form field, test fixture, or documentation placeholder—not an environment binding, log, URL, props value, or returned RPC value.

- [ ] **Step 2: Run complete verification**

```bash
pnpm lint
pnpm build
pnpm test
pnpm --dir packages/workshop-frontend test
pnpm --dir packages/workshop-backend test
pnpm --dir packages/gatekeeper-x exec vitest run
pnpm --dir packages/gatekeeper-x exec wrangler deploy --dry-run
pnpm --dir packages/gatekeeper-x exec wrangler check startup

git diff --check origin/main...HEAD
```

Record exact pass/fail counts. Sequentially reproduce any known loaded-host timeout.

- [ ] **Step 3: Run a local high-risk code-quality review**

Because this changes a core authorization policy and adds an OAuth/billing trust boundary, invoke the code reviewer with the design, plan, base SHA, and head SHA. Fix all Critical and Important findings using TDD and rerun affected tests. Re-review once after fixes.

- [ ] **Step 4: Commit review fixes if any**

Use a narrow commit message describing the fixed invariant.

- [ ] **Step 5: Push and open the runtime PR**

Use the git-pull-request skill. The PR must include:

- owner-only authorization model;
- per-user X app/funding invariant;
- exact MVP/non-goals;
- OAuth/action failure behavior;
- verification evidence;
- live-test limitation requiring a user-funded X app;
- downstream starter/deployment steps.

Request `@codex review`. Do not merge until checks pass and the user authorizes merge, unless their current request is treated as explicit authorization for the complete merge/deploy workflow and repository policy permits it.

## Task 8: Pin the merged runtime in `company_os_starter`

**Prerequisite:** Runtime PR merged and merge commit recorded.

**Files:**
- Modify gitlink: `cloudflare-os`
- Modify: `scripts/deploy.test.mjs` only if the new manifest exposes a starter regression
- Modify: `docs/automation-contract.md` only if the generic connector contract changes

- [ ] **Step 1: Create an isolated starter worktree from current `origin/main`**

Use branch `feature/x-integration` under the existing sibling worktree convention. Initialize the submodule and install the frozen lockfile with Node 22.

- [ ] **Step 2: Write a failing managed-deployment regression if needed**

The rendered deployment must accept a connector topology containing `gatekeeper-x`, deploy the worker, and bind Workshop/router through the existing generic expansion without any X deployment secret.

- [ ] **Step 3: Pin the runtime merge and run tests**

```bash
git -C cloudflare-os fetch origin main
git -C cloudflare-os checkout --detach <runtime-merge-sha>
pnpm test
```

Generate a temporary tenant deployment config containing the new connector topology and run:

```bash
pnpm check --deployment-config <ignored-mode-0600-config>
```

- [ ] **Step 4: Commit, push, open, review, and merge the starter PR**

Commit only the gitlink and any proven generic regression/docs change. Request `@codex review`, wait for checks, then merge according to the authorized rollout workflow.

## Task 9: Plan and deploy vlightup staging

**Prerequisites:** Runtime and starter PRs merged; deployment repository remains on current `main`; vlightup AI remains disabled.

**Private files:**
- Read existing: `company-os-deployments/.operations/vlightup/staging/vlightup.connector-topology.json` or the current canonical topology artifact
- Create ignored mode-0600: `company-os-deployments/.operations/vlightup/staging/vlightup.x.connector-topology.json`
- Create ignored mode-0600 plan/deploy logs and evidence under the same directory

- [ ] **Step 1: Verify downstream source commits and private-file protections**

Record runtime, starter, and deployment commits plus SHA-256 digests of manifest, Access handoff, adoption proof, topology, and credential file. Private directories must be `0700`; files `0600`.

- [ ] **Step 2: Derive a closed fifteen-connector topology**

Copy the current canonical topology inside the ignored operations directory and add only the X connector using the managed worker name and binding convention:

```text
<worker-prefix>x
GATEKEEPER_X
/gatekeeper/x
```

Validate it with the deployment repository's topology loader/tests. Preserve the existing fourteen entries byte-for-byte where possible. Do not create deployment X credential fields.

- [ ] **Step 3: Run the read-only managed plan**

Use the merged starter checkout and the existing Access handoff/resource-adoption inputs:

```bash
mise exec node@24.13.0 -- pnpm cli -- plan vlightup \
  --starter <merged-starter-checkout> \
  --access-handoff <mode-0600-access-handoff> \
  --resource-adoption <mode-0600-adoption-proof> \
  --connector-topology <mode-0600-x-topology>
```

Capture stdout/stderr mode `0600`. Require:

- fifteen connector Workers verified/planned;
- existing KV/R2 reused;
- existing Access preserved;
- one new X Worker created;
- Workshop/router bindings updated;
- starter check passed;
- `DEFAULT_LANGUAGE=ja` preserved;
- no AI Gateway or `REQUIRE_USER_FUNDED_AI` binding added.

Stop and investigate any unrelated create/delete/adoption action.

- [ ] **Step 4: Revalidate digests and deploy**

Run the corresponding `deploy vlightup` command only after the exact plan and input digests are recorded and unchanged. Capture mode-0600 evidence.

- [ ] **Step 5: Verify live staging**

Verify:

- new versions for Workshop, router if managed separately, context/gatekeeper/reporter as planned, and `gatekeeper-x`;
- Workshop and router include `GATEKEEPER_X`;
- X Worker contains `BASE_URL` and no `CLIENT_ID`, `CLIENT_SECRET`, bearer token, or platform credential;
- Workshop still has `DEFAULT_LANGUAGE=ja`;
- AI remains disabled;
- public Workshop URL returns the expected Cloudflare Access `302`;
- an authenticated English and Japanese connect attempt reaches the localized X credential form without exposing or requiring deployment credentials.

A real OAuth/write smoke test is conditional on the operator entering a funded user-owned X app through the form. Never request or persist that secret in chat, git, shell history, plan logs, or evidence.

- [ ] **Step 6: Record evidence and clean worktrees**

Copy final ignored evidence to the owning deployment repository, verify mode `0600`, check all repositories are clean, and remove merged feature/deployment worktrees using the finishing-development-branch workflow.
