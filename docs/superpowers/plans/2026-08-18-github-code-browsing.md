# GitHub Code Browsing & Account Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development by default to implement this plan task-by-task. Run independent, safely isolated tasks in parallel; sequence tasks that share state or dependencies. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Note:** All tasks modify the same package (`packages/gatekeeper-github`) in the same worktree and are strictly ordered by dependency — execute sequentially.

**Goal:** Let agents (1) discover which of a user's GitHub repos is relevant to a message via a new account-wide resource, and (2) read the codebase (branches, trees, files, default-branch code search) of connected repos.

**Architecture:** Extend the existing gatekeeper: a parameterized read-only code layer on `GitHubGatekeeperImpl` (ETag/DO-cached, cursor-paged, observation-authorized) serves both the existing `GitHubRepo` session and a new `"account"` resource kind (`GitHubAccount` session) on the same DO class. No new DO classes, scopes, or migrations. See spec: `docs/superpowers/specs/2026-08-18-github-code-browsing-and-account-discovery-design.md`.

**Tech Stack:** Cloudflare Workers/DO, capnweb-validate, vitest (node env), pnpm. Node 22 (`export PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH`).

**Worktree:** `/Users/kei/lumirator/agents/cloudflare-os-worktrees/github-code-browsing` (all paths below relative to `packages/gatekeeper-github/`).

**Verification commands:**
- Tests: `pnpm test` (vitest, `__tests__/*.test.ts`)
- Types: `pnpm run types:check` (builds configurators + `tsc --noEmit`)

---

### Task 1: Pure code-read helpers (`src/github-code.ts`)

**Files:**
- Create: `src/github-code.ts`
- Test: `__tests__/github-code.test.ts`
- Modify: `src/github-configurators.ts` (import shared `splitRepoFullName`)

New module free of `cloudflare:workers` imports so it runs under the node vitest env. Contents:

- `parseGitHubResourceUrl(url)` → `{kind:"account"} | {kind:"repo"|"issue"|"pull", owner, repo, issueNumber?}`; hostname must be `github.com`; 0 segments → account; 1 segment → throw; `issues/N`/`pull/N` → issue/pull; otherwise repo (preserves current behavior for extra segments like `/tree/main`).
- `splitRepoFullName(input)` — moved verbatim from `github-configurators.ts` (with `GITHUB_OWNER_PATTERN`/`GITHUB_REPO_PATTERN`); configurators re-import it.
- `decodeRepoFileText(base64)` → `{ text, isBinary }` — base64→bytes (`atob`, whitespace-tolerant), NUL-byte sniff in first 8192 bytes ⇒ binary (empty text), else UTF-8 decode.
- `filterTreeEntries(entries, path?, recursive?)` — subtree filter over recursive tree listings: strips trailing slashes from `path`, keeps entries under `path` (or all when omitted), and when `recursive` is false keeps only direct children (no further `/` beyond the prefix).

- [ ] **Step 1:** Write `__tests__/github-code.test.ts` covering: account URL (bare origin + trailing slash), repo/issue/pull URLs, extra-segment URL → repo, single-segment and non-github URLs throw; `splitRepoFullName` accepts `owner/name` + GitHub URLs, rejects malformed; `decodeRepoFileText` decodes multi-byte UTF-8, flags NUL-containing content binary; `filterTreeEntries` root/subtree/non-recursive cases.
- [ ] **Step 2:** Run `pnpm test` — new file FAILS (module not found).
- [ ] **Step 3:** Implement `src/github-code.ts`; update `github-configurators.ts` to import `splitRepoFullName` (delete local copy + regexes).
- [ ] **Step 4:** `pnpm test` — PASS. `pnpm run types:check` — clean.
- [ ] **Step 5:** Commit: `feat(github): pure helpers for code browsing (URL parsing, file decode, tree filtering)`

### Task 2: Scoped search builders + result-scope assertions (`src/github-search.ts`)

**Files:**
- Modify: `src/github-search.ts`
- Test: `__tests__/github-api.test.ts` (extend)

Additions (mirroring the existing injection-hardened issue search):

```ts
export type GitHubSearchScope = { owner: string; repo?: string };
// scopeQualifier: repo -> `repo:o/r`, owner-only -> `user:o`
export function buildCodeSearchQuery(scope, query: { text: string; path?: string; extension?: string }): string
  // JSON.stringify-quotes text/path/extension; appends scope qualifier
export function assertCodeSearchResultsInScope(scope, results: readonly { repository: { full_name: string } }[]): void
export function assertRepoSearchResultsInScope(scope, results: readonly { full_name: string }[]): void
export function buildScopedIssueSearchQuery(scope, query: GitHubIssueSearch): string
  // generalizes buildIssueSearchQuery; existing (owner, repo) function delegates to it
export function assertIssueSearchResultsInScope(scope, results): void
  // generalizes assertIssueSearchResultsInRepo (owner-only scope checks owner segment + issues kind);
  // existing function delegates
```

Scope checks are case-insensitive, reject prefix-share names (`workerd` vs `workerd-private`), malformed full names, and non-github/malformed URLs.

- [ ] **Step 1:** Extend `__tests__/github-api.test.ts` with describes for the five new exports (quoting/injection attempts incl. `" repo:evil/repo"` in text; scope violations; owner-only scope).
- [ ] **Step 2:** `pnpm test` — FAILS (exports missing).
- [ ] **Step 3:** Implement; keep the two existing exports as thin delegates (their pinned tests must not change).
- [ ] **Step 4:** `pnpm test` — PASS.
- [ ] **Step 5:** Commit: `feat(github): scoped search query builders and result-scope assertions`

### Task 3: GitHub API surface (`src/github-api.ts`)

**Files:**
- Modify: `src/github-api.ts`
- Test: `__tests__/github-api.test.ts` (extend, stubbed `fetch` per existing pattern)

1. Extend `GitHubRepoResponse`: `default_branch?: string; updated_at?: string; archived?: boolean; fork?: boolean; language?: string | null;`
2. New response types: `GitHubBranchResponse { name; commit: { sha }; protected? }`, `GitHubTreeEntryResponse { path; mode; type: "blob"|"tree"|"commit"; sha; size? }`, `GitHubTreeResponse { sha; truncated; tree: [] }`, `GitHubContentsResponse { type: "file"|"dir"|"symlink"|"submodule"; name; path; sha; size; encoding?; content?; html_url? }`, `GitHubCodeSearchItemResponse { path; sha; html_url; repository: { full_name }; text_matches?: { fragment? }[] }`.
3. New methods on `GitHubApi`:
   - `listBranches(owner, repo, { per_page, page })` → `GET /repos/{o}/{r}/branches`
   - `getTreeConditional(owner, repo, ref, options?)` → `GET /repos/{o}/{r}/git/trees/{ref}?recursive=1` (always recursive; ETag via `#conditionalGet`; `ref` URL-encoded)
   - `getContentsConditional(owner, repo, path, ref?, options?)` → `GET /repos/{o}/{r}/contents/{path}` (`ref` query param; path encoded per-segment: `path.split("/").map(encodeURIComponent).join("/")`) returning `GitHubContentsResponse | GitHubContentsResponse[]`
   - `searchCode({ q, per_page, page })` → `GET /search/code` with `Accept: application/vnd.github.text-match+json`; returns `items`

- [ ] **Step 1:** Add tests: `searchCode` sends the text-match Accept header and q/paging params; `getContentsConditional` encodes path segments and passes `ref`; `getTreeConditional` requests `recursive=1` and encodes the ref.
- [ ] **Step 2:** `pnpm test` — FAILS.
- [ ] **Step 3:** Implement types + methods.
- [ ] **Step 4:** `pnpm test` — PASS. `pnpm run types:check` — clean.
- [ ] **Step 5:** Commit: `feat(github): REST endpoints for branches, trees, contents, and code search`

### Task 4: Agent-facing types (`src/types.d.ts` + `src/types.txt`)

**Files:**
- Modify: `src/types.d.ts` (then `cp src/types.d.ts src/types.txt` — the files are identical by convention)

1. Replace the `TODO` comment on `GitHubRepo` and add methods:
   `listBranches(options?: GitHubPageOptions): Promise<Cursor<GitHubBranch>>`,
   `readTree(options?: GitHubTreeOptions): Promise<GitHubRepoTree>`,
   `readFile(path: string, options?: GitHubFileOptions): Promise<GitHubFileContent>`,
   `searchCode(query: GitHubCodeSearch): Promise<Cursor<GitHubCodeSearchResult>>` —
   with doc comments stating code search covers **only the default branch** (use `readTree`/`readFile` with `ref` for other branches) and only indexed files (<384 KB).
2. `GitHubRepoMetadata` gains `defaultBranch: string`.
3. New types:

```ts
export type GitHubBranch = { name: string; sha: string; protected?: boolean };
export type GitHubTreeOptions = GitHubPageOptions & {
  /** Branch, tag, or commit SHA. Defaults to the repository's default branch. */
  ref?: string;
  /** Restrict the listing to this directory. */
  path?: string;
  /** When false, list only the direct children of `path`. Defaults to true. */
  recursive?: boolean;
};
export type GitHubTreeEntry = { path: string; type: "file" | "dir" | "submodule" | "symlink"; sha: string; size?: number };
export type GitHubRepoTree = { ref: string; sha: string; /** True if GitHub truncated the listing (very large repos). */ truncated: boolean; entries: Cursor<GitHubTreeEntry> };
export type GitHubFileOptions = { /** Branch, tag, or commit SHA. Defaults to the default branch. */ ref?: string };
export type GitHubFileContent = { path: string; ref: string; sha: string; size: number; /** Empty when `isBinary`. */ text: string; isBinary: boolean; url?: string };
export type GitHubCodeSearch = GitHubPageOptions & { text: string; path?: string; extension?: string };
export type GitHubCodeSearchResult = { repo: GitHubRepoRef; path: string; url: string; /** Matching source fragments. */ matches: string[] };
export type GitHubAccountMetadata = { login: string; displayName?: string; url: string; avatarUrl?: string };
export type GitHubRepoFilter = GitHubPageOptions & { affiliation?: "owner" | "collaborator" | "organizationMember" | "all" };
export type GitHubRepoSearch = GitHubPageOptions & { text: string; /** Defaults to the connected account's login. */ owner?: string };
export type GitHubRepoSummary = GitHubRepoMetadata & { updatedAt?: Date; archived?: boolean; fork?: boolean; language?: string };
export type GitHubAccountCodeSearch = GitHubCodeSearch & { owner?: string; repo?: string };
export type GitHubAccountIssueSearch = GitHubIssueSearch & { owner?: string; repo?: string };
```

4. New `GitHubAccount` interface (doc comments explain the discovery→drill-in flow, the default `user:{login}` search scope + `owner`/`repo` narrowing for org/collaborator repos, and that issue/PR/write access requires a repo-scoped connection):

```ts
export interface GitHubAccount {
  getMetadata(): Promise<GitHubAccountMetadata>;
  listRepos(options?: GitHubRepoFilter): Promise<Cursor<GitHubRepoSummary>>;
  searchRepos(query: GitHubRepoSearch): Promise<Cursor<GitHubRepoSummary>>;
  searchCode(query: GitHubAccountCodeSearch): Promise<Cursor<GitHubCodeSearchResult>>;
  searchIssues(query: GitHubAccountIssueSearch): Promise<Cursor<GitHubIssueSummary>>;
  getRepoMetadata(repo: string): Promise<GitHubRepoMetadata>;
  listBranches(repo: string, options?: GitHubPageOptions): Promise<Cursor<GitHubBranch>>;
  readTree(repo: string, options?: GitHubTreeOptions): Promise<GitHubRepoTree>;
  readFile(repo: string, path: string, options?: GitHubFileOptions): Promise<GitHubFileContent>;
}
```

- [ ] **Step 1:** Edit `types.d.ts`; run `cp src/types.d.ts src/types.txt`; `diff src/types.d.ts src/types.txt` → identical.
- [ ] **Step 2:** `pnpm run types:check` — expected to FAIL only in `github.ts` (`GitHubRepoSessionImpl` missing new members / metadata missing `defaultBranch`) — that confirms the interface change reached the impl; fixed in Task 5.
- [ ] **Step 3:** Commit: `feat(github): agent-facing types for code browsing and account sessions`

### Task 5: DO code-read layer + `GitHubRepo` session methods (`src/github.ts`)

**Files:**
- Modify: `src/github.ts`

1. Constants: `CODE_SEARCH_CACHE_TTL_MS = 60_000` (GitHub code search: 10 req/min), `MAX_FILE_SIZE_BYTES = 1024 * 1024`.
2. Imports from `./github-code` and new `./github-search` + `./github-api` symbols.
3. Parameterize repo metadata: `#getRepoMetadataFor(owner, repo)` (cache key `cache:repo:{owner}:{repo}`, adds `defaultBranch: result.data.default_branch ?? "main"`); existing `repoMetadata()` delegates with props. Public `repoMetadataFor(owner, repo)`.
4. New DO methods (all read-only; caching per pattern; **cache keys include owner/repo** so the account session can reuse them safely):
   - `codeBranches(owner, repo, pageSize)` → `StreamingCursor` (identity overlay/filter, zero comparator, no injected items) over `api.listBranches`; maps to `GitHubBranch { name, sha: commit.sha, protected }`.
   - `codeTree(owner, repo, { ref?, path?, recursive? }, pageSize)` → resolves `ref` from metadata default branch; `#loadCachedWithEtag` key `cache:tree:{owner}:{repo}:{ref}` over `api.getTreeConditional` (always recursive — one cached fetch serves every `path`/`recursive` combination); maps entries (`blob`→`file` or `symlink` when mode `120000`, `tree`→`dir`, `commit`→`submodule`); applies `filterTreeEntries`; returns `{ ref, sha, truncated, entries: new ArrayCursor(entries, pageSize) }`.
   - `codeFile(owner, repo, path, ref?)` → resolves `ref`; `#loadCachedWithEtag` key `cache:file:{owner}:{repo}:{ref}:{path}` over `api.getContentsConditional`. Errors: array response → "directory, use readTree"; `type !== "file"` → unsupported entry type; `size > MAX_FILE_SIZE_BYTES` or `encoding !== "base64"`/missing content → "too large (>1 MB)". Otherwise `decodeRepoFileText` → `GitHubFileContent`.
   - `codeSearch(scope: GitHubSearchScope, query, pageSize)` → `StreamingCursor` whose `fetchPage` consults a per-page TTL cache (key `cache:codesearch:{stableKey({scope,query})}:{page}`, `CODE_SEARCH_CACHE_TTL_MS`), calls `api.searchCode` with `buildCodeSearchQuery`, runs `assertCodeSearchResultsInScope`, and maps to `GitHubCodeSearchResult` (repo ref parsed from `repository.full_name`; `matches` from `text_matches[].fragment`).
5. `GitHubRepoSessionImpl` methods (each `authorizeObservation` first, then delegate with `this.ctx.props`-bound owner/repo via gatekeeper):
   - `listBranches(options?)` — "List branches in {owner}/{repo}"
   - `readTree(options?)` — "Read the file tree of {owner}/{repo}" (+ ref/path in description)
   - `readFile(path, options?)` — "Read file {path} in {owner}/{repo}" (+ ref in description)
   - `searchCode(query)` — "Search code in {owner}/{repo} for \"{text}\"" — delegates with `scope = { owner, repo }`

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `pnpm run types:check` — clean (Task 4's expected failure resolves). `pnpm test` — still green.
- [ ] **Step 3:** Commit: `feat(github): code browsing on repo sessions (branches, tree, files, code search)`

### Task 6: Account resource (`src/github.ts`)

**Files:**
- Modify: `src/github.ts`

1. `ACCOUNT_RESOURCE: SupportedResource = { urlPattern: "https://github.com", title: "GitHub Account", description: "Discover, search, and read code across every repository this GitHub account can access." }`; prepend to `SUPPORTED_RESOURCES`.
2. Props: `resourceKind: "repo" | "issue" | "pull" | "account"`; for `"account"`, `owner`/`repo` are set to `""` and never read (documented on the type; the union-type alternative would force narrowing at ~50 existing call sites).
3. `GatekeeperUserImpl.getGatekeeperClassFor`: rewrite on `parseGitHubResourceUrl`; `account` → props `{ userObjectId, resourceKind: "account", owner: "", repo: "" }` + `ACCOUNT_RESOURCE`.
4. `describe()` account branch: viewer-based (`accountMetadata`) → `{ url, title: "GitHub account @{login}", snippet, suggestedBindingName: "GITHUB_ACCOUNT", tsType: "GitHubAccount" }`.
5. `startSession()` account branch → `new GitHubAccountSessionImpl(this, queue)`; widen return type union.
6. `addObserver()`: account kind throws `"Account-wide GitHub connections grant access to everything the connecting user's GitHub account can read, so they cannot be shared with collaborators. Connect a specific repository instead."` before the repo ACL check.
7. New DO methods:
   - `accountMetadata()` — from cached viewer (`#getViewerActor` machinery) → `GitHubAccountMetadata`.
   - `accountRepos(filter, pageSize)` — `StreamingCursor` over `api.listRepos` (affiliation mapping: `organizationMember` → `organization_member`, default `owner,collaborator,organization_member`; sort `updated`); maps to `GitHubRepoSummary` (incl. `defaultBranch`, `updatedAt`, `archived`, `fork`, `language`).
   - `accountSearchRepos(query, pageSize)` — scope owner = `query.owner ?? viewer.login`; `api.searchRepos` with quoted text + `user:{owner} fork:true`; `assertRepoSearchResultsInScope`; maps to summaries.
   - `accountSearchIssues(query, pageSize)` — scope from `query.repo` (via `splitRepoFullName`, invalid → throw) else `query.owner` else viewer login; `buildScopedIssueSearchQuery` + `api.searchIssues`; `assertIssueSearchResultsInScope`; normalize per-item owner/repo parsed from `html_url` (already scope-validated). Per-page TTL cache like `codeSearch`.
8. `GitHubAccountSessionImpl extends RpcTarget implements GitHubAccount` (`@validateRpc()`, `Symbol.dispose` like the repo session): every method authorizes an observation with a specific title (e.g. `Search code across account for "{text}"`, `Read file {path} in {repo}`), resolves `repo` strings via `splitRepoFullName` (throw on invalid), and delegates to the DO methods from Tasks 5–6. `searchCode` scope: `repo` → `{owner, repo}`; else `owner` → `{owner}`; else `{owner: viewer.login}`.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `pnpm run types:check` — clean; `pnpm test` — green (URL parsing behavior already covered by Task 1 tests).
- [ ] **Step 3:** Commit: `feat(github): account-wide resource for repo discovery and cross-repo search`

### Task 7: Account configurator

**Files:**
- Create: `src/configurator/github-account-configurator-types.d.ts` (`GitHubAccountConfiguratorValues = {}`; empty `GitHubAccountConfiguratorRpc` interface)
- Create: `src/configurator/github-account-configurator-ui.tsx` — no inputs: `initial: {}`, `resourceUrl: () => "https://github.com"`, `render` returns a `Section` explaining the grant ("Grants read access to every repository this GitHub account can access — repository discovery, code search, and file reading. Issues, pull requests, and write access still require connecting a specific repository.")
- Modify: `src/github-configurators.ts` — `GitHubAccountConfiguratorUI` RpcTarget
- Modify: `src/github.ts` — import generated `github-account-configurator-ui.txt`; `startResourceConfigurator` branch for `ACCOUNT_RESOURCE.urlPattern`

- [ ] **Step 1:** Implement all four files.
- [ ] **Step 2:** `pnpm run types:check` — configurator build generates `src/generated/github-account-configurator-ui.txt` and tsc is clean.
- [ ] **Step 3:** Commit: `feat(github): account resource configurator`

### Task 8: Docs + final verification

**Files:**
- Modify: `README.md` (document the account resource + code access in the connections overview and verify-setup steps)

- [ ] **Step 1:** Update README.
- [ ] **Step 2:** Full gate: `pnpm test` (all green) + `pnpm run types:check` (clean) + `git status` (no stray generated files staged — `src/generated/` is build output; confirm whether it is gitignored and follow the existing convention).
- [ ] **Step 3:** Commit: `docs(github): document account resource and code browsing`
