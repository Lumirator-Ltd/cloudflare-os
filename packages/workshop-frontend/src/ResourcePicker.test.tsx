// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type {
  AccountDescription,
  SupportedResource,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'
import ResourcePicker, { type SelectableItem } from './ResourcePicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const dispose = vi.fn<() => void>()
  const promise = Object.assign(new Promise<T>(next => { resolve = next }), {
    [Symbol.dispose]: dispose,
  })
  return { promise, resolve, dispose }
}

describe('ResourcePicker', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const vendor = {
    displayName: 'GitHub',
    url: 'https://github.com',
  } as VendorDescription

  function fakeApi(
    resources: SupportedResource[],
    accounts: { id: number, description: AccountDescription }[] = [],
  ): RpcStub<AuthenticatedApi> {
    return {
      subscribeConnectedAccounts(subscriber: ConnectedAccountsSubscriber) {
        for (const account of accounts) {
          subscriber.add(account.id, account.description, vendor, resources, true, 'github')
        }
        subscriber.ready()
        return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
          [Symbol.dispose]() {},
        })
      },
      listGatekeeperVendors: async () => [{
        id: 'github',
        description: vendor,
        supportedResources: resources,
      }],
    } as unknown as RpcStub<AuthenticatedApi>
  }

  async function renderPicker(
    resources: SupportedResource[],
    options: {
      accounts?: { id: number, description: AccountDescription }[]
      onItems?: (items: SelectableItem[]) => void
      onSelectAccount?: () => void
      onRefine?: (newUrl: string, placeholderStart: number, placeholderEnd: number) => void
      searchText?: string
      activateRef?: { current: ((index: number) => void) | null }
    } = {},
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker
        authenticatedApi={fakeApi(resources, options.accounts)}
        searchText={options.searchText ?? ''}
        onSelectAccount={options.onSelectAccount ?? (() => {})}
        onRefine={options.onRefine}
        onItems={options.onItems}
        activateRef={options.activateRef}
      />,
    ))
  }

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  it('shows new connection rows only for resources that allow new bindings', async () => {
    const resources = [
      {
        urlPattern: 'https://github.com/:owner/:repo',
        title: 'Blocked repository',
        description: 'A grandfathered scoped repository connection.',
        newConnectionsAllowed: false,
      },
      {
        urlPattern: 'https://github.com',
        title: 'Default-allowed account',
        description: 'An account connection using the default policy.',
      },
      {
        urlPattern: 'https://github.com/visible',
        title: 'Explicitly allowed account',
        description: 'An account connection with explicit policy.',
        newConnectionsAllowed: true,
      },
    ] satisfies SupportedResource[]

    await renderPicker(resources)

    expect([...container!.querySelectorAll('[role="button"]')].map(row => row.textContent))
      .toEqual(['Connect new account', 'Connect new account'])
    expect(container!.textContent).not.toContain('Blocked repository')
  })

  it('does not offer an existing OAuth account for a blocked new binding', async () => {
    const resource = {
      urlPattern: 'https://github.com/:owner/:repo',
      title: 'GitHub Repository',
      description: 'A grandfathered scoped repository connection.',
      newConnectionsAllowed: false,
    } satisfies SupportedResource
    const onItems = vi.fn<(items: SelectableItem[]) => void>()
    const onSelectAccount = vi.fn<() => void>()
    const activateRef: { current: ((index: number) => void) | null } = { current: null }

    await renderPicker([resource], {
      accounts: [{
        id: 7,
        description: {
          displayName: 'Acme repository',
          uniqueName: 'acme/widgets',
          avatar: { url: 'https://github.com/acme.png' },
        },
      }],
      onItems,
      onSelectAccount,
      activateRef,
    })

    expect(onItems).toHaveBeenLastCalledWith([])
    expect(container!.textContent).not.toContain('Acme repository')

    act(() => activateRef.current?.(0))

    expect(onSelectAccount).not.toHaveBeenCalled()
  })

  it('does not offer refinement into a blocked new binding', async () => {
    const onRefine = vi.fn<(
      newUrl: string,
      placeholderStart: number,
      placeholderEnd: number,
    ) => void>()

    await renderPicker([{
      urlPattern: 'https://github.com/:owner/:repo',
      title: 'GitHub Repository',
      description: 'A grandfathered scoped repository connection.',
      newConnectionsAllowed: false,
    }], { onRefine, searchText: 'github' })

    expect(container!.textContent).not.toContain('GitHub Repository')
    expect(onRefine).not.toHaveBeenCalled()
  })

  it('disposes a pending connected-account subscription on unmount', async () => {
    const pendingSubscription = deferred<{ [Symbol.dispose](): void }>()
    const authenticatedApi = {
      subscribeConnectedAccounts: () => pendingSubscription.promise,
      listGatekeeperVendors: async () => [],
    } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker
        authenticatedApi={authenticatedApi}
        searchText="https://example.com"
        onSelectAccount={() => {}}
      />,
    ))

    act(() => root!.unmount())
    root = undefined

    expect(pendingSubscription.dispose).toHaveBeenCalledOnce()
  })
})
