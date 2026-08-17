import type { VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

export const CONNECTOR_NOT_CONFIGURED_MESSAGE =
  'Ask an administrator to configure this connector.'

export function connectorIsConfigured(description: VendorDescription): boolean {
  return description.configuration?.configured !== false
}

export function connectionErrorMessage(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    error.message.includes('This connector is not configured.')
  ) {
    return CONNECTOR_NOT_CONFIGURED_MESSAGE
  }
  return fallback
}
