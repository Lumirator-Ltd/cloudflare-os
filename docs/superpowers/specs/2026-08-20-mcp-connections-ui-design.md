# MCP Connections UI Design

## Summary

Add an admin-managed MCP connection to Cloudflare OS by exposing the existing `gatekeeper-mcp-portal` connector in **Admin → Connector configuration**. A deployment administrator configures one existing Cloudflare MCP Server Portal endpoint. Users then authenticate to that approved portal and explicitly grant one upstream server, or selected tools from that server, to a workspace chat or Gadget.

This is an MVP integration with one deployment-wide portal and OAuth-only user authentication. Cloudflare OS will not manage the portal's upstream server catalog; administrators continue to add and approve upstream MCP servers in Cloudflare Zero Trust.

## Goals

- Let a deployment admin configure one approved MCP Portal URL from the Cloudflare OS admin UI.
- Keep the configured URL write-only from the application's perspective after submission.
- Require each user to authenticate to the portal with OAuth.
- Reuse the existing per-workspace and per-Gadget capability grant flow.
- Scope every grant to one upstream MCP server and optionally a selected tool set.
- Disable the generic user-supplied MCP endpoint connector by default for new deployments.
- Fail closed when the portal is removed, invalidated, or repointed.

## Non-goals

- Creating or deleting Cloudflare MCP Server Portals.
- Managing upstream MCP servers through the Cloudflare One API.
- Supporting multiple portals per Cloudflare OS deployment.
- Supporting bearer-token or unauthenticated portals.
- Revoking already-minted generic MCP capabilities when an existing deployment later disables the generic connector.
- Changing the existing workspace/Gadget grant and approval interfaces.

## Existing Components

- `packages/gatekeeper-mcp-portal` connects one environment-configured portal and converts its tools into scoped Gadget capabilities.
- `packages/gatekeeper-mcp` lets a user paste an arbitrary MCP endpoint.
- `packages/workshop-backend/src/connector-configuration.ts` lets an admin write allowlisted connector settings to a dedicated Worker through the Cloudflare Workers secrets API.
- `packages/workshop-frontend/src/AdminConnectorsPage.tsx` renders the existing admin connector configuration page.
- `packages/workshop-backend/src/admin-config.ts` controls which Gatekeepers are offered.

## Architecture

### Admin configuration

The admin page will list `mcp_portal` as a configurable connector even when no portal is currently configured. Its only input is an HTTPS MCP endpoint URL.

The backend owns a static descriptor for every configurable connector. The MCP descriptor maps:

- Gatekeeper vendor ID: `mcp_portal`
- Worker suffix: `mcp-portal`
- Environment value: `MCP_PORTAL_URL`
- Input presentation: URL, not password
- Setup guide: Cloudflare MCP Server Portal documentation
- Callback display: omitted because the portal uses MCP OAuth discovery rather than a manually registered provider application in this UI

The submitted URL is validated on the backend before any Cloudflare API call:

- valid absolute URL;
- `https:` scheme;
- no username or password;
- no query string or fragment;
- non-empty hostname.

The normalized URL is written as a `secret_text` Worker binding using the existing backend-only `CONNECTOR_CONFIG_API_TOKEN`. The value is never returned through RPC. Using a secret binding avoids introducing a second control-plane write path and preserves the existing write-only configuration contract, even though the URL itself is not normally confidential.

After a successful write, the frontend reloads connector status instead of unconditionally claiming activation. Cloudflare control-plane propagation may be asynchronous, so the success message says the setting was saved and may take a moment to become available.

### Portal connector readiness

`gatekeeper-mcp-portal` will include `VendorDescription.configuration` with `configured: true` only when `MCP_PORTAL_URL` parses as a valid portal configuration. This lets the admin page show the connector before it is usable while the user-facing connector list remains hidden until configuration is valid.

A crafted direct call to `connectAccount()` must also reject an unconfigured portal. UI hiding is not authorization.

### OAuth-only connection

The portal connector always constructs a deployment-owned `ConnectedServer` with `auth: "oauth"`. Legacy `MCP_PORTAL_AUTH` and `MCP_PORTAL_TOKEN` values no longer change behavior.

An endpoint configured as OAuth must return an OAuth authorization challenge. If its unauthenticated probe succeeds, connection fails instead of silently recording `auth: "none"`. Existing portal accounts whose stored server is not OAuth require reconnection and cannot mint new portal capabilities.

### Live configuration enforcement

Admin configuration is mutable while connected accounts and Gadget facets are durable. An account therefore validates the live portal configuration at operation time, not only when a facet is minted.

`McpAccountBase` gains a protected no-op validation hook for connector-specific deployment policy. The portal account overrides it to require:

- a currently valid portal configuration;
- OAuth mode;
- canonical endpoint equality between current configuration and the connected account.

The base calls this hook before returning credentials and again in the final pre-request current-connection assertion. A removed or repointed portal therefore blocks old facets before outbound traffic. Reconnecting moves the account to the new deployment-owned endpoint and clears old OAuth state through the existing connection-generation mechanism.

### User and Gadget flow

Once configured:

1. The user opens **Connectors** and chooses the approved MCP Portal.
2. The user completes OAuth against the portal.
3. In a workspace, the user or agent requests an MCP resource.
4. The existing configurator lists upstream portal servers and tools.
5. The user grants exactly one upstream server, with either all tools or selected tools.
6. The resulting capability is introduced to that chat or bound into a Gadget.

The portal is not ambient. No workspace or Gadget receives it until the user explicitly grants it.

### Generic MCP connector default

New deployments start with the `mcp` Gatekeeper disabled in `DEFAULT_ADMIN_CONFIG`. Administrators can deliberately enable it from the existing Gatekeepers controls. Persisted configuration remains authoritative during upgrades; this is a safe default for new deployments, not a hard migration or revocation mechanism.

## Security Model

### Assets

- Backend Cloudflare API token used for connector configuration.
- Per-user portal OAuth tokens.
- The deployment-approved MCP endpoint.
- MCP tool grants and action approvals.

### Trust boundaries

- Browser → `AdminApi`: only a server-minted admin capability can configure a connector.
- Workshop backend → Cloudflare API: the API token remains server-side and connector/Worker/input names are allowlisted.
- Portal Gatekeeper → external portal/OAuth endpoints: existing SSRF-safe fetch and redirect validation remains mandatory.
- Agent/Gadget → MCP tools: existing observation authorization and action approval queues remain mandatory.

### Invariants

- An ordinary user cannot modify deployment connector configuration.
- The browser cannot choose a Worker name or secret name.
- A configured portal must use HTTPS and cannot carry credentials in its URL.
- Portal authentication cannot downgrade from OAuth to anonymous or shared-token access.
- A stale account or facet cannot contact a removed or repointed portal.
- Every Gadget grant covers one upstream server, never the whole portal.
- The generic arbitrary-endpoint connector is unavailable by default on new deployments.

## Failure Behavior

- Invalid URL: reject before calling the Cloudflare API.
- Cloudflare API error: retain existing configuration and return a bounded error without response bodies or credentials.
- Successful write not yet active: show saved/propagating status and reload authoritative readiness.
- Unconfigured portal: omit from user connector discovery and reject direct connection attempts.
- Public endpoint configured as portal: reject because no OAuth challenge was received.
- Portal repoint/removal: existing sessions fail before outbound MCP traffic and ask the user to reconnect.
- OAuth expiry/revocation: preserve existing reconnect behavior.

## Testing

- Backend unit tests for explicit `mcp_portal` → `mcp-portal` Worker mapping, URL validation, allowlisting, and no request on invalid input.
- Frontend tests for URL rendering, omitted callback instructions, save/reload behavior, and admin-only access.
- Portal config tests proving OAuth-only behavior and configuration readiness.
- MCP account tests proving an OAuth-declared endpoint cannot downgrade to unauthenticated access.
- Account/facet tests proving live portal removal and repoint block credentials and outbound calls.
- Admin config tests proving new deployments disable `mcp` while explicit persisted settings remain authoritative.
- Focused package tests, then full build, unit tests, integration tests, and lint.

## Rollout

1. Deploy the release with `gatekeeper-mcp-portal` bound per tenant.
2. Ensure `CONNECTOR_CONFIG_ACCOUNT_ID`, `CONNECTOR_CONFIG_WORKER_PREFIX`, and least-privilege `CONNECTOR_CONFIG_API_TOKEN` are configured.
3. In Cloudflare Zero Trust, create or select the MCP Server Portal and its approved upstream servers.
4. In Cloudflare OS, configure the portal endpoint under **Admin → Connector configuration**.
5. For existing deployments, disable the generic MCP connector manually if approved-only access is required; the new default applies automatically only to new deployments.
6. Verify a non-admin cannot access the admin configuration capability and a user can complete OAuth and grant one upstream server to a workspace.
