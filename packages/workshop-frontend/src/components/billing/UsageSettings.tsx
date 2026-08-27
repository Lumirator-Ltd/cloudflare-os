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
import { useTranslation } from 'react-i18next'
import { useLanguage } from '../../i18n/LanguageProvider'
import { formatNumber } from '../../i18n/format'

/**
 * Shows the user's free-tier usage and Cloudflare connection / credit status on the profile page.
 * Renders nothing unless the Cloudflare limits flow is enabled server-side.
 */
export default function UsageSettings() {
  const limitsEnabled = useCloudflareLimitsEnabled()
  const { t } = useTranslation()
  const { effectiveLanguage } = useLanguage()
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
        title: connectionErrorMessage(error, t('gatekeepers.common.connectionFailed')),
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
        title: connectionErrorMessage(error, t('billing.common.reconnectFailed')),
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
      toasts.add({ title: t('billing.common.selected'), variant: 'success' })
      setAccounts(null)
      refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('billing.common.selectFailed')
      toasts.add({ title: msg, variant: 'error' })
    } finally {
      setSelecting(null)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        {t('billing.usage.title')}
      </h2>
      <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
      {loading || !usage ? (
        <p className="text-sm text-kumo-subtle">{t('billing.usage.loading')}</p>
      ) : (
        <div className="space-y-6">
          {usage.userFundingRequired ? (
            <div>
              <p className="text-xs font-medium text-kumo-subtle mb-1">{t('billing.usage.userFunded')}</p>
              <p className="text-sm text-kumo-default">
                {t('billing.usage.userFundedDescription')}
              </p>
            </div>
          ) : (
            <div>
              <p className="text-xs font-medium text-kumo-subtle mb-1">{t('billing.usage.freeAllowance')}</p>
              <p className="text-sm text-kumo-default">
                {t('billing.usage.requestsRemaining', { remaining: formatNumber(usage.remaining, effectiveLanguage), limit: formatNumber(usage.dailyLimit, effectiveLanguage) })}
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
            <p className="text-xs font-medium text-kumo-subtle mb-1">{t('billing.common.cloudflareAccount')}</p>
            {!usage.connected ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                  <CloudflareLogo size={16} />
                  <span>{t('billing.usage.notConnected')}</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  {usage.userFundingRequired
                    ? t('billing.usage.fundingRequired')
                    : t('billing.usage.beyondFree')}
                </p>
                <div className="pt-1">
                  <Button variant="primary" size="sm" onClick={connect} loading={busy}>
                    <Lightning size={14} weight="bold" className="mr-1" />
                    {t('billing.usage.connect')}
                  </Button>
                </div>
              </div>
            ) : usage.needsReconnect ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <Warning size={18} weight="bold" className="text-kumo-warning" />
                  <span>{t('billing.usage.reauth')}</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  {t('billing.usage.reauthDescription')}
                </p>
                <Button variant="primary" size="sm" onClick={reconnect} loading={busy}>
                  <Lightning size={14} weight="bold" className="mr-1" />
                  {t("billing.usage.reauthenticate")}
                </Button>
              </div>
            ) : usage.needsAccountSelection ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <Warning size={18} weight="bold" className="text-kumo-warning" />
                  <span>
                    {usage.accountDiscoveryFailed || accountLoadFailed
                      ? t('billing.usage.unableAccounts')
                      : accounts?.length === 0
                        ? t('billing.usage.noEligibleAccount')
                        : t('billing.usage.chooseBilling')}
                  </span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  {usage.accountDiscoveryFailed || accountLoadFailed
                    ? t('billing.common.discoveryFailed')
                    : accounts?.length === 0
                      ? t('billing.common.noEligible')
                      : t('billing.usage.selectCredits')}
                </p>
                {usage.accountDiscoveryFailed || accountLoadFailed ? (
                  <Button variant="secondary" size="sm" onClick={retryAccountDiscovery}>
                    {t('common.retry')}
                  </Button>
                ) : accounts === null ? (
                  <p className="text-sm text-kumo-subtle">{t('billing.common.loadingAccounts')}</p>
                ) : accounts.length === 0 ? (
                  <Button variant="primary" size="sm" onClick={reconnect} loading={busy}>
                    <Lightning size={14} weight="bold" className="mr-1" />
                    {t("billing.usage.reauthenticate")}
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
                    {t('billing.usage.connected')}
                    {usage.accountName && <> — {usage.accountName}</>}
                  </span>
                </div>
                <p className="text-sm text-kumo-default">
                  Account balance:{' '}
                  {usage.balance !== null ? (
                    <strong>{formatNumber(usage.balance, effectiveLanguage, { style: 'currency', currency: 'USD' })}</strong>
                  ) : (
                    <span className="text-kumo-subtle">{t('billing.common.unknown')}</span>
                  )}
                </p>

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => window.open(buildAddCreditsUrl(usage.accountId), '_blank')}
                  >
                    <Lightning size={14} weight="bold" className="mr-1" />
                    {t('billing.usage.addCredits')}
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
