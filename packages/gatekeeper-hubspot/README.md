# Gatekeeper HubSpot

This package connects Cloudflare OS to one HubSpot account through OAuth and exposes contacts,
companies, and deals to Gadgets. It uses HubSpot's current project-based Developer Platform, not a
legacy public app or a private-app access token.

## Create the HubSpot OAuth app

1. Follow HubSpot's [create an app](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/create-an-app)
   guide to create and upload a Developer Platform project.
2. Configure the top-level `app-hsmeta.json` with OAuth authentication and the exact callback URL:
   `{PUBLIC_BASE_URL}/gatekeeper/hubspot/oauth`. Replace `{PUBLIC_BASE_URL}` with the public origin
   of the Cloudflare OS deployment, without a trailing slash. Production callbacks must use HTTPS;
   HubSpot permits HTTP only for localhost testing.
3. For a managed proof of concept, use private distribution with OAuth. HubSpot permits a privately
   distributed OAuth app in up to 10 allowlisted accounts. Add each client account under the app's
   **Distribution** settings. Use marketplace distribution later if the app needs broader
   installation or a Marketplace listing.
4. Request all of these required scopes:
   - `oauth`
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
   - `crm.objects.companies.read`
   - `crm.objects.companies.write`
   - `crm.objects.deals.read`
   - `crm.objects.deals.write`
5. Upload the project, then open **Development > Projects > your project > your app > Auth**. Copy
   the Client ID and Client secret. Treat both as secrets.

An `app-hsmeta.json` auth configuration can use this shape. Every angle-bracketed or braced value is
a placeholder:

```json
{
  "uid": "<APP_UID>",
  "type": "app",
  "config": {
    "name": "<APP_NAME>",
    "description": "<APP_DESCRIPTION>",
    "distribution": "private",
    "auth": {
      "type": "oauth",
      "redirectUrls": [
        "{PUBLIC_BASE_URL}/gatekeeper/hubspot/oauth"
      ],
      "requiredScopes": [
        "oauth",
        "crm.objects.contacts.read",
        "crm.objects.contacts.write",
        "crm.objects.companies.read",
        "crm.objects.companies.write",
        "crm.objects.deals.read",
        "crm.objects.deals.write"
      ],
      "optionalScopes": [],
      "conditionallyRequiredScopes": []
    }
  }
}
```

HubSpot documents the schema, distribution modes, callback rules, and scopes in [App
configuration](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/app-configuration).
See [Manage apps in HubSpot](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/manage-apps-in-hubspot)
for the allowlist, installation limits, credentials, and verification status.

## Install the credentials

The Client ID and Client secret are write-only installation values. Enter them in the deployment
wizard or in Cloudflare OS under **Admin > Connectors**. Cloudflare OS writes `CLIENT_ID` and
`CLIENT_SECRET` to the HubSpot Gatekeeper Worker and never reads either value back.

For local development, put placeholders for your own credentials in the root `.dev.vars` file:

```dotenv
HUBSPOT_CLIENT_ID=<HUBSPOT_CLIENT_ID>
HUBSPOT_CLIENT_SECRET=<HUBSPOT_CLIENT_SECRET>
```

`pnpm dev-server` maps these root variables to the Gatekeeper's `CLIENT_ID` and `CLIENT_SECRET`.
HubSpot is a connector only; do not add it to `AUTH_GATEKEEPERS` for Cloudflare OS login.

## Install and verify an account

The HubSpot user completing OAuth must be a Super Admin or have **App Marketplace Access** plus
any permissions required by the requested scope groups.

1. Start Cloudflare OS and open **Connections**.
2. Add a HubSpot account connection and complete the HubSpot consent flow as an eligible user.
3. Confirm that HubSpot returns to the exact callback URL and the authorization tab closes.
4. Select the connected HubSpot account and create the connection.
5. Verify that the Gadget can search contacts, companies, and deals. Submit a test write only if it
   is safe to review through the normal approval flow.
6. In HubSpot, check the app's OAuth installation log if authorization or token exchange fails.

HubSpot may show an unverified-app warning when the developer account has no verified domain, or a
not-reviewed warning before Marketplace approval. These warnings do not change the private
allowlist or installation permission requirements. See [Working with
OAuth](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth)
and the [scope reference](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes).

## Disconnect and uninstall

Disconnecting the account in Cloudflare OS clears the Gatekeeper's locally stored OAuth credentials
but does not uninstall the app at HubSpot. To remove the provider-side grant, a HubSpot administrator
must open **Settings > Integrations > Connected Apps**, choose the app, and select **Actions >
Uninstall**. HubSpot documents this in [Connect apps to
HubSpot](https://knowledge.hubspot.com/integrations/connect-apps-to-hubspot#how-to-uninstall-an-app).
