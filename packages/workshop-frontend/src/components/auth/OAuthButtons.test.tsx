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

const UNCONFIGURED_MESSAGE =
  'This connector is not configured. Ask an administrator to configure it.'

function vendor(configured: boolean): AuthVendorInfo {
  return { vendorId: 'github', displayName: 'GitHub', configured }
}

describe('OAuthButtons connector readiness', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  function render(vendors: AuthVendorInfo[], startGatekeeperLogin = vi.fn<() => void>()) {
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

  it('disables unconfigured auth vendors with the shared administrator guidance', () => {
    const rendered = render([vendor(false)])
    const button = rendered.container.querySelector('button') as HTMLButtonElement

    expect(button.disabled).toBe(true)
    expect(rendered.container.textContent).toContain(UNCONFIGURED_MESSAGE)
    button.click()
    expect(rendered.startGatekeeperLogin).not.toHaveBeenCalled()
  })

  it('keeps configured auth vendors enabled', () => {
    const rendered = render([vendor(true)])

    expect((rendered.container.querySelector('button') as HTMLButtonElement).disabled).toBe(false)
    expect(rendered.container.textContent).not.toContain(UNCONFIGURED_MESSAGE)
  })
})
