import { createFileRoute } from '@tanstack/react-router'
import AdminPage from '../AdminPage'
import { adminTabFromSearch, type AdminTab } from '../adminNavigation'

type AdminSearch = { tab?: AdminTab }

export const Route = createFileRoute('/admin')({
  component: AdminRoutePage,
  validateSearch: (search: Record<string, unknown>): AdminSearch => ({
    tab: adminTabFromSearch(search.tab),
  }),
})

function AdminRoutePage() {
  return <AdminPage activeTab={Route.useSearch().tab} />
}
