/** Durable event bus: dedupe, loop suppression, subscriptions, coalescing, rate limits, and dispatch. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { VerifiedWebhookDelivery, WebhookDeliveryId, WebhookRule, WebhookRuleId, WebhookSessionRequest, WebhookSourceId } from '@deepseek-ai/dsh-webhook'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { matchesSubscription, suppressionReason } from './match.ts'
import { batchTitle, buildSessionRequest, clip, formatBatchNote, formatResultNote } from './prompt.ts'
import { busDomain, type BatchRecord, type LsyEventRecord } from './storage.ts'
import type { BatchEvent, LsyDeliveryEvent, LsyEventInput, LsyNotifier, PublishOutcome, SessionAction, Subscription, SuppressConfig } from './types.ts'

export * from './match.ts'
export * from './prompt.ts'
export type * from './storage.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lsyEventBus: LsyEventBus
    lsyNotifier: LsyNotifier
  }
}

declare module '@deepseek-ai/dsh-webhook' {
  interface WebhookEventMap {
    'lsy-event': LsyDeliveryEvent
  }
}

/** Webhook provider kind of every delivery this bus dispatches. */
export const LSY_EVENT_KIND = 'lsy-event'
/** Id of the webhook rule that turns bus deliveries into Session requests. */
export const LSY_EVENT_RULE_ID = 'lsy-event-bus'

const HOUR_MS = 3_600_000
/** Titles are labels; anything longer is a sensor bug, not content. */
const MAX_TITLE_CHARS = 300

/** Bus configuration. */
export interface Config {
  /** User-authored routing rules; only these can start actuators. */
  subscriptions: Subscription[]
  /** Loop suppression for events the agent itself caused. */
  suppress: SuppressConfig
  /** Settled events kept for dedupe and inspection; the oldest are pruned first. */
  retainEvents: number
  /** Batches kept for rate limiting and inspection; the oldest are pruned first. */
  retainBatches: number
  /** Maximum stored characters of each event's untrusted text. */
  maxTextChars: number
  /** Send the final assistant text of each bus-started Session to the notifier. */
  notifySessionResult: boolean
  /** Events listed in one notify message before the remainder is counted. */
  maxNoteEvents: number
  /** Web UI link attached to Session result messages. */
  webUrl?: string
}

// Schemastery materializes a missing nested object as `{}`, so the fields a
// session subscription needs are checked by assertConfig rather than marked required.
const sessionActionSchema: z<SessionAction> = z.object({
  workspacePath: z.string(),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('danger-full-access'),
  instructions: z.string(),
  titlePrefix: z.string(),
  maxPromptEvents: z.natural().min(1).default(50),
  maxTextChars: z.natural().min(1).default(2000),
})

const subscriptionSchema: z<Subscription> = z.object({
  id: z.string().required(),
  sources: z.array(z.string()).default([]),
  kinds: z.array(z.string()).default([]),
  subjects: z.array(z.string()).default([]),
  action: z.union(['notify', 'session'] as const).required(),
  coalesceMs: z.natural().default(60_000),
  maxPerHour: z.natural().min(1).default(12),
  session: sessionActionSchema,
})

/** Configuration schema. */
export const Config: z<Config> = z.object({
  subscriptions: z.array(subscriptionSchema).default([]),
  suppress: z.object({
    actors: z.array(z.string()).default([]),
    markers: z.array(z.string()).default([]),
  }),
  retainEvents: z.natural().min(1).default(5000),
  retainBatches: z.natural().min(1).default(1000),
  maxTextChars: z.natural().min(1).default(4000),
  notifySessionResult: z.boolean().default(true),
  maxNoteEvents: z.natural().min(1).default(10),
  webUrl: z.string(),
})

/** Shape check for deliveries that come back through the webhook rule. */
const deliveryEventSchema = zod.object({
  subscription: zod.string(),
  events: zod.array(zod.object({
    id: zod.string(),
    source: zod.string(),
    kind: zod.string(),
    subject: zod.string(),
    title: zod.string(),
    url: zod.string().optional(),
    actor: zod.string().optional(),
    text: zod.string().optional(),
    occurredAt: zod.number().optional(),
  })),
})

/** A bus-started Session waiting for the end of its first turn. */
interface TrackedSession {
  batchId: string
  subscription: string
  title: string
  text: string | undefined
}

/** A batch persisted by a flush and waiting for its actuator. */
interface FlushedBatch {
  batch: BatchRecord
  events: BatchEvent[]
  subscription: Subscription
}

/** Fail at load on configuration that cannot route events. */
function assertConfig(config: Config): void {
  const ids = new Set<string>()
  for (const subscription of config.subscriptions) {
    if (subscription.id.trim() === '') throw new Error('lsy-event-bus: subscription id must be non-empty')
    if (ids.has(subscription.id)) throw new Error(`lsy-event-bus: duplicate subscription id "${subscription.id}"`)
    ids.add(subscription.id)
    if (subscription.action !== 'session') continue
    const session = subscription.session
    if (session === undefined || typeof session.workspacePath !== 'string' || !session.workspacePath.startsWith('/')) {
      throw new Error(`lsy-event-bus: session subscription "${subscription.id}" needs an absolute session.workspacePath`)
    }
    if (typeof session.instructions !== 'string' || session.instructions.trim() === '') {
      throw new Error(`lsy-event-bus: session subscription "${subscription.id}" needs session.instructions`)
    }
  }
}

/** Fail on events a sensor should never produce. */
function assertEvent(input: LsyEventInput): void {
  for (const field of ['source', 'kind', 'key', 'subject', 'title'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new TypeError(`lsy-event-bus: event ${field} must be a non-empty string`)
    }
  }
}

/** Project a stored event into the fields batches carry. */
function toBatchEvent(record: LsyEventRecord): BatchEvent {
  return {
    id: record.id,
    source: record.source,
    kind: record.kind,
    subject: record.subject,
    title: record.title,
    ...(record.url === undefined ? {} : { url: record.url }),
    ...(record.actor === undefined ? {} : { actor: record.actor }),
    ...(record.text === undefined ? {} : { text: record.text }),
    ...(record.occurredAt === undefined ? {} : { occurredAt: record.occurredAt }),
  }
}

/** Narrow one content part to text. */
function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return typeof part === 'object' && part !== null
    && 'type' in part && part.type === 'text'
    && 'text' in part && typeof part.text === 'string'
}

/** Concatenated text parts of one message, or undefined when it has none. */
function messageText(content: readonly unknown[]): string | undefined {
  const text = content.filter(isTextPart).map(part => part.text).join('\n').trim()
  return text === '' ? undefined : text
}

/** Values of one table, or none before the domain opens. */
function rowsOf<V>(table: KvTable<string, V> | undefined): V[] {
  return table === undefined ? [] : [...table.entries()].map(([, value]) => value)
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Durable event bus. Sensors publish; user-authored subscriptions decide which
 * events reach which actuator; the bus owns dedupe, loop suppression,
 * coalescing, and rate limits so actuators never see raw sensor traffic.
 */
export class LsyEventBus extends Service {
  static inject = ['timer', 'storageDomain']
  static Config = Config

  private readonly ready: Promise<Domain<typeof busDomain>>
  private domain: Domain<typeof busDomain> | undefined
  private readonly subscriptions: ReadonlyMap<string, Subscription>
  private readonly flushTimers = new Map<string, { at: number; dispose: () => void }>()
  private readonly tracked = new Map<string, TrackedSession>()
  private readonly inflight = new Set<Promise<void>>()
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false

  /**
   * @param ctx - Host services owning timers, storage, and Session events.
   * @param config - Subscriptions, suppression, and retention.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'lsyEventBus')
    assertConfig(config)
    this.subscriptions = new Map(config.subscriptions.map(subscription => [subscription.id, subscription]))
    this.ready = ctx.storageDomain.open(busDomain)

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const cleanup = ctx.effect(() => async () => {
        this.stopping = true
        for (const timer of this.flushTimers.values()) timer.dispose()
        this.flushTimers.clear()
        await Promise.allSettled([...this.inflight])
        await this.chain // serialize() keeps the chain itself non-rejecting.
        await domain.close()
      }, 'lsyEventBus.lifecycle()')
      await this.restorePending()
      return cleanup
    }, 'lsyEventBus.init()')

    // The rule plugin starts whenever a webhook runtime is mounted; the bus works without one.
    ctx.plugin({
      name: 'lsy-event-bus-session-rule',
      inject: ['webhookRuntime'],
      apply: (child: Context) => {
        const rule: WebhookRule<typeof LSY_EVENT_KIND> = {
          id: LSY_EVENT_RULE_ID as WebhookRuleId,
          kind: LSY_EVENT_KIND,
          run: delivery => this.sessionRequest(delivery),
        }
        child.effect(() => child.webhookRuntime.register(rule), 'lsyEventBus.sessionRule()')
      },
    })

    ctx.on('session/event', (session, event) => { this.observeSession(session, event) })
  }

  /**
   * Publish one sensor observation.
   * @param input - event; `source` + `key` identify it for dedupe.
   * @returns `accepted` (queued for at least one subscription), `duplicate`, `suppressed`, or `unmatched`.
   * @throws when a required field is empty.
   */
  async publish(input: LsyEventInput): Promise<PublishOutcome> {
    assertEvent(input)
    return this.serialize(async () => {
      const domain = await this.ready
      const events = domain.table('events')
      const id = `${input.source}:${input.key}`
      if (events.get(id) !== undefined) return 'duplicate'

      const now = Date.now()
      const reason = suppressionReason(this.config.suppress, input)
      const matching = reason === undefined
        ? this.config.subscriptions.filter(subscription => matchesSubscription(subscription, input))
        : []
      const matched = matching.map(subscription => subscription.id)
      const outcome = reason !== undefined ? 'suppressed' : matched.length === 0 ? 'unmatched' : 'accepted'
      const record: LsyEventRecord = {
        id,
        source: input.source,
        kind: input.kind,
        key: input.key,
        subject: input.subject,
        title: clip(input.title, MAX_TITLE_CHARS),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        ...(input.text === undefined ? {} : { text: clip(input.text, this.config.maxTextChars) }),
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
        receivedAt: now,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        subscriptions: matched,
      }
      await events.put(id, record)
      for (const subscription of matching) {
        await domain.table('pending').put(`${subscription.id}|${id}`, { subscription: subscription.id, eventId: id, enqueuedAt: now })
        this.scheduleFlush(subscription.id, now + subscription.coalesceMs)
      }
      await this.prune(domain)
      this.ctx.logger.debug(`lsy-event-bus: ${outcome} ${id}${reason === undefined ? '' : ` (${reason})`} → [${matched.join(', ')}]`)
      return outcome
    })
  }

  /**
   * Stored events, oldest first.
   * @returns snapshot of the events table.
   */
  events(): LsyEventRecord[] {
    return rowsOf(this.domain?.table('events')).sort((a, b) => a.receivedAt - b.receivedAt)
  }

  /**
   * Stored batches, oldest first.
   * @returns snapshot of the batches table.
   */
  batches(): BatchRecord[] {
    return rowsOf(this.domain?.table('batches')).sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Number of event/subscription pairs waiting for a batch.
   * @returns pending row count.
   */
  pendingCount(): number {
    return this.domain?.table('pending').size ?? 0
  }

  /** Run storage work one at a time; rejections reach the caller without breaking the chain. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work)
    this.chain = result.catch(() => undefined)
    return result
  }

  /** Keep a background actuator call alive until teardown drains it. */
  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.ctx.logger.warn(`lsy-event-bus: background work failed: ${errorText(error)}`)
    }).finally(() => this.inflight.delete(tracked))
    this.inflight.add(tracked)
  }

  /** Arm the subscription's flush timer unless an earlier one is armed. */
  private scheduleFlush(subscriptionId: string, at: number): void {
    /* v8 ignore next -- publish and flush can still run while teardown drains the chain. */
    if (this.stopping) return
    const armed = this.flushTimers.get(subscriptionId)
    if (armed !== undefined && armed.at <= at) return
    armed?.dispose()
    const dispose = this.ctx.timeout(() => {
      this.flushTimers.delete(subscriptionId)
      this.track(this.flush(subscriptionId))
    }, Math.max(0, at - Date.now()))
    this.flushTimers.set(subscriptionId, { at, dispose })
  }

  /** Re-arm flushes for pending rows that survived a restart; drop rows of removed subscriptions. */
  private async restorePending(): Promise<void> {
    await this.serialize(async () => {
      const domain = await this.ready
      const pending = domain.table('pending')
      for (const [key, row] of [...pending.entries()]) {
        const subscription = this.subscriptions.get(row.subscription)
        if (subscription === undefined) {
          this.ctx.logger.info(`lsy-event-bus: dropping pending ${row.eventId} of removed subscription ${row.subscription}`)
          await pending.delete(key)
          continue
        }
        this.scheduleFlush(subscription.id, row.enqueuedAt + subscription.coalesceMs)
      }
    })
  }

  /** Turn one subscription's pending rows into a batch and hand it to its actuator. */
  private async flush(subscriptionId: string): Promise<void> {
    const flushed = await this.serialize(() => this.persistBatch(subscriptionId))
    if (flushed !== undefined) await this.actuate(flushed)
  }

  /** Persist the next batch, or re-arm the flush when the hourly limit is reached. */
  private async persistBatch(subscriptionId: string): Promise<FlushedBatch | undefined> {
    const subscription = this.subscriptions.get(subscriptionId)
    /* v8 ignore next -- a flush queued behind teardown or for a subscription removed by a reload. */
    if (subscription === undefined || this.stopping) return undefined
    const domain = await this.ready
    const pending = domain.table('pending')
    const rows = [...pending.entries()]
      .filter(([, row]) => row.subscription === subscriptionId)
      .sort(([, a], [, b]) => a.enqueuedAt - b.enqueuedAt)
    /* v8 ignore next -- defensive: every armed timer belongs to at least one pending row. */
    if (rows.length === 0) return undefined

    const now = Date.now()
    const recent = rowsOf(domain.table('batches'))
      .filter(batch => batch.subscription === subscriptionId && batch.createdAt > now - HOUR_MS)
      .sort((a, b) => a.createdAt - b.createdAt)
    if (recent.length >= subscription.maxPerHour) {
      // The batch whose expiry brings the window back under the limit; it exists because recent.length >= maxPerHour.
      /* v8 ignore next */
      const reopensAt = (recent.at(-subscription.maxPerHour)?.createdAt ?? now) + HOUR_MS
      this.ctx.logger.info(`lsy-event-bus: ${subscriptionId} reached ${subscription.maxPerHour}/h; ${rows.length} event(s) wait until ${new Date(reopensAt).toISOString()}`)
      this.scheduleFlush(subscriptionId, reopensAt)
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
    this.ctx.logger.info(`lsy-event-bus: batch ${batch.id} (${subscription.action}, ${events.length} event(s))`)
    return { batch, events, subscription }
  }

  /** Hand one batch to its actuator and record the result. */
  private async actuate({ batch, events, subscription }: FlushedBatch): Promise<void> {
    if (subscription.action === 'notify') {
      const notifier = this.ctx.get('lsyNotifier')
      if (notifier === undefined) {
        await this.markBatch(batch.id, { status: 'failed', error: 'no lsyNotifier service is mounted' })
        return
      }
      try {
        await notifier.send(formatBatchNote(subscription.id, events, this.config.maxNoteEvents))
        await this.markBatch(batch.id, { status: 'delivered' })
      } catch (error: unknown) {
        this.ctx.logger.warn(`lsy-event-bus: notify ${batch.id} failed: ${errorText(error)}`)
        await this.markBatch(batch.id, { status: 'failed', error: errorText(error) })
      }
      return
    }

    const runtime = this.ctx.get('webhookRuntime')
    if (runtime === undefined) {
      await this.markBatch(batch.id, { status: 'failed', error: 'no webhookRuntime service is mounted' })
      return
    }
    try {
      runtime.dispatch({
        kind: LSY_EVENT_KIND,
        source: subscription.id as WebhookSourceId,
        deliveryId: batch.id as WebhookDeliveryId,
        event: { subscription: subscription.id, events },
        receivedAt: batch.createdAt,
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`lsy-event-bus: session dispatch ${batch.id} failed: ${errorText(error)}`)
      await this.markBatch(batch.id, { status: 'failed', error: errorText(error) })
    }
  }

  /** Merge fields into one stored batch; a pruned batch is ignored. */
  private markBatch(id: string, patch: Partial<Pick<BatchRecord, 'status' | 'error' | 'sessionId' | 'outcome'>>): Promise<void> {
    return this.serialize(async () => {
      const domain = await this.ready
      const batches = domain.table('batches')
      const current = batches.get(id)
      if (current === undefined) return
      await batches.put(id, { ...current, ...patch })
    })
  }

  /** Webhook rule body: rebuild the Session request from the subscription that produced the delivery. */
  private sessionRequest(delivery: Readonly<VerifiedWebhookDelivery<typeof LSY_EVENT_KIND>>): WebhookSessionRequest | null {
    const subscription = this.subscriptions.get(delivery.source)
    if (subscription?.action !== 'session' || subscription.session === undefined) return null
    const parsed = deliveryEventSchema.safeParse(delivery.event)
    if (!parsed.success) {
      this.ctx.logger.warn(`lsy-event-bus: delivery ${delivery.deliveryId} carries a malformed event`)
      return null
    }
    return buildSessionRequest(subscription.id, subscription.session, parsed.data.events)
  }

  /** Follow bus-started Sessions to their first turn end and report the outcome. */
  private observeSession(session: Session, event: SessionEvent): void {
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        if (source.kind !== 'webhook' || source.provider !== LSY_EVENT_KIND || this.tracked.has(session.id)) return
        const batch = this.domain?.table('batches').get(source.deliveryId)
        this.tracked.set(session.id, {
          batchId: source.deliveryId,
          subscription: source.source,
          title: batch?.title ?? source.source,
          text: undefined,
        })
        this.track(this.markBatch(source.deliveryId, { sessionId: session.id }))
        return
      }
      case 'assistant/message': {
        const tracked = this.tracked.get(session.id)
        const text = tracked === undefined ? undefined : messageText(event.data.message.content)
        if (tracked !== undefined && text !== undefined) tracked.text = text
        return
      }
      case 'turn/end': {
        const tracked = this.tracked.get(session.id)
        if (tracked === undefined) return
        this.tracked.delete(session.id)
        const outcome = event.data.reason.kind
        this.ctx.logger.info(`lsy-event-bus: Session ${session.id} of ${tracked.batchId} ended its first turn: ${outcome}`)
        this.track(this.reportResult(tracked, outcome))
        return
      }
      default:
        return
    }
  }

  /** Record the Session outcome and send it to the notifier. */
  private async reportResult(tracked: TrackedSession, outcome: string): Promise<void> {
    await this.markBatch(tracked.batchId, { status: 'completed', outcome })
    if (!this.config.notifySessionResult) return
    const notifier = this.ctx.get('lsyNotifier')
    if (notifier === undefined) return
    await notifier.send(formatResultNote({
      subscription: tracked.subscription,
      title: tracked.title,
      outcome,
      text: tracked.text,
      url: this.config.webUrl,
    }))
  }

  /** Drop the oldest settled events and batches beyond the retention caps. */
  private async prune(domain: Domain<typeof busDomain>): Promise<void> {
    const pendingIds = new Set(rowsOf(domain.table('pending')).map(row => row.eventId))
    const events = domain.table('events')
    const excessEvents = events.size - this.config.retainEvents
    if (excessEvents > 0) {
      const victims = rowsOf(events)
        .filter(record => !pendingIds.has(record.id))
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .slice(0, excessEvents)
      for (const record of victims) await events.delete(record.id)
    }
    const batches = domain.table('batches')
    const excessBatches = batches.size - this.config.retainBatches
    if (excessBatches > 0) {
      const victims = rowsOf(batches).sort((a, b) => a.createdAt - b.createdAt).slice(0, excessBatches)
      for (const batch of victims) await batches.delete(batch.id)
    }
  }
}

export default LsyEventBus
