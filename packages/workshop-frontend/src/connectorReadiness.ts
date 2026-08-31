import {
  CONNECTOR_NOT_CONFIGURED_MESSAGE,
  connectorIsConfigured,
} from '@gadgets/workshop-shared/gatekeeper'
import i18n from './i18n/config'

export const CONNECTOR_SETUP_GUIDANCE =
  'Ask an administrator to configure this connector.'

export function connectorSetupGuidance(): string {
  return i18n.t('adminConnectors.setupRequired')
}

export { connectorIsConfigured }

export function connectionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message === CONNECTOR_NOT_CONFIGURED_MESSAGE) {
    return connectorSetupGuidance()
  }
  return fallback
}
