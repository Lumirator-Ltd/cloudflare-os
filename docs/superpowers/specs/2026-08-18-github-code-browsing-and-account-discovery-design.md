# GitHub Code Browsing & Account-Wide Discovery — Design

**Date:** 2026-08-18
**Package:** `packages/gatekeeper-github`
**Status:** Approved (user confirmed: broad account resource OK; account connections not observable by collaborators; code search limited to the default branch; proceed to implementation).

## Problem

Users can connect GitHub, but agents cannot:

1. **Find which repo contains the answer to a message.** Connections are scoped to a single
   repo/issue/PR chosen by the user at connect time. There is no account-wide discovery
   (list repos, search repos, search code/issues across repos).
2. **Read the codebase.** The agent-facing `GitHubRepo` session exposes only issues, PRs,
   reviews, and discussions — no branches, file trees, file contents, or code search
   (the `TODO` at the top of `src/types.d.ts`).

## Design Overview

Two additions to the GitHub gatekeeper, sharing one parameterized code-read layer:

### A. Code browsing on grandfathered `GitHubRepo` sessions

These methods remain available only on already-persisted legacy scoped bindings; new scoped
bindings cannot be created. New read-only session methods (all authorize an observation; none touch the ApprovalQueue
action path, since they cannot mutate anything):

- `getMetadata()` — extended: `GitHubRepoMetadata` gains `defaultBranch: string`.
- `listBranches(options?)` → `Cursor<GitHubBranch>` (`GET /repos/{o}/{r}/branches`, lazily paged).
- `readTree(options?: { ref?, path?, recursive?, resultsPerPage? })` →
  `GitHubRepoTree { ref, sha, truncated, entries: Cursor<GitHubTreeEntry> }`
  (`GET /repos/{o}/{r}/git/trees/{ref}?recursive=1`; `ref` defaults to the default branch;
  `path` filters entries to a subtree prefix; GitHub's `truncated` flag is surfaced).
- `readFile(path, options?: { ref? })` → `GitHubFileContent { path, ref, sha, size, text, isBinary, url }`
  (`GET /repos/{o}/{r}/contents/{path}?ref=`; base64 decoded to UTF-8). Files over GitHub's
  1 MB contents-API limit throw a descriptive error. Directories throw with a pointer to
  `readTree`. Binary files (NUL byte sniff in the first 8 KB) return `isBinary: true` with
  empty `text`.
- `searchCode(query: GitHubCodeSearch)` → `Cursor<GitHubCodeSearchResult>`
  (`GET /search/code`, `repo:` qualifier, text-match media type for snippet fragments).
  **Default-branch only** — documented in the TS types so agents know to use `readTree`/
  `readFile` with an explicit `ref` for other branches.

### B. New account-level resource: "GitHub Account"

A fourth `SupportedResource` with `urlPattern: "https://github.com"` (the bare origin —
precedent: Confluence's site-wide resource). Session type `GitHubAccount`:

- `getMetadata()` → `GitHubAccountMetadata { login, displayName?, url, avatarUrl? }` (viewer).
- `listRepos(options?)` → `Cursor<GitHubRepoSummary>` (`/user/repos`,
  affiliation owner+collaborator+org-member, sorted by `updated`).
- `searchRepos(query)` → `Cursor<GitHubRepoSummary>` (`/search/repositories`,
  scoped `user:{login}` by default, optional `owner` override).
- `searchCode(query)` → `Cursor<GitHubCodeSearchResult>` account-wide; scoped
  `user:{login}` by default, with optional `owner` (org) or `repo` ("owner/name") narrowing.
  Known limitation (documented): GitHub search qualifiers cannot express "everything my
  token can read" in one query; org/collaborator repos need an explicit `owner`/`repo`
  scope, discoverable via `listRepos`.
- `searchIssues(query)` → `Cursor<GitHubIssueSummary>` account-wide (summaries carry
  `repo` refs), same scoping rules. This directly serves "which repo has the answer".
- Per-repo code reads on any accessible repo, parameterized by `repo: "owner/name"`:
  `getRepoMetadata(repo)`, `listBranches(repo, options?)`, `readTree(repo, options?)`,
  `readFile(repo, path, options?)`.

**Deliberately excluded from the account session:** issue/PR capability objects and all
write operations. New scoped connections are unavailable. Only already-persisted legacy
repository, issue, and pull-request bindings retain their scoped discussions and writes for
compatibility; the account session remains read-only.

## Architecture & Data Flow

```
Agent code (executeCode)
  └─ GitHubRepoSessionImpl / GitHubAccountSessionImpl   (RpcTarget; authorizeObservation per call)
       └─ GitHubGatekeeperImpl (DO)                     (cache + cursor construction)
            └─ GitHubApi                                (REST; ETag conditional requests)
```

- **One DO class, one new `resourceKind`.** `GitHubGatekeeperImplProps.resourceKind` gains
  `"account"`; `owner`/`repo` become optional (present only for repo/issue/pull kinds).
  No new Durable Object classes → no wrangler migrations.
- **Parameterized code-read layer.** All new DO read methods take explicit `owner`/`repo`
  arguments (repo sessions pass their props; account sessions pass caller-supplied values),
  and cache keys include `owner/repo`. This avoids the storage-key collisions that would
  occur if the existing props-bound issue/PR machinery were reused across repos —
  which is also why the account session does not hand out full `GitHubRepo` sub-sessions.
- **Caching.** Metadata/tree/contents use the existing `#loadCachedWithEtag` pattern
  (`ENTITY_CACHE_TTL_MS`). Code/repo/issue search pages use a plain TTL cache
  (`CODE_SEARCH_CACHE_TTL_MS = 60 s`) to stay inside GitHub's 10 req/min code-search limit.
- **Cursors.** Branch/search listings use the existing `StreamingCursor` with identity
  overlay/filter and no injected items; tree entries use `ArrayCursor` over the (single)
  tree response, so huge trees stream into agent context page by page.
- **Search-injection safety.** Mirror the existing issue-search hardening:
  `buildCodeSearchQuery` quotes all caller text; `assertCodeSearchResultsInScope`
  (and a generalized issue-scope assertion) verify every result's repository falls inside
  the requested scope, rejecting qualifier-injection escapes.

## Security

- **OAuth surface unchanged.** The `repo` scope already grants code read; this design adds
  app-level capability, not new scopes. The account resource is *not* `grantable`
  (no scope subsetting exists to attach it to); user consent happens at binding accept
  time, as with every resource.
- **Observers.** Repo/issue/pull kinds keep the existing single-unit ACL check
  (`hasRepoAccess`). The account kind **rejects all observers** in `addObserver` (thrown
  error explains that account-wide connections cannot be shared). `addObserver` is only
  invoked for non-owner collaborators (verified in `overseer.ts ensureObserver`), so the
  connecting user is unaffected.
- **Observation authorization.** Every account read calls `authorizeObservation` with a
  specific title/description and `prohibitAllSharing: true`. The Overseer rejects reads in
  already-shared workspaces and prevents future sharing after a successful read.
- **Scope verification on search results** (above) prevents a prompt-injected qualifier
  from exfiltrating results outside the connected scope.

## Failure Behavior

- GitHub 401 → existing `noteCredentialsExpired` + reconnect message path (`#withApi`).
- Code-search secondary rate limits (403/429) propagate as `GitHubApiError` with GitHub's
  message; the 60 s search cache reduces the chance of hitting them.
- Oversized files (> 1 MB), directory paths passed to `readFile`, submodule/symlink
  entries, and truncated trees all produce explicit, agent-actionable errors or flags
  rather than silent truncation.

## File Changes

| File | Change |
| --- | --- |
| `src/github-api.ts` | Response types (`default_branch` on repo; branch, tree, contents, code-search item) + methods: `listBranches`, `getTreeConditional`, `getContentsConditional`, `searchCode`, `searchIssuesScoped` reuse |
| `src/github-code.ts` (new) | Pure helpers: base64→UTF-8 decode, binary sniff, tree path filtering, `owner/name` parsing — unit-testable without a DO |
| `src/github-search.ts` | `buildCodeSearchQuery`, scope types, `assertCodeSearchResultsInScope`, generalized issue-scope assertion |
| `src/types.d.ts` + `src/types.txt` | `GitHubAccount` interface, new `GitHubRepo` methods, new types (`GitHubBranch`, `GitHubTreeEntry`, `GitHubRepoTree`, `GitHubFileContent`, `GitHubCodeSearch`, `GitHubCodeSearchResult`, `GitHubRepoSummary`, `GitHubAccountMetadata`, …), `defaultBranch` on `GitHubRepoMetadata` (files kept identical) |
| `src/github.ts` | `ACCOUNT_RESOURCE`; props change; URL parsing extracted to pure `parseGitHubResourceUrl`; `describe`/`startSession`/`addObserver` account branches; parameterized DO read methods; `GitHubAccountSessionImpl`; new `GitHubRepoSessionImpl` methods |
| `src/configurator/github-account-configurator-ui.tsx` + `-types.d.ts` (new) | Trivial configurator (no inputs; fixed resource URL) |
| `src/github-configurators.ts` | `GitHubAccountConfiguratorUI` (no RPC methods needed beyond base) |
| `__tests__/github-code.test.ts`, `__tests__/github-api.test.ts` (extend) | See Testing |
| `README.md` | Document the new resource + code access |

## Testing

Unit tests (existing vitest node environment, stubbed `fetch` where needed):

- `buildCodeSearchQuery`: quoting/escaping of caller text; qualifier injection attempts.
- `assertCodeSearchResultsInScope`: repo scope exact match, owner scope, prefix-name
  rejection (`workerd` vs `workerd-private`), malformed URLs/repos.
- `github-code.ts`: base64 decode (multi-byte UTF-8), binary sniff, tree subtree
  filtering, `owner/name` parsing.
- `parseGitHubResourceUrl`: account (bare origin, trailing slash), repo, issue, pull,
  single-segment rejection, non-github hosts.
- `GitHubApi.searchCode`: text-match Accept header, query/paging params.
- `GitHubApi.getContentsConditional`: `ref` param, ETag round-trip.

Full-stack behavior (session ↔ DO ↔ approval queue) follows the existing pattern of being
exercised via the workshop dev loop; the integration-tests package is out of scope here.

## Rollout

No storage migrations, no wrangler config changes, no new OAuth scopes. Existing
connections and their DO state are untouched (new cache keys only). The new resource type
appears in the connection picker once deployed; `types.txt` regeneration is a plain file
copy of `types.d.ts`.
