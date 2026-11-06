/** Durable event bus: dedupe, loop suppression, config and run-time subscriptions, coalescing, rate limits, dispatch, and reports. */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
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
import {
  archiveDomain, autoArchiveSchema, resolveAutoArchive, SessionArchiver, type ArchiveHost, type ArchiveStatus, type AutoArchiveConfig,
  logModifiedAt, type LogLocator, type ProtectionDisposer, type SessionProtector, type SessionRow, type SweepReport,
} from './archive.ts'
import { applyRoutePatch, downstreamOf, findCycle, FLOW_SOURCE, flowResultKind, mergeRoutePatches, resultOf } from './flow.ts'
import { matchesSubscription, suppressionReason } from './match.ts'
import {
  LSY_SILENT_REPLY, batchTitle, buildBatchPrompt, buildSessionRequest, clip, failureDetail, formatBatchNote, formatReminderNote,
  formatResultNote, isSilentReply, monitorLabel, reminderLabel, type CarriedOver,
} from './prompt.ts'
import { busDomain, type BatchRecord, type LsyEventRecord, type PersistentRecord, type RouteOverrideRecord, type SubscriptionRecord } from './storage.ts'
import type {
  FlowChange, FlowEdit, FlowEditMeta, FlowEditResult, FlowRouteView, RoutePatch,
  BatchEvent, BatchSummary, BusStats, LsyDeliveryEvent, LsyEventInput, LsyNotifier, PauseOutcome, PersistentSessionView, PublishOutcome,
  SessionAction, SessionDelivery, SessionHandoverMover, SessionHandoverReport, Subscription, SubscriptionMeta, SubscriptionOrigin,
  SubscriptionView, SuppressConfig, UnsubscribeOutcome,
} from './types.ts'
import { LsyFlowError, LsySubscriptionError, subscriptionProblem } from './validate.ts'

export * from './flow.ts'
export * from './match.ts'
export * from './prompt.ts'
export * from './validate.ts'
export { AUTO_ARCHIVE_DEFAULTS, MAX_RECENT_ARCHIVED, resolveAutoArchive, selectSessions } from './archive.ts'
export type { ArchivedRecord, ArchiveStatus, AutoArchiveConfig, ProtectedSession, ProtectionDisposer, SessionProtector, SessionRow, SweepReport } from './archive.ts'
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
/** Entries of the flow's change history kept. */
const FLOW_CHANGES_KEPT = 200
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
   * turn a lsy-tool-monitor notice wakes, to the notifier.
   */
  reportScheduledTurns: boolean
  /** Events listed in one notify message before the remainder is counted. */
  maxNoteEvents: number
  /** Web UI link attached to Session result messages. */
  webUrl?: string
  /**
   * Archive chat Sessions nobody touched for `inactiveDays` (archive only, never delete). A plain object without this
   * block keeps it off; the schema fills in the defaults.
   */
  autoArchive?: AutoArchiveConfig
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
  quietResult: z.boolean().default(false),
  model: z.object({ provider: z.string(), model: z.string() }),
  project: z.string(),
  persistent: z.object({
    enabled: z.boolean().default(false),
    key: z.union(['subscription', 'subject'] as const).default('subscription'),
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
  autoArchive: autoArchiveSchema,
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
  /** The persistent Session key's subject (`key: subject`). */
  subject?: string
  /** Fixed title of a persistent Session. */
  title?: string
}

/** The stored Session of a persistent subscription, as the Host resolves it now. */
type StoredSession =
  | { kind: 'agent'; agent: { followup(message: ReturnType<typeof createUserMessage>): void } }
  /** Not found or archived: a new Session replaces it, seeded with its last compaction summary when there is one. */
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
 * this one (`failureDetail`, `isSilentReply`, `LsyNotifier`), so the bus reads the service through
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
    if (problem !== undefined) throw new Error(`lsy-event-bus: ${problem}`)
    if (ids.has(subscription.id)) throw new Error(`lsy-event-bus: duplicate subscription id "${subscription.id}"`)
    ids.add(subscription.id)
  }
}

/** When and by whom a configuration route last changed. */
function changedOf(override: RouteOverrideRecord): { at: number; by?: string } {
  return { at: override.updatedAt, ...(override.updatedBy === undefined ? {} : { by: override.updatedBy }) }
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
    ...(session.result === undefined ? {} : { result: session.result }),
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.persistent === undefined ? {} : { persistent: session.persistent }),
    ...(session.project === undefined ? {} : { project: session.project }),
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

/**
 * The `persistent` table key of a subscription's Session: the subscription id, or `<id>|<subject>` for `key: subject`.
 * @param subscription - subscription id.
 * @param subject - the events' subject, for `key: subject`.
 * @returns the table key.
 */
export function persistentKey(subscription: string, subject?: string): string {
  return subject === undefined ? subscription : `${subscription}|${subject}`
}

/** What {@link ensureProject} needs of `ctx.workspaceRegistry`. */
export interface ProjectRegistry {
  resolveByPath(path: string): Promise<{ readonly path: string; readonly title: string } | undefined>
  create(path: string, title?: string): Promise<{ readonly path: string; readonly title: string }>
}

/**
 * Make sure a directory exists and is a Web UI project (Workspace), so the Sessions that run there are grouped under it.
 * An existing project keeps its title (the owner may have renamed it); a new one is titled `name`.
 * @param registry - `ctx.workspaceRegistry`, or undefined to only create the directory.
 * @param path - absolute directory.
 * @param name - title of a new project.
 * @returns `created`, `existing`, or `directory-only` when no registry is mounted.
 */
export async function ensureProject(registry: ProjectRegistry | undefined, path: string, name: string): Promise<'created' | 'existing' | 'directory-only'> {
  await mkdir(path, { recursive: true })
  if (registry === undefined) return 'directory-only'
  if (await registry.resolveByPath(path) !== undefined) return 'existing'
  await registry.create(path, name)
  return 'created'
}

/** The public fields of a stored persistent Session. */
function persistentView(record: PersistentRecord): PersistentSessionView {
  return {
    subscription: record.subscription,
    ...(record.subject === undefined ? {} : { subject: record.subject }),
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
 * Durable event bus. Sensors publish; subscriptions from the configuration or
 * created at run time decide which events reach which actuator; the bus owns
 * dedupe, loop suppression, coalescing, and rate limits so actuators never
 * see raw sensor traffic.
 */
export class LsyEventBus extends Service {
  static inject = ['timer', 'storageDomain']
  static Config = Config

  private readonly ready: Promise<Domain<typeof busDomain>>
  private domain: Domain<typeof busDomain> | undefined
  private readonly configSubscriptions: ReadonlyMap<string, Subscription>
  private readonly flushTimers = new Map<string, { at: number; dispose: () => void }>()
  private readonly tracked = new Map<string, TrackedSession>()
  private readonly deliveries = new Map<string, PendingDelivery>()
  private readonly projects = new Map<string, Promise<void>>()
  private readonly reminders = new Map<string, TrackedReminder>()
  private readonly inflight = new Set<Promise<void>>()
  /** When a flush last met its subscription's hourly limit, for `stats()`; not stored. */
  private readonly rateLimitHits: number[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false
  private readonly archiver: SessionArchiver
  /** Handover movers in registration order. */
  private readonly movers: Array<{ kind: string; move: SessionHandoverMover }> = []

  /**
   * @param ctx - Host services owning timers, storage, and Session events.
   * @param config - Subscriptions, suppression, and retention.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'lsyEventBus')
    assertConfig(config)
    this.configSubscriptions = new Map(config.subscriptions.map(subscription => [subscription.id, subscription]))
    this.ready = ctx.storageDomain.open(busDomain)
    this.archiver = new SessionArchiver(
      resolveAutoArchive(config.autoArchive), this.archiveHost(), ctx.logger,
      (callback, ms) => ctx.timeout(callback, ms), () => ctx.storageDomain.open(archiveDomain),
    )

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const cleanup = ctx.effect(() => async () => {
        this.stopping = true
        for (const timer of this.flushTimers.values()) timer.dispose()
        this.flushTimers.clear()
        await this.archiver.stop()
        await Promise.allSettled([...this.inflight])
        await this.chain // serialize() keeps the chain itself non-rejecting.
        await domain.close()
      }, 'lsyEventBus.lifecycle()')
      await this.restorePending()
      await this.archiver.start()
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
      const paused = this.pausedIds()
      const matching = reason === undefined
        ? this.allSubscriptions().filter(subscription => !paused.has(subscription.id) && matchesSubscription(subscription, input))
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
   * {@link ensureProject} with this Host's Workspace registry, once per path and process.
   * @param path - absolute directory.
   * @param name - title of a new project.
   * @returns resolves once the directory exists and is a project; a registry failure is logged, not thrown.
   */
  ensureProject(path: string, name: string): Promise<void> {
    const known = this.projects.get(path)
    if (known !== undefined) return known
    const work = ensureProject(this.ctx.get('workspaceRegistry'), path, name).then(
      (outcome) => { this.ctx.logger.info(`lsy-event-bus: project ${JSON.stringify(name)} at ${path}: ${outcome}`) },
      (error: unknown) => {
        this.projects.delete(path)
        this.ctx.logger.warn(`lsy-event-bus: project ${JSON.stringify(name)} at ${path} not ensured: ${errorText(error)}`)
      },
    )
    this.projects.set(path, work)
    return work
  }

  /**
   * Add a routing rule at run time. It is stored durably and survives restarts.
   * @param subscription - rule; validated like a configuration row.
   * @param meta - who created the subscription, e.g. the creating Session.
   * @returns the stored subscription with its (empty) status.
   * @throws {LsySubscriptionError} `invalid_subscription` for a rule the bus cannot route, or `duplicate_id`
   * for an id the configuration or another stored subscription already uses.
   */
  async subscribe(subscription: Subscription, meta: SubscriptionMeta = {}): Promise<SubscriptionView> {
    const problem = subscriptionProblem(subscription)
    if (problem !== undefined) throw new LsySubscriptionError('invalid_subscription', `lsy-event-bus: ${problem}`)
    return this.serialize(async () => {
      const domain = await this.ready
      const table = domain.table('subscriptions')
      if (this.configSubscriptions.has(subscription.id) || table.get(subscription.id) !== undefined) {
        const owner = this.configSubscriptions.has(subscription.id) ? 'the bus configuration' : 'another subscription'
        throw new LsySubscriptionError('duplicate_id', `lsy-event-bus: subscription id "${subscription.id}" is already used by ${owner}`)
      }
      const record = toRecord(subscription, meta, Date.now())
      await table.put(record.id, record)
      this.ctx.logger.info(`lsy-event-bus: subscribed ${record.id} (${record.action}; kinds [${record.kinds.join(', ')}]; subjects [${record.subjects.join(', ')}])${record.createdBy === undefined ? '' : ` for Session ${record.createdBy}`}`)
      const [view] = this.views([record])
      /* v8 ignore next -- views() maps each record to one view. */
      if (view === undefined) throw new Error(`lsy-event-bus: no view for ${record.id}`)
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
      this.ctx.logger.info(`lsy-event-bus: unsubscribed ${id}; dropped ${dropped} pending event(s)`)
      return 'removed'
    })
  }

  /**
   * Pause or resume a run-time subscription. A paused subscription stops matching new events (they are
   * `unmatched` for it) and holds the events already pending; resuming flushes those after the usual
   * coalesce window. The flag is stored, so it survives restarts.
   * @param id - subscription id.
   * @param paused - true to pause, false to resume.
   * @returns `ok`, `not_found`, or `config_owned` for an id the configuration owns.
   */
  async setPaused(id: string, paused: boolean): Promise<PauseOutcome> {
    if (this.configSubscriptions.has(id)) return 'config_owned'
    return this.serialize(async () => {
      const domain = await this.ready
      const table = domain.table('subscriptions')
      const record = table.get(id)
      if (record === undefined) return 'not_found'
      if ((record.paused === true) === paused) return 'ok'
      const { paused: _was, ...rest } = record
      await table.put(id, paused ? { ...rest, paused: true } : rest)
      if (paused) {
        this.flushTimers.get(id)?.dispose()
        this.flushTimers.delete(id)
      } else if ([...domain.table('pending').entries()].some(([, row]) => row.subscription === id)) {
        this.scheduleFlush(id, Date.now() + record.coalesceMs)
      }
      this.ctx.logger.info(`lsy-event-bus: ${paused ? 'paused' : 'resumed'} ${id}`)
      return 'ok'
    })
  }

  /**
   * The whole notification flow: every route with where its answer goes and which routes take it, including a configuration route
   * taken out, so it can be seen and put back.
   * @returns routes in matching order, then the ones taken out.
   */
  flowRoutes(): FlowRouteView[] {
    const active = this.allSubscriptions()
    const routes: FlowRouteView[] = this.listSubscriptions().map(view => ({
      ...view,
      ...(view.action === 'session' ? { result: resultOf(view) } : {}),
      downstream: downstreamOf(view, active),
    }))
    const removed = rowsOf(this.domain?.table('route_overrides')).filter(row => row.removed === true)
    for (const row of removed) {
      const route = this.configSubscriptions.get(row.id)
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
   * Changes of the flow.
   * @param limit - most entries.
   * @returns the newest first.
   */
  flowHistory(limit = FLOW_CHANGES_KEPT): FlowChange[] {
    return rowsOf(this.domain?.table('flow_changes')).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0, limit) as FlowChange[]
  }

  /**
   * Change the notification flow at run time. It is stored, so a restart or a deploy keeps it; a configuration route keeps its bundle
   * row and `reset` puts it back.
   * @param edit - the change.
   * @param meta - who made it and why.
   * @returns the route as it stands, the history entry, and anything worth a second look.
   * @throws {LsyFlowError} when the change would leave a route the bus cannot run, or a loop.
   */
  async editFlow(edit: FlowEdit, meta: FlowEditMeta = {}): Promise<FlowEditResult> {
    return this.serialize(async () => {
      const domain = await this.ready
      const before = this.subscriptionById(edit.id)
      await this.applyFlowEdit(domain, edit, before, meta)
      const after = this.subscriptionById(edit.id)
      const now = Date.now()
      const change: FlowChange = {
        id: `${String(now).padStart(15, '0')}-${String(domain.table('flow_changes').size).padStart(6, '0')}`,
        at: now,
        op: edit.op,
        route: edit.id,
        ...(meta.by === undefined ? {} : { by: meta.by }),
        ...(meta.note === undefined ? {} : { note: meta.note }),
        ...(before === undefined ? {} : { before: JSON.stringify(before) }),
        ...(after === undefined ? {} : { after: JSON.stringify(after) }),
      }
      const changes = domain.table('flow_changes')
      await changes.put(change.id, change)
      for (const old of this.flowHistory(Number.MAX_SAFE_INTEGER).slice(FLOW_CHANGES_KEPT)) await changes.delete(old.id)
      const who = meta.by === undefined ? '' : ` by ${meta.by}`
      this.ctx.logger.info(`lsy-event-bus: flow ${edit.op} ${edit.id}${who}${meta.note === undefined ? '' : `: ${meta.note}`}`)
      const route = this.flowRoutes().find(row => row.id === edit.id) ?? null
      const warnings = route?.result === 'event' && route.downstream.length === 0
        ? [`No route takes ${flowResultKind(edit.id)} yet, so its answers go to the notifier until one does.`]
        : []
      return { route, change, warnings }
    })
  }

  /** Apply one change to the stored rows; runs inside the storage chain. */
  private async applyFlowEdit(
    domain: Domain<typeof busDomain>, edit: FlowEdit, before: Subscription | undefined, meta: FlowEditMeta,
  ): Promise<void> {
    const overrides = domain.table('route_overrides')
    const stored = domain.table('subscriptions')
    const configured = this.configSubscriptions.has(edit.id)
    const override = overrides.get(edit.id)
    const row = stored.get(edit.id)
    const stamp = { updatedAt: Date.now(), ...(meta.by === undefined ? {} : { updatedBy: meta.by }) }
    const known = configured || row !== undefined
    if (edit.op === 'reset') {
      if (!configured) throw new LsyFlowError('not_config', `"${edit.id}" is not a configuration route; set or remove it instead.`)
      this.assertNoCycle(this.allSubscriptions().filter(route => route.id !== edit.id), this.configSubscriptions.get(edit.id))
      await overrides.delete(edit.id)
      await this.rearm(domain, edit.id)
      return
    }
    if (edit.op !== 'set' && !known) throw new LsyFlowError('not_found', `No route has id "${edit.id}"; flow_read lists them.`)
    if (edit.op === 'remove') {
      await (configured ? overrides.put(edit.id, { ...override, id: edit.id, removed: true, ...stamp }) : stored.delete(edit.id))
      await this.dropPending(domain, edit.id)
      return
    }
    if (edit.op === 'pause' || edit.op === 'resume') {
      const paused = edit.op === 'pause' ? { paused: true as const } : {}
      if (configured) {
        const { paused: _was, ...rest } = override ?? { id: edit.id, ...stamp }
        await overrides.put(edit.id, { ...rest, ...paused, ...stamp })
      } else if (row !== undefined) {
        const { paused: _was, ...rest } = row
        await stored.put(edit.id, { ...rest, ...paused })
      }
      if (edit.op === 'pause') {
        this.flushTimers.get(edit.id)?.dispose()
        this.flushTimers.delete(edit.id)
      } else {
        await this.rearm(domain, edit.id)
      }
      return
    }
    const original = this.configSubscriptions.get(edit.id)
    const base: Subscription = (original === undefined ? before : applyRoutePatch(original, (override?.patch ?? {}) as RoutePatch))
      ?? { id: edit.id, sources: [], kinds: [], subjects: [], action: 'notify', coalesceMs: 60_000, maxPerHour: 12 }
    const next = applyRoutePatch(base, edit.patch)
    const problem = subscriptionProblem(next)
    if (problem !== undefined) throw new LsyFlowError('invalid_route', `lsy-event-bus: ${problem}`)
    if (next.sources.length === 0 && next.kinds.length === 0) {
      throw new LsyFlowError('invalid_route', `Route "${edit.id}" needs sources or kinds; with neither it takes every event of every service.`)
    }
    this.assertNoCycle(this.allSubscriptions().filter(route => route.id !== edit.id), next)
    if (configured) {
      const { removed: _removed, ...rest } = override ?? { id: edit.id, ...stamp }
      await overrides.put(edit.id, { ...rest, patch: mergeRoutePatches(override?.patch as RoutePatch | undefined, edit.patch), ...stamp })
    } else {
      const createdBy = row === undefined ? meta.by : row.createdBy
      const record = toRecord(next, createdBy === undefined ? {} : { createdBy }, row?.createdAt ?? Date.now())
      await stored.put(edit.id, row?.paused === true ? { ...record, paused: true } : record)
    }
  }

  /** Refuse a set of routes in which an answer could feed itself. */
  private assertNoCycle(others: readonly Subscription[], route: Subscription | undefined): void {
    const loop = findCycle(route === undefined ? others : [...others, route])
    if (loop === undefined) return
    throw new LsyFlowError('cycle', `That change makes a loop: ${loop.join(' → ')}. An answer must not reach its own route again.`)
  }

  /** Drop a route's pending events and its flush timer. */
  private async dropPending(domain: Domain<typeof busDomain>, id: string): Promise<void> {
    this.flushTimers.get(id)?.dispose()
    this.flushTimers.delete(id)
    const pending = domain.table('pending')
    for (const [key, row] of [...pending.entries()]) if (row.subscription === id) await pending.delete(key)
  }

  /** Arm the flush of a route that takes events again and has some waiting. */
  private async rearm(domain: Domain<typeof busDomain>, id: string): Promise<void> {
    const route = this.subscriptionById(id)
    if (route === undefined || this.pausedIds().has(id)) return
    const waiting = [...domain.table('pending').entries()].some(([, row]) => row.subscription === id)
    if (waiting) this.scheduleFlush(id, Date.now() + route.coalesceMs)
  }

  /**
   * Keep a plugin's Sessions out of the auto-archive sweep (for example the QQ resident group Sessions or the WeChat chat
   * Session). `check` runs only for Sessions that are otherwise due; return `true` (or a short reason) to keep one. A throw keeps it.
   * Register inside an effect so a reload withdraws the claim:
   * `ctx.inject(['lsyEventBus'], scoped => {
   *   scoped.effect(() => scoped.lsyEventBus.protectSessions('qq', check), 'qq.archiveProtection()')
   * })`.
   * @param label - skip category name shown in the sweep log and Settings, for example `qq`.
   * @param check - the claim.
   * @returns the disposer; the bus drops every claim when it stops.
   */
  protectSessions(label: string, check: SessionProtector): ProtectionDisposer {
    return this.archiver.protect(label, check)
  }

  /**
   * Register a mover that runs on every {@link handOverSessions}, for a plugin whose bindings name a Session
   * (what it delivers to it, or records as created by it). Register inside an effect so a reload withdraws it:
   * `ctx.inject(['lsyEventBus'], scoped => { scoped.effect(() => scoped.lsyEventBus.registerHandover('monitor', move)) })`.
   * @param kind - binding kind reported with what the mover moved, for example `monitor`.
   * @param move - the mover.
   * @returns the disposer.
   */
  registerHandover(kind: string, move: SessionHandoverMover): () => void {
    const entry = { kind, move }
    this.movers.push(entry)
    return () => {
      const index = this.movers.indexOf(entry)
      if (index >= 0) this.movers.splice(index, 1)
    }
  }

  /**
   * Move every binding of some Sessions to another Session, for a conversation that continues in a new Session
   * (WeChat `/new`): the run-time subscriptions they created now name `to` as their creator, then each registered
   * mover moves its own. A failing mover is logged and reported, and the others still run; a repeat moves nothing
   * the first call moved.
   * @param from - Sessions whose bindings move; `to` itself is ignored.
   * @param to - Session that takes them over.
   * @returns what moved, by kind (kinds that moved nothing are left out), and which movers failed.
   */
  async handOverSessions(from: readonly string[], to: string): Promise<SessionHandoverReport> {
    const sources: ReadonlySet<string> = new Set(from.filter(id => id !== to))
    if (sources.size === 0) return { moved: [], failed: [] }
    const moved: Array<SessionHandoverReport['moved'][number]> = []
    const failed: Array<SessionHandoverReport['failed'][number]> = []
    const subscriptions = await this.serialize(async () => {
      const table = (await this.ready).table('subscriptions')
      const items = []
      for (const record of this.storedSubscriptions()) {
        if (record.createdBy === undefined || !sources.has(record.createdBy)) continue
        await table.put(record.id, { ...record, createdBy: to })
        items.push({ id: record.id, label: record.id })
      }
      return items
    })
    if (subscriptions.length > 0) moved.push({ kind: 'subscription', items: subscriptions })
    for (const { kind, move } of [...this.movers]) {
      try {
        const items = await move(sources, to)
        if (items.length > 0) moved.push({ kind, items: [...items] })
      } catch (error: unknown) {
        this.ctx.logger.warn(`lsy-event-bus: handover mover ${kind} failed: ${errorText(error)}`)
        failed.push({ kind, error: errorText(error) })
      }
    }
    this.ctx.logger.info(`lsy-event-bus: handed Session(s) ${[...sources].join(', ')} over to ${to}: ${moved.length === 0 ? 'nothing to move' : moved.map(part => `${part.items.length} ${part.kind}`).join(', ')}${failed.length === 0 ? '' : `; ${failed.length} mover(s) failed`}`)
    return { moved, failed }
  }

  /**
   * The auto-archive schedule, protectors, last sweep, and recently archived Sessions, for health and Settings.
   * @returns snapshot.
   */
  archiveStatus(): ArchiveStatus {
    return this.archiver.status()
  }

  /**
   * Run an auto-archive sweep now (Settings "sweep now"); joins a sweep already running.
   * @param options - `dryRun: true` lists what a sweep would archive without archiving.
   * @returns the sweep report.
   */
  sweepArchive(options: { dryRun?: boolean } = {}): Promise<SweepReport> {
    return this.archiver.sweep('manual', options)
  }

  /** What the sweep reads from the Host, and which Sessions the bus itself keeps out of it. */
  private archiveHost(): ArchiveHost {
    const ctx = this.ctx
    return {
      now: () => Date.now(),
      archivedIds: () => new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? []),
      pinnedIds: () => new Set(ctx.get('workspaceRegistry')?.pinnedSessionIds ?? []),
      list: async (signal): Promise<readonly SessionRow[]> => {
        const controller = ctx.get('sessionController')
        if (controller === undefined) throw new Error('no sessionController service is mounted')
        const { items } = await controller.list({}, signal)
        const persistence = (ctx.get.bind(ctx) as (name: string) => unknown)('sessionPersistence') as LogLocator | undefined
        const rows: SessionRow[] = []
        for (const item of items) {
          const title = item.projections?.values.title
          // Without the list-metadata projection, updatedAt is the creation time and tells nothing about use: read the log's
          // last write instead, and when that is unavailable too the Session is never archived.
          const known = item.projections?.values.sessionListMetadata !== undefined
          const written = known ? undefined : await logModifiedAt(persistence, item.sessionId)
          rows.push({
            id: item.sessionId,
            updatedAt: written === undefined ? item.updatedAt : Math.max(item.updatedAt, written),
            running: item.running,
            subagent: item.origin === 'subagent',
            activityUnknown: !known && written === undefined,
            ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
            ...(typeof title === 'string' && title !== '' ? { title } : {}),
          })
        }
        return rows
      },
      archive: async (id) => {
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) throw new Error('no workspaceRegistry service is mounted')
        await registry.archiveSession(id as SessionId)
      },
      builtinProtected: () => {
        const kept = new Map<string, string>()
        for (const id of this.tracked.keys()) kept.set(id, 'running')
        for (const id of this.reminders.keys()) kept.set(id, 'running')
        for (const view of this.persistentSessions()) kept.set(view.sessionId, 'persistent')
        for (const record of this.storedSubscriptions()) if (record.createdBy !== undefined) kept.set(record.createdBy, 'subscription')
        return kept
      },
    }
  }

  /**
   * Counters for the last rolling hour and the current queue, for status pages.
   * @returns snapshot; before the storage domain opens, only the configuration rows are counted.
   */
  stats(): BusStats {
    const since = Date.now() - HOUR_MS
    const stored = this.storedSubscriptions()
    while (this.rateLimitHits.length > 0 && (this.rateLimitHits[0] ?? since) <= since) this.rateLimitHits.shift()
    return {
      subscriptions: this.config.subscriptions.length + stored.length,
      paused: stored.filter(record => record.paused === true).length,
      pending: this.pendingCount(),
      eventsLastHour: this.events().filter(event => event.receivedAt > since).length,
      batchesLastHour: this.batches().filter(batch => batch.createdAt > since).length,
      rateLimitHitsLastHour: this.rateLimitHits.length,
    }
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

  /** Ids of paused subscriptions of either origin. */
  private pausedIds(): ReadonlySet<string> {
    return new Set([
      ...this.storedSubscriptions().filter(record => record.paused === true).map(record => record.id),
      ...rowsOf(this.domain?.table('route_overrides')).filter(row => row.paused === true).map(row => row.id),
    ])
  }

  /** A configuration route with its run-time change laid over it; undefined once it is taken out. */
  private effectiveConfig(route: Subscription): Subscription | undefined {
    const override = this.domain?.table('route_overrides').get(route.id)
    if (override?.removed === true) return undefined
    return override?.patch === undefined ? route : applyRoutePatch(route, override.patch as RoutePatch)
  }

  /** Configuration routes as they stand at run time. */
  private configRoutes(): Subscription[] {
    return this.config.subscriptions.flatMap((route) => {
      const effective = this.effectiveConfig(route)
      return effective === undefined ? [] : [effective]
    })
  }

  /** Configuration and run-time subscriptions, in matching order. */
  private allSubscriptions(): Subscription[] {
    return [...this.configRoutes(), ...this.storedSubscriptions().map(toSubscription)]
  }

  /** One subscription by id from either origin. */
  private subscriptionById(id: string): Subscription | undefined {
    const configured = this.configSubscriptions.get(id)
    if (configured !== undefined) return this.effectiveConfig(configured)
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
      const override = origin === 'config' ? this.domain?.table('route_overrides').get(subscription.id) : undefined
      const timer = this.flushTimers.get(subscription.id)
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
          ...(timer === undefined ? {} : { nextFlushAt: timer.at }),
          ...(last === undefined ? {} : { lastBatch: summarize(last) }),
        },
      }
    }
    return [
      ...(withConfig ? this.configRoutes().map(subscription => view(subscription, 'config')) : []),
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
        const subscription = this.subscriptionById(row.subscription)
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
    const subscription = this.subscriptionById(subscriptionId)
    /* v8 ignore next -- a flush queued behind teardown or behind the unsubscribe() that removed its subscription. */
    if (subscription === undefined || this.stopping) return undefined
    const domain = await this.ready
    // A paused subscription keeps its pending rows; resuming arms the flush again.
    if (this.pausedIds().has(subscriptionId)) return undefined
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

    const session = subscription.session
    if (session?.persistent?.enabled === true) {
      await this.actuatePersistent({ batch, events, subscription }, session)
      return
    }
    await this.dispatchSession({ batch, events, subscription }, 'fresh')
  }

  /** Start a new Session for one batch through the webhook runtime. */
  private async dispatchSession(
    { batch, events, subscription }: FlushedBatch, delivery: SessionDelivery, extra: Omit<PendingDelivery, 'delivery'> = {},
  ): Promise<void> {
    const runtime = this.ctx.get('webhookRuntime')
    if (runtime === undefined) {
      await this.markBatch(batch.id, { status: 'failed', error: 'no webhookRuntime service is mounted', delivery })
      return
    }
    const project = subscription.session?.project
    if (project !== undefined && project !== '' && subscription.session !== undefined) await this.ensureProject(subscription.session.workspacePath, project)
    this.deliveries.set(batch.id, { delivery, ...extra })
    try {
      runtime.dispatch({
        kind: LSY_EVENT_KIND,
        source: subscription.id as WebhookSourceId,
        deliveryId: batch.id as WebhookDeliveryId,
        event: { subscription: subscription.id, events },
        receivedAt: batch.createdAt,
      })
      await this.markBatch(batch.id, { delivery })
    } catch (error: unknown) {
      this.deliveries.delete(batch.id)
      this.ctx.logger.warn(`lsy-event-bus: session dispatch ${batch.id} failed: ${errorText(error)}`)
      await this.markBatch(batch.id, { status: 'failed', error: errorText(error), delivery })
    }
  }

  /**
   * Deliver one batch of a persistent subscription. With `key: subject` the batch is split by event subject and each
   * part goes to that subject's Session; the first part keeps the batch id, the others get child batch rows.
   */
  private async actuatePersistent(flushed: FlushedBatch, session: SessionAction): Promise<void> {
    if (session.persistent?.key !== 'subject') {
      await this.deliverPersistent(flushed, session, undefined)
      return
    }
    const groups = new Map<string, BatchEvent[]>()
    for (const event of flushed.events) groups.set(event.subject, [...groups.get(event.subject) ?? [], event])
    const parts = [...groups]
    const prefix = session.titlePrefix ?? flushed.subscription.id
    const batches = await this.serialize(async () => {
      const domain = await this.ready
      const table = domain.table('batches')
      return Promise.all(parts.map(async ([subject, events], index) => {
        const row: BatchRecord = {
          ...flushed.batch,
          id: index === 0 ? flushed.batch.id : `${flushed.batch.id}.${index}`,
          title: batchTitle(prefix, events),
          eventIds: events.map(event => event.id),
          subject,
          ...(index === 0 ? {} : { parent: flushed.batch.id }),
        }
        await table.put(row.id, row)
        return row
      }))
    })
    if (parts.length > 1) this.ctx.logger.info(`lsy-event-bus: batch ${flushed.batch.id} of ${flushed.subscription.id} split by subject into ${parts.length}: ${parts.map(([subject, events]) => `${subject} (${events.length})`).join(', ')}`)
    for (const [index, [subject, events]] of parts.entries()) {
      // One row per part was written above.
      const batch = batches[index] as BatchRecord
      await this.deliverPersistent({ batch, events, subscription: flushed.subscription }, session, subject)
    }
  }

  /**
   * Deliver one batch to its persistent Session: a new turn of the stored Session, a new Session when there is none,
   * a seeded new Session at a rollover or when the stored one is gone, or a one-off Session when it cannot take a turn.
   */
  private async deliverPersistent(flushed: FlushedBatch, session: SessionAction, subject: string | undefined): Promise<void> {
    const { batch, events, subscription } = flushed
    /* v8 ignore next -- actuate() checked enabled; schemastery materializes the defaults. */
    const persistent = session.persistent ?? { enabled: true, key: 'subscription', rolloverDays: 30, maxSeedChars: 20_000 }
    const key = persistentKey(subscription.id, subject)
    const label = subject === undefined ? subscription.id : `${subscription.id} (${subject})`
    const prefix = session.titlePrefix ?? subscription.id
    const fresh = { ...(subject === undefined ? {} : { subject }), title: clip(subject === undefined ? prefix : `${prefix}: ${subject}`, 119) }
    const domain = await this.ready
    const stored = domain.table('persistent').get(key)
    if (stored === undefined) {
      this.ctx.logger.info(`lsy-event-bus: ${label} has no persistent Session yet; batch ${batch.id} starts one`)
      await this.dispatchSession(flushed, 'persistent-new', fresh)
      return
    }
    const seed = (): CarriedOver => ({
      sessionId: stored.sessionId,
      summary: stored.lastSummary === undefined ? undefined : clip(stored.lastSummary, persistent.maxSeedChars),
    })
    const ageDays = (Date.now() - stored.createdAt) / DAY_MS
    if (ageDays >= persistent.rolloverDays) {
      const carried = seed()
      this.ctx.logger.info(`lsy-event-bus: ${label} rolls over Session ${stored.sessionId} after ${ageDays.toFixed(1)} day(s) and ${stored.batches} batch(es); ${carried.summary === undefined ? 'it left no compaction summary' : `its ${carried.summary.length}-char compaction summary is carried over`}`)
      await this.dispatchSession(flushed, 'rollover', { ...fresh, carried })
      return
    }
    const resolved = await this.resolveStored(stored.sessionId)
    if (resolved.kind === 'gone') {
      if (stored.lastSummary !== undefined) {
        this.ctx.logger.info(`lsy-event-bus: persistent Session ${stored.sessionId} of ${label} is ${resolved.reason}; batch ${batch.id} starts a new one seeded with its last compaction summary`)
        await this.dispatchSession(flushed, 'rollover', { ...fresh, carried: seed() })
        return
      }
      this.ctx.logger.info(`lsy-event-bus: persistent Session ${stored.sessionId} of ${label} is ${resolved.reason}; batch ${batch.id} starts a new one`)
      await this.serialize(async () => { await domain.table('persistent').delete(key) })
      await this.dispatchSession(flushed, 'persistent-new', fresh)
      return
    }
    if (resolved.kind === 'unavailable') {
      this.ctx.logger.warn(`lsy-event-bus: persistent Session ${stored.sessionId} of ${label} cannot take batch ${batch.id} now (${resolved.reason}); it gets a one-off Session`)
      await this.dispatchSession(flushed, 'detached')
      return
    }
    const prompt = buildBatchPrompt(subscription.id, session, events)
    this.deliveries.set(batch.id, { delivery: 'persistent', ...(subject === undefined ? {} : { subject }) })
    try {
      resolved.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        // The same source the webhook runtime gives a new Session's first message, so turn-origin checks
        // (lsy-taint: `event`) and this bus's own tracking treat both alike.
        source: {
          kind: 'webhook',
          provider: LSY_EVENT_KIND,
          source: subscription.id as WebhookSourceId,
          deliveryId: batch.id as WebhookDeliveryId,
          ruleId: LSY_EVENT_RULE_ID as WebhookRuleId,
          form: 'notice',
          summary: boundContextSummary(`${LSY_EVENT_KIND} batch of ${label} for its persistent Session`),
        },
      }))
    } catch (error: unknown) {
      this.deliveries.delete(batch.id)
      this.ctx.logger.warn(`lsy-event-bus: batch ${batch.id} did not enter persistent Session ${stored.sessionId}: ${errorText(error)}`)
      await this.markBatch(batch.id, { status: 'failed', error: errorText(error), delivery: 'persistent' })
      return
    }
    await this.markBatch(batch.id, { delivery: 'persistent', sessionId: stored.sessionId })
    const count = await this.serialize(async () => {
      const current = domain.table('persistent').get(key)
      /* v8 ignore next -- a rollover or replacement recorded between the follow-up and this count. */
      if (current?.sessionId !== stored.sessionId) return stored.batches + 1
      await domain.table('persistent').put(key, { ...current, batches: current.batches + 1 })
      return current.batches + 1
    })
    this.ctx.logger.info(`lsy-event-bus: batch ${batch.id} (${events.length} event(s)) entered persistent Session ${stored.sessionId} of ${label} as its batch #${count} (${ageDays.toFixed(1)} day(s) old, rollover at ${persistent.rolloverDays})`)
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
  private async adopt(subscriptionId: string, sessionId: string, delivery: SessionDelivery, subject: string | undefined): Promise<void> {
    const domain = await this.ready
    const key = persistentKey(subscriptionId, subject)
    const adopted = await this.serialize(async () => {
      const table = domain.table('persistent')
      const current = table.get(key)
      if (current?.sessionId === sessionId) return undefined
      await table.put(key, {
        subscription: subscriptionId,
        ...(subject === undefined ? {} : { subject }),
        sessionId,
        createdAt: Date.now(),
        batches: 1,
        compactions: 0,
        ...(current === undefined ? {} : { previous: current.sessionId }),
      })
      return { previous: current?.sessionId }
    })
    if (adopted === undefined) return
    const { previous } = adopted
    const label = subject === undefined ? subscriptionId : `${subscriptionId} (${subject})`
    this.ctx.logger.info(`lsy-event-bus: Session ${sessionId} is now the persistent Session of ${label} (${delivery})${previous === undefined ? '' : `, replacing ${previous}`}`)
    if (previous !== undefined) await this.archive(previous, label)
  }

  /** Archive a replaced persistent Session; its log stays readable in the Web UI's archive. */
  private async archive(sessionId: string, subscriptionId: string): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      this.ctx.logger.warn(`lsy-event-bus: replaced Session ${sessionId} of ${subscriptionId} is not archived: no workspaceRegistry service is mounted`)
      return
    }
    try {
      await registry.archiveSession(sessionId as SessionId)
      this.ctx.logger.info(`lsy-event-bus: archived replaced Session ${sessionId} of ${subscriptionId}`)
    } catch (error: unknown) {
      this.ctx.logger.warn(`lsy-event-bus: replaced Session ${sessionId} of ${subscriptionId} is not archived: ${errorText(error)}`)
    }
  }

  /** Keep the latest compaction summary of a persistent Session for its rollover, and count compactions. */
  private async recordCompaction(sessionId: string, summary: string | undefined): Promise<void> {
    const domain = await this.ready
    await this.serialize(async () => {
      const table = domain.table('persistent')
      const current = rowsOf(table).find(record => record.sessionId === sessionId)
      if (current === undefined) return
      await table.put(persistentKey(current.subscription, current.subject), {
        ...current,
        compactions: current.compactions + 1,
        ...(summary === undefined ? {} : { lastSummary: summary }),
      })
      this.ctx.logger.info(`lsy-event-bus: persistent Session ${sessionId} of ${current.subscription} compacted (#${current.compactions + 1}${summary === undefined ? ', no summary text' : `, ${summary.length}-char summary kept for the rollover`})`)
    })
  }

  /** Merge fields into one stored batch; a pruned batch is ignored. */
  private markBatch(id: string, patch: Partial<Pick<BatchRecord, 'status' | 'error' | 'sessionId' | 'outcome' | 'silent' | 'delivery' | 'notSent'>>): Promise<void> {
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
    const subscription = this.subscriptionById(delivery.source)
    if (subscription?.action !== 'session' || subscription.session === undefined) return null
    const parsed = deliveryEventSchema.safeParse(delivery.event)
    if (!parsed.success) {
      this.ctx.logger.warn(`lsy-event-bus: delivery ${delivery.deliveryId} carries a malformed event`)
      return null
    }
    const pending = this.deliveries.get(delivery.deliveryId)
    const request = buildSessionRequest(subscription.id, subscription.session, parsed.data.events, pending?.carried)
    return pending?.title === undefined ? request : { ...request, title: pending.title }
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
        // A turn woken by a monitor's output (lsy-tool-monitor) is reported like a reminder turn.
        if (kind === 'lsy-tool-monitor') {
          this.trackReminder(session.id, monitorLabel(messageText(event.data.content)), '📡')
          return
        }
        if (source.kind !== 'webhook' || source.provider !== LSY_EVENT_KIND || this.tracked.has(session.id)) return
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
        if (delivery === 'persistent-new' || delivery === 'rollover') this.track(this.adopt(source.source, session.id, delivery, pending?.subject ?? batch?.subject))
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
          this.ctx.logger.info(`lsy-event-bus: ${tracked.subscription} batch ${tracked.batchId} in Session ${session.id} (${tracked.delivery}) ended: ${ended}; context ${formatContext(tracked.usage)}; compaction ${tracked.compactions === 0 ? 'did not run' : `ran ${tracked.compactions} time(s)`}; tool calls ${formatToolCalls(tracked.toolCalls)}`)
          this.track(this.reportResult(tracked, outcome, detail, stoppedByOwner))
        } else if (reminder !== undefined) {
          this.ctx.logger.info(`lsy-event-bus: reminder turn of Session ${session.id} ended: ${ended}`)
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
      this.ctx.logger.info(`lsy-event-bus: Session ${sessionId} is relayed by ${owner}; its ${icon} turn is not reported`)
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
      this.ctx.logger.info(`lsy-event-bus: reminder turn of Session ${sessionId} was stopped by the owner; nothing sent`)
      return
    }
    if (isSilentReply(reminder.text)) {
      this.ctx.logger.info(`lsy-event-bus: reminder turn of Session ${sessionId} answered ${LSY_SILENT_REPLY}; nothing sent`)
      return
    }
    const notifier = this.ctx.get('lsyNotifier')
    if (notifier === undefined) return
    const { label, icon, text } = reminder
    await notifier.send(formatReminderNote({ label, icon, outcome, text, url: this.config.webUrl, detail }))
  }

  /** Record the Session outcome and send it to the notifier unless it is the silent reply or the owner stopped it. */
  private async reportResult(tracked: TrackedSession, outcome: string, detail: string | undefined, stoppedByOwner: boolean): Promise<void> {
    const silent = isSilentReply(tracked.text)
    await this.markBatch(tracked.batchId, { status: 'completed', outcome, ...(silent ? { silent } : {}), ...(detail === undefined ? {} : { error: detail }) })
    if (stoppedByOwner) {
      this.ctx.logger.info(`lsy-event-bus: Session of ${tracked.batchId} was stopped by the owner; nothing sent`)
      return
    }
    if (silent) {
      this.ctx.logger.info(`lsy-event-bus: Session of ${tracked.batchId} answered ${LSY_SILENT_REPLY}; nothing sent`)
      return
    }
    const route = this.subscriptionById(tracked.subscription)
    const result = route === undefined ? 'notify' : resultOf(route)
    if (result === 'quiet') {
      await this.markBatch(tracked.batchId, { notSent: true })
      this.ctx.logger.info(`lsy-event-bus: Session of ${tracked.batchId} belongs to a quiet subscription; nothing sent`)
      return
    }
    if (result === 'event' && await this.passOn(tracked)) return
    if (result === 'main' && await this.tellMain(tracked)) return
    if (!this.config.notifySessionResult) return
    const notifier = this.ctx.get('lsyNotifier')
    if (notifier === undefined) return
    const note = formatResultNote({
      subscription: tracked.subscription,
      title: tracked.title,
      outcome,
      text: tracked.text,
      url: this.config.webUrl,
      detail,
    })
    await notifier.send(result === 'urgent' ? { ...note, urgent: true } : note)
  }

  /** Publish a route's answer as an event for the routes after it. False when nothing takes it, so the answer is not lost. */
  private async passOn(tracked: TrackedSession): Promise<boolean> {
    const text = tracked.text ?? ''
    const subject = this.domain?.table('batches').get(tracked.batchId)?.subject ?? tracked.subscription
    const firstLine = text.split('\n', 1)[0]?.trim()
    const outcome = await this.publish({
      source: FLOW_SOURCE,
      kind: flowResultKind(tracked.subscription),
      key: tracked.batchId,
      subject,
      title: firstLine === undefined || firstLine === '' ? tracked.title : firstLine,
      text,
    })
    this.ctx.logger.info(`lsy-event-bus: answer of ${tracked.batchId} went on as ${flowResultKind(tracked.subscription)}: ${outcome}`)
    if (outcome !== 'accepted') return false
    await this.markBatch(tracked.batchId, { notSent: true })
    return true
  }

  /** Give a route's answer to the owner's main agent. False when there is none or it refused, so the owner still hears it. */
  private async tellMain(tracked: TrackedSession): Promise<boolean> {
    const notifier = this.ctx.get('lsyNotifier')
    if (notifier?.tellMainAgent === undefined) return false
    try {
      await notifier.tellMainAgent({
        text: tracked.text ?? '',
        from: `the notification route ${tracked.subscription} (an unattended Session that read outside events)`,
        origin: 'flow',
      })
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`lsy-event-bus: main agent refused the answer of ${tracked.batchId}: ${reason}`)
      return false
    }
    await this.markBatch(tracked.batchId, { notSent: true })
    return true
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
