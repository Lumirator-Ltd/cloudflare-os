import { logRpcFailure } from './rpcErrors'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from './AuthContext'
import {
  AiChatAuthorInfo,
  AiGatewayInfo,
} from '@gadgets/workshop-shared/api'
import {
  CONNECTOR_NOT_CONFIGURED_MESSAGE,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'
import {
  Camera,
  ArrowRight,
  Check,
  Plus,
  PlugsConnected,
  Sparkle,
  UsersThree,
  Key,
  Plugs,
  Hexagon,
} from '@phosphor-icons/react'
import AddModelModal from './AddModelModal'
import { persistSelectedModel } from './modelSelection'
import { logoComponents } from './components/ConnectionLogos'
import { getVendorIconBackground } from './components/vendorColors'
import { compressAvatar, avatarBlobUrl } from './avatarUtils'
import { invalidateAvatarCache } from './useAvatar'
import { useTheme } from './ThemeContext'
import { useSiteName } from './ServerConfigContext'
import SiteLogo from './components/SiteLogo'
import { useDocumentTitle } from './useDocumentTitle'
import { connectorIsConfigured } from './connectorReadiness'
import { AccountsSubscriberAdapter } from './accountsSubscriber'
import { useTranslation } from 'react-i18next'

// ─── constants ──────────────────────────────────────────────────────────────────

const TOTAL_STEPS_WITH_CONNECTIONS = 4

// Maps RPC vendor IDs to logo keys in our logoComponents map
const VENDOR_LOGO_MAP: Record<string, string> = {
  slack: 'slack',
  discord: 'discord',
  jira: 'jira',
  google: 'google',
  github: 'github',
  notion: 'notion',
  linear: 'linear',
  figma: 'figma',
}

interface VendorEntry {
  id: string
  description: VendorDescription
  logoKey: string
}

export function OnboardingConnectorButton({
  vendorId,
  description,
  resolvedThemeMode,
  connected,
  connecting,
  onConnect,
}: {
  vendorId: string
  description: VendorDescription
  resolvedThemeMode: 'light' | 'dark'
  connected: boolean
  connecting: boolean
  onConnect: () => void
}) {
  const Logo = logoComponents[VENDOR_LOGO_MAP[vendorId] ?? vendorId.toLowerCase()]
  const configured = connectorIsConfigured(description)
  const disabled = connected || connecting || !configured
  const { t } = useTranslation()

  return (
    <button
      onClick={onConnect}
      disabled={disabled}
      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-all duration-150 ${
        connected
          ? 'border-kumo-brand/40 bg-kumo-brand/5 cursor-default'
          : connecting
            ? 'border-kumo-line bg-kumo-tint cursor-wait'
            : !configured
              ? 'border-kumo-line bg-kumo-tint cursor-not-allowed opacity-60'
              : 'border-kumo-line hover:border-kumo-fill hover:bg-kumo-tint cursor-pointer'
      }`}
    >
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: getVendorIconBackground(vendorId, resolvedThemeMode) }}
      >
        {Logo ? (
          <Logo size={16} />
        ) : (
          <span className="text-xs font-bold text-kumo-strong">
            {description.displayName[0]}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-kumo-default truncate">
          {description.displayName}
        </p>
        <p className="text-xs text-kumo-subtle">
          {connected
            ? t('shell.onboarding.connected')
            : connecting
              ? t('shell.onboarding.connecting')
              : configured
                ? t('shell.onboarding.notConnected')
                : t('shell.onboarding.connectorSetup')}
        </p>
      </div>
      {connected && (
        <PlugsConnected
          size={14}
          className="text-kumo-brand flex-shrink-0"
          weight="bold"
        />
      )}
      {connecting && (
        <div className="w-3.5 h-3.5 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
      )}
    </button>
  )
}

// ─── component ──────────────────────────────────────────────────────────────────

export default function OnboardingWizard({
  onComplete,
}: {
  onComplete: () => void
}) {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const { resolvedThemeMode } = useTheme()
  const toasts = useKumoToastManager()
  const siteName = useSiteName()
  const { t } = useTranslation()
  useDocumentTitle(t('shell.pageTitle.setup'))

  // Wizard state
  const [step, setStep] = useState(0) // 0 = avatar, 1 = model, 2 = connections
  const [mounted, setMounted] = useState(false)
  const [finishing, setFinishing] = useState(false)

  // Profile state
  const [displayName, setDisplayName] = useState('')
  const [originalDisplayName, setOriginalDisplayName] = useState('')
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarData, setAvatarData] = useState<Uint8Array | null>(null)
  const [avatarProcessing, setAvatarProcessing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Model state
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [aiConfig, setAiConfig] = useState<AiGatewayInfo | null>(null)
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(true)

  // Connections state
  const [vendors, setVendors] = useState<VendorEntry[]>([])
  const [connectedVendorIds, setConnectedVendorIds] = useState<Set<string>>(new Set())
  const [vendorsLoading, setVendorsLoading] = useState(true)
  const [connectingVendorId, setConnectingVendorId] = useState<string | null>(null)

  // Entrance animation
  useEffect(() => {
    requestAnimationFrame(() => setMounted(true))
  }, [])

  // Revoke avatar blob URL on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      if (avatarPreview) URL.revokeObjectURL(avatarPreview)
    }
  }, [avatarPreview])

  // Populate display name from currentUser (fetched once in AuthContext)
  useEffect(() => {
    if (currentUser) {
      setDisplayName(currentUser.name)
      setOriginalDisplayName(currentUser.name)
    }
  }, [currentUser])

  // Load models + AI config
  const fetchModels = useCallback(async () => {
    try {
      const [modelList, cfg] = await Promise.all([
        authenticatedApi.listModels(),
        authenticatedApi.getAiConfig(),
      ])
      setModels(modelList)
      setAiConfig(cfg)
      // Default to the first model in the list
      if (modelList.length > 0) {
        setSelectedModelId((prev) => prev ?? modelList[0].id)
      }
    } catch (err) {
      console.error('Failed to load models:', err)
    } finally {
      setModelsLoading(false)
    }
  }, [authenticatedApi])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // Load vendors and subscribe to connected accounts.
  // We use a url→vendorId lookup map (built from listGatekeeperVendors) so the
  // subscriber can resolve vendor IDs reliably instead of guessing from display names.
  useEffect(() => {
    let cancelled = false
    const connectedUrls = new Set<string>()
    const accountIdToUrl = new Map<number, string>()

    // Lookup populated by listGatekeeperVendors, used by the subscriber.
    const urlToVendorId = new Map<string, string>()
    // Pending accounts that arrived before the vendor list loaded.
    const pendingUrls: string[] = []

    const refreshConnectedIds = () => {
      const ids = new Set<string>()
      for (const url of connectedUrls) {
        const vid = urlToVendorId.get(url)
        if (vid) ids.add(vid)
      }
      if (!cancelled) setConnectedVendorIds(ids)
    }

    authenticatedApi
      .listGatekeeperVendors()
      .then((vendorList) => {
        if (cancelled) return
        for (const v of vendorList) {
          urlToVendorId.set(v.description.url, v.id)
        }
        setVendors(
          vendorList.map((v) => ({
            id: v.id,
            description: v.description,
            logoKey: VENDOR_LOGO_MAP[v.id] ?? v.id.toLowerCase(),
          })),
        )
        // Resolve any accounts that arrived before the vendor list.
        if (pendingUrls.length > 0) refreshConnectedIds()
      })
      .catch((err) => {
        console.error('Failed to load vendors:', err)
      })
      .finally(() => {
        if (!cancelled) setVendorsLoading(false)
      })

    const subscriber = new AccountsSubscriberAdapter({
      add({ id, vendor }) {
        if (cancelled) return
        const url = vendor.url
        accountIdToUrl.set(id, url)
        connectedUrls.add(url)
        if (urlToVendorId.size > 0) {
          refreshConnectedIds()
        } else {
          pendingUrls.push(url)
        }
      },
      remove(id) {
        const url = accountIdToUrl.get(id)
        if (url) {
          accountIdToUrl.delete(id)
          const stillHas = Array.from(accountIdToUrl.values()).includes(url)
          if (!stillHas) connectedUrls.delete(url)
          refreshConnectedIds()
        }
      },
    })

    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subscription.catch((err) => {
      if (cancelled) return
      logRpcFailure('Failed to subscribe to connected accounts:', err)
    })

    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  // ── avatar handlers ───────────────────────────────────────────────────────────

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toasts.add({ title: t('shell.onboarding.imageRequired'), variant: 'error' })
      return
    }
    setAvatarProcessing(true)
    try {
      const compressed = await compressAvatar(file)
      setAvatarData(compressed)
      // The cleanup effect on avatarPreview handles revoking the previous URL.
      setAvatarPreview(avatarBlobUrl(compressed))
    } catch (err) {
      console.error('Failed to process avatar:', err)
      toasts.add({ title: t('shell.onboarding.imageProcessingError'), variant: 'error' })
    } finally {
      setAvatarProcessing(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }

  // ── connection handlers ───────────────────────────────────────────────────────

  const handleConnect = async (vendorId: string) => {
    setConnectingVendorId(vendorId)
    try {
      const { url } = await authenticatedApi.connectAccount(vendorId)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      console.error('Failed to start connection:', err)
      toasts.add({
        title: err instanceof Error && err.message === CONNECTOR_NOT_CONFIGURED_MESSAGE
          ? t('shell.onboarding.connectorSetup')
          : t('shell.onboarding.connectionStartError'),
        variant: 'error',
      })
    } finally {
      // Reset after a short delay — the subscription will update the UI when the connection completes
      setTimeout(() => setConnectingVendorId(null), 2000)
    }
  }

  // ── navigation ────────────────────────────────────────────────────────────────

  const showConnectionsStep = vendorsLoading || vendors.length > 0
  const totalSteps = showConnectionsStep
    ? TOTAL_STEPS_WITH_CONNECTIONS
    : TOTAL_STEPS_WITH_CONNECTIONS - 1
  const showcaseStep = totalSteps - 1

  useEffect(() => {
    setStep((currentStep) => Math.min(currentStep, showcaseStep))
  }, [showcaseStep])

  const goNext = () => setStep((s) => Math.min(s + 1, totalSteps - 1))
  const goBack = () => setStep((s) => Math.max(s - 1, 0))

  const handleFinish = async () => {
    setFinishing(true)
    try {
      // Save display name if changed
      const trimmedName = displayName.trim()
      if (trimmedName && trimmedName !== originalDisplayName) {
        await authenticatedApi.setOwnDisplayName(trimmedName)
      }
      if (avatarData) {
        await authenticatedApi.setAvatar(avatarData)
        if (currentUser?.id) invalidateAvatarCache(currentUser.id)
      }
      // selectedModelId is null when the user chose "No agent" or didn't pick one
      await authenticatedApi.setPreferredModel(selectedModelId)
      persistSelectedModel(selectedModelId)
      await authenticatedApi.completeOnboarding()
      onComplete()
    } catch (err) {
      console.error('Failed to complete onboarding:', err)
      toasts.add({ title: t('shell.onboarding.completionError'), variant: 'error' })
      setFinishing(false)
    }
  }

  // ── derived ───────────────────────────────────────────────────────────────────

  const sortedVendors = [...vendors].toSorted((a, b) => {
    // Connected ones first
    const aConnected = connectedVendorIds.has(a.id)
    const bConnected = connectedVendorIds.has(b.id)
    if (aConnected !== bConnected) return aConnected ? -1 : 1
    return a.description.displayName.localeCompare(b.description.displayName)
  })

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <>
    <div className="fixed inset-0 bg-kumo-base dotted-bg flex items-center justify-center overflow-y-auto py-8">
      {/* Soft radial glow at the top for depth */}
      <div
        className="absolute inset-x-0 top-0 h-[50vh] pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 60% 60% at 50% 0%, color-mix(in srgb, var(--color-kumo-brand) 8%, transparent) 0%, transparent 70%)',
        }}
      />

      <div
        className={`relative w-full max-w-lg mx-4 transition-all duration-500 ease-out ${
          mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        }`}
      >
        {/* Gadgets brand */}
        <div
          className={`flex items-center justify-center gap-2 mb-10 transition-all duration-500 ${
            mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
          }`}
        >
          <SiteLogo size={22}>
            <Hexagon size={22} className="text-kumo-brand" weight="bold" />
          </SiteLogo>
          <span className="text-base font-semibold tracking-tight text-kumo-default">
            {siteName}
          </span>
        </div>

        {/* Header */}
        <div className="text-center mb-8">
          <h1
            className={`text-3xl font-semibold text-kumo-default tracking-tight transition-all duration-500 delay-100 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
            }`}
          >
            {t('shell.onboarding.title')}
          </h1>
          <p
            className={`mt-2 text-sm text-kumo-subtle transition-all duration-500 delay-200 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
            }`}
          >
            {t('shell.onboarding.subtitle')}
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all duration-400 ${
                i === step
                  ? 'w-8 bg-kumo-brand'
                  : i < step
                    ? 'w-4 bg-kumo-brand/40'
                    : 'w-4 bg-kumo-line'
              }`}
            />
          ))}
        </div>

        {/* Step content — sliding panel */}
        <div className="overflow-hidden rounded-2xl border border-kumo-line bg-kumo-elevated shadow-xl shadow-black/[0.04]">
          <div
            className="flex transition-transform duration-400 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
            style={{ transform: `translateX(-${step * 100}%)` }}
          >
            {/* ── Step 0: Profile ───────────────────────────────────────────── */}
            <div className="w-full flex-shrink-0 p-8 min-h-[420px]">
              <h2 className="text-lg font-medium text-kumo-default mb-1">
                {t('shell.onboarding.profileTitle')}
              </h2>
              <p className="text-sm text-kumo-subtle mb-12">
                {t('shell.onboarding.profileDescription')}
              </p>

              {/* Avatar + Display name side by side */}
              <div className="flex items-start gap-5">
                {/* Avatar */}
                <div className="flex flex-col items-center flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    onDrop={handleDrop}
                    onDragOver={(e) => e.preventDefault()}
                    className={`
                      relative w-20 h-20 rounded-full border-2 border-dashed
                      transition-all duration-200 group cursor-pointer
                      ${avatarPreview
                        ? 'border-kumo-brand/50 hover:border-kumo-brand'
                        : 'border-kumo-line hover:border-kumo-subtle hover:bg-kumo-tint'
                      }
                      ${avatarProcessing ? 'opacity-50 pointer-events-none' : ''}
                    `}
                  >
                    {avatarPreview ? (
                      <>
                        <img
                          src={avatarPreview}
                          alt={t('shell.onboarding.avatarPreview')}
                          className="w-full h-full rounded-full object-cover"
                        />
                        <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <Camera size={18} className="text-white" />
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full">
                        <Camera size={22} className="text-kumo-inactive group-hover:text-kumo-subtle transition-colors" />
                      </div>
                    )}
                    {avatarProcessing && (
                      <div className="absolute inset-0 rounded-full bg-kumo-elevated/80 flex items-center justify-center">
                        <div className="w-5 h-5 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </button>

                  {/* Hidden file inputs */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleFileSelect(file)
                      e.target.value = ''
                    }}
                  />
                  <p className="text-xs text-kumo-inactive mt-1.5">
                    {avatarPreview ? t('shell.onboarding.changePhoto') : t('shell.onboarding.addPhoto')}
                  </p>
                </div>

                {/* Name + camera shortcut */}
                <div className="flex-1 min-w-0 pt-1">
                  <label
                    htmlFor="onboarding-display-name"
                    className="block text-xs font-medium text-kumo-subtle mb-1.5"
                  >
                    {t('shell.onboarding.displayName')}
                  </label>
                  <input
                    id="onboarding-display-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={t('shell.onboarding.displayNamePlaceholder')}
                    className="w-full px-3 py-2.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:border-kumo-brand transition-colors"
                  />
                </div>
              </div>
            </div>

            {/* ── Step 1: Model selection ───────────────────────────────────── */}
            <div className="w-full flex-shrink-0 p-8 min-h-[420px]">
              <div>
                <h2 className="text-lg font-medium text-kumo-default mb-1">
                  {t('shell.onboarding.modelTitle')}
                </h2>
                <p className="text-sm text-kumo-subtle mb-6">
                  {t('shell.onboarding.modelDescription')}
                </p>

                {modelsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="w-6 h-6 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <>
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {models.map((model) => (
                        <button
                          key={model.id}
                          onClick={() => setSelectedModelId(model.id)}
                          className={`
                            w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left
                            transition-all duration-150
                            ${selectedModelId === model.id
                              ? 'border-kumo-brand bg-kumo-brand/5 ring-1 ring-kumo-brand/20'
                              : 'border-kumo-line hover:border-kumo-fill hover:bg-kumo-tint'
                            }
                          `}
                        >
                          <div
                            className={`
                              w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold
                              transition-colors duration-150
                              ${selectedModelId === model.id
                                ? 'bg-kumo-brand text-kumo-inverse'
                                : 'bg-kumo-tint text-kumo-subtle'
                              }
                            `}
                          >
                            {model.name[0]?.toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-kumo-default truncate">
                              {model.name}
                            </p>
                            <p className="text-xs text-kumo-subtle truncate">
                              {model.id}
                            </p>
                          </div>
                          {selectedModelId === model.id && (
                            <Check
                              size={18}
                              weight="bold"
                              className="text-kumo-brand flex-shrink-0"
                            />
                          )}
                        </button>
                      ))}

                      {models.length === 0 && (
                        <div className="text-center py-8">
                          <p className="text-sm text-kumo-subtle mb-1">
                            {t('shell.onboarding.noModels')}
                          </p>
                          <p className="text-xs text-kumo-inactive">
                            {t('shell.onboarding.addModelGuidance')}
                          </p>
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() => setAddModelOpen(true)}
                      className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-kumo-subtle border border-dashed border-kumo-line rounded-xl hover:border-kumo-fill hover:text-kumo-default hover:bg-kumo-tint transition-colors"
                    >
                      <Plus size={14} weight="bold" />
                      {t('shell.onboarding.addModel')}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* ── Step 2: Connections ───────────────────────────────────────── */}
            <div className={`w-full flex-shrink-0 p-8 min-h-[420px] ${showConnectionsStep ? '' : 'hidden'}`}>
              <div>
                <h2 className="text-lg font-medium text-kumo-default mb-1">
                  {t('shell.onboarding.connectionsTitle')}
                </h2>
                <p className="text-sm text-kumo-subtle mb-6">
                  {t('shell.onboarding.connectionsDescription')}
                </p>

                {vendorsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="w-6 h-6 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : vendors.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-sm text-kumo-subtle">
                      {t('shell.onboarding.noServices')}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
                    {sortedVendors.map((vendor) => (
                      <OnboardingConnectorButton
                        key={vendor.id}
                        vendorId={vendor.id}
                        description={vendor.description}
                        resolvedThemeMode={resolvedThemeMode}
                        connected={connectedVendorIds.has(vendor.id)}
                        connecting={connectingVendorId === vendor.id}
                        onConnect={() => handleConnect(vendor.id)}
                      />
                    ))}
                  </div>
                )}

                <p className="text-xs text-kumo-inactive mt-4 text-center">
                  {t('shell.onboarding.connectionsOptional')}
                </p>
              </div>
            </div>

            {/* ── Final step: What you can do ────────────────────────────────── */}
            <div className="w-full flex-shrink-0 p-8 min-h-[420px]">
              <ShowcaseStep active={step === showcaseStep} siteName={siteName} />
            </div>
          </div>

          {/* Fixed footer — stays put across all steps */}
          <div className="flex items-center justify-between gap-3 px-8 py-5 border-t border-kumo-line bg-kumo-elevated">
            {/* Back button (hidden on first step) */}
            {step > 0 ? (
              <button
                onClick={goBack}
                className="text-sm text-kumo-subtle hover:text-kumo-default transition-colors"
              >
                {t('shell.onboarding.back')}
              </button>
            ) : (
              <span />
            )}

            <div className="flex items-center gap-3">
              {/* Primary action */}
              {step < totalSteps - 1 ? (
                <button
                  onClick={goNext}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg transition-all duration-150 text-kumo-inverse bg-kumo-brand hover:bg-kumo-brand-hover"
                >
                  {t('shell.onboarding.next')}
                  <ArrowRight size={14} weight="bold" />
                </button>
              ) : (
                <button
                  onClick={handleFinish}
                  disabled={finishing}
                  className={`
                    flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg
                    transition-all duration-150
                    ${!finishing
                      ? 'text-kumo-inverse bg-kumo-brand hover:bg-kumo-brand-hover'
                      : 'text-kumo-inactive bg-kumo-tint cursor-not-allowed'
                    }
                  `}
                >
                  {finishing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-kumo-inverse/30 border-t-kumo-inverse rounded-full animate-spin" />
                      {t('shell.onboarding.settingUp')}
                    </>
                  ) : (
                    <>
                      {t('shell.onboarding.letsBuild')}
                      <ArrowRight size={14} weight="bold" />
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

    </div>

    {/* Add Model Modal — outside the wizard's inner content so it's not
        clipped by overflow-hidden on the sliding panel */}
    <AddModelModal
      visible={addModelOpen}
      onCancel={() => setAddModelOpen(false)}
      onSuccess={() => {
        setAddModelOpen(false)
        fetchModels()
      }}
      authenticatedApi={authenticatedApi}
      aiConfig={aiConfig}
    />
    </>
  )
}

// ─── showcase step ──────────────────────────────────────────────────────────────

interface ShowcaseFeature {
  icon: typeof Sparkle
  iconColor: string
  iconBg: string
  translationKey: string
}

const SHOWCASE_FEATURES: ShowcaseFeature[] = [
  {
    icon: Sparkle,
    iconColor: 'text-media-100',
    iconBg: 'bg-media-200',
    translationKey: 'build',
  },
  {
    icon: UsersThree,
    iconColor: 'text-compute-100',
    iconBg: 'bg-compute-200',
    translationKey: 'collaborate',
  },
  {
    icon: Key,
    iconColor: 'text-kumo-warning',
    iconBg: 'bg-kumo-warning-tint',
    translationKey: 'models',
  },
  {
    icon: Plugs,
    iconColor: 'text-storage-100',
    iconBg: 'bg-storage-200',
    translationKey: 'tools',
  },
]

function ShowcaseStep({ active, siteName }: { active: boolean; siteName: string }) {
  const { t } = useTranslation()
  // Mount-trigger for staggered fade-in when the step becomes visible
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (active) {
      // Small delay so the slide transition starts before the stagger
      const t = setTimeout(() => setRevealed(true), 150)
      return () => clearTimeout(t)
    }
  }, [active])

  return (
    <div>
      <div className="text-center mb-6">
        <h2 className="text-lg font-medium text-kumo-default mb-1">
          {t('shell.onboarding.showcaseTitle')}
        </h2>
        <p className="text-sm text-kumo-subtle">
          {t('shell.onboarding.showcaseDescription', { siteName })}
        </p>
      </div>

      <div className="space-y-2.5">
        {SHOWCASE_FEATURES.map((feature, i) => {
          const Icon = feature.icon
          return (
            <div
              key={feature.translationKey}
              className={`
                flex items-start gap-3 p-3.5 rounded-xl border border-kumo-line bg-kumo-base
                transition-all ease-out
                ${revealed
                  ? 'opacity-100 translate-x-0'
                  : 'opacity-0 -translate-x-3'
                }
              `}
              style={{
                transitionDuration: '500ms',
                transitionDelay: revealed ? `${i * 90}ms` : '0ms',
              }}
            >
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${feature.iconBg}`}
              >
                <Icon size={18} className={feature.iconColor} weight="fill" />
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <p className="text-sm font-medium text-kumo-default">
                  {t(`shell.onboarding.showcase.${feature.translationKey}.title`)}
                </p>
                <p className="text-xs text-kumo-subtle mt-0.5 leading-relaxed">
                  {t(`shell.onboarding.showcase.${feature.translationKey}.description`)}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
