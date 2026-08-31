# Admin Sidebar Navigation Implementation Plan

> Use test-driven development. Keep this PR limited to frontend navigation; no backend authorization or deployment changes.

## Task 1: URL-addressable admin tabs

- [ ] Add failing route/search tests for General, Gatekeepers, Access, and Formats.
- [ ] Define a closed `AdminTab` type and search validator in `routes/admin.tsx`.
- [ ] Make `AdminPage` controlled by the route and update search state on tab changes.
- [ ] Preserve `/admin` as General and normalize unknown values.
- [ ] Run focused frontend tests.

## Task 2: Admin-only sidebar section

- [ ] Add failing tests for admin visibility, non-admin absence, all five destinations, active state, and collapsed accessibility.
- [ ] Extend `SidebarItem` with safe search propagation and an explicit active override.
- [ ] Add a collapsible Admin section below primary navigation and above Favorites/Recent lists.
- [ ] Use `AuthContext.isAdmin` only; do not duplicate authorization rules.
- [ ] Run focused frontend tests.

## Task 3: Verification and rollout

- [ ] Run frontend tests, full repository tests, lint/typecheck, build, and diff checks.
- [ ] Request code-quality/security review and GitHub Codex review.
- [ ] Merge after upstream-sync PR.
- [ ] Update the starter submodule to the exact merged runtime commit and update `.gitmodules` to the fork URL.
- [ ] Run starter check and tenant read-only plan.
- [ ] Deploy Vlightup using the previously approved managed path only after all checks pass.
- [ ] Verify admin and non-admin navigation behavior in-browser.
