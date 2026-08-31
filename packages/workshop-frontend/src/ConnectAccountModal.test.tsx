// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const addToast = vi.fn<(toast: { title: string; variant: string }) => void>()

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
    },
  )
  return {
    Dialog,
    Loader: () => <span>Loading</span>,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    useKumoToastManager: () => ({ add: addToast }),
  }
})

vi.mock('./components/Avatar', () => ({ default: () => <span data-testid="avatar" /> }))

import ConnectAccountModal from './ConnectAccountModal'

const CONFIGURED = {
  displayName: 'Configured Service',
  url: 'https://configured.example',
  configuration: { configured: true },
} as VendorDescription
const UNCONFIGURED = {
  displayName: 'Setup Needed',
  url: 'https://setup.example',
  configuration: { configured: false },
} as VendorDescription
const UNAVAILABLE = {
  displayName: 'Unavailable Service',
  url: 'https://unavailable.example',
} as VendorDescription

function api(connectAccount = vi.fn<() => Promise<{ url: string }>>(async () => ({ url: 'https://oauth.example' }))) {
  return {
    listGatekeeperVendors: async () => [
      { id: 'configured', description: CONFIGURED, supportedResources: [] },
      { id: 'setup', description: UNCONFIGURED, supportedResources: [] },
      { id: 'unavailable', description: UNAVAILABLE, supportedResources: [], unavailable: true },
    ],
    connectAccount,
  } as unknown as RpcStub<AuthenticatedApi>
}

describe('ConnectAccountModal connector readiness', () => {
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

  async function render(authenticatedApi: RpcStub<AuthenticatedApi>) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ConnectAccountModal
          visible
          onCancel={() => {}}
          onInitiated={() => {}}
          authenticatedApi={authenticatedApi}
        />,
      )
      await Promise.resolve()
    })
    return container
  }

  it('keeps unconfigured connectors visible but disables connect with the exact setup message', async () => {
    const connectAccount = vi.fn<() => Promise<{ url: string }>>(async () => ({ url: 'https://oauth.example' }))
    const rendered = await render(api(connectAccount))

    const setupCard = rendered.querySelector('[data-vendor-id="setup"]') as HTMLElement
    expect(setupCard).not.toBeNull()
    expect(setupCard.getAttribute('aria-disabled')).toBe('true')
    expect(setupCard.textContent).toContain('Ask an administrator to configure this connector.')

    await act(async () => setupCard.click())
    expect(connectAccount).not.toHaveBeenCalled()
  })

  it('leaves configured connectors connectable and unavailable connectors hidden', async () => {
    const connectAccount = vi.fn<() => Promise<{ url: string }>>(async () => ({ url: 'https://oauth.example' }))
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const rendered = await render(api(connectAccount))

    expect(rendered.textContent).not.toContain('Unavailable Service')
    const configuredCard = rendered.querySelector('[data-vendor-id="configured"]') as HTMLElement
    expect(configuredCard.getAttribute('aria-disabled')).toBe('false')
    expect(configuredCard.textContent).not.toContain('Ask an administrator')

    await act(async () => configuredCard.click())
    expect(connectAccount).toHaveBeenCalledWith('configured')
  })

  it('surfaces the clean setup message if the backend readiness guard still rejects', async () => {
    const guardedApi = api(vi.fn<() => Promise<{ url: string }>>(async () => {
      throw new Error('This connector is not configured. Ask an administrator to configure it.')
    }))
    const rendered = await render(guardedApi)

    await act(async () => {
      ;(rendered.querySelector('[data-vendor-id="configured"]') as HTMLElement).click()
    })

    expect(addToast).toHaveBeenCalledWith({
      title: 'Ask an administrator to configure this connector.',
      variant: 'error',
    })
  })
})
