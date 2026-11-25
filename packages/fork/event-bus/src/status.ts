/** Read-only snapshots for status pages, Settings, and the message flow page: stored history, routes with live status, and counters. */

import { downstreamOf, resultOf } from './flow.ts'
import { changedOf, rowsOf, summarize, toSubscription, type BusDomain } from './records.ts'
import type { EventQueue } from './queue.ts'
import type { RouteSet } from './routes.ts'
import type { BatchRecord, BusEventRecord, SubscriptionRecord } from './storage.ts'
import type { BusStats, FlowRouteView, Subscription, SubscriptionOrigin, SubscriptionView } from './types.ts'

const HOUR_MS = 3_600_000

/** What the snapshots read. */
export interface BusStatusDeps {
  /** The open storage domain, or undefined before it opens. */
  current(): BusDomain | undefined
  routes: Pick<RouteSet, 'all' | 'configCount' | 'configRoutes' | 'configured' | 'stored'>
  flushes: Pick<EventQueue, 'nextFlushAt' | 'rateLimitHitsSince'>
}

/** Builds every snapshot from the storage domain and the flush timers as they are when it is called. */
export class BusStatus {
  /** @param deps - storage, routes, and flush timers. */
  constructor(private readonly deps: BusStatusDeps) {}

  /**
   * Stored events.
   * @returns the events table, oldest first.
   */
  events(): BusEventRecord[] {
    return rowsOf(this.deps.current()?.table('events')).sort((a, b) => a.receivedAt - b.receivedAt)
  }

  /**
   * Stored batches.
   * @returns the batches table, oldest first.
   */
  batches(): BatchRecord[] {
    return rowsOf(this.deps.current()?.table('batches')).sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Number of event/subscription pairs waiting for a batch.
   * @returns pending row count.
   */
  pendingCount(): number {
    return this.deps.current()?.table('pending').size ?? 0
  }

  /**
   * Attach origin and status to stored rows, optionally preceded by the configuration routes.
   * @param records - stored run-time subscriptions.
   * @param withConfig - put the configuration routes as they stand first.
   * @returns one view per route.
   */
  views(records: readonly SubscriptionRecord[], withConfig = false): SubscriptionView[] {
    const domain = this.deps.current()
    const now = Date.now()
    const pending = new Map<string, number>()
    for (const row of rowsOf(domain?.table('pending'))) pending.set(row.subscription, (pending.get(row.subscription) ?? 0) + 1)
    const batches = new Map<string, BatchRecord[]>()
    for (const batch of this.batches()) batches.set(batch.subscription, [...batches.get(batch.subscription) ?? [], batch])
    const view = (subscription: Subscription, origin: SubscriptionOrigin, record?: SubscriptionRecord): SubscriptionView => {
      const history = batches.get(subscription.id) ?? []
      const last = history.at(-1)
      const override = origin === 'config' ? domain?.table('route_overrides').get(subscription.id) : undefined
      const nextFlushAt = this.deps.flushes.nextFlushAt(subscription.id)
      return {
        ...subscription,
        origin,
        ...(record === undefined ? {} : { createdAt: record.createdAt }),
        ...(record?.createdBy === undefined ? {} : { createdBy: record.createdBy }),
        ...(record?.paused === true || override?.paused === true ? { paused: true as const } : {}),
        ...(override === undefined ? {} : { changed: changedOf(override) }),
        status: {
          pending: pending.get(subscription.id) ?? 0,
          batchesLastHour: history.filter(batch => batch.createdAt > now - HOUR_MS).length,
          ...(nextFlushAt === undefined ? {} : { nextFlushAt }),
          ...(last === undefined ? {} : { lastBatch: summarize(last) }),
        },
      }
    }
    return [
      ...(withConfig ? this.deps.routes.configRoutes().map(subscription => view(subscription, 'config')) : []),
      ...records.map(record => view(toSubscription(record), 'agent', record)),
    ]
  }

  /**
   * Every subscription, configuration first and then run-time ones by creation time, with live status.
   * @returns snapshot; before the storage domain opens, only configuration rows with empty status.
   */
  listSubscriptions(): SubscriptionView[] {
    return this.views(this.deps.routes.stored(), true)
  }

  /**
   * The whole notification flow, including a configuration route taken out.
   * @returns routes in matching order, then the ones taken out.
   */
  flowRoutes(): FlowRouteView[] {
    const active = this.deps.routes.all()
    const routes: FlowRouteView[] = this.listSubscriptions().map(view => ({
      ...view,
      ...(view.action === 'session' ? { result: resultOf(view) } : {}),
      downstream: downstreamOf(view, active),
    }))
    const removed = rowsOf(this.deps.current()?.table('route_overrides')).filter(row => row.removed === true)
    for (const row of removed) {
      const route = this.deps.routes.configured(row.id)
      if (route === undefined) continue
      routes.push({
        ...route,
        origin: 'config',
        removed: true,
        changed: changedOf(row),
        status: { pending: 0, batchesLastHour: 0 },
        downstream: [],
      })
    }
    return routes
  }

  /**
   * Counters for the last rolling hour and the current queue.
   * @returns snapshot; before the storage domain opens, only the configuration rows are counted.
   */
  stats(): BusStats {
    const since = Date.now() - HOUR_MS
    const stored = this.deps.routes.stored()
    const rateLimitHitsLastHour = this.deps.flushes.rateLimitHitsSince(since)
    return {
      subscriptions: this.deps.routes.configCount() + stored.length,
      paused: stored.filter(record => record.paused === true).length,
      pending: this.pendingCount(),
      eventsLastHour: this.events().filter(event => event.receivedAt > since).length,
      batchesLastHour: this.batches().filter(batch => batch.createdAt > since).length,
      rateLimitHitsLastHour,
    }
  }
}
