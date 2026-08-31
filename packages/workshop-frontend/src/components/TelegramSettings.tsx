import { useEffect, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { TelegramLogo } from '@phosphor-icons/react'
import { useAuthenticatedApi } from '../AuthContext'
import { useServerConfig } from '../ServerConfigContext'

const PRIMARY_BUTTON =
  'press inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60'

export default function TelegramSettings() {
  const telegramEnabled = useServerConfig()?.telegramEnabled ?? false
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [connected, setConnected] = useState<boolean | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [linkActive, setLinkActive] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [confirmingUnlink, setConfirmingUnlink] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const actionInFlight = useRef(false)
  const statusInFlight = useRef(false)

  useEffect(() => {
    if (!telegramEnabled) return

    let cancelled = false
    setConnected(null)
    setStatusError(null)
    authenticatedApi.getTelegramLinkStatus()
      .then(status => {
        if (!cancelled) setConnected(status.connected)
      })
      .catch(() => {
        if (!cancelled) setStatusError('Could not load Telegram status. Try again.')
      })
    return () => { cancelled = true }
  }, [authenticatedApi, telegramEnabled])

  const refreshStatus = async () => {
    if (statusInFlight.current) return

    statusInFlight.current = true
    setRefreshing(true)
    setStatusError(null)
    try {
      const status = await authenticatedApi.getTelegramLinkStatus()
      setConnected(status.connected)
      if (status.connected) {
        setLinkActive(false)
        setActionError(null)
      }
    } catch {
      setStatusError('Could not load Telegram status. Try again.')
    } finally {
      statusInFlight.current = false
      setRefreshing(false)
    }
  }

  const unlink = async () => {
    if (actionInFlight.current) return

    actionInFlight.current = true
    setUnlinking(true)
    setActionError(null)
    try {
      await authenticatedApi.unlinkTelegram()
      setConnected(false)
      setConfirmingUnlink(false)
      setLinkActive(false)
      toasts.add({ title: 'Telegram unlinked.', variant: 'success' })
    } catch {
      setActionError('Could not unlink Telegram. Try again.')
      toasts.add({ title: 'Could not unlink Telegram. Try again.', variant: 'error' })
    } finally {
      actionInFlight.current = false
      setUnlinking(false)
    }
  }

  const connect = async () => {
    if (actionInFlight.current) return

    setActionError(null)
    const popup = window.open('', '_blank')
    if (!popup) {
      setActionError('Allow pop-ups for this site, then try again.')
      toasts.add({
        title: 'Telegram could not open. Allow pop-ups and try again.',
        variant: 'error',
      })
      return
    }

    popup.opener = null
    actionInFlight.current = true
    setConnecting(true)
    try {
      const link = await authenticatedApi.startTelegramLink()
      popup.location.replace(link.url)
      setLinkActive(true)
      toasts.add({
        title: 'Telegram opened. Finish linking there, then refresh your status.',
        variant: 'success',
      })
    } catch {
      popup.close()
      setActionError('Could not start the Telegram connection. Try again.')
      toasts.add({
        title: 'Could not start the Telegram connection. Try again.',
        variant: 'error',
      })
    } finally {
      actionInFlight.current = false
      setConnecting(false)
    }
  }

  if (!telegramEnabled) return null

  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        Telegram
      </h2>
      <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
        <div className="flex items-start gap-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-kumo-tint text-kumo-brand">
            <TelegramLogo size={21} weight="fill" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p role="status" aria-live="polite" className="text-[14px] font-medium tracking-[-0.25px] text-kumo-default">
              {statusError ? 'Status unavailable' : connected === null ? 'Checking status…' : connected ? 'Connected' : 'Not connected'}
            </p>
            <p className={`mt-1 text-[13px] leading-[18px] tracking-[-0.25px] ${actionError || statusError ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
              {actionError ?? statusError ?? (linkActive
                ? 'Complete setup in Telegram, then refresh your status.'
                : 'Send messages to your agents from Telegram.')}
            </p>
            {connected === false ? (
              <div className="mt-4">
                {linkActive ? (
                  <button type="button" onClick={refreshStatus} disabled={refreshing} className={PRIMARY_BUTTON}>
                    {refreshing ? 'Refreshing…' : 'Refresh status'}
                  </button>
                ) : (
                  <button type="button" onClick={connect} disabled={connecting} className={PRIMARY_BUTTON}>
                    <TelegramLogo size={15} weight="fill" aria-hidden="true" />
                    {connecting ? 'Connecting…' : 'Connect Telegram'}
                  </button>
                )}
              </div>
            ) : connected === true ? (
              <div className="mt-4">
                {confirmingUnlink ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-kumo-subtle">Stop receiving Telegram messages?</span>
                    <button
                      type="button"
                      onClick={unlink}
                      disabled={unlinking}
                      className="press inline-flex h-8 cursor-pointer items-center rounded-lg px-2.5 text-[12px] font-medium text-kumo-danger transition-colors hover:bg-kumo-danger-tint disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {unlinking ? 'Unlinking…' : 'Confirm unlink'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingUnlink(false)}
                      disabled={unlinking}
                      className="press inline-flex h-8 cursor-pointer items-center rounded-lg px-2.5 text-[12px] font-medium text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingUnlink(true)}
                    className="press inline-flex h-9 cursor-pointer items-center justify-center rounded-lg px-3 text-[13px] font-medium text-kumo-danger transition-colors hover:bg-kumo-danger-tint"
                  >
                    Unlink Telegram
                  </button>
                )}
              </div>
            ) : statusError ? (
              <div className="mt-4">
                <button type="button" onClick={refreshStatus} disabled={refreshing} className={PRIMARY_BUTTON}>
                  {refreshing ? 'Retrying…' : 'Retry status'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
