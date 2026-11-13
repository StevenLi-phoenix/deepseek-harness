/**
 * What a box says about itself: the tone of its service's overview card, its name, and its one-line job. Pure lookups over the
 * overview's cards and the dictionary, so the box, the detail card, and the lists of neighbours read the same words.
 */

import type { FlowActivityView, FlowRecentItem, FlowRoute, FlowWindow, ServiceCard } from '../views.ts'
import { statusText } from './cards.ts'
import { ago, clock, type Translate } from './format.ts'
import type { FlowGraph, FlowNode, Wiring } from './flow-model.ts'

/** The overview's cards by service id. */
export type Cards = ReadonlyMap<string, ServiceCard>

/**
 * The name of a box: its own title, else the dictionary's.
 * @param node - the box.
 * @param t - the translator.
 * @returns the name.
 */
export function titleOf(node: FlowNode, t: Translate): string {
  return node.title ?? t(`flow.node.${node.id}` as never)
}

/**
 * What a box does, in a sentence. A box with a title of its own has none.
 * @param node - the box.
 * @param t - the translator.
 * @returns the sentence, or undefined.
 */
export function noteOf(node: FlowNode, t: Translate): string | undefined {
  return node.title === undefined ? t(`flow.node.${node.id}.desc` as never) : undefined
}

/**
 * How far the running service matches a box.
 * @param node - the box.
 * @returns its wiring; a box that says nothing is `live`.
 */
export function wiringOf(node: FlowNode): Wiring {
  return node.wired ?? 'live'
}

/**
 * How a box stands: `bad` is broken, `warn` works with a problem, `hit` gets nothing because something it needs is broken, `idle`
 * saw nothing in the window, `planned` is not built, `plain` is fine.
 */
export type BoxState = 'bad' | 'warn' | 'hit' | 'idle' | 'planned' | 'plain'

/** What a box says about now: how it stands and one short fact. */
export interface BoxFact {
  readonly state: BoxState
  readonly text: string
  /** Events or batches in the window; 0 for a box the bus knows nothing about. */
  readonly count: number
  /** Latest passage in the window, or null. */
  readonly lastAt: number | null
}

/** What the facts are read from. */
export interface FactSources {
  readonly cards: Cards
  readonly activity: FlowActivityView | null
  readonly span: FlowWindow
  readonly now: number
  readonly t: Translate
}

/** Today's clock, or how long ago for anything older. */
const whenText = (at: number, { now, t }: FactSources): string =>
  new Date(at).toDateString() === new Date(now).toDateString() ? clock(at) : ago(at, now, t)

/**
 * The route a box stands for.
 * @param node - the box.
 * @param routes - every route.
 * @returns the route of a box that shows one, or undefined.
 */
export function routeOfBox(node: FlowNode, routes: readonly FlowRoute[]): FlowRoute | undefined {
  const ids = node.tracks?.subscriptions
  return ids === undefined ? undefined : routes.find(route => ids.includes(route.id))
}

/**
 * The one line a box shows: what is wrong when something is, otherwise what passed through it. A healthy box says what it did,
 * never that it is healthy.
 * @param node - the box.
 * @param sources - cards, activity, and the chosen span.
 * @returns how the box stands and the line.
 */
export function factOf(node: FlowNode, sources: FactSources): BoxFact {
  const { cards, activity, span, t } = sources
  if (wiringOf(node) === 'planned') return { state: 'planned', text: t('flow.fact.planned'), count: 0, lastAt: null }
  const route = routeOfBox(node, activity?.routes ?? [])
  if (route?.removed === true) return { state: 'idle', text: t('flow.fact.removed'), count: 0, lastAt: null }
  if (route?.paused === true) return { state: 'idle', text: t('flow.fact.paused'), count: 0, lastAt: null }
  const own = node.service === undefined || node.service === 'dsh' ? undefined : cards.get(node.service)
  if (own?.tone === 'down') return { state: 'bad', text: statusText(own, t), count: 0, lastAt: null }
  const need = node.needs === undefined ? undefined : cards.get(node.needs)
  if (need?.tone === 'down') {
    return { state: 'hit', text: t('flow.fact.hit', { name: t(`card.${need.id}.title`) }), count: 0, lastAt: null }
  }
  if (own?.tone === 'warn') return { state: 'warn', text: statusText(own, t), count: 0, lastAt: null }
  const window = activity?.windows[span]
  if (node.id === 'wechatOut') {
    const sent = window?.funnel.sent ?? 0
    return { state: 'plain', text: t('flow.fact.toYou', { count: sent }), count: sent, lastAt: null }
  }
  if (node.id === 'dnd' && activity?.presence != null) {
    return { state: 'plain', text: t(activity.presence.asleep ? 'flow.fact.asleep' : 'flow.fact.awake'), count: 0, lastAt: null }
  }
  if (node.id === 'deferQ' && activity?.presence != null && activity.presence.deferred > 0) {
    const count = activity.presence.deferred
    return { state: 'plain', text: t('flow.fact.holding', { count }), count, lastAt: null }
  }
  if (node.tracks === undefined || window === undefined) return { state: 'plain', text: '', count: 0, lastAt: null }
  const subs = (node.tracks.subscriptions ?? []).flatMap((id) => {
    const row = window.subscriptions[id]
    return row === undefined ? [] : [row]
  })
  const told = subs.reduce((sum, row) => sum + row.sent, 0)
  const batches = subs.reduce((sum, row) => sum + row.count, 0)
  const rows = (node.tracks.sources ?? []).flatMap((id) => {
    const row = window.sources[id]
    return row === undefined ? [] : [row]
  })
  const events = rows.reduce((sum, row) => sum + row.count, 0)
  const lastAt = Math.max(0, ...subs.map(row => row.lastAt ?? 0), ...rows.map(row => row.lastAt ?? 0)) || null
  if (batches + events === 0) return { state: 'idle', text: t(`flow.fact.idle.${span}`), count: 0, lastAt: null }
  if (node.tracks.sources === undefined || events === 0) {
    const text = told > 0 ? t('flow.fact.batchesTold', { count: batches, told }) : t('flow.fact.batchesQuiet', { count: batches })
    return { state: 'plain', text, count: batches, lastAt }
  }
  return { state: 'plain', text: t('flow.fact.events', { count: events, when: whenText(lastAt ?? 0, sources) }), count: events, lastAt }
}

/**
 * The boxes a feed row walked, in order: where it came from, the Sessions that took it, and the owner's WeChat when it reached them.
 * @param graph - the picture.
 * @param item - the row.
 * @returns box ids; empty when no box stands for its source.
 */
export function stopsOf(graph: FlowGraph, item: FlowRecentItem): readonly string[] {
  const owner = graph.nodes.find(node => node.tracks?.sources?.includes(item.source))
  const takers = graph.nodes.filter(node => node.role !== 'source' && item.subscriptions.some(id => node.tracks?.subscriptions?.includes(id)))
  const stops = [...owner === undefined ? [] : [owner.id], ...takers.map(node => node.id)]
  return item.outcome === 'sent' && graph.node('wechatOut') !== undefined ? [...stops, 'wechatOut'] : stops
}

/**
 * Every feed row whose walk includes this box.
 * @param graph - the picture.
 * @param id - the box.
 * @param items - the feed.
 * @returns the rows through the box.
 */
export function rowsThrough(graph: FlowGraph, id: string, items: readonly FlowRecentItem[]): readonly FlowRecentItem[] {
  return items.filter(item => stopsOf(graph, item).includes(id))
}
