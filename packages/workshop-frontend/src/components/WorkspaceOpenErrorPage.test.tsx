// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenGadgetError, OPEN_GADGET_ERROR_CODES } from '@gadgets/workshop-shared/api'
import i18n from '../i18n/config'
import WorkspaceOpenErrorPage, { classifyWorkspaceOpenFailure } from './WorkspaceOpenErrorPage'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('./WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

describe('WorkspaceOpenErrorPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(async () => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    await i18n.changeLanguage('en')
  })

  async function render(kind: 'access-denied' | 'not-found' | 'unexpected') {
    const onRetry = vi.fn<() => void>()
    const onGoToWorkspaces = vi.fn<() => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <I18nextProvider i18n={i18n}>
        <WorkspaceOpenErrorPage
          kind={kind}
          onRetry={onRetry}
          onGoToWorkspaces={onGoToWorkspaces}
        />
      </I18nextProvider>,
    ))
    return { container, onGoToWorkspaces, onRetry }
  }

  it('explains how to recover when access is denied without exposing workspace metadata', async () => {
    const { container: renderedContainer, onGoToWorkspaces, onRetry } = await render('access-denied')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe("You don't have access to this workspace")
    expect(renderedContainer.textContent).toContain('Ask the workspace owner to grant you access, then try again.')
    expect(document.activeElement).toBe(renderedContainer.querySelector('h1'))

    const buttons = [...renderedContainer.querySelectorAll('button')]
    expect(buttons.map(button => button.textContent)).toEqual(['Go to workspaces', 'Try again'])
    act(() => buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onGoToWorkspaces).toHaveBeenCalledOnce()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('gives a missing workspace a distinct, non-retryable state', async () => {
    const { container: renderedContainer } = await render('not-found')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe('Workspace not found')
    expect(renderedContainer.textContent).toContain('The link may be incorrect, or the workspace may have been deleted.')
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Go to workspaces'])
  })

  it('keeps unexpected failures retryable', async () => {
    const { container: renderedContainer } = await render('unexpected')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe("We couldn't load this workspace")
    expect(renderedContainer.textContent).toContain('Try again. If the problem continues, return to your workspaces.')
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Go to workspaces', 'Try again'])
  })

  it('renders recovery guidance in Japanese', async () => {
    await i18n.changeLanguage('ja')
    const { container: renderedContainer } = await render('access-denied')

    expect(renderedContainer.querySelector('h1')?.textContent)
      .toBe('このワークスペースへのアクセス権がありません')
    expect(renderedContainer.textContent)
      .toContain('ワークスペースの所有者にアクセス権を付与してもらってから、もう一度お試しください。')
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['ワークスペース一覧へ', 'もう一度試す'])
  })

  it('classifies stable open error codes without treating unexpected errors as expected', () => {
    expect(classifyWorkspaceOpenFailure(
      createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
    )).toBe('access-denied')
    expect(classifyWorkspaceOpenFailure(
      createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound),
    )).toBe('not-found')
    expect(classifyWorkspaceOpenFailure(
      new Error(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
    )).toBe('unexpected')
    expect(classifyWorkspaceOpenFailure(new Error('storage unavailable'))).toBe('unexpected')
  })
})
