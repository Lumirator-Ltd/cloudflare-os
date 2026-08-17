import { useEffect, useState } from 'react'
import { Button, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { Plugs, ShieldWarning } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AdminApi,
  AdminConnectorConfiguration,
  AdminConnectorConfigurationValues,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import { useDocumentTitle } from './useDocumentTitle'

export default function AdminConnectorsPage() {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  useDocumentTitle('Connector configuration')

  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)
  const [connectors, setConnectors] = useState<AdminConnectorConfiguration[]>([])
  const [drafts, setDrafts] = useState<Record<string, AdminConnectorConfigurationValues>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [unauthorized, setUnauthorized] = useState(!isAdmin)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!isAdmin) {
      setUnauthorized(true)
      setLoading(false)
      return
    }

    setUnauthorized(false)
    setLoading(true)
    setLoadError(false)
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null
    ;(async () => {
      try {
        const api = await authenticatedApi.getAdminApi()
        if (cancelled) {
          api?.[Symbol.dispose]?.()
          return
        }
        if (!api) {
          setUnauthorized(true)
          return
        }
        stub = api
        setAdmin({ api })
        setConnectors(await api.listConnectorConfigurations())
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load connector configurations:', error)
          setLoadError(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      stub?.[Symbol.dispose]?.()
    }
  }, [authenticatedApi, isAdmin])

  const updateDraft = (connectorId: string, name: string, value: string) => {
    setDrafts((current) => ({
      ...current,
      [connectorId]: { ...current[connectorId], [name]: value },
    }))
  }

  const handleSave = async (connector: AdminConnectorConfiguration) => {
    if (!admin || !connector.writeAvailable) return
    const values = Object.fromEntries(
      connector.inputs.map((input) => [input.name, drafts[connector.id]?.[input.name] ?? '']),
    )
    setSaving(connector.id)
    try {
      await admin.api.configureConnector(connector.id, values)
      setDrafts((current) => ({ ...current, [connector.id]: {} }))
      setConnectors((current) => current.map((item) =>
        item.id === connector.id ? { ...item, configured: true } : item,
      ))
      toasts.add({ title: `${connector.displayName} credentials saved`, variant: 'success' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save connector credentials'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSaving(null)
    }
  }

  if (unauthorized) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 text-center">
        <ShieldWarning size={32} className="mx-auto text-kumo-subtle mb-3" />
        <p className="text-sm text-kumo-default">You don't have access to this page.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center gap-2 text-kumo-subtle">
        <Loader />
        <span>Loading connector configurations...</span>
      </div>
    )
  }

  if (loadError || !admin) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 py-16 text-center sm:px-8">
        <p className="text-sm text-kumo-danger">
          Something went wrong loading connector configurations.
        </p>
      </div>
    )
  }

  const readOnly = connectors.some((connector) => !connector.writeAvailable)

  return (
    <div className="mx-auto w-full max-w-[1040px] space-y-6 px-4 py-8 sm:px-8">
      <div>
        <a href="/admin" className="text-sm font-medium text-kumo-brand hover:underline">
          Back to Admin
        </a>
        <h1 className="mt-3 text-2xl font-semibold text-kumo-default">Connector credentials</h1>
        <p className="mt-1 text-sm text-kumo-subtle">
          Configure the deployment OAuth credentials used when users connect their accounts.
        </p>
      </div>

      {readOnly && (
        <div className="rounded-xl border border-kumo-line bg-kumo-elevated px-4 py-3 text-sm text-kumo-subtle">
          Connector credential management is not enabled for this deployment. Configuration is read-only.
        </div>
      )}

      {connectors.length === 0 ? (
        <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-8 text-center">
          <Plugs size={28} className="mx-auto mb-3 text-kumo-subtle" />
          <p className="text-sm text-kumo-subtle">
            No credentialed connectors are installed on this deployment.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {connectors.map((connector) => {
            const values = drafts[connector.id] ?? {}
            const complete = connector.inputs.every((input) => Boolean(values[input.name]))
            return (
              <section
                key={connector.id}
                className="rounded-xl border border-kumo-line bg-kumo-elevated p-6"
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-kumo-tint">
                    {connector.logo ? (
                      <img
                        src={connector.logo.url}
                        alt=""
                        className="h-6 w-6 object-contain"
                      />
                    ) : (
                      <span className="text-sm font-semibold text-kumo-default">
                        {connector.displayName[0]}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold text-kumo-strong">
                      {connector.displayName}
                    </h2>
                    <span
                      className={`text-xs font-medium ${
                        connector.configured ? 'text-kumo-success' : 'text-kumo-warning'
                      }`}
                    >
                      {connector.configured ? 'Configured' : 'Needs setup'}
                    </span>
                  </div>
                </div>

                <div className="mt-5">
                  <p className="text-xs font-medium text-kumo-subtle">Callback URL</p>
                  <code className="mt-1 block overflow-x-auto rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-xs text-kumo-default">
                    {connector.callbackUrl}
                  </code>
                  <p className="mt-2 text-xs text-kumo-subtle">
                    Follow the provider setup guide, register the callback URL above, then enter the credentials.{' '}
                    <a
                      href={connector.setupGuideUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-kumo-brand hover:underline"
                    >
                      View setup guide
                    </a>
                  </p>
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  {connector.inputs.map((input) => {
                    const inputId = `${connector.id}-${input.name}`
                    return (
                      <label key={input.name} htmlFor={inputId} className="block">
                        <span className="mb-1.5 block text-sm font-medium text-kumo-default">
                          {input.label}
                        </span>
                        <input
                          id={inputId}
                          name={inputId}
                          type="password"
                          autoComplete="off"
                          data-keeper-ignore="true"
                          data-1p-ignore="true"
                          data-lpignore="true"
                          data-bwignore="true"
                          data-form-type="other"
                          value={values[input.name] ?? ''}
                          disabled={!connector.writeAvailable || saving === connector.id}
                          onChange={(event) =>
                            updateDraft(connector.id, input.name, event.target.value)
                          }
                          className="h-10 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </label>
                    )
                  })}
                </div>

                {connector.writeAvailable && (
                  <div className="mt-5 flex justify-end">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={saving === connector.id}
                      disabled={!complete || saving !== null}
                      onClick={() => handleSave(connector)}
                    >
                      {connector.configured ? 'Rotate credentials' : 'Save credentials'}
                    </Button>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
