import { Text, Loader } from '@cloudflare/kumo'
import { LinkSimple } from '@phosphor-icons/react'
import { VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import Avatar from './components/Avatar'

export interface VendorCardProps {
  vendorId: string
  vendor: VendorDescription
  onClick: () => void
  loading?: boolean
  disabled?: boolean
  disabledMessage?: string
}

export default function VendorCard({
  vendorId,
  vendor,
  onClick,
  loading = false,
  disabled = false,
  disabledMessage,
}: VendorCardProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onClick()
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      data-vendor-id={vendorId}
      onClick={disabled ? undefined : onClick}
      onKeyDown={handleKeyDown}
      className={`flex items-center gap-4 p-4 border border-kumo-line rounded-lg transition-all ${
        disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:border-kumo-brand hover:bg-kumo-tint'
      } ${disabled && !loading ? 'opacity-60' : ''}`}
    >
      <Avatar
        src={vendor.logo?.url}
        background={vendor.color}
        size={48}
        fallback={<LinkSimple size={22} />}
      />
      <div className="flex-1">
        <Text variant="body" bold as="span" DANGEROUS_className="block text-base">
          {vendor.displayName}
        </Text>
        {disabledMessage ? (
          <Text variant="secondary" size="xs" as="span">
            {disabledMessage}
          </Text>
        ) : vendor.url ? (
          <Text variant="secondary" size="xs" as="span">
            {vendor.url}
          </Text>
        ) : null}
      </div>
      {loading && <Loader size="sm" />}
    </div>
  )
}
