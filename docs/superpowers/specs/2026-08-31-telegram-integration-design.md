# Telegram Integration Design

## Goal

Let linked Cloudflare OS users send text and one incoming Telegram photo to the normal workspace agent from private chats and privacy-mode group mentions/replies, then receive the text response and workspace link in Telegram.

## Product contract

### Deployment administrator

The only customer-supplied value is a BotFather bot token. The deployment operation:

1. stores the token as `TELEGRAM_BOT_TOKEN` on the Workshop backend;
2. generates and stores `TELEGRAM_WEBHOOK_SECRET`;
3. calls Telegram `getMe` and derives the canonical numeric bot ID and username;
4. registers `${PUBLIC_BASE_URL}/api/telegram/webhook` with `setWebhook`, the generated secret, and the minimal allowed update set;
5. verifies webhook state before reporting success.

The username, bot ID, webhook URL, and webhook secret are never manually entered. Privacy Mode remains enabled.

### End user

Profile shows Telegram only when the integration is configured. **Connect Telegram** creates a 32-byte random, ten-minute, latest-only token and opens `https://t.me/<verified_username>?start=<token>`. The user taps Start. No code entry, email matching, or Telegram OIDC flow is required.

### Conversations

- A private Telegram chat maps to one workspace per Telegram user. A Telegram private topic maps to one workspace chat; otherwise the root chat is reused.
- A group or supergroup maps to one workspace per Telegram chat. A forum topic maps to one workspace chat; otherwise the root chat is reused.
- The first linked invoker owns a new group workspace. Later linked users must already have normal `build` access.
- In groups the bot processes only an exact `/ask` command addressed to it, an exact bot mention represented by Telegram entities, or a reply to the verified numeric bot ID. Channel posts, bots, anonymous senders, edited messages, and group `/start` are ignored.
- Responses are plain text only. One incoming Telegram photo is supported; outbound images are not.

## Architecture

Telegram lives inside `workshop-backend` for the MVP. The public router already forwards `/api/*` to the backend, avoiding a new Worker kind, new service-binding topology, or a second deployment lifecycle.

### Identity linking

`TelegramChannel` owns a private link store in its Durable Object storage:

- `telegramLinks`: unique by Telegram user ID and canonical User DO ID;
- `telegramLinkTokens`: latest-only per User DO ID and indexed by SHA-256 digest and expiry;
- `telegramLinkReceipts`: token-digest-bound completion receipts indexed by expiry.

Authenticated link methods derive the canonical `UserDurableObject` ID string from `AuthenticatedApiImpl.#userId`. Starting a link invalidates the previous token. Completion atomically checks digest, expiry, latest token, and reverse uniqueness before consuming the token and replacing that User DO's previous Telegram link. Unlink removes the mapping and pending token. A Telegram identity already linked to another User DO fails closed.

Telegram completion is idempotent by `update_id`: `TelegramChannel` retains a token-digest-bound, Telegram-user-bound result receipt for 24 hours, so a lost RPC acknowledgement can replay the original success without consuming the token again. Receipts never contain the raw token and expire through bounded alarm cleanup.

### Backend API

`AuthenticatedApi` adds:

- `getTelegramLinkStatus()`;
- `startTelegramLink()`;
- `unlinkTelegram()`.

`ServerConfig` exposes only `telegramEnabled`. The bot username is returned only after backend `getMe` verification and is used to construct the deep link.

Telegram routing is private to `TelegramChannel`. It resolves the Telegram user ID through its link store, parses the stored canonical User DO ID with `UserDurableObject.idFromString()`, and calls the shared internal `routeExternalMessage()` helper directly. It never accepts an email or provider subject from Telegram and does not pass through `ExternalMessageGateway`; that gateway retains its email-keyed compatibility contract for separately bound callers.

The internal router applies existing owner/build-collaborator checks, stages incoming images through the existing attachment validator/storage helper, and uses the normal `newChat` / `sendChatMessage` turn path. `GadgetResponse` includes the workspace path so delivery has no submission-result race.

### Telegram ingress and durable processing

`POST /api/telegram/webhook`:

1. requires exact `X-Telegram-Bot-Api-Secret-Token` equality;
2. rejects bodies over 256 KiB before parsing;
3. parses a bounded ordinary `message` update;
4. handles a private `/start` synchronously through the `TelegramChannel` link store without writing its raw bearer token to durable storage, or durably inserts a normalized message record by `update_id`;
5. returns 200 only after synchronous link handling or message insertion.

The DO processes records serially and resumes queued work from an alarm. Pending records use a due index separate from 24-hour update-ID tombstones. Delivered, ignored, and terminal records delete prompts, file IDs, responses, and other payload before retaining a tombstone. Alarm cleanup and draining operate in bounded batches.

For an agent message it sends one `Thinking…` placeholder, persists its Telegram message ID, and submits with `messageKey = update_id`. A restart-safe exported response target stores the completed response in the Telegram DO before acknowledging the backend. The Telegram DO edits the placeholder; repeated identical edits and Telegram's `message is not modified` response are successful. Rate limits and transient failures retry; permanent delivery failures become terminal so backend alarms do not loop forever.

### Photos

The parser selects the largest declared `PhotoSize` at or below 1 MiB and turns an otherwise oversized photo into a terminal user rejection. `getFile` and download use fixed Telegram origins only. Downloads are streamed with a hard `1 MiB + 1` cutoff even when size headers are absent, and the channel validates the JPEG signature before gateway submission. Backend size and signature validation remains authoritative. A photo without caption uses `Please analyze this image.`.

## Security and privacy

- Bot token, webhook secret, and raw link bearer are never written to channel durable storage or included in logs, errors, traces, or user-visible URLs beyond the one intended Telegram deep link.
- Prompt text, image bytes, Telegram request bodies, Telegram profiles, and token-bearing Bot API URLs are not logged.
- Link tokens use 32 random bytes, are stored only by digest, expire after ten minutes, are latest-only and single-use, and are invalidated by link/unlink.
- Telegram IDs and chat/topic IDs are treated as identifiers, not authorization. Authorization always resolves the privately stored canonical User DO ID and then uses existing workspace ACLs.
- Group membership never grants Workshop access automatically.
- Telegram API responses and updates are runtime-validated and bounded.

## Failure behavior

- Invalid webhook authentication: 404 without detail.
- Unlinked sender: bot returns a Connect button/deep-link instruction without disclosing whether any Workshop account exists.
- No model or no workspace permission: edit the placeholder with the backend's actionable rejection.
- Duplicate update: no second placeholder or model turn.
- Backend/Telegram outage: durable queue retries with bounded backoff.
- Oversized/invalid photo: user-facing rejection, no model turn.
- Misconfigured token: Telegram is hidden from Profile and deployment health fails.

## Testing

- Telegram link-store tests cover expiry, latest-only replacement, atomic consume, collisions, relink, unlink, idempotent receipts, and concurrent completion.
- Telegram parser tests cover private/group activation, UTF-16 entities, commands for other bots, anonymous/bot/channel senders, topics, photo captions, and malformed input.
- Transport tests cover webhook secret, body bounds, `getMe`, fixed origins, streamed photo cap, duplicate updates, restart states, response truncation, and permanent/transient Telegram failures.
- Backend integration tests prove canonical User DO routing, normal workspace ACLs, image staging/signature checks, attachment-only input, idempotency, and callback workspace paths.
- Frontend tests cover hidden, disconnected, linking, connected, and unlink states.
- Release/deployment verification proves only the bot token is customer-supplied, the webhook secret is generated, `getMe` binds bot identity, and `setWebhook` succeeds.

## Rollout

Deploy disabled by default. The managed deployment flow accepts the BotFather token, generates the webhook secret, updates backend secrets, deploys, calls `getMe`, registers the webhook, and verifies it. Uninstall calls `deleteWebhook`, removes both secrets, and leaves Workshop data/link mappings inert. Bot token revocation remains available through BotFather.
