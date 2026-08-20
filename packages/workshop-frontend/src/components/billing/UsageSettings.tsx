import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { Lightning, CloudCheck, Warning } from '@phosphor-icons/react'
import CloudflareLogo from '../auth/CloudflareLogo'
import { useAuthenticatedApi } from '../../AuthContext'
import { useCloudflareLimitsEnabled } from '../../ServerConfigContext'
import { buildAddCreditsUrl } from './creditsUrl'
import ResetCountdown from './ResetCountdown'
import { connectionErrorMessage } from '../../connectorReadiness'

/**
 * Shows the user's free-tier usage and Cloudflare connection / credit status on the profile page.
 * Renders nothing unless the Cloudflare limits flow is enabled server-side.
 */
export default function UsageSettings() {
  const limitsEnabled = useCloudflareLimitsEnabled()
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [usage, setUsage] = useState<CloudflareUsageInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // Account-selection state used when no eligible billing account is selected.
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [accountLoadFailed, setAccountLoadFailed] = useState(false)
  const [selecting, setSelecting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => setUsage(u))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authenticatedApi])

  useEffect(() => {
    if (!limitsEnabled) {
      setLoading(false)
      return
    }
    refresh()
    // Re-check when the tab regains focus (e.g. after connecting / topping up elsewhere).
    const onFocus = () => {
      setAccounts(null)
      setAccountLoadFailed(false)
      refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [limitsEnabled, refresh])

  // When the server says the user must pick an account, load the list of accounts to choose from.
  useEffect(() => {
    if (usage?.connected && usage.needsAccountSelection &&
        !usage.accountDiscoveryFailed && accounts === null) {
      authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => {
          setAccountLoadFailed(false)
          setAccounts(list)
        })
        .catch(() => {
          setAccountLoadFailed(true)
          setAccounts([])
        })
    }
  }, [usage, accounts, authenticatedApi])

  // Hidden entirely when the feature is off, or while the unlimited (self-hosted) default applies.
  if (!limitsEnabled || (usage && usage.unlimited)) return null

  const connect = async () => {
    setBusy(true)
    try {
      // Connecting (or signing in with) Cloudflare is handled by the Cloudflare gatekeeper. Open its
      // OAuth popup; the connected-accounts subscription + focus refresh pick up the result.
      const { url } = await authenticatedApi.connectAccount('cloudflare', [])
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      toasts.add({
        title: connectionErrorMessage(error, 'Failed to start Cloudflare connection'),
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const reconnect = async () => {
    setBusy(true)
    try {
      const { url } = await authenticatedApi.reconnectCloudflareBillingAccount()
      setAccounts(null)
      setAccountLoadFailed(false)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      toasts.add({
        title: connectionErrorMessage(error, 'Failed to reconnect Cloudflare'),
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const retryAccountDiscovery = () => {
    setAccounts(null)
    setAccountLoadFailed(false)
    refresh()
  }

  const selectAccount = async (accountId: string) => {
    setSelecting(accountId)
    try {
      await authenticatedApi.selectCloudflareAccount(accountId)
      toasts.add({ title: 'Cloudflare account selected', variant: 'success' })
      setAccounts(null)
      refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to select account'
      toasts.add({ title: msg, variant: 'error' })
    } finally {
      setSelecting(null)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        Usage &amp; billing
      </h2>
      <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
      {loading || !usage ? (
        <p className="text-sm text-kumo-subtle">Loading usage…</p>
      ) : (
        <div className="space-y-6">
          {usage.userFundingRequired ? (
            <div>
              <p className="text-xs font-medium text-kumo-subtle mb-1">User-funded usage</p>
              <p className="text-sm text-kumo-default">
                A funded Cloudflare account is required for all AI inference.
              </p>
            </div>
          ) : (
            <div>
              <p className="text-xs font-medium text-kumo-subtle mb-1">Free daily allowance</p>
              <p className="text-sm text-kumo-default">
                {usage.remaining} of {usage.dailyLimit}{' '}
                {usage.dailyLimit === 1 ? 'request' : 'requests'} remaining today
              </p>
              {usage.resetAt && (
                <p className="text-xs text-kumo-subtle mt-1">
                  Resets at 00:00 UTC, in{' '}
                  <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} />.
                </p>
              )}
            </div>
          )}

          {/* Cloudflare connection / credits */}
          <div>
            <p className="text-xs font-medium text-kumo-subtle mb-1">Cloudflare account</p>
            {!usage.connected ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                  <CloudflareLogo size={16} />
                  <span>Not connected</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  {usage.userFundingRequired
                    ? 'Connect and fund your Cloudflare account to use AI models. Inference is billed to your own AI Gateway credits.'
                    : 'Connect your Cloudflare account to keep building once your free allowance runs out. Usage beyond the free tier is billed to your own Cloudflare AI Gateway credits.'}
                </p>
                <div className="pt-1">
                  <Button variant="primary" size="sm" onClick={connect} loading={busy}>
                    <Lightning size={14} weight="bold" className="mr-1" />
                    Connect Cloudflare
                  </Button>
                </div>
              </div>
            ) : usage.needsReconnect ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <Warning size={18} weight="bold" className="text-kumo-warning" />
                  <span>Cloudflare connection needs re-authentication</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  Re-authenticate the connected Cloudflare account before AI inference can continue.
                </p>
                <Button variant="primary" size="sm" onClick={reconnect} loading={busy}>
                  <Lightning size={14} weight="bold" className="mr-1" />
                  Re-authenticate Cloudflare
                </Button>
              </div>
            ) : usage.needsAccountSelection ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <Warning size={18} weight="bold" className="text-kumo-warning" />
                  <span>
                    {usage.accountDiscoveryFailed || accountLoadFailed
                      ? 'Unable to load Cloudflare accounts'
                      : accounts?.length === 0
                        ? 'No eligible Cloudflare account'
                        : 'Choose which Cloudflare account to bill'}
                  </span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  {usage.accountDiscoveryFailed || accountLoadFailed
                    ? 'Cloudflare account discovery is temporarily unavailable. Try again.'
                    : accounts?.length === 0
                      ? 'This connection has no eligible customer account. Re-authenticate it with access to your own Cloudflare account.'
                      : 'Select the Cloudflare account whose AI Gateway credits should be used.'}
                </p>
                {usage.accountDiscoveryFailed || accountLoadFailed ? (
                  <Button variant="secondary" size="sm" onClick={retryAccountDiscovery}>
                    Try again
                  </Button>
                ) : accounts === null ? (
                  <p className="text-sm text-kumo-subtle">Loading accounts…</p>
                ) : accounts.length === 0 ? (
                  <Button variant="primary" size="sm" onClick={reconnect} loading={busy}>
                    <Lightning size={14} weight="bold" className="mr-1" />
                    Re-authenticate Cloudflare
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2">
                    {accounts.map((a) => (
                      <Button
                        key={a.accountId}
                        variant="secondary"
                        size="sm"
                        className="justify-start"
                        onClick={() => selectAccount(a.accountId)}
                        loading={selecting === a.accountId}
                        disabled={selecting !== null}
                      >
                        {a.accountName}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <CloudCheck size={18} weight="bold" className="text-kumo-success" />
                  <span>
                    Connected
                    {usage.accountName && <> — {usage.accountName}</>}
                  </span>
                </div>
                <p className="text-sm text-kumo-default">
                  Account balance:{' '}
                  {usage.balance !== null ? (
                    <strong>${usage.balance.toFixed(2)}</strong>
                  ) : (
                    <span className="text-kumo-subtle">unknown</span>
                  )}
                </p>

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => window.open(buildAddCreditsUrl(usage.accountId), '_blank')}
                  >
                    <Lightning size={14} weight="bold" className="mr-1" />
                    Add credits
                  </Button>
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-kumo-subtle border-t border-kumo-line pt-3">
            Learn more about{' '}
            <a
              href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              AI Gateway unified billing
            </a>
            .
          </p>
        </div>
      )}
      </div>
    </section>
  )
}
