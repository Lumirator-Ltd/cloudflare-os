// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type { SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { AuthProvider } from './AuthContext'
import GatekeeperModal from './GatekeeperModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => render({}),
    },
  )
  return {
    Dialog,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

const vendor = {
  displayName: 'GitHub',
  url: 'https://github.com',
} as VendorDescription

function api(resources: SupportedResource[]): RpcStub<AuthenticatedApi> {
  return {
    whoami: async () => ({ id: 'user', name: 'User', type: 'user' }),
    amIAdmin: async () => false,
    listModels: async () => [],
    listGatekeeperVendors: async () => [{
      id: 'github',
      description: vendor,
      supportedResources: resources,
    }],
    subscribeConnectedAccounts(subscriber: ConnectedAccountsSubscriber) {
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
        [Symbol.dispose]() {},
      })
    },
  } as unknown as RpcStub<AuthenticatedApi>
}

describe('GatekeeperModal new-binding policy', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.restoreAllMocks()
  })

  it('lists only resource types that allow new connections', async () => {
    const resources = [{
      urlPattern: 'https://github.com',
      title: 'GitHub Account',
      description: 'Read repositories.',
    }, {
      urlPattern: 'https://github.com/:owner/:repo',
      title: 'GitHub Repository',
      description: 'Grandfathered scoped access.',
      newConnectionsAllowed: false,
    }] satisfies SupportedResource[]

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <AuthProvider authenticatedApi={api(resources)} onLogout={() => {}}>
          <GatekeeperModal
            open
            onClose={() => {}}
            getOverseer={() => ({}) as never}
            onCreated={async () => {}}
          />
        </AuthProvider>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    const githubGroup = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.startsWith('GitHub'))
    expect(githubGroup).toBeDefined()
    act(() => githubGroup!.click())

    expect(container.textContent).toContain('GitHub Account')
    expect(container.textContent).not.toContain('GitHub Repository')
  })
})
