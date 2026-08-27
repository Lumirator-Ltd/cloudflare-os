import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

function formatRemaining(ms: number, t: (key: string, values?: Record<string, number>) => string): string {
  if (ms <= 0) return t('billing.reset.zero')
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return t('billing.reset.daysHours', { days, hours })
  if (hours > 0) return t('billing.reset.hoursMinutesSeconds', { hours, minutes, seconds })
  if (minutes > 0) return t('billing.reset.minutesSeconds', { minutes, seconds })
  return t('billing.reset.seconds', { seconds })
}

/**
 * Live-ticking countdown to a reset time (ISO timestamp). Updates once per second. Calls
 * `onElapsed` once when the countdown reaches zero (e.g. to refresh usage). Renders nothing if no
 * valid `resetAt` is provided.
 */
export default function ResetCountdown({
  resetAt,
  onElapsed,
}: {
  resetAt?: string
  onElapsed?: () => void
}) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  // Keep the latest onElapsed in a ref so the "elapsed" effect can fire it without depending on a
  // (possibly unstable) callback identity, which would otherwise re-run the effect every render.
  const onElapsedRef = useRef(onElapsed)
  onElapsedRef.current = onElapsed

  const target = resetAt ? new Date(resetAt).getTime() : NaN
  const valid = Number.isFinite(target)

  useEffect(() => {
    if (!valid) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [valid, resetAt])

  const remaining = valid ? target - now : 0
  const elapsed = valid && remaining <= 0

  useEffect(() => {
    if (elapsed) onElapsedRef.current?.()
  }, [elapsed])

  if (!valid) return null

  return <span className="tabular-nums font-medium">{formatRemaining(remaining, t)}</span>
}
