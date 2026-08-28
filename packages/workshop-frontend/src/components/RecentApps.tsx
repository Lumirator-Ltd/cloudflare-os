import { Link } from '@tanstack/react-router'
import { Clock, ArrowRight } from '@phosphor-icons/react'
import { useAuthenticatedApi } from '../AuthContext'
import { useState, useEffect } from 'react'
import { GadgetMetadataWithTimestamps, type SupportedLanguage } from '@gadgets/workshop-shared/api'
import { useTranslation } from 'react-i18next'
import { useLanguage } from '../i18n/LanguageProvider'
import { formatRelativeTime as formatLocalizedRelativeTime } from '../i18n/format'

// A simple deterministic gradient based on the gadget ID
function getGradient(id: string): string {
  const gradients = [
    'from-[#4A154B] to-[#7C3085]',
    'from-[#0052CC] to-[#2684FF]',
    'from-[#5865F2] to-[#7983F5]',
    'from-[#34A853] to-[#4285F4]',
    'from-[#24292e] to-[#555]',
    'from-[#E01E5A] to-[#ECB22E]',
    'from-orange-600 to-red-600',
    'from-emerald-600 to-teal-600',
  ]
  const idx = id.charCodeAt(0) % gradients.length
  return gradients[idx]
}

function formatRelativeTime(date: Date, language: SupportedLanguage): string {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000)
  if (minutes < 1) {
    return formatLocalizedRelativeTime(0, 'minute', language, { numeric: 'auto' })
  }
  if (minutes < 60) {
    return formatLocalizedRelativeTime(-minutes, 'minute', language, { numeric: 'auto' })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return formatLocalizedRelativeTime(-hours, 'hour', language, { numeric: 'auto' })
  }
  const days = Math.floor(hours / 24)
  return formatLocalizedRelativeTime(-days, 'day', language, { numeric: 'auto' })
}

function AppRow({ gadget }: { gadget: GadgetMetadataWithTimestamps }) {
  const gradient = getGradient(gadget.id)
  const { effectiveLanguage } = useLanguage()
  const { t } = useTranslation()

  return (
    <Link
      to="/workspace/$id"
      params={{ id: gadget.id }}
      className="group flex items-center gap-4 p-3 rounded-xl border border-kumo-line bg-kumo-base hover:border-kumo-fill transition-all cursor-pointer"
    >
      {/* Gradient swatch */}
      <div
        className={`w-10 h-10 rounded-lg bg-gradient-to-br ${gradient} flex-shrink-0`}
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-kumo-default truncate">
          {gadget.title || t('shell.workspaces.untitled')}
        </h3>
        {gadget.owner && (
          <p className="text-xs text-kumo-subtle truncate mt-0.5">
            {t('shell.workspaces.sharedBy', { name: gadget.owner.name })}
          </p>
        )}
      </div>

      {/* Status + time */}
      <div className="flex items-center gap-3 flex-shrink-0">

        <span className="hidden md:flex items-center gap-1 text-xs text-kumo-inactive">
          <Clock size={10} />
          {formatRelativeTime(gadget.lastActive, effectiveLanguage)}
        </span>
      </div>
    </Link>
  )
}

export default function RecentApps() {
  const { authenticatedApi } = useAuthenticatedApi()
  const [gadgets, setGadgets] = useState<GadgetMetadataWithTimestamps[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const { t } = useTranslation()

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listGadgets().then((list) => {
      if (cancelled) return
      const sorted = [...list].toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
      setGadgets(sorted.slice(0, 4))
      setLoading(false)
    }).catch((err) => {
      console.error('Failed to load recent gadgets:', err)
      if (!cancelled) { setLoading(false); setLoadError(true) }
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  if (loading) {
    return (
      <section className="w-full max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-kumo-default">{t('shell.workspaces.recent')}</h2>
        </div>
        <div className="flex flex-col gap-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-[64px] rounded-xl border border-kumo-line bg-kumo-elevated animate-pulse" />
          ))}
        </div>
      </section>
    )
  }

  if (loadError) {
    return (
      <section className="w-full max-w-2xl mx-auto">
        <div className="text-center py-8 text-sm text-kumo-danger">
          {t('shell.workspaces.loadError')}
        </div>
      </section>
    )
  }

  if (gadgets.length === 0) {
    return (
      <section className="w-full max-w-2xl mx-auto">
        <div className="text-center py-8 text-kumo-inactive text-sm">
          {t('shell.workspaces.empty')}
        </div>
      </section>
    )
  }

  return (
    <section className="w-full max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-kumo-default">
          {t('shell.workspaces.recent')}
        </h2>
        <Link
          to="/"
          className="flex items-center gap-1 text-xs text-kumo-subtle hover:text-kumo-brand transition-colors"
        >
          {t('shell.workspaces.viewAll')}
          <ArrowRight size={12} />
        </Link>
      </div>

      <div className="flex flex-col gap-2">
        {gadgets.map((gadget) => (
          <AppRow key={gadget.id} gadget={gadget} />
        ))}
      </div>
    </section>
  )
}
