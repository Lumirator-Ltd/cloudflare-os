# Telegram Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development by default to implement this plan task-by-task. Run independent, safely isolated tasks in parallel; sequence tasks that share state or dependencies. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-click Telegram account linking plus durable private/group text and incoming-photo messaging through normal Cloudflare OS workspaces.

**Architecture:** The Workshop backend owns Telegram ingress, a `TelegramChannel` link store, and a durable per-update queue. Authenticated link methods store the canonical `UserDurableObject` ID; the channel resolves that private link and calls the shared internal message router under normal Overseer ACLs. `ExternalMessageGateway` remains an email-keyed compatibility ingress and is not part of Telegram routing. Profile exposes connect/status/unlink. Deployment accepts only a BotFather token and derives the remaining Telegram configuration.

**Tech Stack:** Cloudflare Workers, Durable Objects, native Workers RPC, Cap'n Web, typed-storage, React, Vitest, pnpm.

---

### Task 1: Canonical User DO Telegram linking

**Files:**
- Create: `packages/workshop-backend/src/telegram/link-store.ts`
- Modify: `packages/workshop-backend/src/telegram/channel.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Modify: `packages/workshop-backend/src/env.d.ts`
- Modify: `packages/workshop-shared/src/api.ts`
- Test: `packages/workshop-backend/__tests__/telegram-link-store.test.ts`
- Test: `packages/workshop-backend/__tests__/telegram-channel.test.ts`

- [ ] **Step 1: Write failing link-store tests** for latest-only SHA-256 tokens, expiry, single-use atomic completion, Telegram/User DO uniqueness, relink, unlink, idempotent receipts, and bounded cleanup.
- [ ] **Step 2: Run the focused tests and verify expected failures.**

Run: `pnpm --filter @gadgets/workshop-backend test:unit -- telegram-link-store.test.ts telegram-channel.test.ts`

- [ ] **Step 3: Implement dedicated Telegram link/token/receipt collections in `TelegramChannel`.** Store only the authenticated user's canonical `UserDurableObject` ID string, never an email or provider subject.
- [ ] **Step 4: Write failing AuthenticatedApi tests** proving start/status/unlink derive that Durable Object ID from the current authenticated capability.
- [ ] **Step 5: Add documented shared RPC result types and authenticated methods.** Use `TELEGRAM_BOT_TOKEN` only as an enablement signal; obtain the verified username through `TelegramChannel.getBotIdentity()`.
- [ ] **Step 6: Run focused unit tests and type checks.**
- [ ] **Step 7: Commit.**

```bash
git add packages/workshop-backend/src/telegram/link-store.ts packages/workshop-backend/src/telegram/channel.ts packages/workshop-backend/src/server.ts packages/workshop-backend/src/env.d.ts packages/workshop-shared/src/api.ts packages/workshop-backend/__tests__/telegram-link-store.test.ts packages/workshop-backend/__tests__/telegram-channel.test.ts
git commit -m "feat: add Telegram account links"
```

### Task 2: Private Telegram message routing and incoming attachments

**Files:**
- Modify: `packages/workshop-backend/src/telegram/channel.ts`
- Modify: `packages/workshop-backend/src/external-message-routing.ts`
- Modify: `packages/workshop-backend/src/overseer.ts`
- Test: `packages/workshop-backend/__tests__/telegram-channel.test.ts`
- Test: `packages/workshop-backend/__integration__/external-message-gateway.test.ts`

- [ ] **Step 1: Write failing channel tests** proving an unlinked Telegram user reveals no account information and a linked user is routed only by the stored canonical User DO ID.
- [ ] **Step 2: Write failing attachment/callback tests** for one image, photo-only prompts, authoritative size/signature validation, deduplication, and callback workspace path.
- [ ] **Step 3: Run focused tests and verify expected failures.**
- [ ] **Step 4: Route Telegram privately from `TelegramChannel` through the shared internal message router.** Do not add a linked-subject mode to `ExternalMessageGateway`.
- [ ] **Step 5: Extract one internal attachment staging helper** and reuse it from browser upload and private Telegram submission.
- [ ] **Step 6: Extend response delivery with the workspace path and preserve existing retry/disposal behavior.**
- [ ] **Step 7: Run focused unit/integration tests and type checks.**
- [ ] **Step 8: Commit.**

```bash
git add packages/workshop-backend/src/telegram/channel.ts packages/workshop-backend/src/external-message-routing.ts packages/workshop-backend/src/overseer.ts packages/workshop-backend/__tests__/telegram-channel.test.ts packages/workshop-backend/__integration__/external-message-gateway.test.ts
git commit -m "feat: route Telegram messages privately"
```

### Task 3: Durable Telegram webhook and Bot API transport

**Files:**
- Create: `packages/workshop-backend/src/telegram/types.ts`
- Create: `packages/workshop-backend/src/telegram/parser.ts`
- Create: `packages/workshop-backend/src/telegram/api.ts`
- Create: `packages/workshop-backend/src/telegram/channel.ts`
- Create: `packages/workshop-backend/src/telegram/webhook.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Modify: `packages/workshop-backend/src/env.d.ts`
- Modify: `packages/workshop-backend/wrangler.jsonc`
- Modify: `packages/workshop-backend/wrangler.dev.jsonc`
- Test: `packages/workshop-backend/__tests__/telegram-parser.test.ts`
- Test: `packages/workshop-backend/__tests__/telegram-api.test.ts`
- Test: `packages/workshop-backend/__tests__/telegram-channel.test.ts`
- Test: `packages/workshop-backend/__tests__/telegram-webhook.test.ts`

- [ ] **Step 1: Write failing pure parser tests** for private/group activation, UTF-16 entities, exact bot ID/username matching, topics, anonymous/bot/channel rejection, `/start`, photos, and malformed updates.
- [ ] **Step 2: Implement bounded normalization without storing Telegram profiles.**
- [ ] **Step 3: Write failing Telegram API tests** for `getMe`, fixed origins, no token-bearing errors, streamed 1 MiB cap, placeholder/edit behavior, truncation with workspace URL, and transient/permanent classification.
- [ ] **Step 4: Implement the minimal Telegram API client using injected fetch in tests.**
- [ ] **Step 5: Write failing durable state-machine tests** for enqueue-before-ack, duplicate/out-of-order updates, restart transitions, one backend turn, persistent callback, and retries.
- [ ] **Step 6: Implement `TelegramChannel` and exported restart-safe response target.** Persist normalized records only, process through alarms, and dispose retained stubs.
- [ ] **Step 7: Write failing webhook tests** for secret comparison, method/path/content-length/body bounds, and durable enqueue.
- [ ] **Step 8: Route `/api/telegram/webhook`, export DO/RPC classes, and add a new SQLite migration tag.**
- [ ] **Step 9: Generate Worker types, run focused tests, and run backend type checks.**
- [ ] **Step 10: Commit.**

```bash
git add packages/workshop-backend/src/telegram packages/workshop-backend/src/server.ts packages/workshop-backend/src/env.d.ts packages/workshop-backend/wrangler.jsonc packages/workshop-backend/wrangler.dev.jsonc packages/workshop-backend/__tests__/telegram-*.test.ts
git commit -m "feat: receive Telegram messages"
```

### Task 4: One-click Profile integration

**Files:**
- Create: `packages/workshop-frontend/src/components/TelegramSettings.tsx`
- Create: `packages/workshop-frontend/src/components/TelegramSettings.test.tsx`
- Modify: `packages/workshop-frontend/src/SettingsPage.tsx`
- Modify: `packages/workshop-frontend/src/ServerConfigContext.tsx`
- Modify: `packages/workshop-shared/src/api.ts`

- [ ] **Step 1: Write failing component tests** for hidden, disconnected, popup/deep-link, connected, error, and unlink states.
- [ ] **Step 2: Run the component test and verify expected failures.**
- [ ] **Step 3: Implement a compact Telegram Profile section** using existing page styles and authenticated RPC; never expose configuration details.
- [ ] **Step 4: Run focused tests, frontend type checks, and accessibility assertions.**
- [ ] **Step 5: Commit.**

```bash
git add packages/workshop-frontend/src/components/TelegramSettings.tsx packages/workshop-frontend/src/components/TelegramSettings.test.tsx packages/workshop-frontend/src/SettingsPage.tsx packages/workshop-frontend/src/ServerConfigContext.tsx packages/workshop-shared/src/api.ts
git commit -m "feat: add Telegram profile linking"
```

### Task 5: One-token deployment setup

**Files:**
- Create: `scripts/configure-telegram.mjs`
- Create: `scripts/configure-telegram.test.js`
- Modify: `package.json`
- Modify: `docs/public-server.md`
- Modify: `.gitignore`
- Modify as required: release manifest/deployment input tests

- [ ] **Step 1: Write failing script tests** proving token input is never printed, `getMe` derives identity, a webhook secret is generated, `setWebhook` uses the exact public URL and allowed updates, and verification fails closed.
- [ ] **Step 2: Implement a non-interactive deployment helper** that accepts secrets through environment/stdin-safe mechanisms and prints only non-secret status.
- [ ] **Step 3: Document BotFather token creation, automatic setup, Privacy Mode, rotation, and uninstall.**
- [ ] **Step 4: Ensure `.env*` and operation artifacts remain ignored; create no tenant files in version control.**
- [ ] **Step 5: Run script tests and release manifest golden tests.**
- [ ] **Step 6: Commit.**

```bash
git add scripts/configure-telegram.mjs scripts/configure-telegram.test.js package.json docs/public-server.md .gitignore
git commit -m "feat: automate Telegram setup"
```

### Task 6: Verification, PR, merge, and Vlightup deployment

**Files:**
- No feature files expected.
- Project-local private operations only under the owning repository's ignored `.operations/vlightup/stg/`.

- [ ] **Step 1: Run all required verification.**

```bash
pnpm test:unit
pnpm test:integration
pnpm build
pnpm lint
```

Record the pre-existing `mcp-shared` Unicode line-separator timeout separately if it reproduces; rerun that focused test before classifying it as baseline-only.

- [ ] **Step 2: Inspect the full diff and secret scan.**
- [ ] **Step 3: Push only to `origin` and open a PR targeting `main`.** Omit the organization name from the PR body.
- [ ] **Step 4: Comment exactly `@codex review`; fix P0/P1 findings with small commits and re-request until clear.**
- [ ] **Step 5: Merge only after required checks and the latest Codex review are clear.** Use explicit merge subject/body without organization-name text.
- [ ] **Step 6: Deploy the merged commit to Vlightup** using the repository's project-local ignored operations files and established deployment workflow. Never print or commit the bot token, webhook secret, tenant config, state, plans, or handoffs.
- [ ] **Step 7: Verify Vlightup health, Telegram `getWebhookInfo`, one link flow, one private text turn, one group mention, and one incoming photo turn.**
