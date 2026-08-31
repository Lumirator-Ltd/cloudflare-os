// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountChooser } from './AccountChooser'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AccountChooser connect readiness', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  function render(connectDisabledMessage?: string) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onConnect = vi.fn<() => void>()
    act(() => {
      root!.render(
        <AccountChooser
          accounts={[]}
          selectedAccountId={null}
          vendorId="example"
          vendorName="Example"
          connecting={false}
          reconnectingAccountId={null}
          onSelect={() => {}}
          onConnect={onConnect}
          onReconnect={() => {}}
          connectDisabledMessage={connectDisabledMessage}
        />,
      )
    })
    return { button: container.querySelector('button') as HTMLButtonElement, onConnect }
  }

  it('disables connect and shows the configuration message', () => {
    const { button, onConnect } = render('This connector is not configured. Ask an administrator to configure it.')

    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('This connector is not configured. Ask an administrator to configure it.')
    act(() => button.click())
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('preserves the existing connect action when configured', () => {
    const { button, onConnect } = render()

    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('Connect Example')
    act(() => button.click())
    expect(onConnect).toHaveBeenCalledOnce()
  })
})
