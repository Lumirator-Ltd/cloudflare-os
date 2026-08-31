export const ADMIN_TABS = ['general', 'gatekeepers', 'formats', 'access'] as const

export type AdminTab = typeof ADMIN_TABS[number]

export function adminTabFromSearch(value: unknown): AdminTab {
  return typeof value === 'string' && (ADMIN_TABS as readonly string[]).includes(value)
    ? value as AdminTab
    : 'general'
}
