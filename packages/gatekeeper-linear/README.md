# Gatekeeper Linear

Connects Cloudflare OS to Linear through OAuth 2.0. Users can connect a Linear workspace, team, or issue and grant the connector read and write access within that selected scope.

## Configure OAuth

1. Open [Linear OAuth applications](https://linear.app/settings/api/applications/new) and create an OAuth2 application.
2. Set its redirect callback URL to the callback displayed in Cloudflare OS at `/admin/connectors`:

   ```text
   <PUBLIC_BASE_URL>/gatekeeper/linear/oauth
   ```

   For local development the default is `http://localhost:8787/gatekeeper/linear/oauth`.
3. The Gatekeeper requests Linear's `read` and `write` scopes when a user connects. No admin scope is requested.
4. Copy the application's Client ID and Client Secret into the Linear card at `/admin/connectors`.

See [Linear OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication) for provider details.

## Local development

Create an uncommitted `.env` file in this package:

```sh
CLIENT_ID=<oauth-client-id>
CLIENT_SECRET=<oauth-client-secret>
BASE_URL=http://localhost:8787/gatekeeper/linear
```

Never commit OAuth credentials.
