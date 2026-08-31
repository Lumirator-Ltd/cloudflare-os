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
| `AUTH_GATEKEEPERS=cloudflare,google,github` | Allowlists which bound, auth-capable gatekeeper vendors may be used for transient sign-in. Each shows a "Continue with …" button alongside username/password; sign-in neither requires nor creates a connected account. |
| Each gatekeeper's OAuth credentials (on the gatekeeper Worker) | Required for that gatekeeper to actually authenticate. In dev, seeded from `GOOGLE_*` / `GITHUB_*` / `CLOUDFLARE_OAUTH_*` shell vars (see `run-dev-server.js`). |
| `ENABLE_CLOUDFLARE_LIMITS=true` | Enables the free daily limit + Cloudflare-credits top-up flow. Billing reads a token from the connected Cloudflare gatekeeper. |
| `REQUIRE_USER_FUNDED_AI=true` | Disables platform-funded inference and requires a connected Cloudflare account with sufficient AI Gateway credits from the first request. Takes precedence over the free-tier flag. |
| `DISABLE_PASSWORD_AUTH=true` | Hides username/password, leaving gatekeeper sign-in only (ignored unless `AUTH_GATEKEEPERS` is non-empty, to avoid lockout). |

For Gatekeeper, Clerk, and Cloudflare Access authentication, a **verified email is a convergence
claim, not the durable account key**: the deployment-local Identity Registry maps it to an opaque
stable internal ID. Access additionally keys its stable subject by the verified issuer and configured
audience, so two Access deployments cannot collide by subject alone. A verified Access email change
moves that subject's email mapping and version; a conflicting move locks the identity rather than
merging accounts. Each Access API WebSocket and all capabilities minted from it expire at the JWT's
absolute `exp`; extending authority requires reconnecting with a fresh Access assertion. The legacy
built-in password path remains locally username-keyed until it is disabled or removed; neither
usernames nor opaque IDs should be interpreted as provider identities.

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

# Required whenever CF_AI_GATEWAY is set (all inference goes over HTTPS with tokens):
CF_AI_GATEWAY_ACCOUNT_ID=...
CF_AI_GATEWAY_API_TOKEN=...

# To send Workers AI straight to its REST endpoint (no gateway, no cost logs):
CF_AI_GATEWAY_WAI_DIRECT=true
```

Gateway mode always requires `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_API_TOKEN`; the token
needs AI Gateway Run and Read permissions so Gadgets can execute models and report their costs
(the Gateway may live in the Worker's own account or a different one). Workers AI defaults to the
same Gateway ID; set `CF_AI_GATEWAY_WAI` to route it through a different Gateway in the same
account, or `CF_AI_GATEWAY_WAI_DIRECT=true` to bypass gateways and call the Workers AI REST
endpoint directly (using the same account/token pair; such requests produce no cost logs).

When using `CF_AI_GATEWAY*` in local development, start the server with
`pnpm run dev-server -- --use-workers-ai-binding` so the webFetch tool's document-to-Markdown
conversion still has a `WORKERS_AI` binding. (Inference itself no longer uses the binding; it goes
over HTTPS with the tokens above.)

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

To rotate credentials, revoke the old token with BotFather, submit the replacement token to the
managed service, and let deployment generate a new webhook secret, update both Worker secrets, and
register and verify the webhook again. To uninstall Telegram, use the managed deployment removal
flow to delete the Telegram webhook and remove both Worker secrets, then revoke the bot token with
BotFather. Do not place tokens, webhook secrets, or tenant-specific setup output in repository
files.
