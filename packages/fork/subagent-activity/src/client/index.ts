/**
 * Subagent panel, browser half. It moves the subagent list out of the header's hover menu into a
 * right-Sidebar page:
 *
 * - `sidebar.right.pane.tab` page `subagent-activity` (guide entry 子智能体): the Session's subagents,
 *   what each is doing now (from the `subagentActivity` projection), how long, how it ended.
 * - `conversation.session.header.actions` entry `subagent-catalog` at priority -1, which shadows the
 *   upstream catalog trigger of `ui-subagent` (lowest priority renders) with a plain button that
 *   opens the page. The upstream package stays installed: its breadcrumb switcher, Sidebar chat
 *   resource, read-only composer, and `@` source are still in use.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import type {} from '../activity.ts'
import { PANEL_ID, PANEL_KIND, panelDefinition } from './definition.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type SubagentsKey } from './locales.ts'
import { SubagentPanel, type PanelInjected } from './SubagentPanel.tsx'
import { SubagentToggle, type ToggleInjected } from './SubagentToggle.tsx'

export type { PanelInjected, SubagentPanelProps } from './SubagentPanel.tsx'
export type { SubagentToggleProps, ToggleInjected } from './SubagentToggle.tsx'
export type { SubagentsKey } from './locales.ts'
export { PANEL_ID, PANEL_KIND } from './definition.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subagent panel and header toggle copy. */
    'subagent-activity': SubagentsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'subagent-activity'

/** The upstream header entry this package shadows; see `ui-subagent`'s registration. */
const CATALOG_ENTRY_ID = 'subagent-catalog'

/** Required browser services. */
export const inject = ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace']

/**
 * The Sidebar resource address of a child's conversation, as `ui-subagent` registers it
 * (`dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>`, its README's contract).
 * @param address - direct-parent subagent address.
 * @returns the resource address.
 */
export function subagentChatAddress(address: SubagentAddress): string {
  const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode })
  return `dsh-resource://subagentchat/session/${encodeURIComponent(address.childSessionId)}?${query}`
}

/**
 * Register the dictionaries, the Sidebar page, and the header toggle.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'subagent-activity: dictionaries')
  const t = ctx.locale.bind(NS)

  /** Read a catalog and its direct children, the way the upstream menu prepares a level. */
  const readLevel = async (parentId: SessionId): Promise<void> => {
    await ctx.sessions.refreshProjections(parentId)
    const parent = ctx.sessions.list.getSnapshot().projectionsBySession[parentId]
    if (parent?.state !== 'ready') return
    for (const entry of parent.values.subagentCatalog ?? []) {
      if (entry.mode === 'external') continue
      const state = ctx.sessions.list.getSnapshot()
      if (state.byId[entry.id]?.formatStatus === 'migration-required'
        || state.projectionsBySession[entry.id]?.state === 'migration-required'
        || state.projectionsBySession[entry.id]?.state === 'error') continue
      await ctx.sessions.refreshProjections(entry.id)
    }
  }
  // One object for the registration's lifetime, so the page's read effect runs only on real changes.
  const panel: PanelInjected = {
    prepare: (parentId) => {
      void readLevel(parentId).catch((error: unknown) => {
        console.error('[subagent-activity] reading the subagents of %s failed:', parentId, error)
      })
    },
    openAside: (address) => {
      ctx.sidebarRight.openResource(subagentChatAddress(address), { kind: 'subagentchat' })
    },
    openMain: (address) => {
      ctx.uiWorkspace.openSession(address)
    },
  }
  const toggle: ToggleInjected = {
    toggle: () => {
      const active = ctx.sidebarRight.active()
      if (ctx.sidebarRight.isExpanded() && active?.kind === PANEL_KIND) {
        ctx.sidebarRight.toggleExpanded()
        return
      }
      ctx.sidebarRight.openTab(PANEL_KIND)
    },
  }

  ctx.effect(() => ctx.sidebarRightTabs.register(panelDefinition(t)), 'subagent-activity: page type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: PANEL_ID, locale: NS, inject: () => panel },
    SubagentPanel,
  ))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: CATALOG_ENTRY_ID,
    // Same place as the entry it shadows: between the preset label (-10) and background tasks (20).
    order: 10,
    priority: -1,
    locale: NS,
    inject: () => toggle,
  }, SubagentToggle))
}
