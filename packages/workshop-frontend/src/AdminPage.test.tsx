// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigate = vi.fn<(options: {
  to: string
  search: Record<string, string>
  replace: boolean
}) => void>()

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-router')>(),
  useNavigate: () => navigate,
}))
vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, loading: _loading, ...props }: ComponentProps<'button'> & { loading?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  Input: (props: ComponentProps<'input'>) => <input {...props} />,
  Switch: (props: ComponentProps<'input'>) => <input type="checkbox" {...props} />,
  Tabs: ({
    value,
    onValueChange,
    tabs,
  }: {
    value: string
    onValueChange: (value: string) => void
    tabs: Array<{ value: string; label: string }>
  }) => (
    <div data-active-tab={value}>
      {tabs.map((tab) => (
        <button key={tab.value} type="button" onClick={() => onValueChange(tab.value)}>
          {tab.label}
        </button>
      ))}
    </div>
  ),
  Textarea: ({ onValueChange: _onValueChange, ...props }: ComponentProps<'textarea'> & { onValueChange?: (value: string) => void }) => <textarea {...props} readOnly />,
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>() }))
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('./components/format/AdminFormatsPanel', () => ({ default: () => <div>Formats panel</div> }))
vi.mock('./components/SiteLogo', () => ({ default: ({ children }: { children: unknown }) => <>{children}</> }))

import AdminPage from './AdminPage'

const settings = {
  signupsEnabled: true,
  siteName: '',
  siteLogo: null,
  resourceVendors: [],
  instanceInstructions: '',
  announcement: '',
  banner: { text: '', color: 'neutral' as const },
  accentColor: '',
  formats: [],
}

function authenticate() {
  const admin = {
    getSettings: vi.fn<() => Promise<typeof settings>>(async () => settings),
  } as unknown as RpcStub<AdminApi>
  const authenticatedApi = {
    getAdminApi: vi.fn<() => Promise<RpcStub<AdminApi>>>(async () => admin),
  } as unknown as RpcStub<AuthenticatedApi>
  vi.mocked(useAuthenticatedApi).mockReturnValue({
    authenticatedApi,
    isAdmin: true,
  } as ReturnType<typeof useAuthenticatedApi>)
}

describe('AdminPage tabs', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    navigate.mockReset()
    vi.clearAllMocks()
  })

  async function render(activeTab: string) {
    authenticate()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const Page = AdminPage as ComponentType<{ activeTab: string }>
    await act(async () => {
      root!.render(<Page activeTab={activeTab} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    return container
  }

  it('preserves a validated deep-linked tab and replaces the URL when a tab is selected', async () => {
    const rendered = await render('formats')

    expect(rendered.querySelector('[data-active-tab="formats"]')).not.toBeNull()
    const access = [...rendered.querySelectorAll('button')].find((button) => button.textContent === 'Access')
    await act(async () => access?.click())

    expect(navigate).toHaveBeenCalledWith({
      to: '/admin',
      search: { tab: 'access' },
      replace: true,
    })
  })

  it('navigates General to the default /admin URL without a tab parameter', async () => {
    const rendered = await render('access')
    const general = [...rendered.querySelectorAll('button')].find((button) => button.textContent === 'General')
    await act(async () => general?.click())

    expect(navigate).toHaveBeenCalledWith({
      to: '/admin',
      search: {},
      replace: true,
    })
  })
})
