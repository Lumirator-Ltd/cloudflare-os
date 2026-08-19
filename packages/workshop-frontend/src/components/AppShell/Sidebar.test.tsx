// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOptionalAuthenticatedApi } from '../../AuthContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(window, 'scrollTo', {
  value: vi.fn<typeof window.scrollTo>(),
  writable: true,
})

vi.mock('../../AuthContext', () => ({
  useOptionalAuthenticatedApi: vi.fn<typeof useOptionalAuthenticatedApi>(),
}))
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'Workshop' }))
vi.mock('../../useGatekeeperApps', () => ({ useGatekeeperApps: () => [] }))
vi.mock('../SiteLogo', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('./SidebarWorkspaces', () => ({
  SidebarWorkspacesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarWorkspacesTools: () => null,
  SidebarWorkspacesLists: () => <div>Workspace lists</div>,
}))
vi.mock('./SidebarUtilityStrip', () => ({ default: () => null }))

import Sidebar from './Sidebar'

const ADMIN_LABELS = ['General', 'Gatekeepers', 'Access', 'Formats', 'Connectors']

function adminLinks(rendered: HTMLElement) {
  return ADMIN_LABELS.map((label) => {
    const link = [...rendered.querySelectorAll('a')].find((candidate) =>
      candidate.textContent === label || candidate.getAttribute('aria-label') === label,
    )
    expect(link, `${label} link`).toBeDefined()
    return link!
  })
}

function auth(isAdmin: boolean) {
  vi.mocked(useOptionalAuthenticatedApi).mockReturnValue({ isAdmin } as ReturnType<typeof useOptionalAuthenticatedApi>)
}

function createTestRouter(initialEntry: string, collapsed: boolean) {
  const rootRoute = createRootRoute({
    component: () => <Sidebar collapsed={collapsed} onToggleCollapsed={() => {}} />,
  })
  const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin' })
  const connectorsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/connectors' })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' })
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, adminRoute, connectorsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
}

describe('Sidebar admin navigation', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.clearAllMocks()
  })

  async function render({
    initialEntry = '/',
    collapsed = false,
    isAdmin = true,
  }: {
    initialEntry?: string
    collapsed?: boolean
    isAdmin?: boolean
  } = {}) {
    auth(isAdmin)
    const router = createTestRouter(initialEntry, collapsed)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<RouterProvider router={router} />)
      await router.load()
    })
    return container
  }

  it('hides the Admin heading and links from non-admin and loading states', async () => {
    let rendered = await render({ isAdmin: false })
    expect(rendered.textContent).not.toContain('Admin')
    expect(rendered.querySelector('a[href^="/admin"]')).toBeNull()

    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.mocked(useOptionalAuthenticatedApi).mockReturnValue(null)
    const router = createTestRouter('/', false)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<RouterProvider router={router} />)
      await router.load()
    })
    rendered = container

    expect(rendered.textContent).not.toContain('Admin')
    expect(rendered.querySelector('a[href^="/admin"]')).toBeNull()
  })

  it('shows the five admin destinations in the required order', async () => {
    const rendered = await render()
    const links = adminLinks(rendered)

    expect(links.map((link) => link.textContent)).toEqual([
      'General',
      'Gatekeepers',
      'Access',
      'Formats',
      'Connectors',
    ])
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/admin',
      '/admin?tab=gatekeepers',
      '/admin?tab=access',
      '/admin?tab=formats',
      '/admin/connectors',
    ])
  })

  it('marks only the current admin tab active', async () => {
    const rendered = await render({ initialEntry: '/admin?tab=access' })
    const links = adminLinks(rendered)

    expect(links.map((link) => link.classList.contains('bg-kumo-fill'))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ])
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'page',
      null,
      null,
    ])
  })

  it('distinguishes the connectors page from every /admin tab', async () => {
    const rendered = await render({ initialEntry: '/admin/connectors' })
    const links = adminLinks(rendered)

    expect(links.map((link) => link.classList.contains('bg-kumo-fill'))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ])
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([
      null,
      null,
      null,
      null,
      'page',
    ])
  })

  it('defaults the expanded Admin section open and toggles its links closed', async () => {
    const rendered = await render()
    const toggle = rendered.querySelector<HTMLButtonElement>('button[aria-expanded]')

    expect(toggle?.textContent).toContain('Admin')
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(adminLinks(rendered)).toHaveLength(5)

    await act(async () => toggle?.click())

    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(rendered.querySelector('a[href^="/admin"]')).toBeNull()
  })

  it('shows icon-only admin links with accessible labels and tooltips when collapsed', async () => {
    const rendered = await render({ collapsed: true })
    const links = adminLinks(rendered)

    for (const [index, link] of links.entries()) {
      const label = ADMIN_LABELS[index]
      expect(link.getAttribute('aria-label')).toBe(label)
      expect(link.getAttribute('title')).toBe(label)
      expect(link.textContent).toBe('')
    }
  })
})
