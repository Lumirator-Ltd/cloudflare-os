// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ServerConfig } from '@gadgets/workshop-shared/api'
import SettingsPage from '../SettingsPage'
import TelegramSettings from './TelegramSettings'

const mocks = vi.hoisted(() => ({
  useAuthenticatedApi: vi.fn<() => { authenticatedApi: RpcStub<AuthenticatedApi> }>(),
  useServerConfig: vi.fn<() => ServerConfig | null>(),
  toastAdd: vi.fn<(toast: unknown) => void>(),
}))

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: mocks.toastAdd }),
}));
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: mocks.useAuthenticatedApi }));
vi.mock('../ServerConfigContext', () => ({ useServerConfig: mocks.useServerConfig }));
vi.mock('../useAvatar', () => ({ useAvatar: () => null, invalidateAvatarCache: vi.fn<() => void>() }));
vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: vi.fn<(title: string) => void>() }));
vi.mock('./billing/UsageSettings', () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function api(overrides: Partial<AuthenticatedApi> = {}): RpcStub<AuthenticatedApi> {
  return {
    getTelegramLinkStatus: vi.fn<AuthenticatedApi['getTelegramLinkStatus']>(async () => ({ connected: false })),
    startTelegramLink: vi.fn<AuthenticatedApi['startTelegramLink']>(),
    unlinkTelegram: vi.fn<AuthenticatedApi['unlinkTelegram']>(),
    ...overrides,
  } as unknown as RpcStub<AuthenticatedApi>
}

describe('TelegramSettings', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  async function render(authenticatedApi = api()) {
    mocks.useAuthenticatedApi.mockReturnValue({ authenticatedApi })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<TelegramSettings />))
    return authenticatedApi
  }

  function button(label: string) {
    const match = [...container!.querySelectorAll('button')]
      .find(candidate => candidate.textContent?.trim() === label)
    if (!match) throw new Error(`Button not found: ${label}`)
    return match
  }

  async function click(label: string) {
    await act(async () => button(label).dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  it('is included on the profile settings page', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    const authenticatedApi = api({
      whoami: vi.fn<AuthenticatedApi['whoami']>(async () => ({
        type: 'user', id: 'user-1', name: 'Profile User',
      })),
      hasPasswordLogin: vi.fn<AuthenticatedApi['hasPasswordLogin']>(async () => false),
    })
    mocks.useAuthenticatedApi.mockReturnValue({ authenticatedApi })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(<SettingsPage />))

    expect(container!.textContent).toContain('Telegram')
    expect(authenticatedApi.getTelegramLinkStatus).toHaveBeenCalledOnce()
  })

  it('renders nothing when Telegram is disabled', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: false } as ServerConfig)
    const authenticatedApi = await render()

    expect(container!.textContent).toBe('')
    expect(authenticatedApi.getTelegramLinkStatus).not.toHaveBeenCalled()
  })

  it('shows a disconnected profile with a connect action', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    const authenticatedApi = await render()

    expect(authenticatedApi.getTelegramLinkStatus).toHaveBeenCalledOnce()
    expect(container!.textContent).toContain('Telegram')
    expect(container!.textContent).toContain('Send messages to your agents from Telegram.')
    expect(container!.querySelector('[role="status"]')?.textContent).toContain('Not connected')
    expect(button('Connect Telegram').disabled).toBe(false)
  })

  it('shows a safe retry when status loading fails', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    const getTelegramLinkStatus = vi.fn<AuthenticatedApi['getTelegramLinkStatus']>()
      .mockRejectedValueOnce(new Error('secret status detail'))
      .mockResolvedValueOnce({ connected: false })
    await render(api({ getTelegramLinkStatus }))

    expect(container!.textContent).toContain('Could not load Telegram status. Try again.')
    expect(container!.textContent).not.toContain('secret status detail')
    expect(button('Retry status').disabled).toBe(false)

    await click('Retry status')

    expect(getTelegramLinkStatus).toHaveBeenCalledTimes(2)
    expect(container!.textContent).toContain('Not connected')
    expect(button('Connect Telegram').disabled).toBe(false)
  })

  it('opens the verified connect URL with opener isolation', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    const replace = vi.fn<(url: string) => void>()
    const popup = { opener: window, location: { replace }, close: vi.fn<() => void>() }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const startTelegramLink = vi.fn<AuthenticatedApi['startTelegramLink']>(async () => ({
      url: 'https://t.me/verified_bot?start=one-time-token',
      expiresAt: new Date('2026-04-01T12:10:00Z'),
    }))
    await render(api({ startTelegramLink }))

    await click('Connect Telegram')

    expect(window.open).toHaveBeenCalledWith('', '_blank')
    expect(popup.opener).toBeNull()
    expect(startTelegramLink).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith('https://t.me/verified_bot?start=one-time-token')
    expect(container!.textContent).toContain('Complete setup in Telegram, then refresh your status.')
    expect(button('Refresh status').disabled).toBe(false)
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      title: 'Telegram opened. Finish linking there, then refresh your status.',
      variant: 'success',
    })
  })

  it('disables duplicate connect actions while the link is loading', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    const pending = deferred<{ url: string; expiresAt: Date }>()
    const popup = {
      opener: window,
      location: { replace: vi.fn<(url: string) => void>() },
      close: vi.fn<() => void>(),
    }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const startTelegramLink = vi.fn<AuthenticatedApi['startTelegramLink']>(() => pending.promise)
    await render(api({ startTelegramLink }))

    await click('Connect Telegram')

    expect(button('Connecting…').disabled).toBe(true)
    button('Connecting…').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(startTelegramLink).toHaveBeenCalledOnce()
    await act(async () => pending.resolve({
      url: 'https://t.me/verified_bot?start=one-time-token',
      expiresAt: new Date('2026-04-01T12:10:00Z'),
    }))
  })

  it('explains how to retry when the connect popup is blocked', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    vi.spyOn(window, 'open').mockReturnValue(null)
    const startTelegramLink = vi.fn<AuthenticatedApi['startTelegramLink']>()
    await render(api({ startTelegramLink }))

    await click('Connect Telegram')

    expect(startTelegramLink).not.toHaveBeenCalled()
    expect(container!.textContent).toContain('Allow pop-ups for this site, then try again.')
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      title: 'Telegram could not open. Allow pop-ups and try again.',
      variant: 'error',
    })
  })

  it('closes the blank popup and shows a safe error when link creation fails', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    const popup = {
      opener: window,
      location: { replace: vi.fn<(url: string) => void>() },
      close: vi.fn<() => void>(),
    }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const startTelegramLink = vi.fn<AuthenticatedApi['startTelegramLink']>(async () => {
      throw new Error('secret backend detail')
    })
    await render(api({ startTelegramLink }))

    await click('Connect Telegram')

    expect(popup.close).toHaveBeenCalledOnce()
    expect(container!.textContent).toContain('Could not start the Telegram connection. Try again.')
    expect(container!.textContent).not.toContain('secret backend detail')
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      title: 'Could not start the Telegram connection. Try again.',
      variant: 'error',
    })
    expect(button('Connect Telegram').disabled).toBe(false)
  })

  it('refreshes a pending link to connected', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    const getTelegramLinkStatus = vi.fn<AuthenticatedApi['getTelegramLinkStatus']>()
      .mockResolvedValueOnce({ connected: false })
      .mockResolvedValueOnce({ connected: true })
    const popup = {
      opener: window,
      location: { replace: vi.fn<(url: string) => void>() },
      close: vi.fn<() => void>(),
    }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const startTelegramLink = vi.fn<AuthenticatedApi['startTelegramLink']>(async () => ({
      url: 'https://t.me/verified_bot?start=one-time-token',
      expiresAt: new Date('2026-04-01T12:10:00Z'),
    }))
    await render(api({ getTelegramLinkStatus, startTelegramLink }))
    await click('Connect Telegram')

    await click('Refresh status')

    expect(getTelegramLinkStatus).toHaveBeenCalledTimes(2)
    expect(container!.textContent).toContain('Connected')
    expect(button('Unlink Telegram').disabled).toBe(false)
  })

  it('shows connected status without minting another link', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    const startTelegramLink = vi.fn<AuthenticatedApi['startTelegramLink']>()
    await render(api({
      getTelegramLinkStatus: vi.fn<AuthenticatedApi['getTelegramLinkStatus']>(async () => ({ connected: true })),
      startTelegramLink,
    }))

    expect(container!.textContent).toContain('Connected')
    expect(button('Unlink Telegram').disabled).toBe(false)
    expect(container!.textContent).not.toContain('Connect Telegram')
    expect(container!.textContent).not.toContain('Open Telegram')
    expect(startTelegramLink).not.toHaveBeenCalled()
  })

  it('keeps the connection and shows a safe error when unlinking fails', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    const unlinkTelegram = vi.fn<AuthenticatedApi['unlinkTelegram']>(async () => {
      throw new Error('secret unlink detail')
    })
    await render(api({
      getTelegramLinkStatus: vi.fn<AuthenticatedApi['getTelegramLinkStatus']>(async () => ({ connected: true })),
      unlinkTelegram,
    }))

    await click('Unlink Telegram')
    await click('Confirm unlink')

    expect(container!.textContent).toContain('Connected')
    expect(container!.textContent).toContain('Could not unlink Telegram. Try again.')
    expect(container!.textContent).not.toContain('secret unlink detail')
    expect(button('Confirm unlink').disabled).toBe(false)
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      title: 'Could not unlink Telegram. Try again.',
      variant: 'error',
    })
  })

  it('requires confirmation, supports cancel, and unlinks successfully', async () => {
    mocks.useServerConfig.mockReturnValue({ telegramEnabled: true } as ServerConfig)
    const unlinkTelegram = vi.fn<AuthenticatedApi['unlinkTelegram']>(async () => undefined)
    await render(api({
      getTelegramLinkStatus: vi.fn<AuthenticatedApi['getTelegramLinkStatus']>(async () => ({ connected: true })),
      unlinkTelegram,
    }))

    await click('Unlink Telegram')
    expect(unlinkTelegram).not.toHaveBeenCalled()
    expect(container!.textContent).toContain('Stop receiving Telegram messages?')

    await click('Cancel')
    expect(unlinkTelegram).not.toHaveBeenCalled()
    expect(button('Unlink Telegram').disabled).toBe(false)

    await click('Unlink Telegram')
    await click('Confirm unlink')

    expect(unlinkTelegram).toHaveBeenCalledOnce()
    expect(container!.textContent).toContain('Not connected')
    expect(button('Connect Telegram').disabled).toBe(false)
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      title: 'Telegram unlinked.',
      variant: 'success',
    })
  })
})
