# Japanese Localization Design

## Summary

Cloudflare OS will support English and Japanese across the authenticated and signed-out Workshop, including the admin interface. Every user can select `Auto`, `English`, or `日本語`; the preference follows the user across sessions and devices. `Auto` resolves to a deployment-owned concrete default, preserving English for existing deployments while allowing vlightup to default to Japanese.

Chat activity language is independent from interface language. Provisional and completed tool-call labels and other intermediate activity use the language of the latest genuine human chat message. Assistant text is not translated by the UI and continues to follow the conversation naturally.

## Requirements

- Translate both user-facing Workshop UI and `/admin` when the effective UI language is Japanese.
- Offer `Auto`, `English`, and `日本語` in the user language selector.
- Persist the selector in the authenticated user's Durable Object.
- Resolve `Auto` from the deployment default, not IP geolocation.
- Default existing deployments to English.
- Configure vlightup's deployment default as Japanese outside the runtime repository.
- Make tool calls, compaction state, thinking state, and intermediate chat activity follow the latest genuine human message.
- Preserve filenames, code, URLs, API names, resource names, user-authored content, and third-party proper nouns.
- Keep `AiChatStreamEvent` semantic and language-neutral.
- Preserve callback, retry, approval, connection, collaborator, restart, and resumed-turn language.
- Render legacy unstamped chat history in English.

## Non-goals

- Translating historical assistant responses or user-authored content.
- Inferring language from `request.cf.country`, IP location, or Cloudflare Access identity.
- Supporting languages other than English and Japanese in this release.
- Machine-translating arbitrary backend errors or third-party content.
- Translating source code identifiers or stored connector/resource titles.

## Locale model

The shared API defines:

```ts
export type SupportedLanguage = "en" | "ja";
export type LanguagePreference = "auto" | SupportedLanguage;
export type ChatActivityLanguage = SupportedLanguage;
```

`ServerConfig.defaultLanguage` is always concrete. Missing deployment configuration resolves to `"en"`. The effective UI language is:

1. explicit user preference (`"en"` or `"ja"`);
2. `ServerConfig.defaultLanguage` for `"auto"` and signed-out users;
3. `"en"` while server configuration is unavailable.

The application updates `<html lang>` whenever the effective language changes. Browser and request language headers are not authoritative and are not persisted automatically.

## UI localization architecture

The Workshop uses `i18next` and `react-i18next` with TypeScript resource catalogs:

```text
packages/workshop-frontend/src/i18n/
  config.ts
  locale.ts
  format.ts
  resources.ts
  locales/en.ts
  locales/ja.ts
```

Catalog keys are semantic and domain-scoped, for example:

```text
navigation.workspaces
settings.language.title
chat.activity.readFile.running
chat.activity.readFile.completed
admin.general.save
billing.balance.remaining
```

Whole sentences are translation units. English fragments are not concatenated because Japanese word order differs. Dynamic targets are interpolated into full templates. Counts use i18next plural resolution and `Intl.NumberFormat`; dates and relative times use `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` with the effective language.

The provider is mounted where signed-out pages can consume the deployment default. Authentication then loads the saved preference without allowing a stale response from a prior account to overwrite the current account. Failure to load a preference falls back to `Auto` and never blocks access.

The language selector persists through authenticated RPC. It updates locally after successful persistence and reports a translated error on failure.

## Persisted user preference

`UserDurableObject` adds a typed-storage singleton with default `"auto"`. No Durable Object migration or backfill is needed because missing singleton keys return the declared default.

`AuthenticatedApi` adds documented `getLanguagePreference()` and `setLanguagePreference()` methods. The backend validates untrusted RPC input at runtime and leaves the old value unchanged on invalid input.

`DEFAULT_LANGUAGE` is an optional Workshop Worker variable. `getServerConfig()` validates it as `"en" | "ja"`; omission produces `"en"`. Tenant-specific values do not enter runtime source, `INITIAL_ADMIN_CONFIG`, or Terraform.

## Chat activity language

### Detection

Only direct human-send chokepoints can change a chat's activity language. Synthetic user-authored approval messages, model output, callbacks, retries, connection acceptance, compaction, and gadget messages must not trigger detection.

A pure backend detector removes URLs, fenced code, and inline code before examining meaningful characters:

- any Hiragana or Katakana selects Japanese;
- otherwise a meaningful Han-character presence selects Japanese for this English/Japanese MVP;
- otherwise Latin letters select English;
- punctuation, emoji, numbers, attachments-only input, and commands without natural-language arguments are neutral.

Neutral input inherits the chat's current activity language. A neutral new chat defaults to English.

### Persistence

`AiChatMetadata.activityLanguage` stores the language governing current provisional activity. Each durable `AiChatMessage` optionally carries `activityLanguage`, stamped from metadata when persisted. This preserves mixed-language history and allows callbacks and resumed turns to inherit the initiating context after restart.

Fields are optional for wire and storage compatibility. Legacy records without the field render in English.

### Rendering

The frontend maps stable tool names and semantic stream events to localized catalog entries. `AiChatStreamEvent` remains unchanged. Provisional activity uses current metadata; completed durable groups use their stamped message language.

The current English helper design (`verb + target`) is replaced with whole-message templates so Japanese can render targets in natural order. Tool targets and raw outputs remain verbatim.

Thread and gadget title prompts receive the detected activity language. Japanese prompts request a concise natural Japanese title rather than applying English word-count guidance.

## Errors and server-authored copy

Known application failures should move toward stable codes plus interpolation data. The frontend translates codes and keeps raw diagnostic detail out of the primary UI. Unknown, third-party, and legacy errors remain unchanged rather than being machine-translated.

Connector names, operator-authored banners, resource titles, usernames, and third-party data remain as authored. Static host UI around them is translated.

## Embedded gatekeeper surfaces

Context Library, Scheduled Tasks, resource configurators, and the MCP connection form are separate bundles. They receive the resolved UI language from the Workshop host through their existing initialization/configuration boundary and maintain bundle-local English/Japanese catalogs. Generated artifacts are rebuilt from source and never edited directly.

This work is a separate implementation layer because it touches independent build pipelines and many connector packages. It may ship in a follow-up PR after the Workshop/API layer, but the Japanese-language release is complete only when these visible embedded surfaces are covered.

## Deployment architecture

Runtime support lands first in `Lumirator-Ltd/cloudflare-os`. After that commit is reviewed and merged:

1. `company_os_starter` pins the reviewed runtime commit and forwards `DEFAULT_LANGUAGE`.
2. `company-os-deployments` adds a tenant presentation-language field and renders `DEFAULT_LANGUAGE` into the temporary Workshop configuration.
3. vlightup sets the field to Japanese.
4. Terraform remains unchanged because it owns Access, not presentation defaults.

## Failure behavior

- Invalid deployment default: deployment/configuration validation fails clearly.
- Invalid persisted preference: getter normalizes to `Auto`; setter rejects without mutation.
- Preference RPC unavailable: UI uses `Auto` and remains usable.
- Missing Japanese catalog key: English fallback is displayed and catalog-parity tests fail in development/CI.
- Neutral chat message: existing language is retained.
- Missing legacy chat language: English is displayed.

## Testing

- Pure locale resolution and catalog-parity tests.
- Provider tests for deployment default, persisted preference, account changes, stale responses, failures, and `<html lang>`.
- Backend RPC/storage tests for defaulting, validation, isolation, and persistence.
- Deployment config tests for missing, valid, and invalid defaults.
- Pure chat-language detector tests for Japanese, English, mixed, code/URL, and neutral input.
- Overseer tests for collaborators, callbacks, retries, approvals, connection resumes, restarts, and durable stamps.
- ChatInterface tests for provisional and historical English/Japanese tool labels and unchanged targets.
- Component tests for Japanese user/admin screens, accessibility labels, dates, counts, and errors.
- Embedded-bundle tests for host locale propagation and Japanese rendering.
- Managed-deployment tests proving vlightup emits `DEFAULT_LANGUAGE="ja"` without affecting other tenants.

## Rollout

1. Land locale types, persistence, deployment default, i18n foundation, selector, and chat activity localization.
2. Translate all Workshop user and admin surfaces and add a static visible-string completion gate.
3. Translate embedded gatekeeper apps/configurators and localizable server-authored descriptors.
4. Pin and deploy the reviewed runtime; set vlightup's default to Japanese.

English remains the fallback throughout. No automatic location-based redirect or language mutation is introduced.
