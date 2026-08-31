import { Component, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { reportIssue } from './error-reporting'

function ErrorFallback() {
  const { t } = useTranslation()
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-semibold">{t('app.fatalTitle')}</h1>
      <button className="rounded-md border px-3 py-2" onClick={() => location.reload()}>
        {t('app.reload')}
      </button>
    </main>
  )
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false }

  static getDerivedStateFromError() { return { crashed: true } }

  componentDidCatch(error: Error) {
    reportIssue('context.react-render', error, {
      handled: false, severity: 'fatal', captureMechanism: 'react',
    })
  }

  render() {
    if (!this.state.crashed) return this.props.children
    return <ErrorFallback />
  }
}
