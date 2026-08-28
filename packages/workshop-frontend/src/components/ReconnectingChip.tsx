/**
 * "Reconnecting…" pill for a fixed-height chrome strip (the workspace editor's top bar, the app
 * shell's top bar). Deliberately an inline chip rather than a full-width banner: a banner inserted
 * above the page reflows everything below it, so a blip that recovers on its own visibly jolts the
 * layout twice.
 */
import { useTranslation } from 'react-i18next'

export default function ReconnectingChip() {
  const { t } = useTranslation()
  return (
    <span
      role="status"
      className="text-xs text-kumo-warning px-2 py-0.5 rounded-full bg-kumo-warning-tint border border-kumo-warning/20"
    >
      {t('shell.status.reconnecting')}
    </span>
  )
}
