// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const messages: Record<string, string> = {
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'gatekeepers.accountChooser.connectVendor': 'Connect Example',
  'gatekeepers.connectorModal.capabilities': 'What this gatekeeper can do',
  'gatekeepers.connectorModal.continueVendor': 'Continue to Example',
  'gatekeepers.connectorModal.ownerOnlyDescription':
    'This account can only be used in a private workspace owned by you. After adding it, this workspace remains private even if you remove the connection.',
  'gatekeepers.connectorModal.securityDescription':
    'Each Gadget only sees the resources you connect. If the workspace is shared, Gatekeeper verifies other users have the required permissions before they can access those resources.',
  'gatekeepers.connectorModal.securityTitle': 'Gatekeeper sits between Example and your Gadgets.',
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => messages[key] ?? key }),
}))

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render: renderClose }: { render: (props: object) => ReactNode }) => (
        <>{renderClose({})}</>
      ),
    },
  )
  return {
    Dialog,
    Switch: () => <button type="button">Toggle</button>,
  }
})

vi.mock('./WorkshopControls', () => ({
  WorkshopButton: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  WorkshopIconButton: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('@phosphor-icons/react', () => ({
  ShieldCheck: () => <span />,
  X: () => <span />,
}))

import ConnectConnectorModal from './ConnectConnectorModal'

const normalResource: SupportedResource = {
  urlPattern: 'https://example.com/public/*',
  title: 'Example resource',
  description: 'An example resource',
}

const ownerOnlyResource: SupportedResource = {
  ...normalResource,
  urlPattern: 'https://example.com/private/*',
  title: 'Private account',
  workspaceAccess: 'owner-only',
}

async function render(resource: SupportedResource) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ConnectConnectorModal
        open
        mode="connect"
        vendorDescription={{ displayName: 'Example', url: 'https://example.com' }}
        supportedResources={[resource]}
        onOpenChange={() => undefined}
      />,
    )
  })
  return { container, root }
}

describe('ConnectConnectorModal owner-only policy', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  it('replaces shared-user verification copy for an owner-only resource', async () => {
    ({ root, container } = await render(ownerOnlyResource))

    expect(container.textContent).toContain(messages['gatekeepers.connectorModal.ownerOnlyDescription'])
    expect(container.textContent).not.toContain(messages['gatekeepers.connectorModal.securityDescription'])
  })

  it('preserves shared-user verification copy for a normal resource', async () => {
    ({ root, container } = await render(normalResource))

    expect(container.textContent).toContain(messages['gatekeepers.connectorModal.securityDescription'])
    expect(container.textContent).not.toContain(messages['gatekeepers.connectorModal.ownerOnlyDescription'])
  })
})
