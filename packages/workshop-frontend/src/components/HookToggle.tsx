import { Switch, Tooltip } from '@cloudflare/kumo'
import { useTranslation } from 'react-i18next'
import '../i18n/config'

interface HookToggleProps {
  enabled: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
  size?: 'sm' | 'base' | 'lg'
}

/** Enable/disable toggle for bound hooks. Used in the Connections tab, Activity log, and inline chat. */
export function HookToggle({ enabled, disabled = false, onToggle, size = 'sm' }: HookToggleProps) {
  const { t } = useTranslation()
  return (
    <Tooltip content={t(enabled
      ? 'workspace.activity.disableHookTooltip'
      : 'workspace.activity.enableHookTooltip')} asChild>
      <span className="inline-flex items-center">
        <Switch
          checked={enabled}
          disabled={disabled}
          size={size}
          onCheckedChange={(checked) => onToggle(checked)}
          aria-label={t(enabled
            ? 'workspace.activity.disableHook'
            : 'workspace.activity.enableHook')}
        />
      </span>
    </Tooltip>
  )
}
