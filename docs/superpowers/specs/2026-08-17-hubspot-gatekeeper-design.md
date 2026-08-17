# HubSpot Gatekeeper Design

## Goal

Add an installable HubSpot connector to Cloudflare OS that connects one HubSpot account through OAuth and gives Gadgets bounded access to contacts, companies, and deals. The MVP supports read/search plus approval-gated create/update operations. It does not delete records, access sensitive-data scopes, act as a sign-in provider, or expose marketing, ticketing, custom-object, batch, association, or webhook APIs.

## Provider contract

The connector targets HubSpot's current Developer Platform rather than legacy public apps.

- Authorization endpoint: `https://app.hubspot.com/oauth/authorize`.
- Token endpoint: `POST https://api.hubspot.com/oauth/2026-03/token`.
- Refresh-token revoke endpoint: `POST https://api.hubapi.com/oauth/2026-03/token/revoke`.
- CRM endpoints: `https://api.hubapi.com/crm/objects/2026-03/{contacts|companies|deals}` and their `/search` endpoints.
- Required scopes: `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.objects.companies.write`, `crm.objects.deals.read`, and `crm.objects.deals.write`.
- Installing users must be HubSpot Super Admins or have HubSpot Marketplace Access.
- Production redirects require HTTPS and must be registered exactly in the app configuration.

The HubSpot app can use private distribution for the staging/managed-service PoC. HubSpot currently limits privately distributed OAuth apps to an allowlist of accounts; marketplace distribution can be added later without changing the Gatekeeper protocol.

Sources:

- https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth
- https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens
- https://developers.hubspot.com/docs/api-reference/latest/authentication/oauth-tokens/revoke-token
- https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes
- https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm
- https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide
- https://developers.hubspot.com/docs/api-reference/latest/crm/objects/companies/guide
- https://developers.hubspot.com/docs/api-reference/latest/crm/objects/deals/guide

## Package architecture

Create `packages/gatekeeper-hubspot` using the established static-OAuth Gatekeeper shape:

- `src/hubspot.ts`: HTTP OAuth entrypoint, vendor RPC, per-account credential Durable Object, connected-account RPC, whole-account resource configurator, per-Gadget Gatekeeper Durable Object, action persistence, and session RPC.
- `src/hubspot-api.ts`: bounded HubSpot OAuth and CRM HTTP client, response validation, error classification, and curated property conversion.
- `src/types.d.ts` / `src/types.txt`: agent-facing RPC types for contacts, companies, deals, paging, and mutation tickets/results.
- `src/configurator/*`: a no-input whole-account configurator that emits the canonical portal URL.
- `README.md` and `deploy-inputs.json`: current HubSpot Developer Platform setup, exact callback contract, scopes, and write-only credential inputs.
- `wrangler.jsonc`: `UserAccount` and `HubSpotGatekeeperImpl` SQLite migrations, service-worker entrypoint build, observability, and no secrets in source/config.

The release manifest discovers every package with `wrangler.jsonc`, so the new package becomes installable automatically and receives the standard `CLIENT_ID` / `CLIENT_SECRET` secret contract. It is not preinstalled without input and is not a singleton.

## OAuth and credential lifecycle

`GatekeeperVendor.connectAccount()` creates a unique `UserAccount` Durable Object, stores the callback capability, and returns a nonce-bearing local initiation URL. The HTTP entrypoint validates the initiation nonce, rotates it to a one-time OAuth state nonce, and redirects to HubSpot.

HubSpot does not document PKCE for this server-side flow, so the connector uses the confidential client secret at the token endpoint and a cryptographic state nonce for CSRF/replay protection. The token response supplies short-lived access credentials, a refresh token, scopes, and Hub ID. The Durable Object stores tokens and identity; credentials never leave it or enter logs.

Before expiry, `getAccessToken()` single-flights refreshes through the 2026-03 endpoint per Durable Object instance and persists a returned rotated refresh token when present. A bounded persisted credential generation prevents an in-flight refresh from overwriting a reconnect, resurrecting a revoked account, or emitting a stale expiry notification. Only OAuth `invalid_grant` marks current credentials expired and calls `credentialsExpired()` once; provider/configuration failures remain distinct. Initial and refresh responses that include scopes must contain every required scope before credentials are stored. Reconnect reuses the existing connected-account capability, accepts only the original Hub ID, and advances the generation before replacing credentials and calling `credentialsRestored()`.

Disconnect enters a fail-closed revoking state and advances the credential generation before calling HubSpot's 2026-03 refresh-token revoke endpoint. Local credentials and capabilities are deleted only after provider success. Provider failure clears the revoking state and preserves credentials for a retry; manual HubSpot uninstall is the incident fallback rather than the normal disconnect contract.

## Resource and privacy model

The only supported resource is the connected HubSpot CRM account. The configurator returns `https://app.hubspot.com/contacts/{hubId}`. `getGatekeeperClassFor()` accepts only HubSpot app URLs whose portal identifier matches the OAuth token's Hub ID and pins that Hub ID into immutable Gatekeeper capability props. Resource descriptions, sessions, reads, mutations, applications, and mutation-result lookups re-check the account against the pinned authority and fail closed on mismatch.

HubSpot documents that app access tokens reflect granted scopes rather than the installing user's object ownership restrictions. The API does not provide a reliable oracle proving another Cloudflare OS collaborator can read every record previously observed. Therefore the Gatekeeper uses the private-only observer strategy: `addObserver()` always rejects, preventing the binding from being shared beyond its owner.

## Agent API

Expose explicit methods rather than a generic arbitrary-object/property API:

- `searchContacts`, `getContact`, `createContact`, `updateContact`
- `searchCompanies`, `getCompany`, `createCompany`, `updateCompany`
- `searchDeals`, `getDeal`, `createDeal`, `updateDeal`
- `getMutationResult`

Search accepts a bounded free-text query, page size up to 100, and HubSpot's digit-string `after` cursor. Cursors remain strings end-to-end, and provider cursors and record IDs are limited to 32 digits. Responses include only curated standard properties.

Writable properties are allowlisted per object:

- Contacts: email, first/last name, phone/mobile, job title, company, website, lifecycle stage.
- Companies: name, domain, phone, website, city, state, country, industry, lifecycle stage.
- Deals: name, amount, close date, pipeline, stage, description, and type.

Contacts must include at least one identifying field. Companies require name or domain. Deals require deal name, pipeline, and stage. Input objects reject unknown keys, non-string values, excessive key/value sizes, malformed IDs, and unbounded queries.

## Observation and action policy

Every remote read completes before `authorizeObservation()` and returns data only after authorization succeeds. Descriptions include the object type, query or record ID, result count, and portal ID, but not full CRM contents.

Create/update methods never call HubSpot directly. They persist a validated pending mutation, including the immutable expected Hub ID, in the Gatekeeper Durable Object, submit it to the approval queue with `awaitDecision: true`, and return a mutation ticket. `applyAction()` claims `pending` as `applying` before exactly one POST/PATCH. Confirmed success stores `ready`; any application error stores a redacted terminal `failed` or `uncertain` result, removes pending state, and throws so the Overseer does not mark the action applied. A stale persisted `applying` state is terminalized with manual-inspection guidance and never retried. Concurrent duplicate applications and rejection of active, stale, or uncertain writes fail closed without changing the first or terminal outcome. A normal pre-application rejection stores `rejected` without remote side effects. Actions are never auto-approvable and declare no automatic revert; deletion is not implemented.

Reads may retry a single `429`/transient failure only when HubSpot supplies a bounded retry delay. Writes are never retried automatically because a lost response could duplicate a create or replay an update. Provider errors expose status/category/correlation IDs but redact tokens, secrets, response bodies, and submitted CRM values from logs.

## Deployment and Admin integration

Add HubSpot to the backend's immutable connector credential/setup-guide maps and readiness static test. Add it to local development credential mapping, root connector documentation, release golden fixtures, and observer-strategy documentation.

The connector is installed by default wherever the managed deployment selects all installable Gatekeepers. The Vlightup staging wrapper will add:

- Worker: `vlightup-os-staging-gk-hubspot`
- Router and Workshop binding: `GATEKEEPER_HUBSPOT`
- Callback: `https://vlightup-os-staging-router.keisuke-watanabe.workers.dev/gatekeeper/hubspot/oauth`

It initially appears visible but disabled with `Ask an administrator to configure this connector.` Admins install `CLIENT_ID` and `CLIENT_SECRET` through `/admin/connectors`; no credential is read back.

## Testing

- Unit-test OAuth URL/state, token exchange/refresh, CRM endpoint selection, curated properties, response bounds, and provider error redaction.
- Unit-test input allowlists and action descriptions.
- Test that reads require observation authorization and writes require approval before fetch.
- Test readiness metadata, Admin server-owned guide URL, local-development credential mapping, release manifest generation, and package build.
- Run package tests, static readiness tests, release manifest tests, full typecheck, lint, full repository tests, Wrangler dry run, and frontend build.
- After merge, deploy the unconfigured Worker, bind Router/Workshop, and verify staging shows HubSpot as Needs setup without changing existing connectors.

## Deferred

- Deletes, archival, batch APIs, associations, custom properties, sensitive/highly-sensitive scopes, tickets, marketing APIs, webhooks, and HubSpot login.
- Marketplace certification and provider-side program/security questionnaire work.
