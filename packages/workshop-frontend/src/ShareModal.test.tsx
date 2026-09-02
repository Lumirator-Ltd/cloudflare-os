// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  CollaboratorInfo,
  CollaboratorRole,
  GadgetMetadata,
  ObserverBindingNeed,
  Overseer,
  ShareLinkInfo,
} from '@gadgets/workshop-shared/api'
import i18n from './i18n/config'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) =>
        render({ 'aria-label': 'Close' }),
    },
  )
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" data-testid="role-option" onClick={onClick}>{children}</button>
      ),
    },
  )
  return {
    Checkbox: ({ label }: { label: ReactNode }) => <label>{label}</label>,
    Dialog,
    DropdownMenu,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./components/PersonAvatar', () => ({
  PersonAvatar: () => <span data-testid="avatar" />,
}))

const copyToClipboard = vi.fn<(text: string) => Promise<boolean>>(async () => true)
vi.mock('./clipboard', () => ({ copyToClipboard: (text: string) => copyToClipboard(text) }))

import ShareModal from './ShareModal'

const METADATA = { id: 'trip-planner', title: 'Trip planner' } as GadgetMetadata
const WORKSPACE_URL = `${window.location.origin}/workspace/trip-planner`

const CURRENT_USER: AiChatAuthorInfo = { type: 'user', id: 'dan@example.com', name: 'Dan' }

const DOC_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: 7,
  vendorId: 'google',
  resourceTitle: 'Q3 planning',
  resourceUrl: 'https://docs.google.com/document/d/quarterly',
}

const CRM_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: 8,
  vendorId: 'salesforce',
  resourceTitle: 'Pipeline dashboard',
}

const SHARE_LINK: ShareLinkInfo = {
  linkId: 'link-1',
  note: 'Team link',
  created: new Date('2026-08-01T00:00:00Z'),
  createdBy: CURRENT_USER,
  role: 'use',
}

type OverseerOverrides = {
  collaborators?: CollaboratorInfo[]
  requirements?: Partial<Record<CollaboratorRole, ObserverBindingNeed[]>>
  listObserverRequirements?: (role: CollaboratorRole) => Promise<ObserverBindingNeed[]>
  addCollaborator?: (
    accountKey: string,
    role: CollaboratorRole,
    sharer?: string,
  ) => Promise<CollaboratorInfo | null>
  shareLinks?: ShareLinkInfo[]
  updateShareLink?: (linkId: string, note?: string) => Promise<void>
}

function fakeOverseer(overrides: OverseerOverrides = {}): RpcStub<Overseer> {
  const requirements = overrides.requirements ?? { use: [], build: [] }
  return {
    listCollaborators: async () => overrides.collaborators ?? [],
    listShareLinks: async () => overrides.shareLinks ?? [],
    listObserverRequirements:
      overrides.listObserverRequirements ??
      (async (role: CollaboratorRole) => requirements[role] ?? []),
    addCollaborator: overrides.addCollaborator ?? (async () => ({
      profile: { type: 'user', id: 'ada@example.com', name: 'Ada' },
      role: 'use',
      addedBy: [],
    })),
    createShareLink: async () => ({ key: 'secret', linkId: 'link-1' }),
    updateShareLink: overrides.updateShareLink ?? (async () => {}),
  } as unknown as RpcStub<Overseer>
}

const fakeAuthenticatedApi = {} as RpcStub<AuthenticatedApi>

function click(element: Element) {
  return act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function button(rendered: HTMLElement, label: string): HTMLButtonElement {
  const found = [...rendered.querySelectorAll('button')].find(candidate =>
    candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!found) throw new Error(`No button labelled “${label}”`)
  return found
}

function roleOption(rendered: HTMLElement, label: string): HTMLButtonElement {
  const found = [...rendered.querySelectorAll<HTMLButtonElement>('[data-testid="role-option"]')]
    .find(candidate => candidate.textContent?.startsWith(label))
  if (!found) throw new Error(`No role option for “${label}”`)
  return found
}

function verificationSection(rendered: HTMLElement, headingId: string): HTMLElement {
  const section = rendered.querySelector(`#${headingId}`)?.closest('section')
  if (!section) throw new Error(`No verification section with heading “${headingId}”`)
  return section
}

async function enterAccountKey(rendered: HTMLElement, accountKey: string) {
  const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Username or email"]')
  expect(input).not.toBeNull()
  if (!input) return null
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, accountKey)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

async function invite(rendered: HTMLElement, accountKey: string) {
  await enterAccountKey(rendered, accountKey)
  await click(button(rendered, 'Invite'))
}

describe('ShareModal', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    copyToClipboard.mockClear()
  })

  afterEach(async () => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    await i18n.changeLanguage('en')
  })

  async function render(overseer: RpcStub<Overseer>) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ShareModal
          open
          onClose={() => {}}
          overseer={overseer}
          metadata={METADATA}
          currentUser={CURRENT_USER}
          authenticatedApi={fakeAuthenticatedApi}
        />,
      )
    })
    // Let the load effects settle.
    await act(async () => { await Promise.resolve() })
    return container
  }

  it.each(['Ada_User', 'ada@example.com'])(
    'accepts the account key %s and sends it unchanged for direct discovery',
    async (accountKey) => {
      const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
        async () => null,
      )
      const rendered = await render(fakeOverseer({ addCollaborator }))

      await invite(rendered, accountKey)

      expect(addCollaborator).toHaveBeenCalledExactlyOnceWith(accountKey, 'use', undefined)
    },
  )

  it('localizes the username-or-email account key input in Japanese', async () => {
    await i18n.changeLanguage('ja')
    const rendered = await render(fakeOverseer())

    expect(rendered.querySelector('input[aria-label="ユーザー名またはメールアドレス"]')).not.toBeNull()
  })

  it('does not submit a direct invite while an IME composition is active', async () => {
    const addCollaborator = vi.fn<NonNullable<OverseerOverrides['addCollaborator']>>(
      async () => null,
    )
    const rendered = await render(fakeOverseer({ addCollaborator }))
    const input = await enterAccountKey(rendered, 'あだ')
    if (!input) return

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        isComposing: true,
        key: 'Enter',
      }))
    })

    expect(addCollaborator).not.toHaveBeenCalled()
  })

  it('does not present account keys as secondary profile text', async () => {
    const rendered = await render(fakeOverseer())

    expect(rendered.textContent).toContain('Dan')
    expect(rendered.textContent).not.toContain(CURRENT_USER.id)
  })

  it('does not render a direct sharer account key', async () => {
    const sharerAccountKey = 'sharer@example.com'
    const rendered = await render(fakeOverseer({
      collaborators: [{
        profile: { type: 'user', id: 'ada@example.com', name: 'Ada' },
        role: 'use',
        addedBy: [{
          type: 'user',
          sharer: sharerAccountKey,
          created: new Date('2026-08-01T00:00:00Z'),
          role: 'use',
        }],
      }],
    }))

    expect(rendered.textContent).toContain('Added directly')
    expect(rendered.textContent).not.toContain(sharerAccountKey)
  })

  it('reveals the workspace link to send after a direct invite', async () => {
    const rendered = await render(fakeOverseer())
    expect(rendered.textContent).not.toContain(WORKSPACE_URL)

    await invite(rendered, 'ada')

    expect(rendered.textContent).toContain('Added Ada')
    expect(rendered.textContent).toContain(WORKSPACE_URL)
  })

  it('copies the plain workspace link, never a share-link secret', async () => {
    const rendered = await render(fakeOverseer())
    await invite(rendered, 'ada')

    await click(button(rendered, 'Copy link'))

    expect(copyToClipboard).toHaveBeenCalledWith(WORKSPACE_URL)
    expect(rendered.textContent).toContain('Link copied')
  })

  it('names the connections a recipient must verify for the selected role', async () => {
    const rendered = await render(fakeOverseer({
      requirements: { use: [DOC_REQUIREMENT], build: [DOC_REQUIREMENT, CRM_REQUIREMENT] },
    }))

    // The invite composer defaults to "App only".
    expect(rendered.textContent).toContain('Q3 planning')
    expect(rendered.textContent).not.toContain('Pipeline dashboard')

    await click(roleOption(rendered, 'Workspace'))

    expect(rendered.textContent).toContain('Pipeline dashboard')
  })

  it('keeps invite and share-link requirements tied to their own role pickers', async () => {
    const rendered = await render(fakeOverseer({
      requirements: { use: [DOC_REQUIREMENT], build: [DOC_REQUIREMENT, CRM_REQUIREMENT] },
    }))

    await click(button(rendered, 'Create a share link'))
    expect(rendered.querySelector('#recipient-verification-heading')).not.toBeNull()
    expect(rendered.querySelector('#invite-verification-heading')).toBeNull()
    expect(rendered.querySelector('#link-verification-heading')).toBeNull()

    const buildOptions = [...rendered.querySelectorAll<HTMLButtonElement>('[data-testid="role-option"]')]
      .filter(option => option.textContent?.startsWith('Workspace'))
    expect(buildOptions).toHaveLength(2)
    await click(buildOptions[1])

    expect(verificationSection(rendered, 'invite-verification-heading').textContent)
      .not.toContain('Pipeline dashboard')
    expect(verificationSection(rendered, 'link-verification-heading').textContent)
      .toContain('Pipeline dashboard')

    await click(button(rendered, 'Create link'))
    expect(verificationSection(rendered, 'link-verification-heading').textContent)
      .toContain('Pipeline dashboard')
  })

  it('hides verification messaging when recipients have nothing to verify', async () => {
    const rendered = await render(fakeOverseer())

    expect(rendered.querySelector('#recipient-verification-heading')).toBeNull()
    expect(rendered.textContent).not.toContain('verify any connections')
  })

  it('degrades quietly when the requirements lookup fails', async () => {
    const rendered = await render(fakeOverseer({
      listObserverRequirements: async () => { throw new Error('offline') },
    }))

    expect(rendered.textContent).toContain('Couldn’t check')
    // The rest of the modal still works.
    expect(rendered.textContent).toContain('People with access')
  })

  it('refreshes requirements when the modal regains focus', async () => {
    const listObserverRequirements = vi.fn<
      (role: CollaboratorRole) => Promise<ObserverBindingNeed[]>
    >(async () => [])
    await render(fakeOverseer({ listObserverRequirements }))
    expect(listObserverRequirements).toHaveBeenCalledTimes(2)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })

    expect(listObserverRequirements).toHaveBeenCalledTimes(4)
  })

  it('does not rename a share link when its name did not change', async () => {
    const updateShareLink = vi.fn<(linkId: string, note?: string) => Promise<void>>(async () => {})
    const rendered = await render(fakeOverseer({ shareLinks: [SHARE_LINK], updateShareLink }))

    await click(button(rendered, 'Rename Team link'))
    expect(rendered.querySelector<HTMLInputElement>('input[aria-label="Share link name"]')?.value)
      .toBe('Team link')
    await click(button(rendered, 'Save'))

    expect(updateShareLink).not.toHaveBeenCalled()
    expect(rendered.querySelector('input[aria-label="Share link name"]')).toBeNull()
  })
})
