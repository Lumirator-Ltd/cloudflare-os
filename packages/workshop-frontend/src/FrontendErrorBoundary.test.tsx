// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FrontendErrorBoundary from './FrontendErrorBoundary'
import { reportIssue } from './errorReporting'
import i18n from './i18n/config'

vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<typeof reportIssue>() }))

function Broken(): never { throw new Error('render failed') }

describe('FrontendErrorBoundary', () => {
  let root: Root | undefined
  afterEach(async () => {
    act(() => root?.unmount())
    vi.restoreAllMocks()
    await i18n.changeLanguage('en')
  })

  it('reports a React crash and offers a reload action', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <FrontendErrorBoundary>
        <Broken />
      </FrontendErrorBoundary>,
    ))
    expect(container.textContent).toContain('Something went wrong')
    expect(container.querySelector('button')?.textContent).toContain('Reload')
    expect(reportIssue).toHaveBeenCalledWith('workshop.react-render', expect.any(Error),
      expect.objectContaining({ captureMechanism: 'react', handled: false }))
    container.remove()
  })

  it('renders the crash fallback in Japanese', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await i18n.changeLanguage('ja')
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <I18nextProvider i18n={i18n}>
        <FrontendErrorBoundary>
          <Broken />
        </FrontendErrorBoundary>
      </I18nextProvider>,
    ))

    expect(container.textContent).toContain('エラーが発生しました')
    expect(container.textContent).toContain('Workshop を再読み込みして、もう一度やり直してください。')
    expect(container.querySelector('button')?.textContent).toContain('再読み込み')
    container.remove()
  })
})
