# GitHub Account-Only Connection Implementation Plan

**Goal:** Show one GitHub Account choice for new connections and extend its read-only capability so agents can resolve repositories and inspect code, issues, and pull requests without scoped pickers.

**Architecture:** Keep the complete supported-resource catalog for compatibility, add an enforceable `newConnectionsAllowed` policy, and deny new GitHub scoped bindings at UI, agent, and capability-minting boundaries while persisted scoped classes remain usable. Add a bounded account resolver plus explicit read-only issue/PR operations. Every account observation forces sharing lockdown, and all remote reads use the credential-aware API boundary and repository-qualified caches.

**Tech stack:** TypeScript, React, Cloudflare Workers RPC/Durable Objects, Vitest, pnpm/Vite+.

---

## Task 1: Separate resource support from new-binding eligibility

**Files:**
- Modify: `packages/workshop-shared/src/gatekeeper.ts`
- Modify: `packages/workshop-frontend/src/ResourcePicker.tsx`
- Modify: `packages/workshop-frontend/src/ResourcePicker.test.tsx`
- Create: `packages/gatekeeper-github/src/github-resources.ts`
- Create: `packages/gatekeeper-github/__tests__/github-resources.test.ts`
- Modify: `packages/gatekeeper-github/src/github.ts`

1. Write failing frontend tests proving `newConnectionsAllowed: false` resources disappear from `ResourcePicker`, including existing OAuth-account and refinement choices, while omitted/true resources remain visible.
2. Add a GatekeeperModal regression test proving blocked resource types are absent.
3. Add the optional property to `SupportedResource`, documented as an enforceable new-binding policy defaulting to true.
4. Filter ResourcePicker, GatekeeperModal, and agent discovery/request surfaces without filtering admin or compatibility catalogs.
5. Enforce the policy in `UserDurableObject.getGatekeeperClassFor()` and add a direct-bypass regression test.
6. Move resource declarations to a pure module, mark repository/issue/PR false, and keep `getSupportedResources()` returning all four.
7. Prove persisted scoped gatekeepers rehydrate from their stored class without invoking the new-capability path.
8. Run focused frontend, backend, and GitHub tests.

## Task 2: Add deterministic repository resolution

**Files:**
- Create: `packages/gatekeeper-github/src/github-repo-resolution.ts`
- Create: `packages/gatekeeper-github/__tests__/github-repo-resolution.test.ts`
- Modify: `packages/gatekeeper-github/src/types.d.ts`
- Modify: `packages/gatekeeper-github/src/github.ts`

1. Define a discriminated `GitHubRepoResolution` result and `resolveRepo(input)` account method.
2. Write failing unit tests for literal `owner/name`, canonical repository URLs, preserved `.git` suffixes, rejected surrounding whitespace, case-insensitive exact bare-name matches, owner/collaborator/organization pages, zero matches, duplicate names across owners, malformed input, and the hard pagination bound.
3. Implement direct credentialed repository lookup for exact qualified `owner/name` values and canonical repository URLs without trimming or suffix removal; it must not depend on listing pagination.
4. Implement callback-driven bounded all-affiliations pagination only for bare repository names so ambiguity behavior is testable without Worker runtime mocks.
5. Never return a bare-name unique result until all bounded pages prove uniqueness; a bound failure asks for qualified `owner/name`.
6. Test direct qualified lookup even when the repository would lie beyond the listing bound.
7. Add account-session approval and delegation with `prohibitAllSharing: true`; return canonical repository summaries only and prevent reads when authorization rejects.
8. Run focused tests and typecheck.

## Task 3: Define safe account issue and pull-request searches

**Files:**
- Modify: `packages/gatekeeper-github/src/types.d.ts` (`src/types.txt` is a tracked symlink to this file; verify the link and equality during tests)
- Modify: `packages/gatekeeper-github/src/github-search.ts`
- Create: `packages/gatekeeper-github/__tests__/github-search.test.ts`

1. Write failing tests for `is:pr` query construction with quoted text/labels/actors and exact owner/repository scope.
2. Write failing tests for issue and PR validators covering wrong host, malformed URL, cross-owner, cross-repository, and wrong kind.
3. Generalize kind-aware validation without weakening issue checks.
4. Add `GitHubAccountPullRequestSearch` and an issue-search-shaped PR result type; document that full PR fields come from `getPullRequest()`.
5. Run focused tests and typecheck.

## Task 4: Implement repository-qualified account reads

**Files:**
- Modify: `packages/gatekeeper-github/src/github.ts`
- Modify: `packages/gatekeeper-github/src/types.d.ts` (and its `src/types.txt` symlink target)
- Modify: `packages/gatekeeper-github/__tests__/github-code.test.ts`
- Create or modify: account cache-key unit tests

1. Write failing tests for shared helpers that validate canonical repository identifiers, positive safe issue/PR numbers, and finite integer account page sizes from 1 through 200.
2. Add account-gatekeeper operations for scoped PR search, issue details, PR details, and PR diff pages.
3. Route every API call through `#withApi()`; account cache keys normalize owner/repository case and include owner/repository/kind/number/revision.
4. Add explicit tests proving identical issue/PR numbers and diff revisions in two repositories cannot share cache entries.
5. Reject PR-shaped results from `getIssue()` with the friendly wrong-kind error after validating repository/number; return `/pull/{number}` URLs for PR details; reject issue-shaped/wrong-number PR responses.
6. Extract/reuse diff-file normalization so account and legacy sessions return the same shape.
7. Add account-session methods that validate page size before approval, force `prohibitAllSharing: true` on every observation/cursor creation, and delegate only after authorization.
8. Preserve existing non-atomic cursor semantics and document concurrent PR-update behavior.
9. Add the strongest feasible tests for approval and `401` expiry handling; if Worker integration is required, add a focused integration fixture rather than bypassing the invariant.
10. Verify `src/types.txt` remains a symlink to `types.d.ts` and therefore serves the updated public agent types.
11. Run focused tests and typecheck.

## Task 5: Update product and package copy

**Files:**
- Modify: `packages/gatekeeper-github/src/configurator/github-account-configurator-ui.tsx`
- Modify: `packages/gatekeeper-github/src/github.ts`
- Modify: `packages/gatekeeper-github/src/types.d.ts`
- Modify: `packages/gatekeeper-github/README.md`

1. Describe one account connection for repository discovery, code, issue details, PR details, and diffs.
2. Explicitly state account sessions are read-only and owner-only; discussion threads/writes exist only on grandfathered persisted scoped bindings and cannot be newly connected.
3. Update vendor text so it does not imply account-wide writes.
4. Build the configurator and inspect generated changes.

## Task 6: Compatibility and full verification

1. Add strict canonical GitHub URL parser regressions for scheme, origin, credentials, ports, query/fragment, path shape, owner/repository, and positive safe entity numbers.
2. Add/extend tests showing the new-binding policy does not remove scoped types from admin/compatibility catalogs or persisted gatekeeper rehydration.
3. Run `pnpm --filter @gadgets/github-gatekeeper test:run`.
4. Run focused `workshop-frontend` tests.
5. Run repository lint/typecheck required by `AGENTS.md`.
6. Run relevant builds, including GitHub configurator and Workshop frontend.
7. Inspect `git diff --check`, status, and complete diff for generated/private artifacts.
8. Request independent code-quality, security, and spec reviews; address findings test-first.
9. Re-run all verification.
10. Commit and open a focused runtime PR if authorized. Do not pin the starter or deploy without separate explicit approval.
