# MCP Connections UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development by default to implement this plan task-by-task. Run independent, safely isolated tasks in parallel; sequence tasks that share state or dependencies. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let deployment admins configure one approved OAuth MCP Portal in Cloudflare OS, after which users can explicitly grant its upstream servers to workspace chats and Gadgets.

**Architecture:** Extend the existing write-only connector configuration path with an explicit `mcp_portal` descriptor and URL input, then make `gatekeeper-mcp-portal` report readiness and enforce live OAuth-only deployment policy. Preserve the existing user connection and capability-grant flow; disable the arbitrary endpoint connector by default for new deployments.

**Tech Stack:** TypeScript, React, Kumo UI, Cap'n Web RPC, Cloudflare Workers/Durable Objects, Vitest, pnpm/Vite+

---

## Execution Notes

- Worktree: `/Users/kei/lumirator/agents/cloudflare-os-worktrees/mcp-connections-ui`
- Branch: `feature/mcp-connections-ui`
- Design: `docs/superpowers/specs/2026-08-20-mcp-connections-ui-design.md`
- Always prepend `/Users/kei/.nodebrew/node/v22.22.3/bin` to `PATH`; the default Node 20 shell cannot launch the pinned pnpm 11.
- Tasks share core MCP and admin API types, so execute them sequentially in this worktree. Do not run implementation agents concurrently against it.
- Follow strict TDD for every behavior change: add one failing test, run it and record the expected failure, implement minimally, rerun focused tests, then commit.
- Keep comments limited to non-local security invariants and exported API contracts.

### Task 1: Prevent OAuth Downgrade During MCP Connection

**Files:**
- Modify: `packages/mcp-shared/__tests__/account-endpoint.test.ts`
- Modify: `packages/mcp-shared/src/account.ts`

- [ ] **Step 1: Add a failing test for an OAuth-declared public endpoint**

Add a test account whose `probe()` succeeds without a token and assert that an `auth: "oauth"` deployment target does not complete:

```ts
it("refuses an OAuth-configured endpoint that answers without authorization", async () => {
  const context = fakeContext();
  const account = new PublicProbeAccount(context as never, {});
  const nonce = "o".repeat(64);
  await account.prepareReconnect(nonce);

  await expect(account.beginConnect(nonce, {
    ...server("https://portal.example/mcp"),
    provenance: "deployment",
    auth: "oauth",
  })).rejects.toThrow(/must require OAuth/i);
  expect(context.storage.kv.get("connected")).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/mcp-shared exec vitest run __tests__/account-endpoint.test.ts
```

Expected: the new test fails because `beginConnect()` currently downgrades the target to `auth: "none"` and completes.

- [ ] **Step 3: Implement the OAuth downgrade guard**

In the successful unauthenticated probe branch of `McpAccountBase.beginConnect()`, reject when the requested server declared `auth: "oauth"` instead of rewriting it to `none`. Restore the claimed selection so the user can retry after correcting the endpoint.

```ts
if (server.auth === "oauth") {
  this.restoreSelection(initiationNonce);
  throw new Error(`The MCP server "${server.serverName}" must require OAuth.`);
}
```

Preserve generic user-supplied public MCP behavior when its initial target is `auth: "none"` and preserve the existing token path.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all `account-endpoint` tests pass.

- [ ] **Step 5: Run the package suite**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/mcp-shared test:run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-shared/src/account.ts \
  packages/mcp-shared/__tests__/account-endpoint.test.ts
git commit -m "fix(mcp): require configured OAuth authorization"
```

### Task 2: Enforce Live OAuth Portal Policy

**Files:**
- Modify: `packages/mcp-shared/src/account.ts`
- Modify: `packages/mcp-shared/__tests__/account-endpoint.test.ts`
- Modify: `packages/gatekeeper-mcp-portal/src/config.ts`
- Modify: `packages/gatekeeper-mcp-portal/src/portal.ts`
- Modify: `packages/gatekeeper-mcp-portal/__tests__/config.test.ts`
- Modify: `packages/gatekeeper-mcp-portal/README.md`
- Modify: `packages/gatekeeper-mcp-portal/wrangler.jsonc`

- [ ] **Step 1: Add failing account-policy hook tests**

Add a test subclass with mutable deployment policy:

```ts
class PolicyAccount extends McpAccountBase<AccountEnv> {
  allowedEndpoint: string | null = "https://old.example/mcp";
  protected baseUrl(): string { return "https://gatekeeper.example"; }
  protected log(): never { return testLog as never; }
  protected mintAccount(): never { throw new Error("not reached"); }
  protected override assertServerAvailable(server: ConnectedServer): void {
    if (this.allowedEndpoint !== server.endpoint) throw new Error("Portal configuration changed.");
  }
}
```

Test both checkpoints:

1. `getConnection(oldEndpoint)` fails after `allowedEndpoint` is unset/repointed.
2. A connection captured while allowed fails `assertConnectionCurrent()` after policy changes.

- [ ] **Step 2: Run the account test and verify RED**

Use the Task 1 focused test command. Expected: compile/test failure because `assertServerAvailable` is not a base hook and current-connection methods do not invoke it.

- [ ] **Step 3: Add the connector policy hook**

Add a protected no-op hook to `McpAccountBase`:

```ts
protected assertServerAvailable(_server: ConnectedServer): void {}
```

Invoke it before credentials are read in `getConnection()` and in `assertConnectionCurrent()` immediately before a request is allowed to leave. Also apply it when accepting an OAuth callback so a repoint during the browser round-trip cannot install tokens for the old portal.

- [ ] **Step 4: Verify the account hook tests pass**

Run the Task 1 focused command. Expected: PASS.

- [ ] **Step 5: Replace portal auth/token tests with failing OAuth-only tests**

Update `config.test.ts` to assert:

```ts
expect(readPortalConfig(env({
  MCP_PORTAL_URL: "https://gw.example.com/mcp",
  MCP_PORTAL_AUTH: "token",
  MCP_PORTAL_TOKEN: "ignored",
}))?.auth).toBe("oauth");
```

Also assert URLs containing userinfo, query strings, or fragments return `null`, and remove tests for `portalTokenFor()` and `portalAuthRequiresReconnect()`.

- [ ] **Step 6: Run portal config tests and verify RED**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/mcp-portal-gatekeeper exec vitest run __tests__/config.test.ts
```

Expected: failures because token/none auth and fragment stripping are currently accepted.

- [ ] **Step 7: Make portal configuration OAuth-only**

In `config.ts`:

- return `auth: "oauth"` unconditionally for a valid endpoint;
- reject `url.search`, `url.hash`, `url.username`, and `url.password`;
- remove `portalTokenFor()` and `portalAuthRequiresReconnect()`;
- retain HTTPS enforcement and local insecure mode for development tests.

In `portal.ts`:

- remove static-token handling;
- add `configuration: { configured: config !== null }` to `describe()`;
- reject `connectAccount()` when `readPortalConfig()` is null;
- require a connected account's stored server auth to be exactly `oauth` before minting a facet;
- override `assertServerAvailable()` on `McpAccount` to compare the live configured endpoint with the stored endpoint using `sameEndpoint()` and reject missing/repointed configuration.

- [ ] **Step 8: Verify portal tests and MCP shared tests**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/mcp-portal-gatekeeper test:run
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/mcp-shared test:run
```

Expected: PASS.

- [ ] **Step 9: Update portal documentation/config comments**

Document OAuth-only behavior, remove `MCP_PORTAL_AUTH` and `MCP_PORTAL_TOKEN` from the configuration table/comments, and state that changing/removing the URL makes existing capabilities dormant until reconnect.

- [ ] **Step 10: Commit**

```bash
git add packages/mcp-shared packages/gatekeeper-mcp-portal
git commit -m "fix(mcp): enforce live OAuth portal policy"
```

### Task 3: Add MCP Portal to Admin Connector Configuration

**Files:**
- Modify: `packages/workshop-shared/src/gatekeeper.ts`
- Modify: `packages/workshop-shared/src/api.ts`
- Modify: `packages/workshop-backend/src/connector-configuration.ts`
- Modify: `packages/workshop-backend/__tests__/admin-connector-configuration.test.ts`

- [ ] **Step 1: Add failing backend tests for MCP metadata and Worker targeting**

Add `GATEKEEPER_MCP_PORTAL` to the test environment with a description reporting `configuration.configured`.

Assert `listConnectorConfigurations()` returns:

```ts
expect(result).toContainEqual(expect.objectContaining({
  id: "mcp_portal",
  displayName: "Cloudflare MCP Server Portal",
  callbackUrl: undefined,
  inputs: [{ name: "MCP_PORTAL_URL", label: "Portal URL", secret: false }],
}));
```

Submit a valid URL and assert the request targets:

```text
.../workers/scripts/<prefix>mcp-portal/secrets
```

with secret name `MCP_PORTAL_URL`.

- [ ] **Step 2: Add failing URL-validation tests**

For `http:`, userinfo, query, fragment, relative, empty, control-character, and overlong values, assert:

- `configureConnector()` rejects with a URL-specific validation error;
- the mocked `fetch` is not called.

Also assert unknown connector IDs cannot influence Worker names or secret names.

- [ ] **Step 3: Run focused backend tests and verify RED**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/admin-connector-configuration.test.ts
```

Expected: new MCP metadata/mapping tests fail because no canonical MCP descriptor exists.

- [ ] **Step 4: Extend the shared input/view contracts**

Broaden `ConnectorConfigurationInput.secret` from literal `true` to `boolean`, documenting that it controls input presentation while all submitted values remain write-only.

Make `AdminConnectorConfiguration.callbackUrl` optional and document why some connectors use discovery rather than a manually registered callback.

- [ ] **Step 5: Replace parallel maps with one canonical connector descriptor map**

Create a kernel-owned descriptor shape:

```ts
type ConnectorDescriptor = {
  workerSuffix: string;
  setupGuideUrl: string;
  showCallback: boolean;
  inputs: readonly ConnectorConfigurationInput[];
};
```

Add:

```ts
mcp_portal: {
  workerSuffix: "mcp-portal",
  setupGuideUrl: "https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/",
  showCallback: false,
  inputs: [{ name: "MCP_PORTAL_URL", label: "Portal URL", secret: false }],
}
```

Use the descriptor's `workerSuffix` when constructing the Cloudflare Workers API URL. Never derive a Worker script name from an RPC-supplied vendor ID.

- [ ] **Step 6: Normalize and validate the portal URL before writing**

Keep the allowlisted descriptor/input names authoritative. For `MCP_PORTAL_URL`, parse and normalize the URL, require HTTPS, and reject userinfo/query/fragment. Return/use the normalized value when building the `secret_text` request body.

Do not fetch or probe the endpoint from the Workshop backend.

- [ ] **Step 7: Run backend tests and shared type checks**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/admin-connector-configuration.test.ts
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/workshop-shared build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/workshop-shared/src/gatekeeper.ts \
  packages/workshop-shared/src/api.ts \
  packages/workshop-backend/src/connector-configuration.ts \
  packages/workshop-backend/__tests__/admin-connector-configuration.test.ts
git commit -m "feat(admin): configure the approved MCP portal"
```

### Task 4: Render and Refresh MCP Configuration in the Admin UI

**Files:**
- Modify: `packages/workshop-frontend/src/AdminConnectorsPage.tsx`
- Modify: `packages/workshop-frontend/src/AdminConnectorsPage.test.tsx`

- [ ] **Step 1: Add failing UI tests**

Add an MCP configuration fixture with `secret: false` and no callback URL. Assert:

- the page heading/copy says connector configuration rather than OAuth credentials only;
- the portal input renders as `type="url"`;
- no callback block or provider-app registration copy renders for the portal;
- saving sends `{ MCP_PORTAL_URL: "https://portal.example.com/mcp" }`;
- after save, `listConnectorConfigurations()` is called again and its result replaces local status;
- the success toast says configuration was saved and may take a moment to become available.

- [ ] **Step 2: Run the focused frontend test and verify RED**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/workshop-frontend exec vitest run \
  src/AdminConnectorsPage.test.tsx
```

Expected: failures because every input is currently a password, callback copy is unconditional, and save status is optimistic.

- [ ] **Step 3: Implement generic connector input rendering**

Render `type="password"` for `input.secret` and `type="url"` otherwise. Keep password-manager suppression attributes for secret inputs; use URL autocomplete/spellcheck behavior for the portal input.

Conditionally render callback/setup-provider instructions only when `connector.callbackUrl` is present. Always retain the setup-guide link.

- [ ] **Step 4: Reload authoritative readiness after save**

After `configureConnector()` resolves, clear the draft and call `listConnectorConfigurations()` again. Replace the connector list with the returned status. Do not force `configured: true` locally.

Use bounded user-facing copy such as:

```text
MCP Portal configuration saved. It may take a moment to become available.
```

- [ ] **Step 5: Run the focused frontend suite**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/workshop-frontend exec vitest run \
  src/AdminConnectorsPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-frontend/src/AdminConnectorsPage.tsx \
  packages/workshop-frontend/src/AdminConnectorsPage.test.tsx
git commit -m "feat(admin): add MCP portal configuration form"
```

### Task 5: Default to Approved MCP Connections

**Files:**
- Modify: `packages/workshop-backend/src/admin-config.ts`
- Modify: `packages/workshop-backend/__tests__/admin-config.test.ts`
- Modify: `packages/gatekeeper-mcp/README.md`
- Modify: `packages/gatekeeper-mcp-portal/README.md`

- [ ] **Step 1: Add failing default-policy tests**

Assert:

```ts
expect(DEFAULT_ADMIN_CONFIG.disabledGatekeepers).toContain("mcp");
expect(parseAdminConfig("{}").disabledGatekeepers).toContain("mcp");
expect(parseAdminConfig('{"disabledGatekeepers":[]}').disabledGatekeepers).toEqual([]);
```

The last case preserves an existing deployment's explicit stored configuration.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/admin-config.test.ts
```

Expected: default assertions fail because the generic `mcp` connector is currently enabled.

- [ ] **Step 3: Change the default and legacy backfill**

Set:

```ts
disabledGatekeepers: ["mcp"],
```

When `disabledGatekeepers` is absent, copy the default. When it is explicitly present as an array, sanitize and preserve it, including `[]`.

- [ ] **Step 4: Update connector documentation**

Document that:

- new deployments default to the approved portal connector;
- an admin may deliberately enable the generic connector;
- disabling prevents new discovery/grants but does not revoke already-minted capabilities;
- workspace/Gadget use still requires explicit resource introduction.

- [ ] **Step 5: Run focused tests**

Run the Task 5 focused command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workshop-backend/src/admin-config.ts \
  packages/workshop-backend/__tests__/admin-config.test.ts \
  packages/gatekeeper-mcp/README.md \
  packages/gatekeeper-mcp-portal/README.md
git commit -m "feat(mcp): default to approved portal connections"
```

### Task 6: Full Verification

**Files:**
- Review all changed files
- Update generated outputs only if existing build scripts require them

- [ ] **Step 1: Inspect the complete branch diff**

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

Confirm there are no credentials, generated local state, unrelated changes, or unsupported auth modes.

- [ ] **Step 2: Run focused package tests together**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/mcp-shared test:run
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/mcp-portal-gatekeeper test:run
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/workshop-frontend exec vitest run \
  src/AdminConnectorsPage.test.tsx
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH \
  pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/admin-connector-configuration.test.ts __tests__/admin-config.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full build and test suite**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH pnpm build
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH pnpm test
```

Expected: PASS, including integration tests.

- [ ] **Step 4: Run lint and type validation**

```bash
PATH=/Users/kei/.nodebrew/node/v22.22.3/bin:$PATH pnpm lint
```

Expected: PASS with no new blocking diagnostics.

- [ ] **Step 5: Confirm a clean worktree**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: only committed feature/design/plan changes and a clean worktree.

- [ ] **Step 6: Commit any verification-only generated updates if required**

Only if a documented build generator intentionally changed tracked output:

```bash
git add <exact-generated-files>
git commit -m "chore: refresh MCP configuration artifacts"
```
