import { createFileRoute } from '@tanstack/react-router'
import { BookOpen, Sparkle, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import { useDocumentTitle } from '../useDocumentTitle'
import ComingSoonPreview from '../components/ComingSoonPreview'
import { useSiteName } from '../ServerConfigContext'
import { useTranslation } from 'react-i18next'

/**
 * Context & Skills. The knowledge/skills surface isn't built into the rail yet — agents read
 * curated collections of documents (context) and reusable skills. Until then this page shows a
 * frosted design mock so the nav entry has a stable, on-language target.
 */
export const Route = createFileRoute('/context')({
  component: ContextPage,
})

type Kind = 'collection' | 'skill'

interface ContextItem {
  id: string
  name: string
  kind: Kind
  detail: string
  updated: string
}

const TYPE_META: Record<Kind, { labelKey: string; Icon: PhosphorIcon }> = {
  collection: { labelKey: 'context.collection', Icon: BookOpen },
  skill: { labelKey: 'context.skill', Icon: Sparkle },
}

const MOCK_ITEMS: ContextItem[] = [
  { id: '1', name: 'context.companyHandbook', kind: 'collection', detail: 'context.documents|12', updated: 'context.daysAgo|2' },
  { id: '2', name: 'context.brandVoice', kind: 'collection', detail: 'context.documents|5', updated: 'context.weeksAgo|1' },
  { id: '3', name: 'context.apiReference', kind: 'collection', detail: 'context.documents|28', updated: 'context.weeksAgo|1' },
  { id: '4', name: 'context.summarizeMeetings', kind: 'skill', detail: 'context.reusableSkill', updated: 'context.daysAgo|3' },
  { id: '5', name: 'context.salesPlaybook', kind: 'collection', detail: 'context.documents|9', updated: 'context.weeksAgo|2' },
  { id: '6', name: 'context.draftEmail', kind: 'skill', detail: 'context.reusableSkill', updated: 'context.weeksAgo|2' },
]

function ContextRow({ item }: { item: ContextItem }) {
  const { t } = useTranslation()
  const { labelKey, Icon } = TYPE_META[item.kind]
  const localized = (value: string) => {
    const [key, count] = value.split('|')
    return t(key, count ? { count: Number(count) } : undefined)
  }
  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">{localized(item.name)}</p>
        <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
          {t(labelKey)} · {localized(item.detail)}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs tracking-[-0.1px] text-kumo-inactive lg:block">
        {localized(item.updated)}
      </span>
    </div>
  )
}

function ContextPage() {
  const { t } = useTranslation()
  useDocumentTitle(t('context.title'))
  const siteName = useSiteName()
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 sm:px-10">
      <header className="px-3 pb-4 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">{t('context.title')}</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          {t('context.subtitle')}
        </p>
      </header>

      <ComingSoonPreview
        icon={BookOpen}
        title={t('context.comingSoon', { siteName })}
        description={t('context.preview')}
      >
        <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
          <div className="flex flex-col gap-0.5">
            {MOCK_ITEMS.map((item) => (
              <ContextRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      </ComingSoonPreview>
    </div>
  )
}
