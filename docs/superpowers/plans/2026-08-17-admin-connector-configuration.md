# Admin connector configuration implementation plan

## 1. Readiness contract

- Add status-only configuration metadata to `VendorDescription` and `GatekeeperVendorInfo`.
- Add tests first, then update the ten static-OAuth Gatekeepers to report readiness.
- Add a server-side readiness guard to every connection attempt.

## 2. Secret control plane

- Add typed connector configuration views and write-only Admin API methods.
- Implement kernel-owned immutable connector/input allowlists and Cloudflare Workers secret API calls.
- Add tests with mocked fetch covering success, partial failure, missing deployment configuration, invalid inputs, and redacted errors.

## 3. User experience

- Keep every configured or unconfigured connector visible.
- Disable connection actions for unconfigured connectors.
- Display “Ask an administrator to configure this connector.”
- Preserve unavailable and admin-disabled behavior.

## 4. Admin experience

- Add non-nested `/admin/connectors` route.
- List readiness and callback URLs.
- Add write-only Client ID / Client Secret forms and Save / Rotate behavior.
- Link from the existing Admin Gatekeepers section.

## 5. Deployment

- Add Workshop env declarations for connector configuration.
- Extend the starter staging config with account ID and worker prefix.
- Create a dedicated account token with only `Workers Scripts Write`, install it as `CONNECTOR_CONFIG_API_TOKEN`, and never expose it to clients.
- Deploy the fork commit, verify GitHub remains configured, configure one previously unconfigured connector, and test both admin and user views.
