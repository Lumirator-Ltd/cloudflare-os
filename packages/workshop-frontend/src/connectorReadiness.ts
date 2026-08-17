import {
  CONNECTOR_NOT_CONFIGURED_MESSAGE,
  connectorIsConfigured,
} from '@gadgets/workshop-shared/gatekeeper'

export const CONNECTOR_SETUP_GUIDANCE =
  'Ask an administrator to configure this connector.'

export { connectorIsConfigured }

export function connectionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message === CONNECTOR_NOT_CONFIGURED_MESSAGE) {
    return CONNECTOR_SETUP_GUIDANCE
  }
  return fallback
}
