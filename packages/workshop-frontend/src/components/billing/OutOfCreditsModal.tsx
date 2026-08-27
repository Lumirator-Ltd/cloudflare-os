import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Dialog, Button, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { CloudWarning, Lightning } from '@phosphor-icons/react'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { buildAddCreditsUrl } from './creditsUrl'
import ResetCountdown from './ResetCountdown'
import { connectionErrorMessage } from '../../connectorReadiness'
import { useTranslation } from 'react-i18next'
import { useLanguage } from '../../i18n/LanguageProvider'
import { formatNumber } from '../../i18n/format'

interface OutOfCreditsModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Modal shown when a user has exhausted their free daily allowance. Guides them to connect their
 * Cloudflare account (if not connected), pick which account to bill (if they have several), or top
 * up credits in the Cloudflare dashboard (if connected but low balance).
 */
export default function OutOfCreditsModal({ open, onClose }: OutOfCreditsModalProps) {
  const auth = useOptionalAuthenticatedApi()
  const { t } = useTranslation()
  const { effectiveLanguage } = useLanguage()
  const toasts = useKumoToastManager()
  const [usage, setUsage] = useState<CloudflareUsageInfo | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [accountLoadFailed, setAccountLoadFailed] = useState(false)
  const [selecting, setSelecting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!auth) return
    auth.authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => setUsage(u))
      .catch(() => {})
  }, [auth])

  useEffect(() => {
    if (!open || !auth) return
    setUsage(null)
    setAccounts(null)
    setAccountLoadFailed(false)
    refresh()
    // Re-check when the tab regains focus, so returning from the "Connect Cloudflare" OAuth pop-up
    // updates the modal (connected state / balance / account list) without reopening it.
    const onFocus = () => {
      setAccounts(null)
      setAccountLoadFailed(false)
      refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [open, auth, refresh])

  // Load the account list when the server says the user must pick one.
  useEffect(() => {
    if (!auth) return
    if (usage?.connected && usage.needsAccountSelection &&
        !usage.accountDiscoveryFailed && accounts === null) {
      auth.authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => {
          setAccountLoadFailed(false)
          setAccounts(list)
        })
        .catch(() => {
          setAccountLoadFailed(true)
          setAccounts([])
        })
    }
  }, [auth, usage, accounts])

  const connect = async () => {
    if (!auth) return
    setConnecting(true)
    try {
      const { url } = await auth.authenticatedApi.connectAccount('cloudflare', [])
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      toasts.add({
        title: connectionErrorMessage(error, t('gatekeepers.common.connectionFailed')),
        variant: 'error',
      })
    } finally {
      setConnecting(false)
    }
  }

  const reconnect = async () => {
    if (!auth) return
    setConnecting(true)
    try {
      const { url } = await auth.authenticatedApi.reconnectCloudflareBillingAccount()
      setAccounts(null)
      setAccountLoadFailed(false)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      toasts.add({
        title: connectionErrorMessage(error, t('billing.common.reconnectFailed')),
        variant: 'error',
      })
    } finally {
      setConnecting(false)
    }
  }

  const retryAccountDiscovery = () => {
    setAccounts(null)
    setAccountLoadFailed(false)
    refresh()
  }

  const selectAccount = async (accountId: string) => {
    if (!auth) return
    setSelecting(accountId)
    try {
      await auth.authenticatedApi.selectCloudflareAccount(accountId)
      setAccounts(null)
      refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('billing.common.selectFailed')
      toasts.add({ title: msg, variant: 'error' })
    } finally {
      setSelecting(null)
    }
  }

  const connected = usage?.connected ?? false
  const needsReconnect = connected && (usage?.needsReconnect ?? false)
  const needsSelection = connected && (usage?.needsAccountSelection ?? false)
  const userFundingRequired = usage?.userFundingRequired ?? false
  const accountDiscoveryFailed = usage?.accountDiscoveryFailed || accountLoadFailed

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="p-6 sm:w-[560px]" size="base">
        <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
          <CloudWarning size={22} weight="bold" className="text-kumo-warning" />
          {userFundingRequired ? t('billing.outOfCredits.connectTitle') : t('billing.outOfCredits.limitTitle')}
        </Dialog.Title>

        {usage === null ? (
          <div className="flex justify-center py-8"><Loader size="base" /></div>
        ) : (
          <div className="space-y-4">
            {!connected ? (
              <p className="text-sm text-kumo-subtle">
                {userFundingRequired ? (
                  t('billing.outOfCredits.fundingDescription')
                ) : (
                  <>
                    {t('billing.outOfCredits.freeLimit', { limit: usage.dailyLimit })}
                    {usage.resetAt && (
                      <> {t('billing.outOfCredits.waitForReset')} <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} /></>
                    )}
                  </>
                )}
              </p>
            ) : needsReconnect ? (
              <p className="text-sm text-kumo-subtle">
                {t('billing.usage.reauthDescription')}
              </p>
            ) : needsSelection ? (
              <p className="text-sm text-kumo-subtle">
                {accountDiscoveryFailed
                  ? t('billing.common.discoveryFailed')
                  : accounts?.length === 0
                    ? t('billing.common.noEligible')
                    : t(userFundingRequired
                      ? 'billing.outOfCredits.chooseAccountAll'
                      : 'billing.outOfCredits.chooseAccountBeyond')}
              </p>
            ) : (
              <p className="text-sm text-kumo-subtle">
                {t('billing.outOfCredits.connectedBalance', {
                  amount: usage.balance === null
                    ? t('billing.common.unknown')
                    : formatNumber(usage.balance, effectiveLanguage, { style: 'currency', currency: 'USD' }),
                })}
                {usage.resetAt && (
                  <> {t('billing.outOfCredits.waitForReset')} <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} /></>
                )}
              </p>
            )}

            {needsSelection && (
              <div className="flex flex-col gap-2">
                {accountDiscoveryFailed ? (
                  <Button variant="secondary" onClick={retryAccountDiscovery}>{t('common.retry')}</Button>
                ) : accounts === null ? (
                  <p className="text-sm text-kumo-subtle">{t('billing.common.loadingAccounts')}</p>
                ) : accounts.length === 0 ? (
                  <p className="text-sm text-kumo-subtle">{t('billing.common.noAccounts')}</p>
                ) : (
                  accounts.map((a) => (
                    <Button
                      key={a.accountId}
                      variant="secondary"
                      className="justify-start"
                      onClick={() => selectAccount(a.accountId)}
                      loading={selecting === a.accountId}
                      disabled={selecting !== null}
                    >
                      {a.accountName}
                    </Button>
                  ))
                )}
              </div>
            )}

            <p className="text-sm text-kumo-subtle">
              <a
                href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {t('billing.usage.learnMore')}
              </a>
            </p>

            <div className="flex items-center justify-end gap-2 pt-2">
              {!connected ? (
                <>
                  <Button variant="secondary" onClick={onClose}>{t('billing.outOfCredits.maybeLater')}</Button>
                  <Button variant="primary" onClick={connect} loading={connecting}>
                    <Lightning size={16} weight="bold" />
                    {t('billing.usage.connect')}
                  </Button>
                </>
              ) : needsReconnect ? (
                <>
                  <Button variant="secondary" onClick={onClose}>{t('billing.common.close')}</Button>
                  <Button variant="primary" onClick={reconnect} loading={connecting}>
                    <Lightning size={16} weight="bold" />
                    {t('billing.usage.reauthenticate')}
                  </Button>
                </>
              ) : needsSelection ? (
                <>
                  <Button variant="secondary" onClick={onClose}>{t('billing.common.close')}</Button>
                  {!accountDiscoveryFailed && accounts?.length === 0 && (
                    <Button variant="primary" onClick={reconnect} loading={connecting}>
                      <Lightning size={16} weight="bold" />
                      {t('billing.usage.reauthenticate')}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Button variant="secondary" onClick={onClose}>{t('billing.common.close')}</Button>
                  <Button
                    variant="primary"
                    onClick={() => window.open(buildAddCreditsUrl(usage.accountId), '_blank')}
                  >
                    {t('billing.outOfCredits.addCreditsCloudflare')}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
