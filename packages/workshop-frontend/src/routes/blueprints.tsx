import { createFileRoute } from '@tanstack/react-router'
import BlueprintList from '../components/BlueprintList'
import { useDocumentTitle } from '../useDocumentTitle'
import { useTranslation } from 'react-i18next'

/**
 * "Blueprints" — the user's own + saved blueprints, laid out like the Workspaces page. Discovering
 * new blueprints lives on the separate Explore page, linked from the list's toolbar (alongside
 * Upload, so the two actions line up) and from the rail's bottom nav.
 */
export const Route = createFileRoute('/blueprints')({
  component: BlueprintsRoutePage,
})

function BlueprintsRoutePage() {
  const { t } = useTranslation()
  useDocumentTitle(t('blueprints.page.title'))
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 sm:px-10">
      {/* Title only — Explore and Upload sit together in the list's toolbar so they share a width. */}
      <header className="min-w-0 px-3 pb-3 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">{t('blueprints.page.title')}</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          {t('blueprints.page.subtitle')}
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <BlueprintList />
      </div>
    </div>
  )
}
