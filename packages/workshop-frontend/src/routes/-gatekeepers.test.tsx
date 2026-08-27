// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n/config'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../AuthContext', () => ({ useAuthenticatedApi: vi.fn<() => never>() }))
vi.mock('../ServerConfigContext', () => ({ useSiteName: () => 'Test Site' }))
vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

import { ConnectorCard } from './gatekeepers'

describe('Gatekeepers page connector cards', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  function render(disabledMessage?: string) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onClick = vi.fn<() => void>()
    act(() => {
      root!.render(
        <I18nextProvider i18n={i18n}>
          <ConnectorCard
            fallback="Example"
            name="Example"
            tagline="Example connector"
            state="available"
            onClick={onClick}
            disabledMessage={disabledMessage}
          />
        </I18nextProvider>,
      )
    })
    return { card: container.querySelector('[role="button"]') as HTMLElement, onClick }
  }

  it('keeps an unconfigured card visible and disables its connect action', () => {
    const consoleWarn = vi.spyOn(console, 'warn')
    const { card, onClick } = render('This connector is not configured. Ask an administrator to configure it.')

    expect(consoleWarn).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'NO_I18NEXT_INSTANCE' }),
    )
    expect(card.textContent).toContain('Example')
    expect(card.textContent).toContain('This connector is not configured. Ask an administrator to configure it.')
    expect(card.getAttribute('aria-disabled')).toBe('true')
    act(() => card.click())
    expect(onClick).not.toHaveBeenCalled()
  })

  it('leaves a configured card unchanged', () => {
    const { card, onClick } = render()

    expect(card.textContent).toContain('Example connector')
    expect(card.getAttribute('aria-disabled')).toBe('false')
    act(() => card.click())
    expect(onClick).toHaveBeenCalledOnce()
  })
})
