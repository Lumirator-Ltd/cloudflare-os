import { createFileRoute } from '@tanstack/react-router'
import AdminConnectorsPage from '../AdminConnectorsPage'

export const Route = createFileRoute('/admin_/connectors')({
  component: AdminConnectorsPage,
})
