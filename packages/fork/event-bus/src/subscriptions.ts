/** Run-time subscriptions: subscribe, unsubscribe, pause and resume, and the creator a Session handover moves. */

import type { BusLogger } from './log.ts'
import type { EventQueue } from './queue.ts'
import { toRecord, type BusStore } from './records.ts'
import type { RouteSet } from './routes.ts'
import type { BusStatus } from './status.ts'
import type { PauseOutcome, SessionHandoverItem, Subscription, SubscriptionMeta, SubscriptionView, UnsubscribeOutcome } from './types.ts'
import { SubscriptionError, subscriptionProblem } from './validate.ts'

/** What the subscription store reads and calls. */
export interface SubscriptionStoreDeps {
  store: BusStore
  routes: Pick<RouteSet, 'isConfigured' | 'stored'>
  flushes: Pick<EventQueue, 'cancel' | 'dropPending' | 'hasPending' | 'schedule'>
  status: Pick<BusStatus, 'views'>
  logger: BusLogger
}

/** Writes the `subscriptions` table on the storage chain; the configuration's rows are never written here. */
export class SubscriptionStore {
  /** @param deps - storage, routes, flush timers, and views. */
  constructor(private readonly deps: SubscriptionStoreDeps) {}

  /**
   * Store a routing rule.
   * @param subscription - rule; validated like a configuration row.
   * @param meta - who created the subscription.
   * @returns the stored subscription with its (empty) status.
   * @throws {SubscriptionError} `invalid_subscription` or `duplicate_id`.
   */
  async subscribe(subscription: Subscription, meta: SubscriptionMeta): Promise<SubscriptionView> {
    const problem = subscriptionProblem(subscription)
    if (problem !== undefined) throw new SubscriptionError('invalid_subscription', `event-bus: ${problem}`)
    const { store, routes } = this.deps
    return store.background.serialize(async () => {
      const domain = await store.ready
      const table = domain.table('subscriptions')
      if (routes.isConfigured(subscription.id) || table.get(subscription.id) !== undefined) {
        const owner = routes.isConfigured(subscription.id) ? 'the bus configuration' : 'another subscription'
        throw new SubscriptionError('duplicate_id', `event-bus: subscription id "${subscription.id}" is already used by ${owner}`)
      }
      const record = toRecord(subscription, meta, Date.now())
      await table.put(record.id, record)
      this.deps.logger.info(`event-bus: subscribed ${record.id} (${record.action}; kinds [${record.kinds.join(', ')}]; subjects [${record.subjects.join(', ')}])${record.createdBy === undefined ? '' : ` for Session ${record.createdBy}`}`)
      const [view] = this.deps.status.views([record])
      /* v8 ignore next -- views() maps each record to one view. */
      if (view === undefined) throw new Error(`event-bus: no view for ${record.id}`)
      return view
    })
  }

  /**
   * Remove a run-time subscription, its pending events, and its flush timer.
   * @param id - subscription id.
   * @returns `removed`, `not_found`, or `config_owned`.
   */
  async unsubscribe(id: string): Promise<UnsubscribeOutcome> {
    const { store, routes, flushes } = this.deps
    if (routes.isConfigured(id)) return 'config_owned'
    return store.background.serialize(async () => {
      const domain = await store.ready
      if (!await domain.table('subscriptions').delete(id)) return 'not_found'
      const dropped = await flushes.dropPending(domain, id)
      this.deps.logger.info(`event-bus: unsubscribed ${id}; dropped ${dropped} pending event(s)`)
      return 'removed'
    })
  }

  /**
   * Pause or resume a run-time subscription; resuming arms the flush of the events it held.
   * @param id - subscription id.
   * @param paused - true to pause, false to resume.
   * @returns `ok`, `not_found`, or `config_owned`.
   */
  async setPaused(id: string, paused: boolean): Promise<PauseOutcome> {
    const { store, routes, flushes } = this.deps
    if (routes.isConfigured(id)) return 'config_owned'
    return store.background.serialize(async () => {
      const domain = await store.ready
      const table = domain.table('subscriptions')
      const record = table.get(id)
      if (record === undefined) return 'not_found'
      if ((record.paused === true) === paused) return 'ok'
      const { paused: _was, ...rest } = record
      await table.put(id, paused ? { ...rest, paused: true } : rest)
      if (paused) {
        flushes.cancel(id)
      } else if (flushes.hasPending(domain, id)) {
        flushes.schedule(id, Date.now() + record.coalesceMs)
      }
      this.deps.logger.info(`event-bus: ${paused ? 'paused' : 'resumed'} ${id}`)
      return 'ok'
    })
  }

  /**
   * Make a Session the creator of the run-time subscriptions some other Sessions created.
   * @param from - the earlier creators.
   * @param to - the new creator.
   * @returns the subscriptions moved.
   */
  async reassignCreators(from: ReadonlySet<string>, to: string): Promise<SessionHandoverItem[]> {
    const { store, routes } = this.deps
    return store.background.serialize(async () => {
      const table = (await store.ready).table('subscriptions')
      const items: SessionHandoverItem[] = []
      for (const record of routes.stored()) {
        if (record.createdBy === undefined || !from.has(record.createdBy)) continue
        await table.put(record.id, { ...record, createdBy: to })
        items.push({ id: record.id, label: record.id })
      }
      return items
    })
  }
}
