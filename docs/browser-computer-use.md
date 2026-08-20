# Remote browser computer use

## Status

Deferred for future implementation. This document records the investigation and current design direction as of 2026-08-20. No implementation is currently planned.

Cloudflare APIs in this area are evolving quickly. Recheck the Browser Run, Agents SDK, Sandbox, and provider documentation before implementation.

## Decision summary

Cloudflare OS can support remote web-browser automation using Cloudflare Browser Run. The missing capability is the Cloudflare OS agent integration, not the browser infrastructure.

If this work resumes:

- Start with a Phase 2 experience that includes reusable remote browser sessions, Live View, and human handoff.
- Use a Cloudflare-hosted remote Chrome instance. Do not attempt to access the user's existing local Chrome browser.
- Let the user log in, complete MFA, enter sensitive values, or resolve CAPTCHA through Live View, then return control to the agent.
- Keep browser authority explicit, owner-scoped, and isolated from unrelated Gatekeeper capabilities.
- Use provider-neutral tools in the existing Pi agent loop before considering provider-native computer-use protocols.

## What the browser can and cannot access

Browser Run creates a separate Chrome instance on Cloudflare. The agent can navigate and inspect webpages, interact with page elements, capture screenshots, and retain state within that remote session.

It cannot see or access the user's existing local Chrome data:

- Open tabs or windows
- Browsing history
- Existing cookies or authenticated sessions
- Bookmarks or extensions
- Password manager contents
- Local downloads or files

Live View does not change this boundary. The user opens a short-lived Live View URL in their local browser and sees the remote browser session. The user and agent can take turns controlling that remote session, but the remote session does not gain access to the local Chrome profile.

Access to an existing local Chrome tab would require a separate Chrome extension or native companion using an API such as `chrome.debugger`. That would introduce broad device permissions and a new local-device trust boundary and is not part of this design.

## Current repository state

The backend already has most of the Cloudflare substrate required for remote browser automation:

- `packages/workshop-backend/wrangler.jsonc` configures the `BROWSER` Browser Run binding and the `LOADER` worker-loader binding.
- `packages/workshop-backend/package.json` depends on `@cloudflare/puppeteer`.
- `packages/workshop-backend/src/browser-export.ts` launches Browser Run for Gadget PDF export.
- `packages/workshop-backend/src/agent.ts` runs an extensible, sequential Pi tool loop.
- `packages/workshop-backend/src/overseer.ts` owns the agent's execution hooks and Durable Object state.

The current browser path is intentionally not general-purpose:

- PDF export loads generated Gadget content and blocks arbitrary network access.
- `webFetch` performs public, unauthenticated retrieval and returns text; it does not maintain tabs, cookies, or an interactive page.
- The agent's `executeCode` worker receives only explicit named bindings and has `globalOutbound: null`.
- The `BROWSER` binding is not exposed to agent-generated code.
- Built-in agent tool results are currently wrapped as plain text, while visual browser use needs image-bearing results or stored screenshot artifacts.

This isolation should be preserved. Do not make Browser Run ambient by injecting `BROWSER` into the `executeCode` environment.

## Intended user experience

A practical first release should include human handoff from the beginning:

1. The agent creates an isolated remote browser session for the current user and task.
2. It navigates and performs low-risk browsing until authentication, sensitive input, or approval is needed.
3. Cloudflare OS presents a **Take over browser** control.
4. The backend creates a short-lived, owner-only Live View URL.
5. The user opens Live View, logs in or completes the requested step, and selects **Done** or **Failed**.
6. The agent resumes against the same remote tabs and cookies.
7. The agent may continue reading, navigating, and drafting.
8. It pauses immediately before an action that sends data or creates an external effect.
9. The session is closed and its ephemeral data is destroyed when the task ends or expires.

Cloudflare Browser Run exposes structured Human-in-the-Loop CDP commands under the `Cloudflare.*` namespace. These support generating Live View URLs, requesting a handoff, waiting for completion, and resuming the same session.

## Session modes

### Temporary session

This should be the default.

- One browser context per user and task
- Available across agent turns and handoff pauses
- Owner-only, including in collaborative workspaces
- Idle and absolute expiration
- Closed explicitly when the task finishes
- No state restored into later tasks

The same Browser Run process is not guaranteed to live indefinitely. Durable state should describe how to recover or fail closed, rather than assuming a live process will always be present.

### Remember this site

This may be added as an explicit opt-in after the temporary-session path is proven.

- Persist Playwright/Puppeteer storage state for a specific account and origin
- Store resulting session cookies and origin storage, never passwords
- Encrypt stored state and bind it to the stable Cloudflare OS account ID
- Restore it only into a fresh, isolated browser context for the same owner and origin
- Provide disconnect, delete, and expiration controls
- Revoke stored state when the user's Cloudflare OS session or connected account is revoked where possible

Cookies and browser storage are credentials. This mode requires the same ownership, retention, encryption, audit, and revocation treatment as other secret-bearing connections.

## Proposed architecture

### Keep the existing agent loop

The initial implementation should use ordinary Pi tools instead of provider-native computer-use protocols. This keeps behavior consistent across model providers and avoids changes to the Anthropic, OpenAI, and Google transport adapters.

A possible tool surface is:

```text
browserOpen(url, viewport)
browserObserve(sessionId, includeScreenshot)
browserAct(sessionId, action)
browserRequestHandoff(sessionId, reason)
browserClose(sessionId)
```

Prefer accessibility and DOM snapshots for routine reasoning. Include screenshots when visual state is required. Coordinate-only actions should be a fallback because they are harder to validate and audit than selector- or element-based actions.

### Add a narrow browser service

Add a module such as `packages/workshop-backend/src/browser-use.ts`. It should be the only layer that receives the Browser Run binding and should enforce:

- Session ownership
- Allowed URL schemes and destinations
- Navigation and action limits
- Browser-level request filtering
- Time, byte, tab, and browser-minute budgets
- Cleanup and cancellation
- Screenshot minimization and retention
- Handoff creation and completion

Expose it to `runAgent()` through narrow `AgentHooks` methods rather than passing the full Worker environment.

### Durable state

The Overseer or a dedicated Durable Object should record recoverable browser metadata keyed by account, workspace, and chat. It should not treat a browser process or CDP handle as durable.

Record:

- Browser session and task identity
- Owner account ID
- Current origin and URL
- Session mode and expiration
- Last successful observation
- Pending handoff or approval
- Action status, including `outcome-unknown`
- Artifact references and retention deadlines

### Tool results and artifacts

Generalize the text-only tool-result helper in `agent.ts` so browser observations can return model image content.

Do not persist large base64 screenshots directly in chat history. Store screenshots as short-lived, tenant-scoped artifacts and record references and hashes in the tool call. Replay should use the recorded observation rather than reissuing navigation or actions.

Extend the `AiToolCall` union in `packages/workshop-shared/src/api.ts` with explicit browser operations and results. Never automatically replay a click, form submission, or other external effect after a crash or timeout.

### Frontend

The chat UI should display:

- Current origin and URL
- Browser operation summary
- Screenshot preview when available
- Session state and expiration
- **Take over browser** control
- Human handoff instructions and result
- Approval prompt for external-impact actions
- Explicit disconnect and delete controls for remembered sites

Live View URLs are bearer secrets. Generate them only after backend authorization, keep them short-lived, never write them to logs or durable chat history, and show them only to the session owner.

## Capability and approval model

Remote browser access should be an explicit per-chat capability, not an ambient singleton. A browser-influenced agent should not simultaneously hold broad authority to unrelated Gatekeepers.

The browser may automatically:

- Open public HTTPS pages
- Follow links and navigate within permitted origins
- Read rendered content
- Inspect accessibility and DOM state
- Scroll, expand controls, and change non-persistent local UI state
- Fill drafts that have not been submitted

Pause at action time before:

- Submitting forms or transmitting sensitive data
- Sending messages, comments, invitations, or files
- Creating, changing, or deleting remote data
- Changing permissions, authentication, or security settings
- Purchasing, transferring funds, or accepting legal terms
- Installing or executing downloaded content
- Bypassing browser or website safety barriers

Approval must bind to semantic intent, origin, account, operation, and parameters. It must expire after relevant navigation or page-state changes. Do not approve raw coordinates that may point to a different element by execution time.

The existing deferred/simulated Gatekeeper action model does not safely compose with irreversible GUI actions. The browser must pause before the effect and revalidate the page immediately after approval.

## Security invariants

1. Treat all webpage content as hostile input and a possible prompt-injection source.
2. Keep a browser-driving agent or subagent capability-reduced; webpage instructions do not grant authority.
3. Use a fresh browser context per owner and task unless the owner explicitly restores origin-bound state.
4. Enforce network policy inside the browser, not only through Worker `fetch()` controls.
5. Block private and metadata destinations after DNS resolution and on redirects.
6. Block `file:` URLs, arbitrary WebSockets, WebRTC, downloads, extensions, and local filesystem access unless explicitly designed and reviewed.
7. Never expose raw passwords, refresh tokens, OTPs, or password-manager contents to the model.
8. Minimize screenshots and mask password, payment, OTP, and unrelated notification regions where practical.
9. Never retry an action whose external outcome is unknown.
10. Apply per-user and per-tenant concurrency, duration, action, token, storage, and bandwidth budgets.
11. Make every live session cancellable by the owner and by an operator kill switch.
12. Keep authenticated sessions owner-only until a separate collaborator-authorization design is reviewed.

## Initial non-goals

- Accessing or controlling the user's existing local Chrome browser
- General Linux desktop or native application control
- Persistent unattended browser sessions
- Sharing authenticated browser profiles between users or collaborators
- CAPTCHA or anti-bot bypass
- Executing downloaded files or browser extensions
- Autonomous purchases, financial transfers, account deletion, security-setting changes, or legal acceptance
- Replacing service-specific Gatekeepers where a semantic API is available

For high-impact authenticated services, prefer dedicated Gatekeepers with narrow APIs and credentials over open-ended GUI automation.

## Suggested future rollout

### Milestone 1: browser and handoff foundation

- Browser session manager and ownership enforcement
- Public navigation and accessibility snapshots
- Screenshots as ephemeral artifacts
- Live View and structured handoff
- Session cleanup, quotas, and cancellation
- Static test-site integration coverage

### Milestone 2: controlled interaction

- Element-based click, type, scroll, and wait actions
- Draft filling
- Pre-effect approval and page revalidation
- Outcome-unknown handling and audit records
- Prompt-injection containment tests

### Milestone 3: opt-in authenticated continuity

- Origin-bound encrypted storage state
- Remember/disconnect/delete controls
- Revocation and expiration behavior
- Privacy and retention review

### Milestone 4: provider and substrate evaluation

Only after the provider-neutral path is measured:

- Evaluate Anthropic, OpenAI, and Google native computer-use protocols
- Evaluate Cloudflare Agents SDK browser tools as an implementation reference or adapter
- Consider an external browser provider only if Browser Run has a demonstrated functional or operational gap
- Treat full desktop automation as a separate product and threat model

## Testing requirements

- Browser session ownership and cross-tenant denial
- Owner-only Live View issuance
- Session timeout, eviction, cancellation, and cleanup
- Redirect and DNS-based private-network blocking
- Blocked URL schemes, WebSockets, WebRTC, and downloads
- Accessibility and screenshot result handling
- Model-history replay without repeating actions
- Crash after action dispatch but before persistence
- Handoff success, failure, expiration, and revoked user session
- Approval invalidation after navigation or target mutation
- Persistent-state origin binding, expiry, deletion, and failed decryption
- Browser-minute and concurrency quota enforcement
- Prompt injection from page content while unrelated capabilities remain unavailable

## Alternatives considered

### Browser Gatekeeper

A Browser Gatekeeper fits Cloudflare OS capability discovery and provisioning, but the generic Gatekeeper action-simulation model is unsafe for irreversible GUI operations. It may still be useful as the outer capability and account boundary if browser execution uses synchronous pre-effect approval.

### Cloudflare Agents SDK browser tools

Cloudflare's browser tools provide a useful reference implementation for model-driven CDP and durable handoff. Cloudflare OS currently uses Pi's agent loop rather than `AIChatAgent` and the Vercel AI SDK, so directly adopting them would require an adapter or agent-loop migration.

### External managed browsers

Browserbase, Browserless, and Steel expose browser sessions over HTTP or CDP. They add another processor and control plane and should be considered only if Browser Run lacks a required feature or reliability characteristic.

### Full desktop automation

Cloudflare Sandbox removed its built-in desktop API in version `0.10.2`. Rebuilding desktop/VNC support with Sandbox extensions or Containers is technically possible but has substantially higher lifecycle, persistence, security, and maintenance costs. E2B or another dedicated remote-desktop substrate would be a separate alternative.

## Open questions for future implementation

- Which sites and action classes are permitted in the first deployment?
- How long should temporary and remembered sessions live?
- Is encrypted storage state acceptable under deployment privacy and residency requirements?
- Which model families provide acceptable results from accessibility snapshots before screenshots are necessary?
- How should browser costs be budgeted and attributed per tenant?
- What evidence can establish whether an external action happened when the browser disconnects mid-operation?
- Which authenticated workflows should become dedicated Gatekeepers instead of remaining browser automation?

## References

- [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/)
- [Cloudflare Agents browser tools](https://developers.cloudflare.com/agents/tools/browser/)
- [Reuse Browser Run sessions](https://developers.cloudflare.com/browser-run/features/reuse-sessions/)
- [Browser Run Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
- [Browser Run Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)
- [Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/)
- [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)
- [OpenAI computer-use harness options](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Anthropic computer-use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Cloudflare Sandbox 2026 deprecation guide](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/)
- [Cloudflare Sandbox lifecycle](https://developers.cloudflare.com/sandbox/1-0-preview/lifecycle/)
