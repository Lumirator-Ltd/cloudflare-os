// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthVendorInfo, PublicApi } from '@gadgets/workshop-shared/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, loading: _loading, ...props }: ComponentProps<'button'> & { loading?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  Banner: ({ title }: { title: string }) => <div>{title}</div>,
}))

import OAuthButtons from './OAuthButtons'

function vendor(vendorId: string, displayName: string): AuthVendorInfo {
  return { vendorId, displayName }
}

describe('OAuthButtons', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  function render(
    vendors: AuthVendorInfo[],
    startGatekeeperLogin: (vendorId: string) => unknown =
      vi.fn<(vendorId: string) => unknown>(),
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root!.render(<OAuthButtons
        rpcStub={{ startGatekeeperLogin } as unknown as RpcStub<PublicApi>}
        vendors={vendors}
      />)
    })
    return { container, startGatekeeperLogin }
  }

  it('enables every advertised auth vendor without connector readiness metadata', () => {
    const rendered = render([vendor('github', 'GitHub')])
    const button = rendered.container.querySelector('button') as HTMLButtonElement

    expect(button.disabled).toBe(false)
    expect(rendered.container.textContent)
      .not.toContain('Ask an administrator to configure this connector.')
    button.click()
    expect(rendered.startGatekeeperLogin).toHaveBeenCalledWith('github')
  })

  it('disables auth vendor buttons only while a sign-in attempt is pending', async () => {
    const startGatekeeperLogin = vi.fn<
      (vendorId: string) => Promise<never>
    >(() => new Promise<never>(() => {}))
    const rendered = render([
      vendor('github', 'GitHub'),
      vendor('google', 'Google'),
    ], startGatekeeperLogin)
    const buttons = [...rendered.container.querySelectorAll('button')]

    expect(buttons.every(button => !button.disabled)).toBe(true)
    await act(async () => buttons[0].click())

    expect(buttons.every(button => button.disabled)).toBe(true)
    expect(startGatekeeperLogin).toHaveBeenCalledExactlyOnceWith('github')
  })
})
