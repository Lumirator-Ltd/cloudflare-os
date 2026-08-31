import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Dialog, Button, Loader, Radio, useKumoToastManager } from '@cloudflare/kumo'
import { Lightning, Warning } from '@phosphor-icons/react'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { useCloudflareLimitsEnabled } from '../../ServerConfigContext'
import { connectionErrorMessage } from '../../connectorReadiness'
import { useTranslation } from 'react-i18next'

/**
 * Global modal that requires an eligible Cloudflare billing account. It offers account selection
 * when several are available and reconnection when none are eligible. Mounted once in the app shell.
 */
export default function AccountSelectionModal() {
  const limitsEnabled = useCloudflareLimitsEnabled()
  const { t } = useTranslation()
  const auth = useOptionalAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [needsSelection, setNeedsSelection] = useState(false)
  const [userFundingRequired, setUserFundingRequired] = useState(false)
  const [accountDiscoveryFailed, setAccountDiscoveryFailed] = useState(false)
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [accountLoadFailed, setAccountLoadFailed] = useState(false)
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [connecting, setConnecting] = useState(false)

  const check = useCallback(() => {
    if (!auth) return
    auth.authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => {
        setNeedsSelection(!!(u.connected && u.needsAccountSelection))
        setUserFundingRequired(u.userFundingRequired)
        setAccountDiscoveryFailed(!!u.accountDiscoveryFailed)
      })
      .catch(() => {})
  }, [auth])

  useEffect(() => {
    if (!limitsEnabled || !auth) return
    check()
    const onFocus = () => {
      setAccounts(null)
      setAccountLoadFailed(false)
      check()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [limitsEnabled, auth, check])

  // Load the account list once we know a selection is needed; default the choice to the first one.
  useEffect(() => {
    if (needsSelection && !accountDiscoveryFailed && accounts === null && auth) {
      auth.authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => {
          setAccountLoadFailed(false)
          setAccounts(list)
          setChosen(list[0]?.accountId)
        })
        .catch(() => {
          setAccountLoadFailed(true)
          setAccounts([])
        })
    }
  }, [needsSelection, accountDiscoveryFailed, accounts, auth])

  if (!limitsEnabled || !auth || !needsSelection) return null

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
    setAccountDiscoveryFailed(false)
    check()
  }

  const save = async () => {
    if (!chosen) return
    setSaving(true)
    try {
      await auth.authenticatedApi.selectCloudflareAccount(chosen)
      toasts.add({ title: t('billing.common.selected'), variant: 'success' })
      setNeedsSelection(false)
      setAccounts(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('billing.common.selectFailed')
      toasts.add({ title: msg, variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    // role="alertdialog" + no close affordance: the choice is mandatory, so it isn't dismissible by
    // clicking outside.
    <Dialog.Root open role="alertdialog">
      <Dialog className="p-6 sm:w-[480px]" size="base">
        <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
          <Warning size={22} weight="bold" className="text-kumo-warning" />
          {accountDiscoveryFailed || accountLoadFailed
            ? t('billing.accountModal.loadTitle')
            : accounts?.length === 0
              ? t('billing.accountModal.emptyTitle')
              : t('billing.accountModal.chooseTitle')}
        </Dialog.Title>

        <div className="space-y-4">
          <p className="text-sm text-kumo-subtle">
            {accountDiscoveryFailed || accountLoadFailed
              ? t('billing.common.discoveryFailed')
              : accounts?.length === 0
                ? t('billing.common.noEligible')
                : userFundingRequired
                  ? t('billing.accountModal.fundingAll')
                  : t('billing.accountModal.fundingBeyond')}
          </p>

          {accountDiscoveryFailed || accountLoadFailed ? null : accounts === null ? (
            <div className="flex justify-center py-6"><Loader size="base" /></div>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-kumo-subtle">{t('billing.common.noAccounts')}</p>
          ) : (
            <Radio.Group
              appearance="card"
              value={chosen}
              onValueChange={setChosen}
              disabled={saving}
            >
              <Radio.Legend className="sr-only">{t('billing.common.cloudflareAccount')}</Radio.Legend>
              {accounts.map((a) => (
                <Radio.Item key={a.accountId} value={a.accountId} label={a.accountName} />
              ))}
            </Radio.Group>
          )}

          <div className="flex justify-end gap-2 pt-1">
            {accountDiscoveryFailed || accountLoadFailed ? (
              <Button variant="secondary" onClick={retryAccountDiscovery}>
                {t("common.retry")}
              </Button>
            ) : accounts !== null && accounts.length === 0 ? (
              // No eligible customer account is available. Keep the modal actionable so the user
              // can re-authenticate with a different Cloudflare identity or retry discovery.
              <>
                <Button variant="ghost" onClick={() => setNeedsSelection(false)}>
                  {t('common.close')}
                </Button>
                <Button variant="secondary" onClick={() => setAccounts(null)}>
                  {t("common.retry")}
                </Button>
                <Button variant="primary" onClick={reconnect} loading={connecting}>
                  <Lightning size={16} weight="bold" />
                  {t('billing.usage.reauthenticate')}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                onClick={save}
                loading={saving}
                disabled={!chosen || saving}
              >
                {t('common.save')}
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
