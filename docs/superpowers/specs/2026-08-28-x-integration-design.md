# X Integration Design

**Date:** 2026-08-28
**Status:** Approved requirements; implementation design

## Summary

Cloudflare OS will add an installable `gatekeeper-x` Worker that gives a Gadget whole-account access to an end user's X account. Each end user supplies a confidential X Developer App and funds its API credits. Cloudflare OS never supplies an X client, token, credit balance, retry path, or billing fallback.

The first release supports account and profile reads, post lookup and timelines, mentions, recent search, likes, bookmarks, followers, and following. It queues create/reply/delete post, like/unlike, bookmark/unbookmark, and follow/unfollow operations for manual approval. It excludes Direct Messages, media, reposts, Lists, streams, webhooks, and resource-level grants.

Because an X account is a high-authority, billable resource, X bindings are owner-only. They can only be added by the workspace owner to a workspace with no active shares. Adding one permanently makes that workspace private because removing a binding cannot remove previously read X data or draft actions from workspace history. X actions cannot be auto-approved and only the workspace owner can approve or reject them.

## Requirements

### Product requirements

- Add X as an available Cloudflare OS gatekeeper.
- Offer one resource type: `X Account` with the whole-instance URL pattern `https://*`.
- Support:
  - authenticated account profile;
  - profile lookup by immutable ID or username;
  - individual post lookup;
  - the authenticated account's posts, mentions, and reverse-chronological home timeline;
  - recent post search;
  - the authenticated account's likes and bookmarks;
  - followers and following;
  - create a post or reply;
  - delete a post;
  - like and unlike;
  - bookmark and remove a bookmark;
  - follow and unfollow.
- Require manual approval for every mutation.
- Include English and Japanese user-facing connection and policy UI.
- Ship in the runtime release and deploy to vlightup staging.

### Funding requirements

- Every connected account supplies its own X Developer App client ID and client secret.
- X API requests use only that account's OAuth grant and developer project.
- The Worker has no deployment-level X credentials.
- Missing, rejected, stale, or replaced user credentials fail closed.
- Credit exhaustion, spending-limit errors, plan restrictions, and rate limits fail closed without fallback or automatic retry.
- No read method silently paginates, fans out, or retries a billable request.

## Non-goals

- Direct Messages or `dm.*` scopes.
- Media upload or `media.write`.
- Reposts, quote posts, polls, or long-form post authoring.
- Lists, Spaces, mutes, blocks, communities, trends, analytics, or profile editing.
- Filtered streams, Activity API subscriptions, webhooks, or scheduled polling.
- App-only bearer-token operations.
- Per-profile, per-list, or per-query resource grants.
- Deployment-admin or Lumirator-funded X applications.
- Reading X Developer Console credit balances. X does not expose a documented user-context balance contract suitable for this invariant.
- Automatic action approval or optimistic write simulation.

## Upstream contracts

The implementation targets X API v2 and these fixed origins:

- Authorization: `https://x.com/i/oauth2/authorize`
- Token exchange and refresh: `https://api.x.com/2/oauth2/token`
- API: `https://api.x.com/2`

OAuth uses Authorization Code with PKCE (`S256`) for a confidential Web App. The callback is an exact deployment URL:

```text
https://<deployment-origin>/gatekeeper/x/oauth
```

Requested scopes are exactly:

```text
tweet.read tweet.write users.read follows.read follows.write
like.read like.write bookmark.read bookmark.write offline.access
```

Any missing or unexpected returned scope rejects the grant. In particular, `dm.*`, `media.write`, and unrelated account scopes are never accepted.

The X API is pay-per-use. Reads are billed per resource returned and writes per request. Prices can change, so Cloudflare OS does not hard-code price claims. Connection UI states that requests consume the user's X Developer App credits and links to the current X pricing page.

Sources:

- [OAuth 2.0 Authorization Code with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
- [X API v2 authentication mapping](https://docs.x.com/resources/fundamentals/authentication/guides/v2-authentication-mapping)
- [X API pay-per-use pricing](https://docs.x.com/x-api/getting-started/pricing)
- [X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)

## Runtime architecture

### Package

Create `packages/gatekeeper-x` with no new external dependency. It follows existing gatekeeper package conventions:

- `src/x.ts`: Worker routing, vendor/account/gatekeeper Durable Objects, resource session, and approval state;
- `src/x-api.ts`: fixed-origin OAuth and X API client, runtime response validation, bounded bodies, and safe provider errors;
- `src/connect-form.ts`: English/Japanese no-JavaScript credential onboarding HTML and security headers;
- `src/types.d.ts`: agent-facing `XAccountSession` API;
- `__tests__/`: OAuth, API, action, owner-policy contract, localization, and manifest tests;
- `deploy-inputs.json`: `[]`, explicitly preventing release defaults from creating deployment X credentials;
- `wrangler.jsonc`: `UserAccount` and `XAccountGatekeeperImpl` SQLite Durable Objects;
- `README.md`: X app setup, callback, scopes, billing, privacy, limitations, and revocation instructions.

The release short name and vendor ID are `x`. Generated service bindings are `GATEKEEPER_X`.

### Credential onboarding

`GatekeeperVendor.connectAccount()` creates a new `UserAccount` Durable Object, a 256-bit initiation nonce, and a callback capability. It persists the resolved `GatekeeperConnectOptions.language` and returns a nonce-bearing gatekeeper URL.

The gatekeeper URL renders a server-generated form that:

- shows the exact callback URL to register in X Developer Console;
- instructs the user to create a confidential Web App, purchase credits, and set a spending limit;
- asks for client ID and client secret;
- posts directly to the X Worker through the same origin;
- contains no client-side JavaScript;
- never sends credentials through Workshop RPC or storage.

The form response uses:

```text
Cache-Control: no-store
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

The POST requires the original path nonce, same-origin form submission, `application/x-www-form-urlencoded`, and a bounded body. Client IDs and secrets are validated as non-empty printable values with conservative length limits. The account DO claims the initiation nonce synchronously before any external I/O, so concurrent or replayed submissions fail.

### OAuth state machine

After claiming the credential form:

1. Persist the candidate client ID and secret inside the account DO only.
2. Generate an independent 256-bit OAuth state nonce.
3. Generate a 256-bit PKCE verifier and its SHA-256 base64url challenge.
4. Persist the state, verifier, exact redirect URI, requested scopes, attempt generation, and expiry.
5. Redirect only to the fixed X authorization origin.
6. Accept only a GET callback with one exact, unexpired state shape.
7. Consume the state and PKCE verifier before token exchange.
8. Exchange the code at the fixed token endpoint using the candidate confidential client and the exact redirect URI.
9. Require access token, refresh token, expiry, and the exact scope set.
10. Call `GET /2/users/me` once and validate an immutable numeric X user ID.
11. Atomically commit client credentials, tokens, token expiry, immutable X user ID, cached profile, and credential generation.
12. Call the Workshop completion callback using the cached profile; `describe()` performs no billable read.

Failed attempts erase all candidate credentials, code, state, and verifier. OAuth and API errors are bounded and redacted before logging or display. Logs never contain form bodies, URLs with callback parameters, headers, post/search text, tokens, client credentials, or provider response bodies.

### Identity and reconnect

The connected account's `uniqueName` is `x:<immutable-user-id>`, never the mutable username.

Reconnect presents the credential form again. This supports a rotated secret or replacement X Developer App without returning the stored secret to a browser. A replacement grant is committed only if `/2/users/me` returns the original immutable X user ID. A different X account is rejected and the prior credential generation remains usable.

A successful reconnect increments the credential generation. Pending actions remember the generation under which they were staged and become terminally stale if the generation changes. Reads created by existing bindings use the current account generation and continue working.

Access-token refresh is single-flight within the account DO. Refresh uses only the stored app credentials and refresh token. It commits a rotated refresh token before releasing waiters. Only explicit X credential rejection marks the account expired; transport failures remain retryable by a later user operation but are not retried inside the same billable API call.

No supported user-context OAuth revocation endpoint was confirmed in the current X documentation. Disconnect therefore always deletes local tokens, client credentials, pending OAuth state, cached profile, and alarms, and instructs the user to revoke Cloudflare OS from X account settings for provider-side invalidation. If a documented supported endpoint is confirmed during live validation, it may be added as best-effort remote revocation before local deletion; local deletion is unconditional.

### Credential boundary

Secrets and tokens stay in `UserAccount` storage. They are never returned to Workshop, a Gadget, a gatekeeper facet, or `ctx.props`.

Gatekeeper sessions invoke a narrow account-DO RPC with a typed X operation and validated arguments. The account DO constructs the method, path, query, and body from an allowlisted operation. It accepts no arbitrary URL, host, HTTP method, headers, or raw path.

All redirects from token and API endpoints are rejected. Dynamic numeric IDs, usernames, pagination tokens, query strings, and page sizes are bounded and validated before request construction. Actor-scoped paths always use the immutable stored X user ID.

## Owner-only workspace policy

### Motivation

Current `prohibitAllSharing` observations are unsuitable: they block future sharing but also permanently block every action and public web fetch. X needs owner-only data and owner-approved writes.

### Shared contract

Add an optional trusted policy to `SupportedResource`:

```ts
workspaceAccess?: "owner-only";
```

An owner-only resource means:

- only the workspace owner using their own connected account may create the binding;
- the binding cannot be added while any collaborator or active share link exists;
- adding the binding durably marks the workspace owner-only;
- no collaborator or share-link redemption may be added afterward, including after the binding is removed;
- non-owner opens fail closed;
- only the workspace owner may approve or reject its actions;
- auto-approval catalog/rules are disabled for the binding;
- actions and public web fetches otherwise remain available to the owner.

The Overseer persists `ownerOnly: true` on the internal `GatekeeperRecord` and a separate sticky `ownerOnlyWorkspace` singleton after successful creation. It derives the credential owner from the authenticated user creating the binding and requires that user to equal the immutable workspace owner. Owner identity and policy history are not exported in blueprints.

Owner-only binding creation and access-granting sharing changes participate in opposing in-memory transition counters around every await. Creation checks `SharingManager.hasAnyShares()` before committing the record. Sharing checks for committed owner-only records and active owner-only creation. This closes add/share and share/redeem races.

Blueprints may declare an X connection requirement but never contain account credentials or identity. Instantiation requires the new workspace owner to select their own X account and is subject to the same private-workspace checks.

### User interface

Connection UI describes X as an owner-only account. The generic shared-user verification promise is replaced with English/Japanese text warning that adding the connection permanently makes the workspace private, even after removal. Server errors remain authoritative if UI state is stale or bypassed.

## Agent-facing API

`XAccountSession` exposes one-request, explicitly paginated methods. List methods default to 10 and hard-cap at 20 resources per request. They return a bounded `nextToken` rather than fetching subsequent pages automatically.

```ts
export interface XAccountSession {
  getMe(): Promise<XUser>;
  getUser(input: { id?: string; username?: string }): Promise<XUser>;
  getPost(id: string): Promise<XPost>;

  listMyPosts(options?: XPageOptions): Promise<XPostPage>;
  listMentions(options?: XPageOptions): Promise<XPostPage>;
  listHomeTimeline(options?: XPageOptions): Promise<XPostPage>;
  searchRecent(query: string, options?: XPageOptions): Promise<XPostPage>;
  listLikedPosts(options?: XPageOptions): Promise<XPostPage>;
  listBookmarks(options?: XPageOptions): Promise<XPostPage>;
  listFollowers(options?: XPageOptions): Promise<XUserPage>;
  listFollowing(options?: XPageOptions): Promise<XUserPage>;

  createPost(text: string): Promise<void>;
  reply(text: string, postId: string): Promise<void>;
  deletePost(postId: string): Promise<void>;
  like(postId: string): Promise<void>;
  unlike(postId: string): Promise<void>;
  bookmark(postId: string): Promise<void>;
  removeBookmark(postId: string): Promise<void>;
  follow(userId: string): Promise<void>;
  unfollow(userId: string): Promise<void>;
}
```

The exact exported response types include only documented fields the implementation validates. Raw provider payloads are not exposed. Every read calls `authorizeObservation()` before returning data. Observation titles contain only bounded safe summaries and do not persist search text or full post content.

## Action lifecycle

Each mutation is stored in the `XAccountGatekeeperImpl` DO with:

- local approval ID;
- validated normalized operation and arguments;
- immutable actor ID;
- expected credential generation;
- state: `staged`, `pending`, `applying`, `applied`, `rejected`, `failed`, `stale`, or `outcome-unknown`.

Lifecycle:

1. Persist `staged` before submitting to Workshop.
2. Call `ApprovalQueue.submitAction()` with `awaitDecision: true` and a bounded, safely fenced description.
3. Commit `pending` after submission succeeds; delete the staged record if submission fails.
4. On owner approval, atomically claim `pending -> applying` before external I/O.
5. Verify the credential generation and dispatch exactly one X request.
6. Commit `applied` only after a validated success response.
7. A definite provider rejection becomes terminal `failed`.
8. A network interruption, 5xx after dispatch, eviction during `applying`, or ambiguous response becomes terminal `outcome-unknown` and is never redispatched.
9. Rejection becomes terminal and erases the gatekeeper's stored mutation payload.
10. Applied/failed/stale payloads are minimized after retaining only audit-safe state.

Two concurrent applies make at most one X request. No action advertises `autoApprovable` or `actionKind`; `getAutoApprovableActions()` returns `[]`. The core owner-only policy separately rejects auto-approval rule changes as defense in depth.

The gatekeeper does not simulate pending writes. Reads always reflect X's current state.

## X API behavior

### Request controls

- Fixed method and path per operation.
- `Authorization: Bearer <access-token>` only at the X API origin.
- `redirect: "error"` for token and API requests.
- Bounded JSON request and response bodies.
- Explicit field and expansion allowlists.
- `max_results` defaults to 10 and is capped at 20.
- Search query length is capped at X's current recent-search contract.
- Numeric IDs, usernames, and pagination tokens use closed runtime validation.
- No automatic retry for 429, transport errors, 5xx, or billed operations.
- No fallback to app-only or deployment credentials.

### Error classification

- 401 or OAuth `invalid_grant`: notify credential expiry once and require reconnect.
- `invalid_client`: report that the supplied X Developer App credentials must be replaced; do not fall back.
- 402/403 funding, project, scope, or plan errors: report a bounded user-facing funding/permission error without marking a valid token expired unless X explicitly says so.
- 429: include a bounded reset time derived from `x-rate-limit-reset`; do not sleep or retry.
- 5xx/network failure: return a temporary provider error. Reads may be manually retried by the user/agent; writes dispatched under approval become `outcome-unknown`.
- Malformed success payload: fail closed and expose no partial data.

## Localization

The credential/setup form and all owner-only policy UI support `en` and `ja`. `GatekeeperConnectOptions.language` is persisted with the connection attempt. Missing or invalid language falls back to English.

Provider names, URLs, scopes, IDs, post/user content, and raw safe dynamic values are not translated. English and Japanese catalogs must maintain structural parity and pass the repository's no-English-fallback audit.

## Deployment contract

`gatekeeper-x/deploy-inputs.json` is an empty array. The release manifest must contain:

- one installable `gatekeeper-x` Worker;
- `BASE_URL=$PUBLIC_BASE_URL/gatekeeper/x` only;
- no `CLIENT_ID`, `CLIENT_SECRET`, bearer token, or other X secret input;
- Workshop and router `GATEKEEPER_X` service-binding expansion;
- the X Durable Object migrations.

After the runtime PR merges:

1. Update `company_os_starter` to the runtime merge commit and verify managed dry-run deployment.
2. Update vlightup's private connector topology to include `gatekeeper-x` while preserving all existing connector names and bindings.
3. Run a read-only managed deployment plan.
4. Confirm existing KV/R2/Access resources are reused, existing Workers are updated, one new X Worker is created, and AI remains disabled.
5. Deploy vlightup staging.
6. Verify all Worker versions, `GATEKEEPER_X` bindings, Access redirect, the localized X onboarding form, and absence of deployment-level X credentials.
7. A real OAuth/API smoke test requires a user-owned funded X Developer App. Credentials must be entered only through the deployed onboarding form and never stored in repository or operations evidence.

## Testing strategy

### Core owner-only policy

- Owner can add an owner-only connection to a private workspace.
- Collaborator cannot add it using their account.
- Owner cannot add it to an already shared workspace.
- Collaborator addition, share-link creation/copy, and share-key redemption fail while it exists.
- Add/share and add/redeem races fail closed.
- Non-owner open fails.
- Only owner can approve or reject actions.
- Auto-approval catalog and rule mutation reject owner-only bindings.
- Owner actions and public web fetch remain available.
- Removing the final owner-only binding does not re-enable sharing because workspace history may retain X data and drafts.
- Blueprints preserve the requirement but not owner identity or credentials.

### OAuth and credential security

- Unique cryptographic initiation nonce, state, and PKCE verifier.
- Exact `S256` challenge and callback URL.
- One successful form claim among concurrent submissions.
- Expired/replayed/malformed form links and callback states reject without exchange.
- Callback replay reaches the token endpoint once.
- Secrets are absent from URL, HTML, Workshop RPC, logs, errors, descriptions, and props.
- Scope mismatch and unexpected scopes fail before storage.
- Cached profile prevents an extra billed describe request.
- Reconnect preserves immutable X user ID and rejects account switching.
- Late refresh/callback cannot overwrite newer credentials.
- Refresh rotation is single-flight.
- Revocation clears every local secret and token even if optional remote work fails.

### API and billing

- Exact method/path/query/body for every MVP endpoint.
- Stored actor ID is used for actor-scoped endpoints.
- URL-like IDs, encoded slashes, arbitrary hosts, invalid usernames, oversized queries/tokens, and redirects reject before credential dispatch.
- Every list call makes one request and returns at most 20 resources.
- 401, invalid client, funding/plan errors, 429, 5xx, malformed responses, and transport failures are classified without retry or fallback.
- Bounded response parsing rejects oversized bodies.
- Every read authorizes before returning data.

### Actions

- Every mutation is queued before X I/O.
- Two concurrent applies dispatch once.
- Credential generation changes make pending actions stale.
- Eviction or ambiguous failure never redispatches.
- Definite provider rejection is terminal.
- Rejected/applied records minimize stored payloads.
- No X action can be auto-approved.

### Release and localization

- Package builds and generated Wrangler types match config.
- Release golden manifest contains X with `inputs: []` and no secret binding.
- Dev-server configuration includes the X Worker/service bindings without environment credentials.
- English/Japanese connection forms and owner-only UI pass parity and static completion audits.
- Full lint, build, unit, workspace, bootstrap, and release checks pass.

## Security decision

**Conditional go** for vlightup staging after all owner-only, OAuth, action-state, billing, and release tests pass. Production remains gated on:

- a live user-funded X app test of OAuth, refresh, all MVP endpoint classes, insufficient-credit behavior, and disconnect;
- confirmation of current X Developer Agreement obligations for stored/displayed protected data and agent-generated actions;
- explicit acceptance that Cloudflare/deployment operators remain in the trust boundary for Durable Object storage;
- documentation of X-side revocation where no supported API endpoint is available.
