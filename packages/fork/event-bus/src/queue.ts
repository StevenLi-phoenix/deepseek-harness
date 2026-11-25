/**
 * Event intake and batching: each published event is stored once and queued for every route that takes it, and a
 * route's queue becomes one batch when its coalesce window ends, within its hourly limit. A batch is recorded before
 * its actuator runs, so a crash in between drops it rather than repeating it.
 */

import { randomUUID } from 'node:crypto'
import type { BusLogger } from './log.ts'
import { matchesSubscription, suppressionReason } from './match.ts'
import { batchTitle, clip } from './prompt.ts'
import { rowsOf, toBatchEvent, type BusDomain, type BusStore } from './records.ts'
import type { RouteSet } from './routes.ts'
import type { BatchRecord, BusEventRecord } from './storage.ts'
import type { BatchEvent, BusEventInput, PublishOutcome, Subscription, SuppressConfig } from './types.ts'

const HOUR_MS = 3_600_000
/** Titles are labels; anything longer is a sensor bug, not content. */
const MAX_TITLE_CHARS = 300

/** A batch persisted by a flush and waiting for its actuator. */
export interface FlushedBatch {
  batch: BatchRecord
  events: BatchEvent[]
  subscription: Subscription
}

/** Fields a later step merges into a stored batch. */
export type BatchPatch = Partial<Pick<BatchRecord, 'status' | 'error' | 'sessionId' | 'outcome' | 'silent' | 'delivery' | 'notSent'>>

/** What the queue reads and calls. */
export interface EventQueueDeps {
  store: BusStore
  routes: Pick<RouteSet, 'all' | 'byId' | 'pausedIds'>
  logger: BusLogger
  /** One-shot timer of the bus's context; the returned function cancels it. */
  timeout(callback: () => void, ms: number): () => void
  /** Hand a persisted batch to its actuator; runs outside the storage chain. */
  actuate(flushed: FlushedBatch): Promise<void>
  /** Loop suppression applied before matching. */
  suppress: SuppressConfig
  /** Stored characters of each event's text. */
  maxTextChars: number
  /** Settled events kept; the oldest are pruned first. */
  retainEvents: number
  /** Batches kept; the oldest are pruned first. */
  retainBatches: number
}

/** Fail on events a sensor should never produce. */
function assertEvent(input: BusEventInput): void {
  for (const field of ['source', 'kind', 'key', 'subject', 'title'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new TypeError(`event-bus: event ${field} must be a non-empty string`)
    }
  }
}

/** Owns the flush timers and the in-memory count of flushes an hourly limit held back. */
export class EventQueue {
  private readonly timers = new Map<string, { at: number; dispose: () => void }>()
  /** When a flush last met its subscription's hourly limit, for `stats()`; not stored. */
  private readonly rateLimitHits: number[] = []
  private stopping = false

  /** @param deps - storage, routes, timer, and actuator. */
  constructor(private readonly deps: EventQueueDeps) {}

  /**
   * Store one sensor observation and queue it for every route that takes it.
   * @param input - event; `source` + `key` identify it for dedupe.
   * @returns `accepted` (queued for at least one subscription), `duplicate`, `suppressed`, or `unmatched`.
   * @throws when a required field is empty.
   */
  async publish(input: BusEventInput): Promise<PublishOutcome> {
    assertEvent(input)
    const { store, routes } = this.deps
    return store.background.serialize(async () => {
      const domain = await store.ready
      const events = domain.table('events')
      const id = `${input.source}:${input.key}`
      if (events.get(id) !== undefined) return 'duplicate'

      const now = Date.now()
      const reason = suppressionReason(this.deps.suppress, input)
      const paused = routes.pausedIds()
      const matching = reason === undefined
        ? routes.all().filter(subscription => !paused.has(subscription.id) && matchesSubscription(subscription, input))
        : []
      const matched = matching.map(subscription => subscription.id)
      const outcome = reason !== undefined ? 'suppressed' : matched.length === 0 ? 'unmatched' : 'accepted'
      const record: BusEventRecord = {
        id,
        source: input.source,
        kind: input.kind,
        key: input.key,
        subject: input.subject,
        title: clip(input.title, MAX_TITLE_CHARS),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        ...(input.text === undefined ? {} : { text: clip(input.text, this.deps.maxTextChars) }),
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
        receivedAt: now,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        subscriptions: matched,
      }
      await events.put(id, record)
      for (const subscription of matching) {
        await domain.table('pending').put(`${subscription.id}|${id}`, { subscription: subscription.id, eventId: id, enqueuedAt: now })
        this.schedule(subscription.id, now + subscription.coalesceMs)
      }
      await this.prune(domain)
      this.deps.logger.debug(`event-bus: ${outcome} ${id}${reason === undefined ? '' : ` (${reason})`} → [${matched.join(', ')}]`)
      return outcome
    })
  }

  /**
   * Arm the subscription's flush timer unless an earlier one is armed.
   * @param subscriptionId - route id.
   * @param at - when the flush is due.
   */
  schedule(subscriptionId: string, at: number): void {
    /* v8 ignore next -- publish and flush can still run while teardown drains the chain. */
    if (this.stopping) return
    const armed = this.timers.get(subscriptionId)
    if (armed !== undefined && armed.at <= at) return
    armed?.dispose()
    const dispose = this.deps.timeout(() => {
      this.timers.delete(subscriptionId)
      this.deps.store.background.track(this.flush(subscriptionId))
    }, Math.max(0, at - Date.now()))
    this.timers.set(subscriptionId, { at, dispose })
  }

  /**
   * Cancel a route's flush timer; its pending rows stay.
   * @param id - route id.
   */
  cancel(id: string): void {
    this.timers.get(id)?.dispose()
    this.timers.delete(id)
  }

  /**
   * When a route's armed flush is due.
   * @param id - route id.
   * @returns the time, or undefined while no flush is armed.
   */
  nextFlushAt(id: string): number | undefined {
    return this.timers.get(id)?.at
  }

  /**
   * Whether a route has events waiting for its next batch.
   * @param domain - the open storage domain.
   * @param id - route id.
   * @returns true when at least one pending row belongs to the route.
   */
  hasPending(domain: BusDomain, id: string): boolean {
    return [...domain.table('pending').entries()].some(([, row]) => row.subscription === id)
  }

  /**
   * Arm the flush of a route that takes events again and has some waiting.
   * @param domain - the open storage domain.
   * @param id - route id.
   */
  rearm(domain: BusDomain, id: string): void {
    const route = this.deps.routes.byId(id)
    if (route === undefined || this.deps.routes.pausedIds().has(id)) return
    if (this.hasPending(domain, id)) this.schedule(id, Date.now() + route.coalesceMs)
  }

  /**
   * Drop a route's pending events and its flush timer; runs inside the storage chain.
   * @param domain - the open storage domain.
   * @param id - route id.
   * @returns how many pending events were dropped.
   */
  async dropPending(domain: BusDomain, id: string): Promise<number> {
    this.cancel(id)
    const pending = domain.table('pending')
    let dropped = 0
    for (const [key, row] of [...pending.entries()]) {
      if (row.subscription !== id) continue
      await pending.delete(key)
      dropped += 1
    }
    return dropped
  }

  /** Re-arm flushes for pending rows that survived a restart; drop rows of removed subscriptions. */
  async restore(): Promise<void> {
    const { store, routes } = this.deps
    await store.background.serialize(async () => {
      const domain = await store.ready
      const pending = domain.table('pending')
      for (const [key, row] of [...pending.entries()]) {
        const subscription = routes.byId(row.subscription)
        if (subscription === undefined) {
          this.deps.logger.info(`event-bus: dropping pending ${row.eventId} of removed subscription ${row.subscription}`)
          await pending.delete(key)
          continue
        }
        this.schedule(subscription.id, row.enqueuedAt + subscription.coalesceMs)
      }
    })
  }

  /** Cancel every flush timer and arm no more; flushes already on the storage chain persist nothing. */
  stop(): void {
    this.stopping = true
    for (const timer of this.timers.values()) timer.dispose()
    this.timers.clear()
  }

  /**
   * Flushes an hourly limit held back since a time; older hits are forgotten.
   * @param since - start of the window.
   * @returns the number of hits after `since`.
   */
  rateLimitHitsSince(since: number): number {
    /* v8 ignore next -- the loop condition checked the array is not empty. */
    while (this.rateLimitHits.length > 0 && (this.rateLimitHits[0] ?? since) <= since) this.rateLimitHits.shift()
    return this.rateLimitHits.length
  }

  /**
   * Merge fields into one stored batch; a pruned batch is ignored.
   * @param id - batch id.
   * @param patch - the fields to set.
   * @returns resolves once the row is written.
   */
  markBatch(id: string, patch: BatchPatch): Promise<void> {
    const { store } = this.deps
    return store.background.serialize(async () => {
      const domain = await store.ready
      const batches = domain.table('batches')
      const current = batches.get(id)
      if (current === undefined) return
      await batches.put(id, { ...current, ...patch })
    })
  }

  /** Turn one subscription's pending rows into a batch and hand it to its actuator. */
  private async flush(subscriptionId: string): Promise<void> {
    const flushed = await this.deps.store.background.serialize(() => this.persistBatch(subscriptionId))
    if (flushed !== undefined) await this.deps.actuate(flushed)
  }

  /** Persist the next batch, or re-arm the flush when the hourly limit is reached. */
  private async persistBatch(subscriptionId: string): Promise<FlushedBatch | undefined> {
    const subscription = this.deps.routes.byId(subscriptionId)
    /* v8 ignore next -- a flush queued behind teardown or behind the unsubscribe() that removed its subscription. */
    if (subscription === undefined || this.stopping) return undefined
    const domain = await this.deps.store.ready
    // A paused subscription keeps its pending rows; resuming arms the flush again.
    if (this.deps.routes.pausedIds().has(subscriptionId)) return undefined
    const pending = domain.table('pending')
    const rows = [...pending.entries()]
      .filter(([, row]) => row.subscription === subscriptionId)
      .sort(([, a], [, b]) => a.enqueuedAt - b.enqueuedAt)
    /* v8 ignore next -- defensive: every armed timer belongs to at least one pending row. */
    if (rows.length === 0) return undefined

    const now = Date.now()
    const recent = rowsOf(domain.table('batches'))
      .filter(batch => batch.subscription === subscriptionId && batch.parent === undefined && batch.createdAt > now - HOUR_MS)
      .sort((a, b) => a.createdAt - b.createdAt)
    if (recent.length >= subscription.maxPerHour) {
      this.rateLimitHits.push(now)
      // The batch whose expiry brings the window back under the limit; it exists because recent.length >= maxPerHour.
      /* v8 ignore next */
      const reopensAt = (recent.at(-subscription.maxPerHour)?.createdAt ?? now) + HOUR_MS
      this.deps.logger.info(`event-bus: ${subscriptionId} reached ${subscription.maxPerHour}/h; ${rows.length} event(s) wait until ${new Date(reopensAt).toISOString()}`)
      this.schedule(subscriptionId, reopensAt)
      return undefined
    }

    const events = rows
      .map(([, row]) => domain.table('events').get(row.eventId))
      .filter(record => record !== undefined)
      .map(toBatchEvent)
    const batch: BatchRecord = {
      id: `${subscriptionId}-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
      subscription: subscriptionId,
      action: subscription.action,
      title: subscription.action === 'session'
        ? batchTitle(subscription.session?.titlePrefix ?? subscriptionId, events)
        : `${subscriptionId}: ${events.length} event(s)`,
      eventIds: events.map(event => event.id),
      createdAt: now,
      status: 'dispatched',
    }
    // At-most-once: the batch is recorded before the actuator runs, so a crash in between drops it rather than repeating it.
    await domain.table('batches').put(batch.id, batch)
    for (const [key] of rows) await pending.delete(key)
    await this.prune(domain)
    this.deps.logger.info(`event-bus: batch ${batch.id} (${subscription.action}, ${events.length} event(s))`)
    return { batch, events, subscription }
  }

  /** Drop the oldest settled events and batches beyond the retention caps. */
  private async prune(domain: BusDomain): Promise<void> {
    const pendingIds = new Set(rowsOf(domain.table('pending')).map(row => row.eventId))
    const events = domain.table('events')
    const excessEvents = events.size - this.deps.retainEvents
    if (excessEvents > 0) {
      const victims = rowsOf(events)
        .filter(record => !pendingIds.has(record.id))
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .slice(0, excessEvents)
      for (const record of victims) await events.delete(record.id)
    }
    const batches = domain.table('batches')
    const excessBatches = batches.size - this.deps.retainBatches
    if (excessBatches > 0) {
      const victims = rowsOf(batches).sort((a, b) => a.createdAt - b.createdAt).slice(0, excessBatches)
      for (const batch of victims) await batches.delete(batch.id)
    }
  }
}
