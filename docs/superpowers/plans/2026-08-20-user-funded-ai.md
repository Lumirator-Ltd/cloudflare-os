# User-Funded AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development by default to implement this plan task-by-task. Run independent, safely isolated tasks in parallel; sequence tasks that share state or dependencies. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed deployment mode that permits platform-gateway inference only when it is routed through a funded Cloudflare account connected by the user.

**Architecture:** Introduce `REQUIRE_USER_FUNDED_AI=true` as a backend deployment policy. The usage checker will require a connected account with the configured minimum balance, return that account's gateway routing, and never consume or fall back to the platform free tier; `getModel()` will independently reject any attempted platform-gateway fallback. Existing unlimited, free-tier, and direct API-key modes remain unchanged when the flag is off.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, Cap'n Web RPC, React, Vitest, pnpm.

---

### Task 1: Define and enforce the user-funded policy

**Files:**
- Modify: `packages/workshop-backend/__tests__/limits.test.ts`
- Modify: `packages/workshop-backend/__tests__/ai-models.test.ts`
- Modify: `packages/workshop-shared/src/limits.ts`
- Modify: `packages/workshop-backend/src/ai-gateway-billing/config.ts`
- Modify: `packages/workshop-backend/src/ai-gateway-billing/limits/usage-checker.ts`
- Modify: `packages/workshop-backend/src/ai-models.ts`
- Modify: `packages/workshop-backend/src/overseer.ts`
- Modify: `packages/workshop-backend/src/env.d.ts`

- [ ] **Step 1: Write failing policy and routing tests**

Add tests proving that required user funding blocks disconnected and underfunded users even when a free allowance exists, permits funded users via BYOK, and makes `getModel()` reject a platform-gateway route without `userGateway`.

- [ ] **Step 2: Run the narrow tests and verify RED**

Run:

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/limits.test.ts __tests__/ai-models.test.ts
```

Expected: failures because the policy input/configuration and platform fallback guard do not exist.

- [ ] **Step 3: Implement the minimal fail-closed backend policy**

Add `isUserFundedAiRequired()` and a billing-feature predicate, extend the pure request decision with a `requireUserFunding` input, branch before free-tier consumption, route callback continuations through the same funded account, and reject platform AI Gateway use without `userGateway` when the flag is enabled.

- [ ] **Step 4: Run the narrow tests and verify GREEN**

Run the same Vitest command. Expected: all selected tests pass.

- [ ] **Step 5: Commit the backend policy**

```bash
git add packages/workshop-backend/__tests__/limits.test.ts \
  packages/workshop-backend/__tests__/ai-models.test.ts \
  packages/workshop-shared/src/limits.ts \
  packages/workshop-backend/src/ai-gateway-billing/config.ts \
  packages/workshop-backend/src/ai-gateway-billing/limits/usage-checker.ts \
  packages/workshop-backend/src/ai-models.ts \
  packages/workshop-backend/src/overseer.ts \
  packages/workshop-backend/src/env.d.ts
git commit -m "feat: require user-funded AI routing"
```

### Task 2: Expose accurate status and user guidance

**Files:**
- Modify: `packages/workshop-shared/src/api.ts`
- Modify: `packages/workshop-backend/src/deployment-config.ts`
- Modify: `packages/workshop-frontend/src/components/billing/UsageSettings.tsx`
- Modify: `packages/workshop-frontend/src/components/billing/OutOfCreditsModal.tsx`
- Test: `packages/workshop-backend/__tests__/feature-flags.test.ts`

- [ ] **Step 1: Write failing configuration/status tests**

Add tests proving that required-user-funding mode exposes the Cloudflare billing UI even without the free-tier flag and reports that no free allowance is available.

- [ ] **Step 2: Run the narrow tests and verify RED**

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/feature-flags.test.ts __tests__/limits.test.ts
```

Expected: failures because the server config and usage payload do not expose the new mode.

- [ ] **Step 3: Implement status and UI copy**

Expose `userFundingRequired` in the usage payload, show account connection/balance without a fake `0 of 0` free tier, and use connect/fund wording instead of saying the user exhausted free requests.

- [ ] **Step 4: Run narrow tests and type checks**

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/feature-flags.test.ts __tests__/limits.test.ts
pnpm --filter @gadgets/workshop-shared types:check
pnpm --filter @gadgets/workshop-frontend types:check
```

Expected: all commands pass.

- [ ] **Step 5: Commit status and UI changes**

```bash
git add packages/workshop-shared/src/api.ts \
  packages/workshop-backend/src/deployment-config.ts \
  packages/workshop-frontend/src/components/billing/UsageSettings.tsx \
  packages/workshop-frontend/src/components/billing/OutOfCreditsModal.tsx \
  packages/workshop-backend/__tests__/feature-flags.test.ts
git commit -m "feat: show required user funding state"
```

### Task 3: Document deployment and future prepaid credits

**Files:**
- Create: `TODO.md`
- Modify: `docs/ai-gateway-billing.md`
- Modify: `docs/public-server.md`

- [ ] **Step 1: Document the deployment flag**

Document `REQUIRE_USER_FUNDED_AI=true`, its precedence over the free tier, its fail-closed behavior, and the requirement for the Cloudflare gatekeeper OAuth configuration.

- [ ] **Step 2: Record prepaid platform credits**

Create `TODO.md` with a scoped item for collecting prepaid client credits before permitting platform-funded inference, including payment webhook verification, an auditable balance ledger, idempotent debits/refunds, and fail-closed enforcement.

- [ ] **Step 3: Review docs for contradictions**

Search for statements that required-user-funding mode still grants free calls or falls back to platform billing and correct them.

- [ ] **Step 4: Commit documentation**

```bash
git add TODO.md docs/ai-gateway-billing.md docs/public-server.md
git commit -m "docs: describe user-funded AI mode"
```

### Task 4: Verify the complete change

**Files:**
- Verify only

- [ ] **Step 1: Run backend unit tests**

```bash
pnpm --filter @gadgets/workshop-backend test:unit
```

Expected: pass.

- [ ] **Step 2: Run repository type checks and lint**

```bash
pnpm types:check
pnpm lint:check
```

Expected: pass.

- [ ] **Step 3: Run the build**

```bash
pnpm build
```

Expected: pass.

- [ ] **Step 4: Inspect the final diff and working tree**

```bash
git diff main...HEAD --check
git status --short
```

Expected: no whitespace errors and no uncommitted implementation changes.
