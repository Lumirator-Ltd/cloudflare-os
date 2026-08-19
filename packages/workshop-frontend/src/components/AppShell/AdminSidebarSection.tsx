import { useState, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import {
  CaretDown,
  FileCode,
  GearSix,
  Key,
  PlugsConnected,
  ShieldCheck,
} from '@phosphor-icons/react'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { adminTabFromSearch, type AdminTab } from '../../adminNavigation'
import SidebarItem from './SidebarItem'

type AdminSidebarItem = {
  label: string
  to: '/admin' | '/admin/connectors'
  icon: ReactNode
  tab?: AdminTab
}

const ADMIN_ITEMS: AdminSidebarItem[] = [
  { label: 'General', to: '/admin', tab: 'general', icon: <GearSix size={14} /> },
  { label: 'Gatekeepers', to: '/admin', tab: 'gatekeepers', icon: <PlugsConnected size={14} /> },
  { label: 'Access', to: '/admin', tab: 'access', icon: <ShieldCheck size={14} /> },
  { label: 'Formats', to: '/admin', tab: 'formats', icon: <FileCode size={14} /> },
  { label: 'Connectors', to: '/admin/connectors', icon: <Key size={14} /> },
]

export default function AdminSidebarSection({ collapsed }: { collapsed: boolean }) {
  const auth = useOptionalAuthenticatedApi()
  const location = useRouterState({ select: (state) => state.location })
  const [open, setOpen] = useState(true)

  if (!auth?.isAdmin) return null

  const activeTab = adminTabFromSearch(location.search.tab)
  const links = (
    <nav aria-label="Admin" className="flex flex-col gap-0.5">
      {ADMIN_ITEMS.map((item) => {
        const search = item.tab === 'general'
          ? { tab: undefined }
          : item.tab === undefined ? undefined : { tab: item.tab }
        const active = item.to === '/admin/connectors'
          ? location.pathname === '/admin/connectors'
          : location.pathname === '/admin' && activeTab === item.tab
        return (
          <SidebarItem
            key={item.label}
            to={item.to}
            search={search}
            label={item.label}
            icon={item.icon}
            collapsed={collapsed}
            active={active}
          />
        )
      })}
    </nav>
  )

  if (collapsed) {
    return <div className="px-2">{links}</div>
  }

  return (
    <section className="flex flex-col px-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-6 cursor-pointer items-center gap-1 px-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive transition-colors hover:text-kumo-subtle"
      >
        <CaretDown
          size={10}
          weight="bold"
          className={['transition-transform', open ? '' : '-rotate-90'].join(' ')}
        />
        <span>Admin</span>
      </button>
      {open && <div className="mt-0.5">{links}</div>}
    </section>
  )
}
