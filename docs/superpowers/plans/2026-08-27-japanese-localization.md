# Japanese Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development by default to implement this plan task-by-task. Run independent, safely isolated tasks in parallel; sequence tasks that share state or dependencies. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted English/Japanese Workshop localization, Japanese user/admin UI, and chat activity labels that follow the latest human message.

**Architecture:** The shared API carries locale preference and semantic chat-language codes; the User Durable Object persists preferences while deployment config supplies a concrete default. React i18n catalogs localize Workshop copy, while semantic stream events stay language-neutral and durable chat records carry the activity language needed to render mixed-language history.

**Tech Stack:** TypeScript, React 19, i18next, react-i18next, Cap'n Web RPC, typed-storage, Cloudflare Workers Durable Objects, Vitest.

---

## File structure

New core files:

- `packages/workshop-frontend/src/i18n/config.ts`: i18next initialization and resource registration.
- `packages/workshop-frontend/src/i18n/locale.ts`: pure effective-language resolution.
- `packages/workshop-frontend/src/i18n/format.ts`: locale-aware number/date/relative-time helpers.
- `packages/workshop-frontend/src/i18n/LanguageProvider.tsx`: deployment/user preference state and HTML language synchronization.
- `packages/workshop-frontend/src/i18n/locales/en.ts`: authoritative English catalog.
- `packages/workshop-frontend/src/i18n/locales/ja.ts`: Japanese catalog matching English keys.
- `packages/workshop-frontend/src/i18n/catalog.test.ts`: key parity and fallback tests.
- `packages/workshop-frontend/src/i18n/locale.test.ts`: locale resolver tests.
- `packages/workshop-frontend/src/i18n/LanguageProvider.test.tsx`: persisted preference lifecycle tests.
- `packages/workshop-backend/src/chat-activity-language.ts`: pure human-message language detection/resolution.
- `packages/workshop-backend/__tests__/chat-activity-language.test.ts`: detector tests.

Existing high-value files:

- `packages/workshop-shared/src/api.ts`: locale types, RPC methods, server config, metadata/message language stamps.
- `packages/workshop-backend/src/user.ts`: persisted preference.
- `packages/workshop-backend/src/server.ts`: authenticated RPC forwarding and deployment config response.
- `packages/workshop-backend/src/deployment-config.ts`: `DEFAULT_LANGUAGE` validation.
- `packages/workshop-backend/src/env.d.ts`: optional Worker variable typing.
- `packages/workshop-backend/src/overseer.ts`: direct-message detection, metadata updates, durable message stamps, continuations, and title prompts.
- `packages/workshop-frontend/src/main.tsx`: provider installation.
- `packages/workshop-frontend/src/SettingsPage.tsx`: language selector.
- `packages/workshop-frontend/src/ChatInterface.tsx`: semantic activity localization.

## Task 1: Shared locale contract and deployment default

**Files:**
- Modify: `packages/workshop-shared/src/api.ts`
- Modify: `packages/workshop-backend/src/env.d.ts`
- Modify: `packages/workshop-backend/src/deployment-config.ts`
- Test: `packages/workshop-backend/__tests__/deployment-config.test.ts`

- [ ] **Step 1: Write failing deployment-default tests**

Add cases proving omission returns English, `en`/`ja` pass through, and any other value throws without silently falling back.

```ts
expect(getServerConfig({} as Env).defaultLanguage).toBe("en");
expect(getServerConfig({ DEFAULT_LANGUAGE: "ja" } as Env).defaultLanguage).toBe("ja");
expect(() => getServerConfig({ DEFAULT_LANGUAGE: "fr" } as Env)).toThrow();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @gadgets/workshop-backend test:run -- deployment-config.test.ts`
Expected: FAIL because `defaultLanguage` and validation do not exist.

- [ ] **Step 3: Add the documented shared types and fields**

```ts
/** Languages supported by first-party Workshop localization. */
export type SupportedLanguage = "en" | "ja";

/** A user's persisted UI language choice. */
export type LanguagePreference = "auto" | SupportedLanguage;

/** Language used to render semantic activity for one chat turn. */
export type ChatActivityLanguage = SupportedLanguage;
```

Add documented `ServerConfig.defaultLanguage`, optional `AiChatMetadata.activityLanguage`, and optional `AiChatMessage.activityLanguage` fields.

- [ ] **Step 4: Parse `DEFAULT_LANGUAGE` fail-closed**

Missing resolves to `"en"`; only `"en"` and `"ja"` are valid.

- [ ] **Step 5: Run focused tests and type checks**

Run:

```bash
pnpm --filter @gadgets/workshop-backend test:run -- deployment-config.test.ts
vp run -F @gadgets/workshop-shared build
vp run -F @gadgets/workshop-backend build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-shared/src/api.ts packages/workshop-backend/src/env.d.ts packages/workshop-backend/src/deployment-config.ts packages/workshop-backend/__tests__/deployment-config.test.ts
git commit -m "feat: define Workshop language configuration"
```

## Task 2: Persist authenticated language preference

**Files:**
- Modify: `packages/workshop-shared/src/api.ts`
- Modify: `packages/workshop-backend/src/user.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Test: `packages/workshop-backend/__integration__/user-language-preference.test.ts`

- [ ] **Step 1: Write failing RPC tests**

Cover default `auto`, persisted `ja` and `en`, invalid input rejection without mutation, user isolation, and reconnect persistence through the real authenticated API boundary.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @gadgets/workshop-backend test:run -- user-language-preference.test.ts`
Expected: FAIL because RPC methods do not exist.

- [ ] **Step 3: Add documented RPC methods**

```ts
/** Returns the user's persisted Workshop language choice. */
getLanguagePreference(): Promise<LanguagePreference>;

/** Persists the user's Workshop language choice. */
setLanguagePreference(preference: LanguagePreference): Promise<void>;
```

- [ ] **Step 4: Add typed storage and runtime validation**

Declare `languagePreference: <LanguagePreference>"auto"`. Validate the setter against a module-level allowed-value set before writing. Normalize an unexpected stored value to `auto` in the getter.

- [ ] **Step 5: Add thin authenticated forwarding**

Forward through `AuthenticatedApiImpl`; do not add a parallel interface or unsafe cast.

- [ ] **Step 6: Run focused tests and build**

Run:

```bash
pnpm --filter @gadgets/workshop-backend test:run -- user-language-preference.test.ts
vp run -F @gadgets/workshop-backend build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/workshop-shared/src/api.ts packages/workshop-backend/src/user.ts packages/workshop-backend/src/server.ts packages/workshop-backend/__integration__/user-language-preference.test.ts
git commit -m "feat: persist Workshop language preferences"
```

## Task 3: Add the frontend i18n foundation

**Files:**
- Modify: `packages/workshop-frontend/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/workshop-frontend/src/i18n/config.ts`
- Create: `packages/workshop-frontend/src/i18n/locale.ts`
- Create: `packages/workshop-frontend/src/i18n/format.ts`
- Create: `packages/workshop-frontend/src/i18n/locales/en.ts`
- Create: `packages/workshop-frontend/src/i18n/locales/ja.ts`
- Create: `packages/workshop-frontend/src/i18n/catalog.test.ts`
- Create: `packages/workshop-frontend/src/i18n/locale.test.ts`

- [ ] **Step 1: Write failing locale and catalog tests**

Test explicit preference precedence, `auto` deployment resolution, English temporary fallback, Japanese/English key parity, English fallback for a missing Japanese value, and locale-aware number/date output.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @gadgets/workshop-frontend test:run -- src/i18n`
Expected: FAIL because modules do not exist.

- [ ] **Step 3: Add i18next dependencies**

Run: `pnpm --filter @gadgets/workshop-frontend add i18next react-i18next`

- [ ] **Step 4: Implement the pure resolver**

```ts
export function resolveLanguage(
  preference: LanguagePreference,
  deploymentDefault: SupportedLanguage | undefined,
): SupportedLanguage {
  return preference === "auto" ? deploymentDefault ?? "en" : preference;
}
```

- [ ] **Step 5: Initialize one browser i18next instance**

Register `en` and `ja`, set `fallbackLng: "en"`, disable escaping for React, and avoid loading translation code dynamically on every render.

- [ ] **Step 6: Add typed catalog roots and formatters**

Begin with common, language selector, and chat-activity keys. Catalog-parity tests must compare recursive leaf paths.

- [ ] **Step 7: Run focused tests and build**

Run:

```bash
pnpm --filter @gadgets/workshop-frontend test:run -- src/i18n
vp run -F @gadgets/workshop-frontend build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/workshop-frontend/package.json pnpm-lock.yaml packages/workshop-frontend/src/i18n
git commit -m "feat: add Workshop localization foundation"
```

## Task 4: Load preference and expose the language selector

**Files:**
- Create: `packages/workshop-frontend/src/i18n/LanguageProvider.tsx`
- Create: `packages/workshop-frontend/src/i18n/LanguageProvider.test.tsx`
- Modify: `packages/workshop-frontend/src/main.tsx`
- Modify: `packages/workshop-frontend/src/SettingsPage.tsx`
- Test: `packages/workshop-frontend/src/SettingsPage.test.tsx`

- [ ] **Step 1: Write failing provider tests**

Cover signed-out deployment default, authenticated saved preference, stale response rejection after account replacement, load failure to Auto, logout reset, setter rollback, and `<html lang>`.

- [ ] **Step 2: Write failing Settings tests**

Assert Auto/English/日本語 choices, current selection, successful RPC persistence, translated Japanese labels, and a translated save failure.

- [ ] **Step 3: Run and verify RED**

Run:

```bash
pnpm --filter @gadgets/workshop-frontend test:run -- LanguageProvider.test.tsx SettingsPage.test.tsx
```

Expected: FAIL because provider and selector do not exist.

- [ ] **Step 4: Implement provider lifecycle**

Mount inside the existing server-config/auth composition without duplicating WebSocket connections. Start independent preference/config requests in parallel where possible. Reset account-owned state before applying a new API stub and ignore stale completions.

- [ ] **Step 5: Add selector**

Persist first, then apply; on failure retain the previous choice and show a localized toast. Display `Auto (日本語)` or `Auto (English)` from the deployment default.

- [ ] **Step 6: Run focused tests and build**

Run the two test files and `vp run -F @gadgets/workshop-frontend build`.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/workshop-frontend/src/i18n/LanguageProvider.tsx packages/workshop-frontend/src/i18n/LanguageProvider.test.tsx packages/workshop-frontend/src/main.tsx packages/workshop-frontend/src/SettingsPage.tsx packages/workshop-frontend/src/SettingsPage.test.tsx
git commit -m "feat: add persisted Workshop language selector"
```

## Task 5: Detect and persist chat activity language

**Files:**
- Create: `packages/workshop-backend/src/chat-activity-language.ts`
- Create: `packages/workshop-backend/__tests__/chat-activity-language.test.ts`
- Modify: `packages/workshop-backend/src/overseer.ts`
- Modify: relevant Overseer tests under `packages/workshop-backend/__tests__/`

- [ ] **Step 1: Write failing pure detector tests**

Cover Hiragana, Katakana, Han-only text, English, Japanese containing identifiers, mixed text, URL/code-only input, emoji/numbers/punctuation, neutral inheritance, and neutral new-chat English fallback.

- [ ] **Step 2: Run and verify detector RED**

Run: `pnpm --filter @gadgets/workshop-backend test:run -- chat-activity-language.test.ts`
Expected: FAIL because detector does not exist.

- [ ] **Step 3: Implement the minimal detector**

Strip fenced code, inline code, and URLs; test Kana, then Han, then Latin. Return `undefined` for neutral text and resolve it against existing metadata.

- [ ] **Step 4: Write failing Overseer flow tests**

Prove direct sends set metadata and stamps, collaborators can switch language, neutral sends inherit, callbacks/retries/approvals/connection resumes preserve language, and synthetic approval copy does not reclassify the turn.

- [ ] **Step 5: Run and verify flow RED**

Run the focused Overseer test files. Expected: FAIL because metadata and durable stamps are absent.

- [ ] **Step 6: Integrate only at direct-human chokepoints**

Update metadata in the same logical commit as direct user messages. Centralize durable stamp inheritance rather than duplicating it across each persistence branch. Never classify synthetic messages.

- [ ] **Step 7: Localize title prompt builders**

Extract pure English/Japanese thread/gadget title prompt builders and test their language-specific constraints.

- [ ] **Step 8: Run focused tests and backend build**

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/workshop-backend/src/chat-activity-language.ts packages/workshop-backend/src/overseer.ts packages/workshop-backend/__tests__
git commit -m "feat: track chat activity language"
```

## Task 6: Localize provisional and completed chat activity

**Files:**
- Modify: `packages/workshop-frontend/src/i18n/locales/en.ts`
- Modify: `packages/workshop-frontend/src/i18n/locales/ja.ts`
- Modify: `packages/workshop-frontend/src/ChatInterface.tsx`
- Create: `packages/workshop-frontend/src/ChatInterface.localization.test.ts`
- Modify: `packages/workshop-frontend/src/ChatInterface.compaction.test.ts`

- [ ] **Step 1: Write failing rendering tests**

Cover Japanese and English provisional Thinking/Compacting/tool labels; completed read/write/edit/execute/fetch/connection labels; grouped counts; observation labels; mixed durable history; English legacy fallback; and unchanged filenames/URLs.

- [ ] **Step 2: Run and verify RED**

Run the localization and compaction tests. Expected: Japanese assertions fail against English literals.

- [ ] **Step 3: Replace fragment concatenation with whole templates**

Pass `TFunction` and activity language into pure formatters. Use `t(key, { lng, count, target })`; do not temporarily switch the global UI locale to render historical activity.

- [ ] **Step 4: Carry language through groups**

Provisional groups read metadata language. Durable groups use the stamped message language and default legacy records to English.

- [ ] **Step 5: Run tests and build**

Run all ChatInterface tests plus frontend build. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-frontend/src/i18n/locales packages/workshop-frontend/src/ChatInterface.tsx packages/workshop-frontend/src/ChatInterface.localization.test.ts packages/workshop-frontend/src/ChatInterface.compaction.test.ts
git commit -m "feat: localize chat activity in English and Japanese"
```

## Task 7: Translate signed-out shell, navigation, and onboarding

**Files:**
- Modify catalogs under `packages/workshop-frontend/src/i18n/locales/`
- Modify: `packages/workshop-frontend/index.html`
- Modify: `packages/workshop-frontend/src/LoginPage.tsx`
- Modify: `packages/workshop-frontend/src/SignupPage.tsx`
- Modify: `packages/workshop-frontend/src/ProtectedRoute.tsx`
- Modify: `packages/workshop-frontend/src/OnboardingWizard.tsx`
- Modify: `packages/workshop-frontend/src/FrontendErrorBoundary.tsx`
- Modify: `packages/workshop-frontend/src/components/AppShell/*.tsx`
- Modify: `packages/workshop-frontend/src/components/Header.tsx`
- Modify: `packages/workshop-frontend/src/components/UserMenu.tsx`
- Modify route modules under `packages/workshop-frontend/src/routes/`
- Test existing component tests and add Japanese cases.

- [ ] **Step 1: Add failing Japanese component assertions**
- [ ] **Step 2: Run focused tests and verify RED**
- [ ] **Step 3: Add complete sentence catalog entries and migrate visible text/aria labels**
- [ ] **Step 4: Localize document title and update `<html lang>` dynamically**
- [ ] **Step 5: Run focused frontend tests and build**
- [ ] **Step 6: Commit with message `feat: localize Workshop shell and onboarding`**

## Task 8: Translate workspace, sharing, editor, and activity UI

**Files:**
- Modify catalogs.
- Modify: `packages/workshop-frontend/src/Activity.tsx`
- Modify: `packages/workshop-frontend/src/ActivityNotifications.tsx`
- Modify: `packages/workshop-frontend/src/Connections.tsx`
- Modify: `packages/workshop-frontend/src/FileSidebar.tsx`
- Modify: `packages/workshop-frontend/src/GadgetCodeInterface.tsx`
- Modify: `packages/workshop-frontend/src/GadgetEditor.tsx`
- Modify: `packages/workshop-frontend/src/GadgetExportMenu.tsx`
- Modify: `packages/workshop-frontend/src/GadgetUI.tsx`
- Modify: `packages/workshop-frontend/src/GadgetUseView.tsx`
- Modify: `packages/workshop-frontend/src/ShareModal.tsx`
- Modify: `packages/workshop-frontend/src/WorkpiecePicker.tsx`
- Modify relevant `components/*.tsx`, `diff/*.ts`, hooks, transfer utilities, and timestamp helpers identified in the design inventory.
- Test existing component suites and add Japanese cases.

- [ ] **Step 1: Add failing Japanese tests for high-risk dialogs, toasts, counts, and accessibility labels**
- [ ] **Step 2: Run and verify RED**
- [ ] **Step 3: Migrate complete visible copy to catalogs**
- [ ] **Step 4: Replace duplicated English relative-time/count formatting with locale helpers**
- [ ] **Step 5: Run all affected tests and frontend build**
- [ ] **Step 6: Commit with message `feat: localize Workshop workspace UI`**

## Task 9: Translate admin, providers, blueprints, formats, and billing

**Files:**
- Modify catalogs.
- Modify: `packages/workshop-frontend/src/AdminPage.tsx`
- Modify: `packages/workshop-frontend/src/AdminConnectorsPage.tsx`
- Modify: `packages/workshop-frontend/src/AddModelModal.tsx`
- Modify: `packages/workshop-frontend/src/BlueprintLandingPage.tsx`
- Modify: `packages/workshop-frontend/src/BlueprintModal.tsx`
- Modify: `packages/workshop-frontend/src/BlueprintsPage.tsx`
- Modify: `packages/workshop-frontend/src/components/format/*.tsx`
- Modify: `packages/workshop-frontend/src/components/billing/*.tsx`
- Modify connector host/modal components and gatekeeper-modal forms.
- Test existing admin, connector, modal, and billing suites with Japanese cases.

- [ ] **Step 1: Add failing Japanese tests for each route family**
- [ ] **Step 2: Run and verify RED**
- [ ] **Step 3: Translate static UI, validation, toasts, aria labels, and host iframe titles**
- [ ] **Step 4: Format money, durations, counts, and dates with locale helpers**
- [ ] **Step 5: Run affected suites and frontend build**
- [ ] **Step 6: Commit with message `feat: localize Workshop admin and catalog UI`**

## Task 10: Translate embedded gatekeeper applications and configurators

**Files:**
- Modify Workshop iframe initialization/host locale payload.
- Modify: `packages/gatekeeper-context/app/*`
- Modify: `packages/gatekeeper-scheduler/app/*`
- Modify: `packages/configurator-ui/src/index.ts`
- Modify: `scripts/build-gatekeeper-configurator.ts`
- Modify configurator UI modules under `packages/gatekeeper-*/src/configurator/`
- Modify: `packages/gatekeeper-mcp/src/connect-form.ts`
- Test bundle-local apps and configurator build/runtime tests.

- [ ] **Step 1: Write failing locale-propagation and Japanese rendering tests**
- [ ] **Step 2: Run and verify RED**
- [ ] **Step 3: Extend existing initialization messages with a backward-compatible language field**
- [ ] **Step 4: Add bundle-local catalogs and translate full Context/Scheduler apps**
- [ ] **Step 5: Translate generic configurator runtime and connector-specific static copy**
- [ ] **Step 6: Rebuild generated artifacts through existing build tasks; never edit generated files**
- [ ] **Step 7: Run configurator/app tests and builds**
- [ ] **Step 8: Commit with message `feat: localize embedded connector interfaces`**

## Task 11: Completion gate and full verification

**Files:**
- Create: `scripts/frontend-localization.test.ts`
- Modify catalogs and any missed production source files.
- Modify documentation for language configuration.

- [ ] **Step 1: Write a failing static localization-completion test**

Scan first-party production TSX/HTML for uncatalogued visible literals, with a small reviewed allowlist for proper nouns, code, filenames, and generated content. The test should report exact file/line candidates.

- [ ] **Step 2: Run and verify RED against remaining English literals**
- [ ] **Step 3: Migrate valid misses and document every allowlist category**
- [ ] **Step 4: Run focused localization suites**
- [ ] **Step 5: Run full verification**

```bash
pnpm test
pnpm build
pnpm lint
git diff --check
```

Expected: all tests/builds pass; lint has no errors; diff check is clean.

- [ ] **Step 6: Inspect the full diff for raw errors, untranslated accessibility copy, locale-global mutation, and tenant-specific runtime values**
- [ ] **Step 7: Commit with message `test: enforce Workshop localization coverage`**

## Task 12: Managed vlightup default after runtime merge

This task executes in dedicated branches/worktrees in the downstream repositories after the runtime PR merges.

**Repositories:**
- `company_os_starter`: pin the reviewed runtime and preserve/forward `DEFAULT_LANGUAGE`.
- `company-os-deployments`: add a validated presentation-language manifest field and render the temporary Workshop variable.
- vlightup manifest: set Japanese default.

- [ ] **Step 1: Write failing starter passthrough tests**
- [ ] **Step 2: Pin the reviewed runtime and pass starter checks**
- [ ] **Step 3: Write failing deployment manifest/config tests**
- [ ] **Step 4: Add `defaultLanguage: ja` for vlightup without changing other tenants**
- [ ] **Step 5: Run plan, review exact resource actions, deploy, and verify Japanese signed-out UI plus selector override**
- [ ] **Step 6: Record private deployment evidence under ignored mode-0600 `.operations/vlightup/<environment>/` files**
