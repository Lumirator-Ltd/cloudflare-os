# X gatekeeper

Connects a Cloudflare OS user's X account through that user's own funded X Developer App. It runs as a separate Cloudflare Worker and is discovered through the `GATEKEEPER_X` service binding.

## Funding model

The deployment does not contain an X client ID, client secret, bearer token, or shared credit balance. Every user creates a confidential X Web App, buys X API credits, chooses a spending limit in X Developer Console, and enters that app's client ID and secret directly into the one-time gatekeeper form.

Every X request is billed to the connected user's Developer App. Missing credentials, rejected credentials, exhausted credits, spending limits, plan restrictions, and rate limits fail closed. The gatekeeper does not retry billable requests, follow redirects, auto-page, or fall back to another app.

See X's current [pay-per-use pricing](https://docs.x.com/x-api/getting-started/pricing) before connecting.

## X Developer App setup

1. Open [X Developer Console](https://console.x.com/) and create a project and App.
2. Configure the App as a confidential **Web App** with OAuth 2.0 enabled.
3. Add the exact callback URL shown by Cloudflare OS. It has this form:

   ```text
   https://<deployment-origin>/gatekeeper/x/oauth
   ```

4. Enable exactly these scopes:

   ```text
   tweet.read tweet.write users.read follows.read follows.write
   like.read like.write bookmark.read bookmark.write offline.access
   ```

5. Purchase API credits and configure a spending limit. Auto-recharge is optional and is managed entirely in X Developer Console.
6. In Cloudflare OS, open **Gatekeepers**, connect X, copy the displayed callback URL into the App settings, and enter the App's client ID and client secret in the gatekeeper form.
7. Complete X authorization. The app verifies and stores the immutable X user ID before the connection appears.

Do not put X credentials in `.env`, Wrangler variables, deployment manifests, chat, source control, or operations evidence.

## Workspace security

X is a whole-account, owner-only resource. It can be added only by the workspace owner to a workspace that has no collaborators or active share links.

Adding an X binding permanently makes that workspace private. Removing the binding does not re-enable sharing because workspace history may still contain protected X data, rejected drafts, or action descriptions. Create a separate workspace for X automation rather than adding X to a workspace you may later need to share.

Every mutation waits for the workspace owner's manual approval. X actions never appear in the auto-approval catalog.

## Available API

Reads:

- connected account profile;
- profile lookup by immutable ID or username;
- post lookup;
- connected account posts and mentions;
- reverse-chronological home timeline;
- recent search;
- liked posts and bookmarks;
- followers and following.

Writes, all manually approved:

- create a text-only post;
- reply to a post;
- delete a post;
- like and unlike;
- bookmark and remove a bookmark;
- follow and unfollow.

List/search methods make one request, default to 10 records, cap at 20, and return an explicit next-page token. The gatekeeper never fetches the next page automatically.

Direct Messages, media upload, reposts, quote posts, Lists, streams, webhooks, and app-only access are not included.

## Reconnect and disconnect

Reconnect asks for the client ID and secret again so a user can rotate a secret or move to another funded Developer App. The new grant must identify the same immutable X user ID. A different X account is rejected, and existing credentials remain active.

Disconnect always removes all local X client credentials, access/refresh tokens, OAuth state, and cached account data. Current X documentation does not identify a supported revocation endpoint for these user-context OAuth 2.0 grants. After disconnecting, also revoke Cloudflare OS from the connected account's X authorization settings.

## Development

Run the root development server:

```bash
pnpm dev-server
```

The connection form supplies credentials per user; no `X_CLIENT_ID` or `X_CLIENT_SECRET` environment variable is read.

Run focused verification:

```bash
pnpm --dir packages/gatekeeper-x exec vitest run
pnpm --dir packages/gatekeeper-x exec tsc -p tsconfig.json --noEmit
pnpm --dir packages/gatekeeper-x exec wrangler deploy --dry-run
```
