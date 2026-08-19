# Admin Sidebar Navigation Design

## Goal

Give deployment administrators direct, discoverable navigation to every admin surface from the Workshop sidebar without exposing admin UI to non-admins.

## Existing behavior

- `AuthContext.isAdmin` is populated by the server-authorized `amIAdmin()` RPC.
- `/admin` renders four local tabs: General, Gatekeepers, Formats, and Access.
- `/admin/connectors` is a separate admin-only route for connector credential configuration.
- Non-admin access remains rejected by each admin page; sidebar visibility is convenience, not authorization.

## Decision

Add a collapsible **Admin** sidebar section, rendered only when `isAdmin` is true. It contains:

1. General → `/admin`
2. Gatekeepers → `/admin?tab=gatekeepers`
3. Access → `/admin?tab=access`
4. Formats → `/admin?tab=formats`
5. Connectors → `/admin/connectors`

The section uses the same compact uppercase heading and disclosure treatment as Favorites and Recent Workspaces. In collapsed-sidebar mode, the heading is hidden and icon-only links remain available with tooltips.

Make the `/admin` tab search parameter canonical and validated. Unknown values fall back to General. Selecting a tab updates the URL with replace semantics so browser refresh, copy/paste, and sidebar navigation preserve the active section without creating noisy history entries.

## Security and UX

- The sidebar consumes only `isAdmin`; it never duplicates email/domain authorization logic.
- Direct routes remain server-capability protected.
- The section is absent while admin status is loading and for non-admins.
- General remains compatible with the existing `/admin` URL.
- Active styling distinguishes each tab and the dedicated Connectors route.
- No external navigation, new Worker route, or Access policy change is introduced.

## Testing

- Non-admins render no Admin section or links.
- Admins render all five links.
- Collapsed mode retains five accessible icon links.
- Each `/admin` search value selects the matching tab; invalid values normalize to General.
- Tab changes update the URL.
- `/admin/connectors` remains independent and active only on that route.
