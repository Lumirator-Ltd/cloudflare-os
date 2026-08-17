// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AdminApi,
  AdminConnectorConfiguration,
  AuthenticatedApi,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const addToast = vi.fn<(toast: { title: string; variant: string }) => void>()

vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, loading: _loading, ...props }: ComponentProps<'button'> & { loading?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  Loader: () => <span>Loading</span>,
  useKumoToastManager: () => ({ add: addToast }),
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>() }))
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

import AdminConnectorsPage from './AdminConnectorsPage'

const CONNECTORS: AdminConnectorConfiguration[] = [
  {
    id: 'github',
    displayName: 'GitHub',
    logo: { url: 'https://example.com/github.svg' },
    configured: true,
    callbackUrl: 'https://workshop.example/gatekeeper/github/callback',
    setupGuideUrl: 'https://github.com/Lumirator-Ltd/cloudflare-os/tree/main/packages/gatekeeper-github#readme',
    inputs: [
      { name: 'CLIENT_ID', label: 'Client ID', secret: true },
      { name: 'CLIENT_SECRET', label: 'Client Secret', secret: true },
    ],
    writeAvailable: true,
  },
  {
    id: 'notion',
    displayName: 'Notion',
    configured: false,
    callbackUrl: 'https://workshop.example/gatekeeper/notion/callback',
    setupGuideUrl: 'https://github.com/Lumirator-Ltd/cloudflare-os/tree/main/packages/gatekeeper-notion#readme',
    inputs: [
      { name: 'CLIENT_ID', label: 'Client ID', secret: true },
      { name: 'CLIENT_SECRET', label: 'Client Secret', secret: true },
    ],
    writeAvailable: true,
  },
]

function auth(admin: Partial<AdminApi> | null, isAdmin = true) {
  const authenticatedApi = {
    getAdminApi: vi.fn<() => Promise<RpcStub<AdminApi> | null>>(
      async () => admin as RpcStub<AdminApi> | null,
    ),
  } as unknown as RpcStub<AuthenticatedApi>
  vi.mocked(useAuthenticatedApi).mockReturnValue({
    authenticatedApi,
    isAdmin,
  } as ReturnType<typeof useAuthenticatedApi>)
  return authenticatedApi
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('/admin/connectors', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    addToast.mockReset()
    vi.restoreAllMocks()
  })

  async function render() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<AdminConnectorsPage />)
      await Promise.resolve()
      await Promise.resolve()
    })
    return container
  }

  it('shows unauthorized without requesting an admin capability for non-admins', async () => {
    const authenticatedApi = auth(null, false)
    const rendered = await render()

    expect(rendered.textContent).toContain("You don't have access to this page.")
    expect(authenticatedApi.getAdminApi).not.toHaveBeenCalled()
  })

  it('loads the admin capability when admin status resolves after the initial render', async () => {
    const listConnectorConfigurations =
      vi.fn<() => Promise<AdminConnectorConfiguration[]>>(async () => [CONNECTORS[0]])
    const admin = { listConnectorConfigurations }
    auth(admin, false)
    const rendered = await render()
    expect(rendered.textContent).toContain("You don't have access to this page.")

    auth(admin, true)
    await act(async () => {
      root!.render(<AdminConnectorsPage />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(rendered.textContent).toContain('GitHub')
    expect(listConnectorConfigurations).toHaveBeenCalledOnce()
  })

  it('lists setup states, callback URLs, and empty write-only credential fields', async () => {
    auth({
      listConnectorConfigurations:
        vi.fn<() => Promise<AdminConnectorConfiguration[]>>(async () => CONNECTORS),
    })
    const rendered = await render()

    expect(rendered.textContent).toContain('GitHub')
    expect(rendered.textContent).toContain('Configured')
    expect(rendered.textContent).toContain('Notion')
    expect(rendered.textContent).toContain('Needs setup')
    expect(rendered.textContent).toContain(CONNECTORS[0].callbackUrl)
    expect(rendered.textContent).toContain(CONNECTORS[1].callbackUrl)
    expect(rendered.textContent).toContain('Follow the provider setup guide, register the callback URL above, then enter the credentials.')
    const guides = [...rendered.querySelectorAll('a')].filter((link) => link.textContent === 'View setup guide')
    expect(guides).toHaveLength(CONNECTORS.length)
    expect(guides[0].getAttribute('href')).toBe(CONNECTORS[0].setupGuideUrl)
    expect(guides.every((link) => link.getAttribute('target') === '_blank')).toBe(true)
    expect(guides.every((link) => link.getAttribute('rel') === 'noreferrer')).toBe(true)
    expect(rendered.querySelector('img')?.getAttribute('src')).toBe(CONNECTORS[0].logo?.url)

    const inputs = [...rendered.querySelectorAll('input')] as HTMLInputElement[]
    expect(inputs).toHaveLength(4)
    for (const input of inputs) {
      expect(input.type).toBe('password')
      expect(input.autocomplete).toBe('off')
      expect(input.getAttribute('data-1p-ignore')).toBe('true')
      expect(input.getAttribute('data-lpignore')).toBe('true')
      expect(input.getAttribute('data-form-type')).toBe('other')
      expect(input.value).toBe('')
    }
    expect(rendered.textContent).not.toContain('existing-client-id')
    expect(rendered.textContent).toContain('Rotate credentials')
    expect(rendered.textContent).toContain('Save credentials')
  })

  it('saves exact fields, clears them, refreshes status, and reports success', async () => {
    const configureConnector = vi.fn<() => Promise<void>>(async () => {})
    const listConnectorConfigurations = vi
      .fn<() => Promise<AdminConnectorConfiguration[]>>()
      .mockResolvedValueOnce([CONNECTORS[1]])
      .mockResolvedValueOnce([{ ...CONNECTORS[1], configured: true }])
    auth({ listConnectorConfigurations, configureConnector })
    const rendered = await render()

    const idInput = rendered.querySelector('input[name="notion-CLIENT_ID"]') as HTMLInputElement
    const secretInput = rendered.querySelector('input[name="notion-CLIENT_SECRET"]') as HTMLInputElement
    await act(async () => {
      setInput(idInput, 'new-client-id')
      setInput(secretInput, 'new-client-secret')
    })
    const save = [...rendered.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Save credentials')) as HTMLButtonElement
    await act(async () => {
      save.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(configureConnector).toHaveBeenCalledWith('notion', {
      CLIENT_ID: 'new-client-id',
      CLIENT_SECRET: 'new-client-secret',
    })
    expect(idInput.value).toBe('')
    expect(secretInput.value).toBe('')
    expect(listConnectorConfigurations).toHaveBeenCalledTimes(2)
    expect(rendered.textContent).toContain('Configured')
    expect(rendered.textContent).toContain('Rotate credentials')
    expect(addToast).toHaveBeenCalledWith({
      title: 'Notion credentials saved',
      variant: 'success',
    })
  })

  it('renders read-only fields and explanation when credential writes are unavailable', async () => {
    const readOnly = CONNECTORS.map((connector) => ({ ...connector, writeAvailable: false }))
    auth({
      listConnectorConfigurations:
        vi.fn<() => Promise<AdminConnectorConfiguration[]>>(async () => readOnly),
    })
    const rendered = await render()

    expect(rendered.textContent).toContain('Connector credential management is not enabled')
    expect([...rendered.querySelectorAll('input')].every((input) => input.disabled)).toBe(true)
    expect(rendered.textContent).not.toContain('Save credentials')
    expect(rendered.textContent).not.toContain('Rotate credentials')
  })

  it('shows empty and failed list states', async () => {
    auth({
      listConnectorConfigurations:
        vi.fn<() => Promise<AdminConnectorConfiguration[]>>(async () => []),
    })
    let rendered = await render()
    expect(rendered.textContent).toContain('No credentialed connectors are installed')

    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    auth({
      listConnectorConfigurations:
        vi.fn<() => Promise<AdminConnectorConfiguration[]>>(async () => {
          throw new Error('failed')
        }),
    })
    rendered = await render()
    expect(rendered.textContent).toContain('Something went wrong loading connector configurations.')
  })
})
