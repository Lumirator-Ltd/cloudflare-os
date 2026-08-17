import {
  CONNECTOR_NOT_CONFIGURED_MESSAGE,
  connectorIsConfigured,
} from '@gadgets/workshop-shared/gatekeeper'

export { CONNECTOR_NOT_CONFIGURED_MESSAGE, connectorIsConfigured }

export function connectionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message === CONNECTOR_NOT_CONFIGURED_MESSAGE) {
    return CONNECTOR_NOT_CONFIGURED_MESSAGE
  }
  return fallback
}
