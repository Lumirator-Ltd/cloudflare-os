import { logRpcFailure } from '../rpcErrors'
import { useState, useEffect, type ReactNode } from 'react'
import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useRpcStub, useConnectionLost } from '../RpcContext'
import { markConnectionRestored } from '../main'
import { useAuth, CF_ACCESS_MODE } from '../useAuth'
import { AuthProvider } from '../AuthContext'
import { FeatureFlagsProvider } from '../FeatureFlagsContext'
import Header from '../components/Header'
import AppShell from '../components/AppShell/AppShell'
import LoginPage from '../LoginPage'
import OnboardingWizard from '../OnboardingWizard'
import AccountSelectionModal from '../components/billing/AccountSelectionModal'
import { LanguageProvider } from '../i18n/LanguageProvider'
import AnnouncementBanner from '../components/AnnouncementBanner'
import { useTranslation } from 'react-i18next'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  const rpcStub = useRpcStub()
  const connectionLost = useConnectionLost()
  const { isAuthenticated, authenticatedApi, isLoading, error, logout, login } = useAuth(rpcStub)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const withLanguage = (children: ReactNode) => (
    <LanguageProvider authenticatedApi={authenticatedApi}>
      <AnnouncementBanner />
      {children}
    </LanguageProvider>
  )

  // When authenticatedApi becomes available, the connection is proven alive.
  useEffect(() => {
    if (authenticatedApi) markConnectionRestored()
  }, [authenticatedApi])

  // Routes that don't require auth (public routes)
  const isSignup = pathname === '/signup'
  const isBlueprint = pathname.startsWith('/blueprint/')

  // A standalone (no app shell) render is used only for signed-out visitors of public routes.
  // Signed-in users get the full app chrome so public pages (esp. the blueprint detail) feel
  // native — sidebar and all — instead of floating on a bare page.
  const standalone = isSignup || (isBlueprint && !isAuthenticated)

  // The workspace editor renders fullscreen (no app chrome). /gadget/ is the legacy URL, kept
  // here so the chrome doesn't flash in during the redirect to /workspace/.
  const isWorkspaceEditor = pathname.startsWith('/workspace/') || pathname.startsWith('/gadget/')

  const handleLoginSuccess = () => {
    const token = localStorage.getItem('authToken')
    if (token) {
      login(token)
    }
  }

  // Loading state
  if (isLoading && !standalone) {
    return withLanguage(
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
        <BootStatus kind={connectionLost ? 'waiting' : 'loading'} />
      </div>,
    )
  }

  // Auth error
  if (error && !standalone) {
    return withLanguage(
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base p-6">
        <BootStatus kind="error" error={error} />
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 text-sm font-medium text-kumo-inverse bg-kumo-brand rounded-lg hover:bg-kumo-brand-hover transition-colors"
        >
          <BootStatus kind="retry" />
        </button>
      </div>,
    )
  }

  // CF Access mode: show spinner while pipelined auth resolves
  if (!isAuthenticated && CF_ACCESS_MODE && !standalone) {
    return withLanguage(
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
        <BootStatus kind="authenticating" />
      </div>,
    )
  }

  // Not authenticated and not a public route — show login
  if (!isAuthenticated && !standalone) {
    return withLanguage(<LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />)
  }

  // Signed-out visitors of public routes render without the auth wrapper / app shell.
  if (standalone) {
    const showHeader = !isSignup
    return withLanguage(
      <TooltipProvider>
        <Toasty>
          {showHeader && <Header />}
          <Outlet />
        </Toasty>
      </TooltipProvider>,
    )
  }

  // Authenticated — render the full shell (with onboarding gate)
  // authenticatedApi is guaranteed non-null here: isLoading, error, and
  // !isAuthenticated branches all return early above.
  if (!authenticatedApi) return withLanguage(null)
  return withLanguage(
    <AuthProvider authenticatedApi={authenticatedApi} onLogout={logout}>
      <FeatureFlagsProvider>
        <TooltipProvider>
          <Toasty>
            <AuthenticatedShell
              authenticatedApi={authenticatedApi}
              isWorkspaceEditor={isWorkspaceEditor}
            />
          </Toasty>
        </TooltipProvider>
      </FeatureFlagsProvider>
    </AuthProvider>,
  )
}

function BootStatus({
  kind,
  error,
}: {
  kind: 'waiting' | 'loading' | 'error' | 'retry' | 'authenticating'
  error?: string
}) {
  const { t } = useTranslation()
  const message = {
    waiting: t('shell.status.waitingForServer'),
    loading: t('shell.status.loading'),
    error: t('shell.status.authenticationError', { error }),
    retry: t('shell.status.retry'),
    authenticating: t('shell.status.authenticating'),
  }[kind]
  const className = kind === 'error'
    ? 'text-sm text-kumo-danger'
    : kind === 'retry' ? undefined : 'text-sm text-kumo-subtle'
  return <span className={className}>{message}</span>
}

/**
 * Inner shell that checks onboarding status and either shows the wizard
 * or the normal app chrome. Lives inside AuthProvider so the wizard can
 * use useAuthenticatedApi().
 */
function AuthenticatedShell({
  authenticatedApi,
  isWorkspaceEditor,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  isWorkspaceEditor: boolean
}) {
  // null = still checking, true = needs onboarding, false = onboarding done
  const [onboardingNeeded, setOnboardingNeeded] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.isOnboardingCompleted().then((completed) => {
      if (!cancelled) setOnboardingNeeded(!completed)
    }).catch((err) => {
      logRpcFailure('Failed to check onboarding status:', err)
      // If the check fails, skip onboarding to avoid blocking the user
      if (!cancelled) setOnboardingNeeded(false)
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  // Still checking onboarding status
  if (onboardingNeeded === null) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // Show onboarding wizard
  if (onboardingNeeded) {
    return <OnboardingWizard onComplete={() => setOnboardingNeeded(false)} />
  }

  // Normal app shell. The workspace editor is rendered fullscreen (no chrome); everything else
  // gets the persistent left-rail AppShell. Connection loss is surfaced by a chip in whichever of
  // those two top bars is showing, never by a banner that reflows the page (see ReconnectingChip).
  const fullscreen = isWorkspaceEditor
  return (
    <>
      <AccountSelectionModal />
      {fullscreen ? (
        <main>
          <Outlet />
        </main>
      ) : (
        <AppShell>
          <Outlet />
        </AppShell>
      )}
    </>
  )
}
