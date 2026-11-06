/**
 * What the message flow page shows beyond health: how much passed each source and subscription, how much of it reached the
 * owner, and the latest events with what became of them. Everything is read from the bus's stored rows, for all windows at once,
 * so switching the span on the page needs no request. Labels and counts only: an event's text never leaves this function.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  FLOW_WINDOWS, type FlowActivityView, type FlowChangeRow, type FlowOutcome, type FlowRecentItem, type FlowRoute, type FlowSourceActivity,
  type FlowSubscriptionActivity, type FlowWindow, type FlowWindowActivity,
} from './views.ts'

const HOUR_MS = 3_600_000
const WINDOW_MS: Readonly<Record<FlowWindow, number>> = { '1h': HOUR_MS, '24h': 24 * HOUR_MS, '7d': 7 * 24 * HOUR_MS }
/** Rows of the list on the page. */
const RECENT_MAX = 50
/** Longest label sent to the browser, in characters. */
const TITLE_MAX = 80
/** Longest instructions sent to the browser, in characters. */
const INSTRUCTIONS_MAX = 1200
/** Changes of the flow on the page. */
const CHANGES_MAX = 8
/** Source of the events that carry a route's answer on to the next route. */
const FLOW_SOURCE = 'flow'

/** The fields read of a stored event. */
interface EventRow {
  readonly id: string
  readonly source: string
  readonly kind: string
  readonly title: string
  readonly receivedAt: number
  readonly outcome: 'accepted' | 'suppressed' | 'unmatched'
  readonly subscriptions: readonly string[]
}

/** The fields read of a stored batch. */
interface BatchRow {
  readonly subscription: string
  readonly eventIds: readonly string[]
  readonly createdAt: number
  readonly status: 'dispatched' | 'delivered' | 'completed' | 'failed'
  readonly silent?: boolean
  readonly notSent?: boolean
}

/** The fields read of a route. */
interface RouteRow {
  readonly id: string
  readonly origin: 'config' | 'agent'
  readonly action: 'notify' | 'session'
  readonly sources: readonly string[]
  readonly kinds: readonly string[]
  readonly subjects: readonly string[]
  readonly paused?: boolean
  readonly removed?: boolean
  readonly changed?: { readonly at: number }
  readonly result?: 'notify' | 'urgent' | 'main' | 'quiet' | 'event'
  readonly downstream: readonly string[]
  readonly session?: { readonly instructions?: string }
}

/** The fields read of a change. */
interface ChangeRow {
  readonly id: string
  readonly at: number
  readonly op: FlowChangeRow['op']
  readonly route: string
  readonly note?: string
}

/** What the page reads of the bus and of the presence service. */
interface BusView { events(): EventRow[]; batches(): BatchRow[]; flowRoutes(): RouteRow[]; flowHistory(limit: number): ChangeRow[] }
interface PresenceReader { view(): { asleep: boolean; deferred: number } }

type BatchResult = 'sent' | 'silent' | 'failed' | 'working'

function resultOf(batch: BatchRow): BatchResult {
  if (batch.status === 'failed') return 'failed'
  if (batch.status === 'dispatched') return 'working'
  return batch.silent === true || batch.notSent === true ? 'silent' : 'sent'
}

const later = (a: number | null, b: number): number => a === null || b > a ? b : a

function windowOf(events: readonly EventRow[], batches: readonly BatchRow[], since: number): FlowWindowActivity {
  const sources: Record<string, FlowSourceActivity> = {}
  const subscriptions: Record<string, FlowSubscriptionActivity> = {}
  const funnel = { events: 0, batches: 0, sent: 0, silent: 0, failed: 0 }
  let ignored = 0
  for (const event of events) {
    // A route's answer going on to the next route is not a new thing that happened.
    if (event.receivedAt < since || event.source === FLOW_SOURCE) continue
    funnel.events += 1
    if (event.outcome !== 'accepted' || event.subscriptions.length === 0) ignored += 1
    const seen = sources[event.source]
    sources[event.source] = { count: (seen?.count ?? 0) + 1, lastAt: later(seen?.lastAt ?? null, event.receivedAt) }
  }
  for (const batch of batches) {
    if (batch.createdAt < since) continue
    const result = resultOf(batch)
    funnel.batches += 1
    if (result !== 'working') funnel[result] += 1
    const seen = subscriptions[batch.subscription]
    subscriptions[batch.subscription] = {
      count: (seen?.count ?? 0) + 1,
      lastAt: later(seen?.lastAt ?? null, batch.createdAt),
      sent: (seen?.sent ?? 0) + (result === 'sent' ? 1 : 0),
      silent: (seen?.silent ?? 0) + (result === 'silent' ? 1 : 0),
      failed: (seen?.failed ?? 0) + (result === 'failed' ? 1 : 0),
    }
  }
  return { funnel, sources, subscriptions, ignored }
}

/** The most telling result among the batches of one event: a failure, then a message to the owner, then the rest. */
const RANK: readonly BatchResult[] = ['failed', 'sent', 'working', 'silent']

function outcomeOf(event: EventRow, results: ReadonlyMap<string, readonly BatchResult[]>): FlowOutcome {
  if (event.outcome !== 'accepted') return event.outcome
  const own = results.get(event.id)
  if (own === undefined) return event.subscriptions.length === 0 ? 'unmatched' : 'waiting'
  return RANK.find(result => own.includes(result)) ?? 'waiting'
}

function recentOf(events: readonly EventRow[], batches: readonly BatchRow[]): FlowRecentItem[] {
  const results = new Map<string, BatchResult[]>()
  for (const batch of batches) {
    for (const id of batch.eventIds) results.set(id, [...results.get(id) ?? [], resultOf(batch)])
  }
  return [...events]
    .filter(event => event.outcome === 'accepted' && event.subscriptions.length > 0)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, RECENT_MAX)
    .map(event => ({
      id: event.id,
      at: event.receivedAt,
      source: event.source,
      kind: event.kind,
      title: Array.from(event.title).slice(0, TITLE_MAX).join(''),
      subscriptions: event.subscriptions,
      outcome: outcomeOf(event, results),
    }))
}

function routeOf(route: RouteRow): FlowRoute {
  const instructions = route.action === 'session' ? route.session?.instructions : undefined
  return {
    id: route.id,
    origin: route.origin,
    sources: route.sources,
    kinds: route.kinds,
    subjects: route.subjects,
    paused: route.paused === true,
    removed: route.removed === true,
    changedAt: route.changed?.at ?? null,
    result: route.action === 'notify' ? 'direct' : route.result ?? 'notify',
    downstream: route.downstream,
    instructions: instructions === undefined ? null : Array.from(instructions).slice(0, INSTRUCTIONS_MAX).join(''),
  }
}

/**
 * Read the activity of the message flow.
 * @param ctx - Host context; the bus and the presence service are optional.
 * @param now - the current time.
 * @returns all windows, the latest events, and the owner's presence.
 */
export function collectActivity(ctx: Context, now: number): FlowActivityView {
  const bus = (ctx.get as (name: string) => unknown)('lsyEventBus') as BusView | undefined
  const presence = (ctx.get as (name: string) => unknown)('lsyPresence') as PresenceReader | undefined
  const events = bus?.events() ?? []
  const batches = bus?.batches() ?? []
  const view = presence?.view()
  return {
    windows: Object.fromEntries(
      FLOW_WINDOWS.map(span => [span, windowOf(events, batches, now - WINDOW_MS[span])]),
    ) as Record<FlowWindow, FlowWindowActivity>,
    recent: recentOf(events, batches),
    presence: view === undefined ? null : { asleep: view.asleep, deferred: view.deferred },
    routes: bus?.flowRoutes().map(routeOf) ?? [],
    changes: bus?.flowHistory(CHANGES_MAX).map(({ id, at, op, route, note }) => ({ id, at, op, route, note: note ?? null })) ?? [],
    checkedAt: now,
  }
}
