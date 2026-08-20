# GitHub Account-Only Connection Design

## Goal

Replace the GitHub repository, issue, and pull-request choices in **Create New Connection** with one **GitHub Account** choice. After one explicit account connection, the agent resolves repositories from the user's request and can safely inspect accessible repositories, code, issues, and pull requests without another picker.

## User experience

1. The connection picker advertises exactly one GitHub resource: **GitHub Account**.
2. Connecting it performs the existing GitHub OAuth account flow and creates the account resource at `https://github.com`.
3. A user may provide `owner/name`, a repository URL, or an unqualified repository name.
4. A backend resolver—not prompt convention alone—handles repository resolution:
   - canonical `owner/name` or a repository URL uses direct credentialed lookup of that exact accessible repository and never depends on list pagination;
   - an unqualified name matches case-insensitively by exact repository name across every repository returned for the account's owner, collaborator, and organization-member affiliations;
   - zero matches return an explicit not-found result;
   - multiple matches return explicit ambiguity candidates and never select one;
   - bounded pagination fails with a request for `owner/name` rather than accepting an incomplete result.
5. Once resolved, account-level read tools support repository metadata, branches, trees, files, code search, issue search/details, pull-request search/details, and pull-request diffs.
6. Account-wide tools remain read-only. Comments, edits, labels, reviews, merges, and other mutations are not exposed by the account session.

## Supported resources versus new-binding policy

`getSupportedResources()` is a compatibility and admin-policy catalog used by blueprints, disabled-resource controls, and persisted binding metadata. It continues returning all four GitHub resource types.

Add an optional, backward-compatible `newConnectionsAllowed` property to `SupportedResource`, defaulting to `true`. Repository, issue, and pull-request resources set it to `false`; the account resource uses the default. Every new-binding surface filters this policy: `ResourcePicker` (including existing OAuth-account choices and URL refinement), `GatekeeperModal`, agent discovery/request flows, and direct resource-configurator startup. `UserDurableObject.getGatekeeperClassFor()` enforces it again at the capability-minting chokepoint so a crafted client cannot bypass the filters.

Existing persisted scoped gatekeepers retain their stored classes and rehydrate without calling the new-capability chokepoint, preserving their scoped reads and mutations. The full catalog remains available to admin and compatibility consumers, but scoped blueprint references cannot mint a new scoped binding. No storage migration is required.

## Authorization model

The OAuth grant has the existing `repo`, `read:user`, and `user:email` scopes, but the capability exposed by `GitHubAccount` is read-only. Every account operation, including repository resolution and cursor creation, authorizes an observation with `prohibitAllSharing: true` before any read occurs. The Overseer rejects the observation when the workspace is already shared; otherwise it permanently disables future sharing and actions for that workspace. Lockdown is serialized against every mutation that can create or extend non-owner access: the transition that starts first may finish and the other fails closed. Sharing revocation starts before graph reachability changes and blocks both account observations and action application through observer cleanup and live-session invalidation. Each permission-graph revocation and its affected-user computation run in one synchronous Durable Object storage transaction, so a post-write exception rolls the complete graph mutation back before the transition can be released. The durability barrier must complete and the delayed abort must be registered with `waitUntil` before a committed revocation reports success; sync failure reports failure and schedules a fail-closed abort. When anyone is affected, only the Overseer restart clears that in-memory transition. Lazy cursor page fetches remain behind the authorized operation and all remote calls use the credential-aware API boundary.

Existing persisted repository/issue/pull-request connections retain their scoped mutation methods for compatibility. No new scoped connection can be created through UI, agent, blueprint, or direct capability-minting paths. A future just-in-time write authorization flow is out of scope.

## Repository resolution

Add `resolveRepo(input)` to the account capability. It returns a discriminated result: `resolved`, `notFound`, or `ambiguous`. Ambiguous results contain only canonical accessible repository summaries so the agent can ask the user to choose.

Exact qualified names and canonical repository URLs use direct authenticated repository lookup, including repositories that would fall beyond any listing bound. Inputs are literal: qualified identifiers are not trimmed and `.git` is not silently removed. Bare names use exact, case-insensitive matching over the all-affiliations repository listing ordered stably by ascending `full_name`, with a hard page/result limit. Reaching the limit before proving uniqueness returns a bounded-resolution error instructing the user to provide `owner/name`; it must not return a potentially incorrect result.

Explicit repository identifiers and URLs use the strict GitHub parser. Resource URLs must be canonical `https://github.com` URLs with no userinfo, port, query, fragment, duplicate slash, trailing segment, or invalid owner/repository/number. Issue and PR numbers are positive safe integers. Non-GitHub, whitespace-normalized, and malformed inputs fail without widening scope.

## Issue and pull-request reads

The account session adds:

- `searchPullRequests(query)`, scoped like account issue search;
- `getIssue(repo, number)`, returning issue body/metadata and rejecting pull requests;
- `getPullRequest(repo, number)`, returning pull-request body, refs, and metadata;
- `readPullRequestDiff(repo, number, options)`, returning revision metadata and paged changed-file hunks.

Account issue search stays `is:issue`. Pull-request search uses `is:pr`, verifies owner/repository and result kind, and returns issue-search-shaped pull-request summaries; callers use `getPullRequest()` for full PR-only fields. Supported search filters must match what GitHub search can enforce safely.

Pull-request diff revision metadata describes the revision observed when the diff was opened. As in the existing scoped API, later pages are not an atomic snapshot and may reflect a concurrent PR update. Account cursor page sizes are validated before approval as finite positive integers with a maximum of 200. This must be documented rather than described as fully pinned.

Issue/PR top-level comments, review summaries, and diff discussion threads remain available only to legacy scoped sessions in this initial change. User-facing copy promises issue/PR details and diffs, not complete discussion-thread inspection.

## Data isolation

All multi-repository account caches include case-normalized owner, repository, entity kind, entity number, and revision where applicable. No account read may reuse the legacy scoped cache keys that contain only an issue/PR number. Tests cover identical issue and PR numbers in two repositories.

## Credential behavior

All account reads and legacy observer verification execute through the credential-aware API boundary. Each request uses a snapshot containing the token and its monotonically increasing credential generation. A delayed `401` can mark only the generation that issued the request, so it cannot expire a later reconnect. Expiry delivery is latched only after the Workshop callback succeeds; callback failure remains internal, returns stable reconnect guidance, and allows a later `401` to retry notification instead of exposing raw `Bad credentials`.

The deployment does not rotate or rewrite OAuth grants. Shared connector Worker identity and Durable Object storage remain unchanged by tenant deployment.

## Testing

Tests establish:

1. the full supported-resource catalog still contains account/repository/issue/PR, while only account permits new bindings;
2. all UI and agent new-binding surfaces filter blocked types, direct capability minting rejects them, persisted scoped gatekeepers still rehydrate, and admin/compatibility catalogs remain complete;
3. the repository resolver handles URLs, `owner/name`, stable all-affiliations pagination, zero matches, ambiguity, and the hard bound without guessing;
4. issue/PR query builders quote user input and cannot escape owner/repository scope;
5. validators reject cross-owner, cross-repository, wrong-host, non-canonical URL, malformed, and issue-vs-PR mismatches;
6. account reads validate repository names and positive integer numbers and isolate same-number cache entries across repositories;
7. account capability types expose no mutation methods;
8. every account operation forces `prohibitAllSharing`, rejection prevents reads, and deferred backend tests cover sharing grants, key redemption, action application, atomic revocation rollback, durability failure, and restart registration in both race orderings with lockdown;
9. credential tests cover generation-bound stale `401`s, retry after callback failure, verifier expiry handling, and reconnect guidance;
10. account cursor page sizes reject non-finite, non-positive, fractional, and greater-than-200 values before approval or cached/uncached cursor creation;
11. `src/types.txt` remains the tracked symlink to `types.d.ts`, so runtime-served agent types include the new account methods;
12. package tests, frontend tests, repository lint/typecheck, and build pass.

## Documentation

Update GitHub gatekeeper README, vendor/resource descriptions, configurator copy, and account type comments. Copy must distinguish account-wide read capability from legacy scoped write capability and must not promise a new write-authorization flow.

## Deployment boundary

This change is prepared and reviewed in the runtime repository first. Pinning it in the starter, planning Vlightup, and deploying are separate steps and require explicit operator approval before any remote mutation.
