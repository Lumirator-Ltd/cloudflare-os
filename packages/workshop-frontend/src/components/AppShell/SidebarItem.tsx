import { Link, useRouterState, type LinkProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'

/**
 * A single nav row in the sidebar. Renders as a TanStack <Link>. Active state is computed from the
 * current router pathname so we can also tint the icon (TanStack's activeProps only swaps top-level
 * className, not child styles). Collapsed rows expose the label through an accessible name and
 * hover tooltip.
 */
export type SidebarItemProps = {
  icon: ReactNode
  label: string
  to: LinkProps['to']
  params?: LinkProps['params']
  search?: LinkProps['search']
  trailing?: ReactNode
  collapsed?: boolean
  /** Overrides the pathname-based active state when provided. */
  active?: boolean
  /** When true, match this item active when the current path starts with `to`. */
  matchPrefix?: boolean
}

export default function SidebarItem({
  icon,
  label,
  to,
  params,
  search,
  trailing,
  collapsed = false,
  active,
  matchPrefix = false,
}: SidebarItemProps) {
  // Resolve the active path manually so we can style the icon as well as the row. For parameterized
  // routes (e.g. "/gatekeepers/$appId"), substitute the params so the resolved path can match.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  let target = typeof to === 'string' ? to : ''
  if (params) {
    for (const [key, value] of Object.entries(params as Record<string, string>)) {
      target = target.replaceAll(`$${key}`, String(value))
    }
  }
  const isActive = active ?? (matchPrefix
    ? pathname === target || pathname.startsWith(target + '/')
    : pathname === target)

  // Kept loose: the generated route-tree union is stricter than is convenient for a generic row.
  const linkProps = (search === undefined ? { to, params } : { to, params, search }) as unknown as LinkProps
  // When a caller supplies a controlled active state, make TanStack's accessible active state use
  // the same exact path/search semantics instead of its default fuzzy, subset search matching.
  const activeOptions = active === undefined
    ? undefined
    : { exact: true, includeSearch: true, explicitUndefined: true }

  return (
    <Link
      {...linkProps}
      activeOptions={activeOptions}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={[
        'group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] leading-[18px] tracking-[-0.25px] transition-colors',
        isActive
          ? 'bg-kumo-fill font-medium text-kumo-strong'
          : 'font-normal text-kumo-default hover:bg-kumo-tint',
      ].join(' ')}
    >
      <span
        className={[
          'flex h-5 w-5 shrink-0 items-center justify-center transition-colors',
          isActive ? 'text-kumo-brand' : 'text-kumo-subtle group-hover:text-kumo-default',
        ].join(' ')}
      >
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing && <span className="shrink-0 text-kumo-inactive">{trailing}</span>}
        </>
      )}
    </Link>
  )
}
