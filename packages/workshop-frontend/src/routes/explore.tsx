import { createFileRoute } from '@tanstack/react-router'
import BlueprintsPage from '../BlueprintsPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { useTranslation } from 'react-i18next'

export const Route = createFileRoute('/explore')({
  component: ExplorePage,
})

function ExplorePage() {
  const { t } = useTranslation()
  useDocumentTitle(t('shell.pageTitle.explore'))

  return <BlueprintsPage />
}
