/**
 * Console, browser half: three Settings sections over this package's Host routes, registered into `settings.section` like the
 * upstream pages so they follow the settings shell's lifetime, and the message flow, a page of its own in the sidebar. "Service
 * overview" (服务总览, order 35) comes before "System status"; "Subscriptions and monitors" (订阅与监控, order 58) and "Claude Code
 * and voice" (order 60) come after the other fork pages.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  AGENTS_ROUTE, FLOW_ROUTE, OVERVIEW_ROUTE, SUBSCRIPTIONS_ROUTE,
  type AgentsAction, type AgentsView, type FlowActivityView, type SubscriptionAction, type SubscriptionsView,
} from '../views.ts'
import { AgentsSection, type AgentsInjected, type PreviewOutcome } from './Agents.tsx'
import { readBalance } from './balance.ts'
import { FlowPage, type FlowInjected } from './Flow.tsx'
import { FlowPanelIcon } from './FlowPanelIcon.tsx'
import { OverviewSection, type OverviewInjected } from './Overview.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'
import { parseAgents, parseFlowActivity, parseOverview, parseSubscriptions } from './parse.ts'
import { ResourceLoader, createResourceStore, failureOf, requestJson } from './resource.ts'
import { optimisticPatch, requestKey } from './subs.ts'
import { SubscriptionsSection, type SubscriptionsInjected } from './Subscriptions.tsx'

export type { AgentsInjected, AgentsProps } from './Agents.tsx'
export type { FlowInjected, FlowProps } from './Flow.tsx'
export type { OverviewInjected, OverviewProps } from './Overview.tsx'
export type { SubscriptionsInjected, SubscriptionsProps } from './Subscriptions.tsx'
export type { ConsoleKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'fork.console'

/** Settings navigation positions: the overview before System status (40), the others after Bilibili (45) and the QQ and WeChat pages. */
const OVERVIEW_ORDER = 35
const SUBSCRIPTIONS_ORDER = 58
const AGENTS_ORDER = 60

/** The message flow's page and its place in the sidebar, after Plugins (0) and Automations (10). */
const FLOW_PANEL = 'fork-flow' as MainPanelId
const FLOW_ORDER = 20

/** What this page uses of the settings shell, when it is mounted. */
interface SettingsNavigation { openSection(id: string): void }

/** Longest wait for a preview: the voice model may load first. */
const PREVIEW_TIMEOUT_MS = 180_000

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries and the three Settings sections.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'fork-console: dictionaries')
  const t = ctx.locale.bind(NS)

  const overviewStore = createResourceStore<ReturnType<typeof parseOverview>>()
  const balanceStore = createResourceStore<Awaited<ReturnType<typeof readBalance>>>()
  const subscriptionsStore = createResourceStore<ReturnType<typeof parseSubscriptions>>()
  const agentsStore = createResourceStore<AgentsView>()
  // Document-relative routes, so a served mount keeps working; the sign-in cookie rides along.
  const overview = new ResourceLoader('overview', overviewStore, () => requestJson<unknown>(OVERVIEW_ROUTE).then(parseOverview))
  const balance = new ResourceLoader('balance', balanceStore, readBalance)
  const subscriptions = new ResourceLoader('subscriptions', subscriptionsStore, () => requestJson<unknown>(SUBSCRIPTIONS_ROUTE).then(parseSubscriptions))
  const agents = new ResourceLoader('agents', agentsStore, () => requestJson<unknown>(AGENTS_ROUTE).then(parseAgents))

  const hasSection = (id: string): boolean => ctx.slots.entries('settings.section').some(entry => entry.options.id === id)

  // Stable functions for the registration's lifetime, so a section's polling effect never restarts on re-render.
  const refreshOverview = (): void => { void overview.refresh(); void balance.refresh() }
  const overviewInjected = (): OverviewInjected => ({
    hooks: { overview: overviewStore, balance: balanceStore },
    refresh: refreshOverview,
    canManage: hasSection,
  })

  const refreshSubscriptions = (): void => { void subscriptions.refresh() }
  const actSubscriptions = (request: SubscriptionAction): Promise<boolean> => {
    const patch = optimisticPatch(request)
    const send = (): Promise<SubscriptionsView> => requestJson<unknown>(SUBSCRIPTIONS_ROUTE, { body: request }).then(parseSubscriptions)
    return subscriptions.act(requestKey(request), send, patch)
  }
  const subscriptionsInjected = (): SubscriptionsInjected => ({
    hooks: { subscriptions: subscriptionsStore },
    refresh: refreshSubscriptions,
    act: actSubscriptions,
    dismiss: () => { subscriptions.dismiss() },
  })

  let audio: HTMLAudioElement | undefined
  let audioUrl: string | undefined
  const stopPreview = (): void => {
    audio?.pause()
    if (audioUrl !== undefined) URL.revokeObjectURL(audioUrl)
    audio = undefined
    audioUrl = undefined
  }
  const preview = async (onPlaying: () => void): Promise<PreviewOutcome> => {
    stopPreview()
    const started = Date.now()
    let response: Response
    try {
      response = await fetch(AGENTS_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'voice.preview' } satisfies AgentsAction),
        signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      })
    } catch {
      console.warn(`[fork-console] voice.preview network (${Date.now() - started} ms)`)
      return { ok: false, code: 'network' }
    }
    if (!response.ok) {
      const failure = await failureOf(response)
      console.warn(`[fork-console] voice.preview ${failure.code} (${Date.now() - started} ms)`)
      return { ok: false, code: failure.code, detail: failure.detail }
    }
    const url = URL.createObjectURL(await response.blob())
    const player = new Audio(url)
    audio = player
    audioUrl = url
    console.info(`[fork-console] voice.preview ready (${Date.now() - started} ms)`)
    return await new Promise<PreviewOutcome>((resolve) => {
      const finish = (outcome: PreviewOutcome): void => { if (audio === player) stopPreview(); resolve(outcome) }
      player.addEventListener('ended', () => { finish({ ok: true }) })
      player.addEventListener('error', () => { finish({ ok: false, code: 'speech_failed', detail: 'playback' }) })
      player.play().then(onPlaying, () => { finish({ ok: false, code: 'speech_failed', detail: 'playback' }) })
    })
  }
  const refreshAgents = (): void => { void agents.refresh() }
  const actAgents = (request: AgentsAction): Promise<boolean> => agents.act(
    request.action === 'voice.preview' ? 'voice.preview' : `${request.action}:${request.name}`,
    () => requestJson<unknown>(AGENTS_ROUTE, { body: request }).then(parseAgents),
  )
  const agentsInjected = (): AgentsInjected => ({
    hooks: { agents: agentsStore }, refresh: refreshAgents, act: actAgents, dismiss: () => { agents.dismiss() }, preview, stopPreview,
  })
  ctx.effect(() => stopPreview, 'fork-console: stop the preview')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'fork-overview', order: OVERVIEW_ORDER, label: () => t('nav.overview'), locale: NS, inject: overviewInjected,
  }, OverviewSection))
  // The picture reads the overview's cards, so it shares the overview's store and Manage check; the balance route stays the overview's.
  const flowStore = createResourceStore<FlowActivityView>()
  const flow = new ResourceLoader('flow', flowStore, () => requestJson<unknown>(FLOW_ROUTE).then(parseFlowActivity))
  const refreshFlow = (): void => { void overview.refresh(); void flow.refresh() }
  const openSettings = (section: string): void => {
    ;(ctx.get as (name: string) => SettingsNavigation | undefined)('settingsNavigation')?.openSection(section)
  }
  const flowInjected = (): FlowInjected => ({
    hooks: { overview: overviewStore, activity: flowStore }, refresh: refreshFlow, canManage: hasSection, openSettings,
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: FLOW_PANEL, locale: NS, inject: flowInjected,
  }, FlowPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: FLOW_PANEL, order: FLOW_ORDER, label: () => t('nav.flow'), locale: NS,
  }, FlowPanelIcon))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'fork-subscriptions', order: SUBSCRIPTIONS_ORDER, label: () => t('nav.subscriptions'), locale: NS, inject: subscriptionsInjected,
  }, SubscriptionsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'fork-agents', order: AGENTS_ORDER, label: () => t('nav.agents'), locale: NS, inject: agentsInjected,
  }, AgentsSection))
}
