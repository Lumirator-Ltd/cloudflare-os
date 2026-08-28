import { useState, useEffect } from 'react'
import { Dialog, Text, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, GatekeeperVendorFilter, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import VendorCard from './VendorCard'
import { useTranslation } from 'react-i18next'
import {
  connectorSetupGuidance,
  connectionErrorMessage,
  connectorIsConfigured,
} from './connectorReadiness'

interface ConnectAccountModalProps {
  visible: boolean
  onCancel: () => void
  onInitiated: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** Optional filter to only show vendors supporting certain features */
  filter?: GatekeeperVendorFilter
}

export default function ConnectAccountModal({
  visible,
  onCancel,
  onInitiated,
  authenticatedApi,
  filter,
}: ConnectAccountModalProps) {
  const toasts = useKumoToastManager()
  const { t } = useTranslation()
  const [connecting, setConnecting] = useState<string | null>(null)
  const [vendors, setVendors] = useState<GatekeeperVendorInfo[]>([])
  const [vendorsLoading, setVendorsLoading] = useState(true)

  // Fetch vendors when modal opens
  useEffect(() => {
    if (!visible) {
      setConnecting(null)
      return
    }

    const fetchVendors = async () => {
      setVendorsLoading(true)
      try {
        const vendorList = await authenticatedApi.listGatekeeperVendors(filter)
        const unavailable = vendorList.filter(v => v.unavailable)
        if (unavailable.length > 0) {
          toasts.add({
            title: t('gatekeepers.common.unavailable', { services: unavailable.map(v => v.id).join(', ') }),
            variant: 'warning',
          })
        }
        setVendors(vendorList.filter(v => !v.unavailable))
      } catch (error) {
        console.error('Failed to fetch vendors:', error)
        toasts.add({ title: t('gatekeepers.common.loadServicesFailed'), variant: 'error' })
      } finally {
        setVendorsLoading(false)
      }
    }

    fetchVendors()
  }, [visible, authenticatedApi, filter])

  const handleConnect = async (vendorId: string) => {
    setConnecting(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      onInitiated()
    } catch (error) {
      console.error('Failed to initiate connection:', error)
      toasts.add({
        title: connectionErrorMessage(error, t('gatekeepers.common.connectionFailed')),
        variant: 'error',
      })
      setConnecting(null)
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="p-6" size="base">
        <Dialog.Title className="text-lg font-semibold mb-4">{t('gatekeepers.connectAccount.title')}</Dialog.Title>
        {vendorsLoading ? (
          <div className="text-center py-8">
            <Loader />
          </div>
        ) : vendors.length === 0 ? (
          <div className="text-center py-8">
            <Text variant="secondary">{t('gatekeepers.connectAccount.empty')}</Text>
          </div>
        ) : (
          <div className="flex flex-col gap-3 mt-2">
            {vendors.map(vendor => {
              const configured = connectorIsConfigured(vendor.description)
              return (
                <VendorCard
                  key={vendor.id}
                  vendorId={vendor.id}
                  vendor={vendor.description}
                  onClick={() => handleConnect(vendor.id)}
                  loading={connecting === vendor.id}
                  disabled={!configured || (connecting !== null && connecting !== vendor.id)}
                  disabledMessage={configured ? undefined : connectorSetupGuidance()}
                />
              )
            })}
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
