# Admin connector configuration design

## Goal

Preserve Cloudflare OS connector behavior and the existing Admin Gatekeepers controls while adding:

- a clear user-facing unconfigured state: **Ask an administrator to configure this connector.**;
- a server-side rejection for raced or crafted requests: **This connector is not configured. Ask an administrator to configure it.**;
- `/admin/connectors`, where deployment admins can write or rotate OAuth credentials.

This is an MVP for managed client deployments. Keep the change narrow and reuse each Gatekeeper's existing `CLIENT_ID` / `CLIENT_SECRET` environment contract.

## Readiness contract

`VendorDescription` gains optional configuration metadata containing only whether the connector is configured. OAuth Gatekeepers report configured only when both `CLIENT_ID` and `CLIENT_SECRET` are present. Connectors without deployment credentials omit configuration metadata and behave exactly as today.

The Workshop kernel owns an immutable connector-ID allowlist and the exact write-only inputs for each connector. Gatekeeper metadata cannot select Cloudflare secret names, worker targets, or additional mutation inputs.

The Workshop propagates readiness through the existing vendor catalog. An unconfigured connector stays visible but is not connectable. Every connection entry point also checks readiness server-side and returns the administrator guidance message.

## Admin API and UI

`/admin/connectors` uses the existing `AdminApi` capability, which is minted only after the deployment-admin check. It lists only bound connectors that declare configuration inputs.

For each connector it shows:

- display name and logo;
- configured / needs setup status;
- OAuth callback URL;
- write-only Client ID and Client Secret fields;
- Save / Rotate action.

Existing `/admin` Gatekeeper enable/disable and resource controls remain unchanged. A link from that section opens `/admin/connectors`.

## Secret writes

The Workshop backend calls Cloudflare's official Workers secret endpoint:

`PUT /accounts/{account_id}/workers/scripts/{script_name}/secrets`

The backend accepts only its fixed connector ID and input-name allowlists. Values are non-empty, bounded, never logged, never persisted in Durable Object storage, and never returned. Cloudflare stores them as `secret_text` bindings.

Deployment configuration supplies:

- `CONNECTOR_CONFIG_ACCOUNT_ID`;
- `CONNECTOR_CONFIG_WORKER_PREFIX`;
- secret `CONNECTOR_CONFIG_API_TOKEN`, scoped to the target account with only `Workers Scripts Write`.

Worker names are derived as `<prefix><vendorId>`. HTTP errors are redacted. Existing configured secrets are detected from Gatekeeper readiness rather than read back.

## Scope

The first release supports the credentialed connectors currently deployed by Lumirator: Cloudflare, Confluence, GitHub, Google, HubSpot, Linear, Notion, Slack, Spotify, Supabase, and ZoomInfo.

Email remains unavailable on `workers.dev`; MCP Portal remains excluded due incomplete deployment metadata. Home Assistant, MCP, Scheduler, and Context need no static OAuth app credentials and remain unchanged.

## Verification

- backend tests cover admin authorization boundary, allowlists, write-only semantics, redacted failures, and Cloudflare API requests;
- Gatekeeper tests cover configured/unconfigured descriptions;
- frontend tests cover disabled user cards, admin guidance, admin route, save/rotate, and no secret readback;
- typecheck, build, lint, and focused package tests pass before staging deployment.
