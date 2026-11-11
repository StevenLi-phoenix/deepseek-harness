// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PANEL_ID, PANEL_KIND, apply, inject, subagentChatAddress, type PanelInjected, type ToggleInjected } from '../src/client/index.ts'
import { GuideArtworkSubagents } from '../src/client/definition.tsx'
import { zh } from '../src/client/locales.ts'

const id = (value: string) => value as SessionId
const PARENT = id('session-parent')

interface Registration {
  readonly options: { name: string; key?: string; id?: string; order?: number; priority?: number; locale: string; inject: () => unknown }
}

/** A client context with only what the entry touches; `snapshot` is the Session list it reads. */
function fakeContext(snapshot: { byId: Record<string, unknown>; projectionsBySession: Record<string, unknown> }) {
  const registered: Registration[] = []
  const dictionaries: Record<string, unknown> = {}
  const tabs: unknown[] = []
  const sidebar = {
    expanded: true,
    activeKind: 'other' as string | undefined,
    openResource: vi.fn(),
    openTab: vi.fn(),
    toggleExpanded: vi.fn(),
  }
  const ctx = {
    effect: (run: () => unknown) => run(),
    locale: {
      register: (namespace: string, value: unknown) => { dictionaries[namespace] = value; return () => {} },
      bind: () => makeTranslate(zh),
    },
    sessions: {
      refreshProjections: vi.fn(async (_id: SessionId) => {}),
      list: { getSnapshot: () => snapshot },
    },
    sidebarRight: {
      openResource: sidebar.openResource,
      openTab: sidebar.openTab,
      toggleExpanded: sidebar.toggleExpanded,
      isExpanded: () => sidebar.expanded,
      active: () => (sidebar.activeKind === undefined ? undefined : { kind: sidebar.activeKind }),
    },
    sidebarRightTabs: { register: (definition: unknown) => { tabs.push(definition); return () => {} } },
    uiWorkspace: { openSession: vi.fn() },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: Registration['options']) => { registered.push({ options }); return () => {} },
    },
  }
  return { ctx, registered, dictionaries, tabs, sidebar }
}

/** The page's and the header's injected actions. */
function faces(registered: Registration[]) {
  const panel = registered.find(entry => entry.options.name === 'sidebar.right.pane.tab')?.options.inject() as PanelInjected
  const header = registered.find(entry => entry.options.name === 'conversation.session.header.actions')?.options.inject() as ToggleInjected
  return { panel, header }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('fork-subagents browser entry', () => {
  it('needs the slots, locale, Sessions, the right Sidebar, and the workspace', () => {
    expect(inject).toEqual(['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace'])
  })

  it('registers eight dictionaries, the page type with its guide entry, the page body, and the header entry over the upstream one', () => {
    const { ctx, registered, dictionaries, tabs } = fakeContext({ byId: {}, projectionsBySession: {} })
    apply(ctx as never)
    expect(Object.keys(dictionaries['fork.subagents'] as object).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    type Label = () => string
    type Guide = { order: number; title: Label; description: Label }
    const [definition] = tabs as Array<{ id: string; kind: string; title: Label; guide: Guide[] }>
    expect(definition).toMatchObject({ id: PANEL_ID, kind: PANEL_KIND })
    expect(definition?.title()).toBe('子智能体')
    expect(definition?.guide.map(entry => [entry.order, entry.title(), entry.description()])).toEqual([[40, '子智能体', '这个会话派出的子智能体在做什么']])
    expect(registered.map(({ options }) => [options.name, options.key ?? options.id, options.order, options.priority])).toEqual([
      ['sidebar.right.pane.tab', PANEL_ID, undefined, undefined],
      ['conversation.session.header.actions', 'subagent-catalog', 10, -1],
    ])
  })

  it('draws the guide artwork at the guide size or its own', () => {
    const { container, rerender } = render(<GuideArtworkSubagents />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('36')
    rerender(<GuideArtworkSubagents size={20} className="x" />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('20')
  })

  it('reads a level: the parent, then each direct child it can read, skipping external, unmigrated, and failed ones', async () => {
    const catalog = [
      { id: id('ok'), mode: 'continuable' },
      { id: id('ext'), mode: 'external' },
      { id: id('old-format'), mode: 'oneshot' },
      { id: id('old-store'), mode: 'oneshot' },
      { id: id('broken'), mode: 'oneshot' },
    ]
    const { ctx, registered } = fakeContext({
      byId: { 'old-format': { formatStatus: 'migration-required' } },
      projectionsBySession: {
        [PARENT]: { state: 'ready', values: { subagentCatalog: catalog } },
        'old-store': { state: 'migration-required', values: {} },
        broken: { state: 'error', values: {} },
      },
    })
    apply(ctx as never)
    faces(registered).panel.prepare(PARENT)
    await vi.waitFor(() => { expect(ctx.sessions.refreshProjections).toHaveBeenCalledTimes(2) })
    expect(ctx.sessions.refreshProjections.mock.calls.map(([sessionId]) => sessionId)).toEqual([PARENT, 'ok'])
  })

  it('stops at a parent whose read did not succeed or holds no catalog, and logs a failed read', async () => {
    const snapshot = { byId: {}, projectionsBySession: { [PARENT]: { state: 'error', values: {} } } as Record<string, unknown> }
    const { ctx, registered } = fakeContext(snapshot)
    apply(ctx as never)
    const { panel } = faces(registered)
    panel.prepare(PARENT)
    await vi.waitFor(() => { expect(ctx.sessions.refreshProjections).toHaveBeenCalledTimes(1) })
    snapshot.projectionsBySession[PARENT] = { state: 'ready', values: {} }
    panel.prepare(PARENT)
    await vi.waitFor(() => { expect(ctx.sessions.refreshProjections).toHaveBeenCalledTimes(2) })

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    ctx.sessions.refreshProjections.mockRejectedValueOnce(new Error('offline'))
    panel.prepare(PARENT)
    await vi.waitFor(() => { expect(error).toHaveBeenCalledWith('[fork-subagents] reading the subagents of %s failed:', PARENT, expect.any(Error)) })
  })

  it('opens a child aside at the ui-subagent address, or in the main view', () => {
    const { ctx, registered, sidebar } = fakeContext({ byId: {}, projectionsBySession: {} })
    apply(ctx as never)
    const address = { parentSessionId: PARENT, childSessionId: id('child one'), mode: 'continuable' } as const
    faces(registered).panel.openAside(address)
    expect(sidebar.openResource).toHaveBeenCalledWith(subagentChatAddress(address), { kind: 'subagentchat' })
    expect(subagentChatAddress(address)).toBe('dsh-resource://subagentchat/session/child%20one?parent=session-parent&mode=continuable')
    faces(registered).panel.openMain(address)
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledWith(address)
  })

  it('shows the page from the header, and hides the Sidebar when the page is already in front', () => {
    const { ctx, registered, sidebar } = fakeContext({ byId: {}, projectionsBySession: {} })
    apply(ctx as never)
    const { header } = faces(registered)
    header.toggle(PARENT)
    expect(sidebar.openTab).toHaveBeenCalledWith(PANEL_KIND)
    sidebar.activeKind = PANEL_KIND
    header.toggle(PARENT)
    expect(sidebar.toggleExpanded).toHaveBeenCalledTimes(1)
    sidebar.expanded = false
    header.toggle(PARENT)
    expect(sidebar.openTab).toHaveBeenCalledTimes(2)
    sidebar.activeKind = undefined
    sidebar.expanded = true
    header.toggle(PARENT)
    expect(sidebar.openTab).toHaveBeenCalledTimes(3)
  })
})
