# AI Gateway billing

An optional flow that bills inference to a user's **own Cloudflare AI Gateway credits**. A
deployment can offer a free daily allowance before requiring user funding, or require user funding
from the first request. Both modes are off by default, leaving usage unlimited for self-hosted
deployments.

## How it works

With `ENABLE_CLOUDFLARE_LIMITS=true`, each user gets a free allowance of LLM calls per UTC day
(default 100), counted on the user's own `UserDurableObject` (`consumeDailyLlmCall` /
`checkDailyLlmCount`). Before each user-initiated agent turn, the overseer calls
`checkUsageAndBalance`:

- **Connected, balance ≥ `$2`** → allowed, routed through the user's own account so usage bills
  their Cloudflare credits — even while free-tier allowance remains. The platform is never charged
  for funded users, and their daily free-tier counter is left untouched.
- **Otherwise, within the free tier** → allowed, served via the platform's configured AI Gateway.
  Workers AI uses the same Gateway ID unless `CF_AI_GATEWAY_WAI_DIRECT=true` sends it straight to
  the Workers AI REST endpoint or `CF_AI_GATEWAY_WAI` selects another Gateway. This includes
  connected users whose balance is below `$2` (incl. $0).
- **Free tier exhausted, no Cloudflare account connected** → blocked, with a prompt to connect.
- **Free tier exhausted, connected but balance below `$2`** → blocked, with a prompt to add credits.

With `REQUIRE_USER_FUNDED_AI=true`, there is no platform-funded allowance or fallback. A request is
allowed only when the user has connected a Cloudflare account with at least the configured minimum
balance; it is then routed through that account's default AI Gateway. Disconnected, unresolved,
expired, unknown-balance, and underfunded connections fail closed. Callback-initiated continuations
use the same requirement, and `getModel()` independently rejects an attempted platform-gateway
fallback.

The balance shown to users is read live from their Cloudflare AI Gateway billing
(`/ai-gateway-billing/credit_balance`), cached for 5 minutes. Topping up means adding credits in the
[Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway) — the platform never
holds money.

## Connecting Cloudflare

Billing is tied to the **Cloudflare gatekeeper**: the OAuth tokens live in that gatekeeper's
connection, and the billing flow obtains a usable token from it via `getUsableAccessToken()`. A user
connects Cloudflare through the "Connect Cloudflare" button, which runs the explicit full-scope
gatekeeper connect flow (`AuthenticatedApi.connectAccount("cloudflare")`). Signing in with
Cloudflare is deliberately separate: it requests only transient identity scopes and never creates
billing authority. See [sign-in](./oauth-signin.md) for the OAuth mechanics and redirect URIs.

The account to bill is auto-selected when the grant sees exactly one account; with several, the user
is prompted to choose one. Billing is account-level (Unified Billing): inference is routed through
the account's auto-created "default" AI Gateway.

## Configuration

```
# Choose either a free allowance with user-funded overflow:
ENABLE_CLOUDFLARE_LIMITS=true
# Or require user funding from the first inference request:
REQUIRE_USER_FUNDED_AI=true

PUBLIC_BASE_URL=https://your-host
AUTH_GATEKEEPERS=cloudflare       # allow Cloudflare sign-in (connector availability is separate)

# The Cloudflare gatekeeper's OAuth app (client id/secret live on the gatekeeper Worker; in dev
# they're seeded from these shell vars by run-dev-server.js):
CLOUDFLARE_OAUTH_CLIENT_ID=...
CLOUDFLARE_OAUTH_CLIENT_SECRET=...

# Platform AI Gateway used for the free tier, or only as the model catalog in required-user-funding mode:
CF_AI_GATEWAY=your-gateway
CF_AI_GATEWAY_PROVIDERS=anthropic,openai,google

# Required whenever CF_AI_GATEWAY is set (all inference goes over HTTPS with tokens):
CF_AI_GATEWAY_ACCOUNT_ID=...
CF_AI_GATEWAY_API_TOKEN=...

# To send Workers AI straight to its REST endpoint (no gateway, no cost logs):
CF_AI_GATEWAY_WAI_DIRECT=true
```

Gateway mode always requires `CF_AI_GATEWAY_ACCOUNT_ID` and an API token with AI Gateway Run and
Read permissions; Read access lets Gadgets retrieve each log's cost for user-visible accounting.
Workers AI uses `CF_AI_GATEWAY` as its Gateway ID by default; set `CF_AI_GATEWAY_WAI` to select
another Gateway, or `CF_AI_GATEWAY_WAI_DIRECT=true` to call the Workers AI REST endpoint directly
(same credentials, no gateway cost logs).

The Cloudflare dashboard OAuth endpoints and scopes are **hardcoded** in the Cloudflare gatekeeper
(`packages/gatekeeper-cloudflare/src/oauth.ts`):

- auth: `https://dash.cloudflare.com/oauth2/auth`
- token: `https://dash.cloudflare.com/oauth2/token`
- sign-in scopes: `offline_access user-details.read` (transient identity grant)
- explicit connector scopes: `offline_access aig.read aig.run aig.write user-details.read account-settings.read`
  (persistent billing grant)

Cloudflare gatekeeper redirect URI: `${PUBLIC_BASE_URL}/gatekeeper/cloudflare/oauth`.

`REQUIRE_USER_FUNDED_AI` takes precedence when both billing flags are true: the daily counter is not
read or consumed, and no request is sent through the platform-funded gateway.

Optional (all have sensible defaults):

```
DAILY_LLM_CALL_LIMIT=100        # free-tier LLM calls per user per UTC day
MINIMUM_CLOUDFLARE_BALANCE=2    # min connected-account balance (USD) to proceed via BYOK
```

## Storage / bindings

The free-tier daily LLM-call counter lives on each `UserDurableObject` (no separate binding).

The OAuth tokens live in the connected Cloudflare *gatekeeper* account. Each `UserDurableObject`
stores only lightweight billing state (the selected account id + a cached credit balance, plus the
daily counter) — no tokens.

## Code layout

Server code lives under `packages/workshop-backend/src/ai-gateway-billing/`:

```
ai-gateway-billing/
├── config.ts                     # ENABLE_CLOUDFLARE_LIMITS / minimum-balance readers
├── limits/
│   ├── config.ts                 # daily-limit + calendar-day helpers + DailyQuotaResult
│   └── usage-checker.ts          # checkUsageAndBalance / getUsageInfo (counter lives on UserDurableObject)
└── cloudflare/
    ├── account-service.ts        # CF REST: accounts / balance
    └── connection-service.ts     # token (from CF gatekeeper), account selection, balance cache, BYOK routing
```

Client-side: `ServerConfigContext` exposes `cloudflareLimitsEnabled`; `components/billing/`
(`UsageSettings`, `OutOfCreditsModal`, `AccountSelectionModal`) renders the usage / top-up /
account-selection UI.
