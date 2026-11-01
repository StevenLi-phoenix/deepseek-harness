/** Durable event bus: dedupe, loop suppression, config and run-time subscriptions, coalescing, rate limits, dispatch, and reports. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
// Type-only: ctx.sessionController, ctx.workspaceRegistry, and the `compaction/summary` Session event.
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-compaction'
import { boundContextSummary, createUserMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { VerifiedWebhookDelivery, WebhookDeliveryId, WebhookRule, WebhookRuleId, WebhookSessionRequest, WebhookSourceId } from '@deepseek-ai/dsh-webhook'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { matchesSubscription, suppressionReason } from './match.ts'
import {
  FORK_SILENT_REPLY, batchTitle, buildBatchPrompt, buildSessionRequest, clip, failureDetail, formatBatchNote, formatReminderNote,
  formatResultNote, isSilentReply, monitorLabel, reminderLabel, type CarriedOver,
} from './prompt.ts'
import { busDomain, type BatchRecord, type ForkEventRecord, type PersistentRecord, type SubscriptionRecord } from './storage.ts'
import type {
  BatchEvent, BatchSummary, ForkDeliveryEvent, ForkEventInput, ForkNotifier, PersistentSessionView, PublishOutcome, SessionAction,
  SessionDelivery, Subscription, SubscriptionMeta, SubscriptionOrigin, SubscriptionView, SuppressConfig, UnsubscribeOutcome,
} from './types.ts'
import { ForkSubscriptionError, subscriptionProblem } from './validate.ts'

export * from './match.ts'
export * from './prompt.ts'
export * from './validate.ts'
export type * from './storage.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    forkEventBus: ForkEventBus
    forkNotifier: ForkNotifier
  }
}

declare module '@deepseek-ai/dsh-webhook' {
  interface WebhookEventMap {
    'fork-event': ForkDeliveryEvent
  }
}

/** Webhook provider kind of every delivery this bus dispatches. */
export const FORK_EVENT_KIND = 'fork-event'
/** Id of the webhook rule that turns bus deliveries into Session requests. */
export const FORK_EVENT_RULE_ID = 'fork-event-bus'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Titles are labels; anything longer is a sensor bug, not content. */
const MAX_TITLE_CHARS = 300

/** Bus configuration. */
export interface Config {
  /** Routing rules owned by the configuration; `subscribe()` adds more at run time. */
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
  /**
   * Send the final assistant text of each unattended Host-schedule reminder turn, and of each
   * turn a fork-tool-monitor notice wakes, to the notifier.
   */
  reportScheduledTurns: boolean
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
  trustedText: z.boolean().default(false),
  model: z.object({ provider: z.string(), model: z.string() }),
  persistent: z.object({
    enabled: z.boolean().default(false),
    rolloverDays: z.natural().min(1).default(30),
    maxSeedChars: z.natural().min(1).default(20_000),
  }),
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
  reportScheduledTurns: z.boolean().default(true),
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

/** A bus-started turn waiting for its end: the first turn of a new Session, or a batch's turn in a persistent one. */
interface TrackedSession {
  batchId: string
  subscription: string
  title: string
  text: string | undefined
  delivery: SessionDelivery
  /** Tool calls of the turn by tool name. */
  toolCalls: Map<string, number>
  /** Compactions that ran during the turn. */
  compactions: number
  /** Usage of the turn's last model call. */
  usage: TokenUsage | undefined
}

/** A `session` batch handed to the webhook runtime, until its Session's first user message arrives. */
interface PendingDelivery {
  delivery: SessionDelivery
  carried?: CarriedOver
}

/** The stored Session of a persistent subscription, as the Host resolves it now. */
type StoredSession =
  | { kind: 'agent'; agent: { followup(message: ReturnType<typeof createUserMessage>): void } }
  /** Not found or archived: a new Session replaces it. */
  | { kind: 'gone'; reason: string }
  /** Exists but cannot take a turn now (busy writer, no controller): this batch gets a one-off Session. */
  | { kind: 'unavailable'; reason: string }

/** A Session running a turn started by a Host-schedule reminder. */
interface TrackedReminder {
  label: string
  /** ⏰ for a reminder, 📡 for a monitor-woken turn. */
  icon: string
  text: string | undefined
}

/**
 * What the bus reads of `ctx.ownerRelay` (`@deepseek-ai/dsh-owner-relay`). That package depends on
 * this one (`failureDetail`, `isSilentReply`, `ForkNotifier`), so the bus reads the service through
 * this shape instead of importing it.
 */
interface OwnerRelayView {
  /** The channel that relays a Session's turns itself, or undefined. */
  ownerOf(sessionId: string): string | undefined
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
    const problem = subscriptionProblem(subscription)
    if (problem !== undefined) throw new Error(`fork-event-bus: ${problem}`)
    if (ids.has(subscription.id)) throw new Error(`fork-event-bus: duplicate subscription id "${subscription.id}"`)
    ids.add(subscription.id)
  }
}

/** Copy a validated subscription into its stored row; a `notify` row keeps no Session settings. */
function toRecord(subscription: Subscription, meta: SubscriptionMeta, createdAt: number): SubscriptionRecord {
  const session = subscription.action === 'session' ? subscription.session : undefined
  return {
    id: subscription.id,
    sources: [...subscription.sources],
    kinds: [...subscription.kinds],
    subjects: [...subscription.subjects],
    action: subscription.action,
    coalesceMs: subscription.coalesceMs,
    maxPerHour: subscription.maxPerHour,
    ...(session === undefined ? {} : { session: toSessionAction(session) }),
    createdAt,
    ...(meta.createdBy === undefined ? {} : { createdBy: meta.createdBy }),
  }
}

/** Copy Session settings, omitting an absent title prefix. */
function toSessionAction(session: SubscriptionRecord['session'] & {}): SessionAction {
  return {
    workspacePath: session.workspacePath,
    agentPreset: session.agentPreset,
    permissionPreset: session.permissionPreset,
    instructions: session.instructions,
    maxPromptEvents: session.maxPromptEvents,
    maxTextChars: session.maxTextChars,
    ...(session.titlePrefix === undefined ? {} : { titlePrefix: session.titlePrefix }),
  }
}

/** The routing fields of a stored run-time subscription. */
function toSubscription(record: SubscriptionRecord): Subscription {
  return {
    id: record.id,
    sources: record.sources,
    kinds: record.kinds,
    subjects: record.subjects,
    action: record.action,
    coalesceMs: record.coalesceMs,
    maxPerHour: record.maxPerHour,
    ...(record.session === undefined ? {} : { session: toSessionAction(record.session) }),
  }
}

/** The outcome fields of one stored batch. */
function summarize(batch: BatchRecord): BatchSummary {
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    eventCount: batch.eventIds.length,
    status: batch.status,
    ...(batch.error === undefined ? {} : { error: batch.error }),
    ...(batch.sessionId === undefined ? {} : { sessionId: batch.sessionId }),
    ...(batch.outcome === undefined ? {} : { outcome: batch.outcome }),
    ...(batch.silent === undefined ? {} : { silent: batch.silent }),
    ...(batch.delivery === undefined ? {} : { delivery: batch.delivery }),
  }
}

/** The public fields of a stored persistent Session. */
function persistentView(record: PersistentRecord): PersistentSessionView {
  return {
    subscription: record.subscription,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    batches: record.batches,
    compactions: record.compactions,
    ...(record.previous === undefined ? {} : { previous: record.previous }),
  }
}

/** `up_comments×2, up_reply_comment×1`, or `none`. */
function formatToolCalls(calls: ReadonlyMap<string, number>): string {
  return calls.size === 0 ? 'none' : [...calls].map(([name, count]) => `${name}×${count}`).join(', ')
}

/** Context size of a turn's last model call, or `unknown` without usage. */
function formatContext(usage: TokenUsage | undefined): string {
  if (usage === undefined) return 'unknown'
  return usage.cacheReadTokens === undefined ? `${usage.inputTokens} input tokens` : `${usage.inputTokens} input tokens (${usage.cacheReadTokens} cache read)`
}

/** Fail on events a sensor should never produce. */
function assertEvent(input: ForkEventInput): void {
  for (const field of ['source', 'kind', 'key', 'subject', 'title'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new TypeError(`fork-event-bus: event ${field} must be a non-empty string`)
    }
  }
}

/** Project a stored event into the fields batches carry. */
function toBatchEvent(record: ForkEventRecord): BatchEvent {
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
 * Durable event bus. Sensors publish; subscriptions from the configuration or
 * created at run time decide which events reach which actuator; the bus owns
 * dedupe, loop suppression, coalescing, and rate limits so actuators never
 * see raw sensor traffic.
 */
export class ForkEventBus extends Service {
  static inject = ['timer', 'storageDomain']
  static Config = Config

  private readonly ready: Promise<Domain<typeof busDomain>>
  private domain: Domain<typeof busDomain> | undefined
  private readonly configSubscriptions: ReadonlyMap<string, Subscription>
  private readonly flushTimers = new Map<string, { at: number; dispose: () => void }>()
  private readonly tracked = new Map<string, TrackedSession>()
  private readonly deliveries = new Map<string, PendingDelivery>()
  private readonly reminders = new Map<string, TrackedReminder>()
  private readonly inflight = new Set<Promise<void>>()
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false

  /**
   * @param ctx - Host services owning timers, storage, and Session events.
   * @param config - Subscriptions, suppression, and retention.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'forkEventBus')
    assertConfig(config)
    this.configSubscriptions = new Map(config.subscriptions.map(subscription => [subscription.id, subscription]))
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
      }, 'forkEventBus.lifecycle()')
      await this.restorePending()
      return cleanup
    }, 'forkEventBus.init()')

    // The rule plugin starts whenever a webhook runtime is mounted; the bus works without one.
    ctx.plugin({
      name: 'fork-event-bus-session-rule',
      inject: ['webhookRuntime'],
      apply: (child: Context) => {
        const rule: WebhookRule<typeof FORK_EVENT_KIND> = {
          id: FORK_EVENT_RULE_ID as WebhookRuleId,
          kind: FORK_EVENT_KIND,
          run: delivery => this.sessionRequest(delivery),
        }
        child.effect(() => child.webhookRuntime.register(rule), 'forkEventBus.sessionRule()')
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
  async publish(input: ForkEventInput): Promise<PublishOutcome> {
    assertEvent(input)
    return this.serialize(async () => {
      const domain = await this.ready
      const events = domain.table('events')
      const id = `${input.source}:${input.key}`
      if (events.get(id) !== undefined) return 'duplicate'

      const now = Date.now()
      const reason = suppressionReason(this.config.suppress, input)
      const matching = reason === undefined
        ? this.allSubscriptions().filter(subscription => matchesSubscription(subscription, input))
        : []
      const matched = matching.map(subscription => subscription.id)
      const outcome = reason !== undefined ? 'suppressed' : matched.length === 0 ? 'unmatched' : 'accepted'
      const record: ForkEventRecord = {
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
      this.ctx.logger.debug(`fork-event-bus: ${outcome} ${id}${reason === undefined ? '' : ` (${reason})`} → [${matched.join(', ')}]`)
      return outcome
    })
  }

  /**
   * Stored events, oldest first.
   * @returns snapshot of the events table.
   */
  events(): ForkEventRecord[] {
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

  /**
   * The persistent Sessions of subscriptions with `session.persistent.enabled`.
   * @returns one row per subscription that has one; empty before the storage domain opens.
   */
  persistentSessions(): PersistentSessionView[] {
    return rowsOf(this.domain?.table('persistent')).map(persistentView)
  }

  /**
   * The subscription whose current persistent Session this is. Tools that may run only in that Session
   * (for example the `up` preset's note tool) ask this.
   * @param sessionId - Session to check.
   * @returns the subscription id, or undefined when the Session is no subscription's current persistent Session.
   */
  persistentSubscriptionOf(sessionId: string): string | undefined {
    return rowsOf(this.domain?.table('persistent')).find(record => record.sessionId === sessionId)?.subscription
  }

  /**
   * Add a routing rule at run time. It is stored durably and survives restarts.
   * @param subscription - rule; validated like a configuration row.
   * @param meta - who created the subscription, e.g. the creating Session.
   * @returns the stored subscription with its (empty) status.
   * @throws {ForkSubscriptionError} `invalid_subscription` for a rule the bus cannot route, or `duplicate_id`
   * for an id the configuration or another stored subscription already uses.
   */
  async subscribe(subscription: Subscription, meta: SubscriptionMeta = {}): Promise<SubscriptionView> {
    const problem = subscriptionProblem(subscription)
    if (problem !== undefined) throw new ForkSubscriptionError('invalid_subscription', `fork-event-bus: ${problem}`)
    return this.serialize(async () => {
      const domain = await this.ready
      const table = domain.table('subscriptions')
      if (this.configSubscriptions.has(subscription.id) || table.get(subscription.id) !== undefined) {
        const owner = this.configSubscriptions.has(subscription.id) ? 'the bus configuration' : 'another subscription'
        throw new ForkSubscriptionError('duplicate_id', `fork-event-bus: subscription id "${subscription.id}" is already used by ${owner}`)
      }
      const record = toRecord(subscription, meta, Date.now())
      await table.put(record.id, record)
      this.ctx.logger.info(`fork-event-bus: subscribed ${record.id} (${record.action}; kinds [${record.kinds.join(', ')}]; subjects [${record.subjects.join(', ')}])${record.createdBy === undefined ? '' : ` for Session ${record.createdBy}`}`)
      const [view] = this.views([record])
      /* v8 ignore next -- views() maps each record to one view. */
      if (view === undefined) throw new Error(`fork-event-bus: no view for ${record.id}`)
      return view
    })
  }

  /**
   * Remove a run-time subscription, its pending events, and its flush timer.
   * Batches already created stay in the history.
   * @param id - subscription id.
   * @returns `removed`, `not_found`, or `config_owned` for an id the configuration owns.
   */
  async unsubscribe(id: string): Promise<UnsubscribeOutcome> {
    if (this.configSubscriptions.has(id)) return 'config_owned'
    return this.serialize(async () => {
      const domain = await this.ready
      if (!await domain.table('subscriptions').delete(id)) return 'not_found'
      this.flushTimers.get(id)?.dispose()
      this.flushTimers.delete(id)
      const pending = domain.table('pending')
      let dropped = 0
      for (const [key, row] of [...pending.entries()]) {
        if (row.subscription !== id) continue
        await pending.delete(key)
        dropped += 1
      }
      this.ctx.logger.info(`fork-event-bus: unsubscribed ${id}; dropped ${dropped} pending event(s)`)
      return 'removed'
    })
  }

  /**
   * Every subscription, configuration first and then run-time ones by creation time, with live status.
   * @returns snapshot; before the storage domain opens, only configuration rows with empty status.
   */
  listSubscriptions(): SubscriptionView[] {
    return this.views(this.storedSubscriptions(), true)
  }

  /** Stored run-time subscriptions, oldest first. */
  private storedSubscriptions(): SubscriptionRecord[] {
    return rowsOf(this.domain?.table('subscriptions')).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Configuration and run-time subscriptions, in matching order. */
  private allSubscriptions(): Subscription[] {
    return [...this.config.subscriptions, ...this.storedSubscriptions().map(toSubscription)]
  }

  /** One subscription by id from either origin. */
  private subscriptionById(id: string): Subscription | undefined {
    const configured = this.configSubscriptions.get(id)
    if (configured !== undefined) return configured
    const stored = this.domain?.table('subscriptions').get(id)
    return stored === undefined ? undefined : toSubscription(stored)
  }

  /** Attach origin and status to stored rows, optionally preceded by the configuration rows. */
  private views(records: readonly SubscriptionRecord[], withConfig = false): SubscriptionView[] {
    const now = Date.now()
    const pending = new Map<string, number>()
    for (const row of rowsOf(this.domain?.table('pending'))) pending.set(row.subscription, (pending.get(row.subscription) ?? 0) + 1)
    const batches = new Map<string, BatchRecord[]>()
    for (const batch of this.batches()) batches.set(batch.subscription, [...batches.get(batch.subscription) ?? [], batch])
    const view = (subscription: Subscription, origin: SubscriptionOrigin, record?: SubscriptionRecord): SubscriptionView => {
      const history = batches.get(subscription.id) ?? []
      const last = history.at(-1)
      const timer = this.flushTimers.get(subscription.id)
      return {
        ...subscription,
        origin,
        ...(record === undefined ? {} : { createdAt: record.createdAt }),
        ...(record?.createdBy === undefined ? {} : { createdBy: record.createdBy }),
        status: {
          pending: pending.get(subscription.id) ?? 0,
          batchesLastHour: history.filter(batch => batch.createdAt > now - HOUR_MS).length,
          ...(timer === undefined ? {} : { nextFlushAt: timer.at }),
          ...(last === undefined ? {} : { lastBatch: summarize(last) }),
        },
      }
    }
    return [
      ...(withConfig ? this.config.subscriptions.map(subscription => view(subscription, 'config')) : []),
      ...records.map(record => view(toSubscription(record), 'agent', record)),
    ]
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
      this.ctx.logger.warn(`fork-event-bus: background work failed: ${errorText(error)}`)
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
        const subscription = this.subscriptionById(row.subscription)
        if (subscription === undefined) {
          this.ctx.logger.info(`fork-event-bus: dropping pending ${row.eventId} of removed subscription ${row.subscription}`)
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
    const subscription = this.subscriptionById(subscriptionId)
    /* v8 ignore next -- a flush queued behind teardown or behind the unsubscribe() that removed its subscription. */
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
      this.ctx.logger.info(`fork-event-bus: ${subscriptionId} reached ${subscription.maxPerHour}/h; ${rows.length} event(s) wait until ${new Date(reopensAt).toISOString()}`)
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
    this.ctx.logger.info(`fork-event-bus: batch ${batch.id} (${subscription.action}, ${events.length} event(s))`)
    return { batch, events, subscription }
  }

  /** Hand one batch to its actuator and record the result. */
  private async actuate({ batch, events, subscription }: FlushedBatch): Promise<void> {
    if (subscription.action === 'notify') {
      const notifier = this.ctx.get('forkNotifier')
      if (notifier === undefined) {
        await this.markBatch(batch.id, { status: 'failed', error: 'no forkNotifier service is mounted' })
        return
      }
      try {
        await notifier.send(formatBatchNote(subscription.id, events, this.config.maxNoteEvents))
        await this.markBatch(batch.id, { status: 'delivered' })
      } catch (error: unknown) {
        this.ctx.logger.warn(`fork-event-bus: notify ${batch.id} failed: ${errorText(error)}`)
        await this.markBatch(batch.id, { status: 'failed', error: errorText(error) })
      }
      return
    }

    const session = subscription.session
    if (session?.persistent?.enabled === true) {
      await this.actuatePersistent({ batch, events, subscription }, session)
      return
    }
    await this.dispatchSession({ batch, events, subscription }, 'fresh')
  }

  /** Start a new Session for one batch through the webhook runtime. */
  private async dispatchSession(
    { batch, events, subscription }: FlushedBatch, delivery: SessionDelivery, carried?: CarriedOver,
  ): Promise<void> {
    const runtime = this.ctx.get('webhookRuntime')
    if (runtime === undefined) {
      await this.markBatch(batch.id, { status: 'failed', error: 'no webhookRuntime service is mounted', delivery })
      return
    }
    this.deliveries.set(batch.id, { delivery, ...(carried === undefined ? {} : { carried }) })
    try {
      runtime.dispatch({
        kind: FORK_EVENT_KIND,
        source: subscription.id as WebhookSourceId,
        deliveryId: batch.id as WebhookDeliveryId,
        event: { subscription: subscription.id, events },
        receivedAt: batch.createdAt,
      })
      await this.markBatch(batch.id, { delivery })
    } catch (error: unknown) {
      this.deliveries.delete(batch.id)
      this.ctx.logger.warn(`fork-event-bus: session dispatch ${batch.id} failed: ${errorText(error)}`)
      await this.markBatch(batch.id, { status: 'failed', error: errorText(error), delivery })
    }
  }

  /**
   * Deliver one batch of a persistent subscription: a new turn of its stored Session, a new Session when there is
   * none or it is gone, a seeded new Session at a rollover, or a one-off Session when the stored one cannot take a turn.
   */
  private async actuatePersistent(flushed: FlushedBatch, session: SessionAction): Promise<void> {
    const { batch, events, subscription } = flushed
    /* v8 ignore next -- actuate() checked enabled; schemastery materializes the defaults. */
    const persistent = session.persistent ?? { enabled: true, rolloverDays: 30, maxSeedChars: 20_000 }
    const domain = await this.ready
    const stored = domain.table('persistent').get(subscription.id)
    if (stored === undefined) {
      this.ctx.logger.info(`fork-event-bus: ${subscription.id} has no persistent Session yet; batch ${batch.id} starts one`)
      await this.dispatchSession(flushed, 'persistent-new')
      return
    }
    const ageDays = (Date.now() - stored.createdAt) / DAY_MS
    if (ageDays >= persistent.rolloverDays) {
      const summary = stored.lastSummary === undefined ? undefined : clip(stored.lastSummary, persistent.maxSeedChars)
      this.ctx.logger.info(`fork-event-bus: ${subscription.id} rolls over Session ${stored.sessionId} after ${ageDays.toFixed(1)} day(s) and ${stored.batches} batch(es); ${summary === undefined ? 'it left no compaction summary' : `its ${summary.length}-char compaction summary is carried over`}`)
      await this.dispatchSession(flushed, 'rollover', { sessionId: stored.sessionId, summary })
      return
    }
    const resolved = await this.resolveStored(stored.sessionId)
    if (resolved.kind === 'gone') {
      this.ctx.logger.info(`fork-event-bus: persistent Session ${stored.sessionId} of ${subscription.id} is ${resolved.reason}; batch ${batch.id} starts a new one`)
      await this.serialize(async () => { await domain.table('persistent').delete(subscription.id) })
      await this.dispatchSession(flushed, 'persistent-new')
      return
    }
    if (resolved.kind === 'unavailable') {
      this.ctx.logger.warn(`fork-event-bus: persistent Session ${stored.sessionId} of ${subscription.id} cannot take batch ${batch.id} now (${resolved.reason}); it gets a one-off Session`)
      await this.dispatchSession(flushed, 'detached')
      return
    }
    const prompt = buildBatchPrompt(subscription.id, session, events)
    this.deliveries.set(batch.id, { delivery: 'persistent' })
    try {
      resolved.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        // The same source the webhook runtime gives a new Session's first message, so turn-origin checks
        // (fork-taint: `event`) and this bus's own tracking treat both alike.
        source: {
          kind: 'webhook',
          provider: FORK_EVENT_KIND,
          source: subscription.id as WebhookSourceId,
          deliveryId: batch.id as WebhookDeliveryId,
          ruleId: FORK_EVENT_RULE_ID as WebhookRuleId,
          form: 'notice',
          summary: boundContextSummary(`${FORK_EVENT_KIND} batch of ${subscription.id} for its persistent Session`),
        },
      }))
    } catch (error: unknown) {
      this.deliveries.delete(batch.id)
      this.ctx.logger.warn(`fork-event-bus: batch ${batch.id} did not enter persistent Session ${stored.sessionId}: ${errorText(error)}`)
      await this.markBatch(batch.id, { status: 'failed', error: errorText(error), delivery: 'persistent' })
      return
    }
    await this.markBatch(batch.id, { delivery: 'persistent', sessionId: stored.sessionId })
    const count = await this.serialize(async () => {
      const current = domain.table('persistent').get(subscription.id)
      if (current?.sessionId !== stored.sessionId) return stored.batches + 1
      await domain.table('persistent').put(subscription.id, { ...current, batches: current.batches + 1 })
      return current.batches + 1
    })
    this.ctx.logger.info(`fork-event-bus: batch ${batch.id} (${events.length} event(s)) entered persistent Session ${stored.sessionId} of ${subscription.id} as its batch #${count} (${ageDays.toFixed(1)} day(s) old, rollover at ${persistent.rolloverDays})`)
  }

  /** Resolve a persistent subscription's stored Session to its live Agent. */
  private async resolveStored(sessionId: string): Promise<StoredSession> {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) return { kind: 'unavailable', reason: 'no sessionController service is mounted' }
    if (this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(sessionId as SessionId) === true) return { kind: 'gone', reason: 'archived' }
    try {
      const result = await controller.resolveAgent(sessionId as SessionId)
      if ('agent' in result) return { kind: 'agent', agent: result.agent }
      return result.error.code === 'session/not-found'
        ? { kind: 'gone', reason: 'not found' }
        : { kind: 'unavailable', reason: `${result.error.code}: ${result.error.message}` }
    } catch (error: unknown) {
      return { kind: 'unavailable', reason: errorText(error) }
    }
  }

  /**
   * Make a newly created Session its subscription's persistent Session, then archive the one it replaces
   * (the rollover's old Session, or one a concurrent batch created).
   */
  private async adopt(subscriptionId: string, sessionId: string, delivery: SessionDelivery): Promise<void> {
    const domain = await this.ready
    const previous = await this.serialize(async () => {
      const table = domain.table('persistent')
      const current = table.get(subscriptionId)
      if (current?.sessionId === sessionId) return undefined
      await table.put(subscriptionId, {
        subscription: subscriptionId,
        sessionId,
        createdAt: Date.now(),
        batches: 1,
        compactions: 0,
        ...(current === undefined ? {} : { previous: current.sessionId }),
      })
      return current?.sessionId
    })
    this.ctx.logger.info(`fork-event-bus: Session ${sessionId} is now the persistent Session of ${subscriptionId} (${delivery})${previous === undefined ? '' : `, replacing ${previous}`}`)
    if (previous !== undefined) await this.archive(previous, subscriptionId)
  }

  /** Archive a replaced persistent Session; its log stays readable in the Web UI's archive. */
  private async archive(sessionId: string, subscriptionId: string): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      this.ctx.logger.warn(`fork-event-bus: replaced Session ${sessionId} of ${subscriptionId} is not archived: no workspaceRegistry service is mounted`)
      return
    }
    try {
      await registry.archiveSession(sessionId as SessionId)
      this.ctx.logger.info(`fork-event-bus: archived replaced Session ${sessionId} of ${subscriptionId}`)
    } catch (error: unknown) {
      this.ctx.logger.warn(`fork-event-bus: replaced Session ${sessionId} of ${subscriptionId} is not archived: ${errorText(error)}`)
    }
  }

  /** Keep the latest compaction summary of a persistent Session for its rollover, and count compactions. */
  private async recordCompaction(sessionId: string, summary: string | undefined): Promise<void> {
    const domain = await this.ready
    await this.serialize(async () => {
      const table = domain.table('persistent')
      const current = rowsOf(table).find(record => record.sessionId === sessionId)
      if (current === undefined) return
      await table.put(current.subscription, {
        ...current,
        compactions: current.compactions + 1,
        ...(summary === undefined ? {} : { lastSummary: summary }),
      })
      this.ctx.logger.info(`fork-event-bus: persistent Session ${sessionId} of ${current.subscription} compacted (#${current.compactions + 1}${summary === undefined ? ', no summary text' : `, ${summary.length}-char summary kept for the rollover`})`)
    })
  }

  /** Merge fields into one stored batch; a pruned batch is ignored. */
  private markBatch(id: string, patch: Partial<Pick<BatchRecord, 'status' | 'error' | 'sessionId' | 'outcome' | 'silent' | 'delivery'>>): Promise<void> {
    return this.serialize(async () => {
      const domain = await this.ready
      const batches = domain.table('batches')
      const current = batches.get(id)
      if (current === undefined) return
      await batches.put(id, { ...current, ...patch })
    })
  }

  /** Webhook rule body: rebuild the Session request from the subscription that produced the delivery. */
  private sessionRequest(delivery: Readonly<VerifiedWebhookDelivery<typeof FORK_EVENT_KIND>>): WebhookSessionRequest | null {
    const subscription = this.subscriptionById(delivery.source)
    if (subscription?.action !== 'session' || subscription.session === undefined) return null
    const parsed = deliveryEventSchema.safeParse(delivery.event)
    if (!parsed.success) {
      this.ctx.logger.warn(`fork-event-bus: delivery ${delivery.deliveryId} carries a malformed event`)
      return null
    }
    return buildSessionRequest(subscription.id, subscription.session, parsed.data.events, this.deliveries.get(delivery.deliveryId)?.carried)
  }

  /** Follow bus-started Sessions and unattended reminder turns to their turn end and report the outcome. */
  private observeSession(session: Session, event: SessionEvent): void {
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        // `schedule` is declared by the Host schedule service, which this package does not import.
        const kind: string = source.kind
        if (kind === 'schedule') {
          this.trackReminder(session.id, reminderLabel(messageText(event.data.content)), '⏰')
          return
        }
        // A turn woken by a monitor's output (fork-tool-monitor) is reported like a reminder turn.
        if (kind === 'fork-tool-monitor') {
          this.trackReminder(session.id, monitorLabel(messageText(event.data.content)), '📡')
          return
        }
        if (source.kind !== 'webhook' || source.provider !== FORK_EVENT_KIND || this.tracked.has(session.id)) return
        const batch = this.domain?.table('batches').get(source.deliveryId)
        const pending = this.deliveries.get(source.deliveryId)
        this.deliveries.delete(source.deliveryId)
        const delivery = pending?.delivery ?? batch?.delivery ?? 'fresh'
        this.tracked.set(session.id, {
          batchId: source.deliveryId,
          subscription: source.source,
          title: batch?.title ?? source.source,
          text: undefined,
          delivery,
          toolCalls: new Map(),
          compactions: 0,
          usage: undefined,
        })
        this.track(this.markBatch(source.deliveryId, { sessionId: session.id }))
        if (delivery === 'persistent-new' || delivery === 'rollover') this.track(this.adopt(source.source, session.id, delivery))
        return
      }
      case 'tool/call': {
        const tracked = this.tracked.get(session.id)
        if (tracked !== undefined) tracked.toolCalls.set(event.data.name, (tracked.toolCalls.get(event.data.name) ?? 0) + 1)
        return
      }
      case 'compaction/summary': {
        const tracked = this.tracked.get(session.id)
        if (tracked !== undefined) tracked.compactions += 1
        const summary = event.data.summary.filter(isTextPart).map(part => part.text).join('\n').trim()
        this.track(this.recordCompaction(session.id, summary === '' ? undefined : summary))
        return
      }
      case 'assistant/message': {
        const tracked = this.tracked.get(session.id)
        const reminder = this.reminders.get(session.id)
        if (tracked === undefined && reminder === undefined) return
        if (tracked !== undefined && event.data.usage !== undefined) tracked.usage = event.data.usage
        const text = messageText(event.data.message.content)
        if (text === undefined) return
        if (tracked !== undefined) tracked.text = text
        if (reminder !== undefined) reminder.text = text
        return
      }
      case 'turn/end': {
        const tracked = this.tracked.get(session.id)
        const reminder = this.reminders.get(session.id)
        this.tracked.delete(session.id)
        this.reminders.delete(session.id)
        const outcome = event.data.reason.kind
        const detail = failureDetail(event.data.reason)
        const ended = detail === undefined ? outcome : `${outcome} (${detail})`
        // Whoever stopped the turn (Web UI, WeChat /stop) already knows; a report would only repeat it.
        const stoppedByOwner = event.data.reason.kind === 'aborted' && event.data.reason.reason.kind === 'user'
        // The first-turn result of a bus-started Session already carries a reminder that joined that turn.
        if (tracked !== undefined) {
          this.ctx.logger.info(`fork-event-bus: ${tracked.subscription} batch ${tracked.batchId} in Session ${session.id} (${tracked.delivery}) ended: ${ended}; context ${formatContext(tracked.usage)}; compaction ${tracked.compactions === 0 ? 'did not run' : `ran ${tracked.compactions} time(s)`}; tool calls ${formatToolCalls(tracked.toolCalls)}`)
          this.track(this.reportResult(tracked, outcome, detail, stoppedByOwner))
        } else if (reminder !== undefined) {
          this.ctx.logger.info(`fork-event-bus: reminder turn of Session ${session.id} ended: ${ended}`)
          this.track(this.reportReminder(session.id, reminder, outcome, detail, stoppedByOwner))
        }
        return
      }
      default:
        return
    }
  }

  /** Start following a reminder turn unless reports are off, the bus already follows the Session, or a relay channel claimed it. */
  private trackReminder(sessionId: string, label: string | undefined, icon: string): void {
    if (!this.config.reportScheduledTurns || this.tracked.has(sessionId) || this.reminders.has(sessionId)) return
    const owner = this.relayOwner(sessionId)
    if (owner !== undefined) {
      this.ctx.logger.info(`fork-event-bus: Session ${sessionId} is relayed by ${owner}; its ${icon} turn is not reported`)
      return
    }
    this.reminders.set(sessionId, { label: label ?? `Session ${sessionId}`, icon, text: undefined })
  }

  /** The relay channel that claimed a Session, read from `ctx.ownerRelay` when it is mounted. */
  private relayOwner(sessionId: string): string | undefined {
    const relay = (this.ctx.get as (name: string) => unknown)('ownerRelay') as Partial<OwnerRelayView> | undefined
    return relay?.ownerOf?.(sessionId)
  }

  /** Send a reminder turn's final answer to the notifier unless it is the silent reply. */
  private async reportReminder(
    sessionId: string, reminder: TrackedReminder, outcome: string, detail: string | undefined, stoppedByOwner: boolean,
  ): Promise<void> {
    if (stoppedByOwner) {
      this.ctx.logger.info(`fork-event-bus: reminder turn of Session ${sessionId} was stopped by the owner; nothing sent`)
      return
    }
    if (isSilentReply(reminder.text)) {
      this.ctx.logger.info(`fork-event-bus: reminder turn of Session ${sessionId} answered ${FORK_SILENT_REPLY}; nothing sent`)
      return
    }
    const notifier = this.ctx.get('forkNotifier')
    if (notifier === undefined) return
    const { label, icon, text } = reminder
    await notifier.send(formatReminderNote({ label, icon, outcome, text, url: this.config.webUrl, detail }))
  }

  /** Record the Session outcome and send it to the notifier unless it is the silent reply or the owner stopped it. */
  private async reportResult(tracked: TrackedSession, outcome: string, detail: string | undefined, stoppedByOwner: boolean): Promise<void> {
    const silent = isSilentReply(tracked.text)
    await this.markBatch(tracked.batchId, { status: 'completed', outcome, ...(silent ? { silent } : {}), ...(detail === undefined ? {} : { error: detail }) })
    if (stoppedByOwner) {
      this.ctx.logger.info(`fork-event-bus: Session of ${tracked.batchId} was stopped by the owner; nothing sent`)
      return
    }
    if (silent) {
      this.ctx.logger.info(`fork-event-bus: Session of ${tracked.batchId} answered ${FORK_SILENT_REPLY}; nothing sent`)
      return
    }
    if (!this.config.notifySessionResult) return
    const notifier = this.ctx.get('forkNotifier')
    if (notifier === undefined) return
    await notifier.send(formatResultNote({
      subscription: tracked.subscription,
      title: tracked.title,
      outcome,
      text: tracked.text,
      url: this.config.webUrl,
      detail,
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

export default ForkEventBus
