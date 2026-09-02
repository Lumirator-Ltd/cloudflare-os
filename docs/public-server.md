# Running Gadgets as a public, multi-user service

By default the Workshop uses built-in username/password accounts (or Cloudflare Access) and gives
every user unlimited AI usage — ideal for self-hosting. It can optionally run as a public,
multi-user service instead: users sign in with Google, GitHub, or Cloudflare, then either receive a
free daily allowance before connecting their own funded Cloudflare account or must connect that
account before their first inference request.

Sign-in is provided by **authentication gatekeepers**: each auth-capable gatekeeper (Google, GitHub,
Cloudflare) uses its single OAuth app both to authenticate the user (by verified email) and to
connect the account's capabilities. There's no single switch — the pieces turn on independently:

| Configure | Effect |
| --- | --- |
| `AUTH_GATEKEEPERS=cloudflare,google,github` | Allowlists which bound, auth-capable gatekeepers may be used to sign in. Each advertised vendor shows an enabled "Continue with …" button alongside username/password. Google and GitHub login grants are transient; Cloudflare sign-in persists its account for AI Gateway billing. |
| Each gatekeeper's OAuth credentials (on the gatekeeper Worker) | Required for that gatekeeper to actually authenticate. In dev, seeded from `GOOGLE_*` / `GITHUB_*` / `CLOUDFLARE_OAUTH_*` shell vars (see `scripts/run-dev-server.ts`). |
| `ENABLE_CLOUDFLARE_LIMITS=true` | Enables the free daily limit + Cloudflare-credits top-up flow. Billing reads a token from the connected Cloudflare gatekeeper. |
| `REQUIRE_USER_FUNDED_AI=true` | Disables platform-funded inference and requires a connected Cloudflare account with sufficient AI Gateway credits from the first request. Takes precedence over the free-tier flag. |
| `DISABLE_PASSWORD_AUTH=true` | Hides username/password, leaving gatekeeper sign-in only (ignored unless `AUTH_GATEKEEPERS` is non-empty, to avoid lockout). |

The durable account key is a **username or provider-verified email**. Built-in password accounts use
the normalized username. Authentication gatekeepers route the verified email returned by the
provider directly to `UserDurableObject.idFromName(email)`, so gatekeepers returning the same exact
email reach the same account.

Cloudflare Access verifies the request's JWT against the configured issuer and audience, requires its
email claim, and routes that raw verified email to the same email-keyed User DO. The Workshop does not
lowercase or otherwise canonicalize Access or gatekeeper emails; changing that route would make
existing account state unreachable. Direct sharing therefore discovers a User DO by its username or
email account key.

For local development, set the required variables in a root `.dev.vars` file (gitignored,
`KEY=VALUE` per line); `pnpm run dev-server` loads it automatically. A minimal example:

```
# Choose ENABLE_CLOUDFLARE_LIMITS for a free allowance, or require user funding immediately:
REQUIRE_USER_FUNDED_AI=true
PUBLIC_BASE_URL=http://localhost:8787
AUTH_GATEKEEPERS=cloudflare,google,github

# Each gatekeeper's OAuth app (client id/secret). In dev these seed the gatekeeper Workers:
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
CLOUDFLARE_OAUTH_CLIENT_ID=...
CLOUDFLARE_OAUTH_CLIENT_SECRET=...

# Model catalog and platform Gateway. In required-user-funding mode, its credentials are never used
# for inference; every allowed call is routed through the connected user's default Gateway.
CF_AI_GATEWAY=your-gateway
CF_AI_GATEWAY_PROVIDERS=anthropic,openai,google

# Required whenever CF_AI_GATEWAY is set:
CF_AI_GATEWAY_ACCOUNT_ID=...
# Required unless the WORKERS_AI binding carries gateway traffic (see below); always required
# for the google provider:
CF_AI_GATEWAY_API_TOKEN=...
```

Gateway mode always requires `CF_AI_GATEWAY_ACCOUNT_ID`, plus a transport for gateway requests.
When the `WORKERS_AI` binding is present, the binding is that transport by default: its requests
are pre-authenticated in-account, so inference and cost-log reads need no API token. This is only
valid when the Gateway lives in the Worker's **own** account — binding requests can't reach
another account's Gateway, and the Worker cannot verify where the Gateway lives at runtime — so
deployments whose Gateway is in a different account must set `CF_AI_GATEWAY_USE_BINDING=false` to
opt out and route over HTTPS instead. Keep `WORKERS_AI` bound when you do: it is also what the
webFetch tool's document-to-Markdown conversion runs on, so unbinding it opts out of far more than
the gateway transport. Without the binding transport, set
`CF_AI_GATEWAY_API_TOKEN` — a token with AI Gateway Run and Read permissions so Gadgets can
execute models and report their costs (over HTTPS the Gateway may live in the Worker's own
account or a different one). The token stays required for the `google` provider regardless of the
binding (the model SDK adapter refuses the binding's fetch — note the platform config above enables
it, so the platform server itself still needs the token). Every provider, Workers AI included,
routes through the same Gateway.

When using `CF_AI_GATEWAY*` in local development, start the server with
`pnpm run dev-server -- --use-workers-ai-binding` so the server has a `WORKERS_AI` binding for
the webFetch tool's document-to-Markdown conversion and for the gateway transport above (without
it, gateway traffic falls back to HTTPS with `CF_AI_GATEWAY_API_TOKEN`). If your dev Gateway
lives in a different account than the binding, also set `CF_AI_GATEWAY_USE_BINDING=false` — keep
`--use-workers-ai-binding` on, since the Markdown conversion still needs the binding.

Each gatekeeper's OAuth app must be registered with that gatekeeper's redirect URI (replace the host
with `PUBLIC_BASE_URL`):

- GitHub: `${PUBLIC_BASE_URL}/gatekeeper/github/oauth`
- Google: `${PUBLIC_BASE_URL}/gatekeeper/google/oauth`
- Cloudflare: `${PUBLIC_BASE_URL}/gatekeeper/cloudflare/oauth`

See [docs/oauth-signin.md](oauth-signin.md) and [docs/ai-gateway-billing.md](ai-gateway-billing.md)
for the full list of options, free-tier and required-user-funding behavior, and storage bindings.

## Telegram bot

Create a bot by opening [BotFather](https://t.me/BotFather) and sending `/newbot`. Keep
BotFather's default Privacy Mode enabled. The deployment admin supplies the managed service with
only the resulting bot token; users never need that token.

The managed deployment derives the bot ID and username with Telegram's `getMe`, generates a random
webhook secret, stores the token and webhook secret as Worker secrets, and registers
`${PUBLIC_BASE_URL}/api/telegram/webhook` for message updates. It then verifies Telegram's recorded
webhook URL and delivery status before reporting success. The deployment primitive is
`pnpm telegram:configure`. Its only customer-supplied secret is `TELEGRAM_BOT_TOKEN`;
`PUBLIC_BASE_URL` and the absolute `TELEGRAM_WRANGLER_CONFIG` path come from the deployment
context. The CLI generates the webhook secret, writes both Worker secrets through the repo-pinned
Wrangler using stdin, then registers and verifies the webhook without printing either secret.
Run `pnpm telegram:configure -- --uninstall` with the same deployment context to delete the webhook
and remove both Worker secrets.

After setup, each user opens **Profile > Connect**, selects Telegram, and presses **Start** to link
their Telegram account. For a group conversation, add the bot to the group and address it by
mentioning its username, replying to one of its messages, or starting a message with `/ask`.
Privacy Mode should remain enabled so unrelated group messages are not delivered to the bot.
Images can be sent to Gadgets from Telegram, but image transfer is incoming-only; bot responses in
Telegram are text.

To rotate credentials, first run the explicit uninstall flow with the current token so it can delete
the existing Telegram webhook and both Worker secrets. Then revoke the old token with BotFather and
run the install flow with the replacement token; deployment generates a new webhook secret and
registers and verifies the replacement webhook. The installer fails closed if either Worker secret
already exists, so rerunning it does not rotate credentials. To uninstall Telegram without replacing
it, use the same managed deployment removal flow before revoking the bot token with BotFather. Do not
place tokens, webhook secrets, or tenant-specific setup output in repository files.
