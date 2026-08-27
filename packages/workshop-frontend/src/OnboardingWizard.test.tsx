// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import i18n from './i18n/config'
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

  afterEach(async () => {
    act(() => root?.unmount())
    container?.remove()
    await i18n.changeLanguage('en')
  })

  function render(description: VendorDescription) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onConnect = vi.fn<() => void>()
    act(() => {
      root!.render(
        <I18nextProvider i18n={i18n}>
          <OnboardingConnectorButton
            vendorId="example"
            description={description}
            resolvedThemeMode="light"
            connected={false}
            connecting={false}
            onConnect={onConnect}
          />
        </I18nextProvider>,
      )
    })
    return { button: container.querySelector('button') as HTMLButtonElement, onConnect }
  }

  it('disables an unconfigured connector and shows the setup message', () => {
    const { button, onConnect } = render(UNCONFIGURED)

    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Needs Setup')
    expect(button.textContent).toContain('Ask an administrator to configure this connector.')
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

  it('renders connector status in Japanese while preserving the vendor name', async () => {
    await i18n.changeLanguage('ja')
    const { button } = render(CONFIGURED)

    expect(button.textContent).toContain('Configured')
    expect(button.textContent).toContain('未接続')
  })
})
