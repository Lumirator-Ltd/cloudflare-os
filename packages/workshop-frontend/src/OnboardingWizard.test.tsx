// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { OnboardingConnectorButton } from './OnboardingWizard'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIGURED = {
  displayName: 'Configured',
  url: 'https://configured.example',
  configuration: { configured: true },
} as VendorDescription
const UNCONFIGURED = {
  displayName: 'Needs Setup',
  url: 'https://setup.example',
  configuration: { configured: false },
} as VendorDescription

describe('onboarding connectors', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  function render(description: VendorDescription) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onConnect = vi.fn<() => void>()
    act(() => {
      root!.render(
        <OnboardingConnectorButton
          vendorId="example"
          description={description}
          resolvedThemeMode="light"
          connected={false}
          connecting={false}
          onConnect={onConnect}
        />,
      )
    })
    return { button: container.querySelector('button') as HTMLButtonElement, onConnect }
  }

  it('disables an unconfigured connector and shows the setup message', () => {
    const { button, onConnect } = render(UNCONFIGURED)

    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Needs Setup')
    expect(button.textContent).toContain('This connector is not configured. Ask an administrator to configure it.')
    act(() => button.click())
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('leaves a configured connector connectable', () => {
    const { button, onConnect } = render(CONFIGURED)

    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('Not connected')
    act(() => button.click())
    expect(onConnect).toHaveBeenCalledOnce()
  })
})
