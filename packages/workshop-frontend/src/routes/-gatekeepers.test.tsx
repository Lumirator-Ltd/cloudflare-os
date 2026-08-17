// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  })

  function render(disabledMessage?: string) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onClick = vi.fn<() => void>()
    act(() => {
      root!.render(
        <ConnectorCard
          fallback="Example"
          name="Example"
          tagline="Example connector"
          state="available"
          onClick={onClick}
          disabledMessage={disabledMessage}
        />,
      )
    })
    return { card: container.querySelector('[role="button"]') as HTMLElement, onClick }
  }

  it('keeps an unconfigured card visible and disables its connect action', () => {
    const { card, onClick } = render('Ask an administrator to configure this connector.')

    expect(card.textContent).toContain('Example')
    expect(card.textContent).toContain('Ask an administrator to configure this connector.')
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
