/** Durable event bus: dedupe, loop suppression, config and run-time subscriptions, coalescing, rate limits, dispatch, and reports. */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
// Type-only: ctx.sessionController, ctx.workspaceRegistry, and the `compaction/summary` Session event.
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-compaction'
import { BackgroundWork } from '@deepseek-ai/dsh-service-kit'
import type { WebhookRule, WebhookRuleId } from '@deepseek-ai/dsh-webhook'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import {
  archiveDomain, autoArchiveSchema, resolveAutoArchive, SessionArchiver, type ArchiveStatus, type AutoArchiveConfig,
  type ProtectionDisposer, type SessionProtector, type SweepReport,
} from './archive.ts'
import { archiveHost } from './archive-host.ts'
import { BUS_EVENT_KIND, BUS_EVENT_RULE_ID, ProjectDirectories } from './delivery.ts'
import { BatchDispatcher } from './dispatch.ts'
import { ROUTE_RESULTS } from './flow.ts'
import { FlowEditor } from './flow-edit.ts'
import { SessionHandover } from './handover.ts'
import { hostServices } from './host.ts'
import { errorText } from './log.ts'
import { PersistentSessions } from './persistent.ts'
import { EventQueue } from './queue.ts'
import type { BusDomain, BusStore } from './records.ts'
import { TurnReporter } from './report.ts'
import { ROUTE_COALESCE_MS, ROUTE_MAX_PER_HOUR, RouteSet } from './routes.ts'
import { BusStatus } from './status.ts'
import { busDomain, type BatchRecord, type BusEventRecord } from './storage.ts'
import { SubscriptionStore } from './subscriptions.ts'
import { TurnObserver } from './turns.ts'
import type {
  FlowChange, FlowEdit, FlowEditMeta, FlowEditResult, FlowRouteView,
  BusStats, BusDeliveryEvent, BusEventInput, OwnerNotifier, PauseOutcome, PersistentSessionView, PublishOutcome,
  SessionAction, SessionHandoverMover, SessionHandoverReport, Subscription, SubscriptionMeta,
  SubscriptionView, SuppressConfig, UnsubscribeOutcome,
} from './types.ts'
import { subscriptionProblem } from './validate.ts'

export type { ProjectRegistry } from './delivery.ts'
export type * from './flow.ts'
export type * from './match.ts'
export type * from './prompt.ts'
export type * from './validate.ts'
export { FlowError, SubscriptionError } from './validate.ts'
export type { ArchivedRecord, ArchiveStatus, AutoArchiveConfig, ProtectedSession, ProtectionDisposer, SessionProtector, SessionRow, SweepReport } from './archive.ts'
export type * from './storage.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    eventBus: EventBus
    ownerNotifier: OwnerNotifier
  }
}

declare module '@deepseek-ai/dsh-webhook' {
  interface WebhookEventMap {
    'bus-event': BusDeliveryEvent
  }
}

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
  /** Changes of the notification flow kept for `flow_read` and the message flow page; the oldest are pruned first. */
  flowChangesKept: number
  /** Maximum stored characters of each event's untrusted text. */
  maxTextChars: number
  /** Send the final assistant text of each bus-started Session to the notifier. */
  notifySessionResult: boolean
  /**
   * Send the final assistant text of each unattended Host-schedule reminder turn, and of each
   * turn a tool-monitor notice wakes, to the notifier.
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
  result: z.union(ROUTE_RESULTS),
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
  coalesceMs: z.natural().default(ROUTE_COALESCE_MS),
  maxPerHour: z.natural().min(1).default(ROUTE_MAX_PER_HOUR),
  session: sessionActionSchema,
})

/** Fail at load on configuration that cannot route events. */
function assertConfig(config: Config): void {
  const ids = new Set<string>()
  for (const subscription of config.subscriptions) {
    const problem = subscriptionProblem(subscription)
    if (problem !== undefined) throw new Error(`event-bus: ${problem}`)
    if (ids.has(subscription.id)) throw new Error(`event-bus: duplicate subscription id "${subscription.id}"`)
    ids.add(subscription.id)
  }
}

/**
 * Durable event bus. Sensors publish; subscriptions from the configuration or
 * created at run time decide which events reach which actuator; the bus owns
 * dedupe, loop suppression, coalescing, and rate limits so actuators never
 * see raw sensor traffic.
 */
export class EventBus extends Service {
  static inject = ['timer', 'storageDomain']
  /** Configuration schema. */
  static Config: z<Config> = z.object({
    subscriptions: z.array(subscriptionSchema).default([]),
    suppress: z.object({
      actors: z.array(z.string()).default([]),
      markers: z.array(z.string()).default([]),
    }),
    retainEvents: z.natural().min(1).default(5000),
    retainBatches: z.natural().min(1).default(1000),
    flowChangesKept: z.natural().min(1).default(200),
    maxTextChars: z.natural().min(1).default(4000),
    notifySessionResult: z.boolean().default(true),
    reportScheduledTurns: z.boolean().default(true),
    maxNoteEvents: z.natural().min(1).default(10),
    webUrl: z.string(),
    autoArchive: autoArchiveSchema,
  })

  private readonly ready: Promise<BusDomain>
  private domain: BusDomain | undefined
  private readonly background = new BackgroundWork((error: unknown) => { this.ctx.logger.warn(`event-bus: background work failed: ${errorText(error)}`) })
  private readonly routes: RouteSet
  private readonly queue: EventQueue
  private readonly status: BusStatus
  private readonly subscriptions: SubscriptionStore
  private readonly flow: FlowEditor
  private readonly projects: ProjectDirectories
  private readonly dispatcher: BatchDispatcher
  private readonly persistent: PersistentSessions
  private readonly turns: TurnObserver
  private readonly handover: SessionHandover
  private readonly archiver: SessionArchiver

  /**
   * @param ctx - Host services owning timers, storage, and Session events.
   * @param config - Subscriptions, suppression, and retention.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'eventBus')
    assertConfig(config)
    this.ready = ctx.storageDomain.open(busDomain)
    const current = (): BusDomain | undefined => this.domain
    const store: BusStore = { ready: this.ready, current, background: this.background }
    const logger = ctx.logger
    const host = hostServices(ctx)
    const timeout = (callback: () => void, ms: number): (() => void) => ctx.timeout(callback, ms)

    this.routes = new RouteSet(config.subscriptions, current)
    this.queue = new EventQueue({
      store, routes: this.routes, logger, timeout,
      actuate: flushed => this.dispatcher.actuate(flushed),
      suppress: config.suppress, maxTextChars: config.maxTextChars, retainEvents: config.retainEvents, retainBatches: config.retainBatches,
    })
    this.status = new BusStatus({ current, routes: this.routes, flushes: this.queue })
    this.subscriptions = new SubscriptionStore({ store, routes: this.routes, flushes: this.queue, status: this.status, logger })
    this.flow = new FlowEditor({
      store, routes: this.routes, flushes: this.queue, status: this.status, changesKept: config.flowChangesKept, logger,
    })
    this.projects = new ProjectDirectories(() => host.workspaceRegistry(), logger)
    this.dispatcher = new BatchDispatcher({
      host, routes: this.routes, projects: { ensure: (path, name) => this.ensureProject(path, name) }, batches: this.queue,
      deliverPersistent: (flushed, session) => this.persistent.deliver(flushed, session),
      maxNoteEvents: config.maxNoteEvents, logger,
    })
    this.persistent = new PersistentSessions({ store, host, sessions: this.dispatcher, batches: this.queue, logger })
    const reporter = new TurnReporter({
      host, routes: this.routes, current, batches: this.queue,
      publish: input => this.queue.publish(input),
      notifySessionResult: config.notifySessionResult, webUrl: config.webUrl, logger,
    })
    this.turns = new TurnObserver({
      current, deliveries: this.dispatcher, persistent: this.persistent, reporter, batches: this.queue,
      host, background: this.background, reportScheduledTurns: config.reportScheduledTurns, logger,
    })
    this.handover = new SessionHandover({ subscriptions: this.subscriptions, logger })
    const sweepHost = archiveHost({ host, turns: this.turns, persistentSessions: () => this.persistentSessions(), routes: this.routes })
    this.archiver = new SessionArchiver(
      resolveAutoArchive(config.autoArchive), sweepHost, logger, timeout, () => ctx.storageDomain.open(archiveDomain),
    )

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const cleanup = ctx.effect(() => async () => {
        this.queue.stop()
        await this.archiver.stop()
        await this.background.drain()
        await domain.close()
      }, 'eventBus.lifecycle()')
      await this.queue.restore()
      await this.archiver.start()
      return cleanup
    }, 'eventBus.init()')

    // The rule plugin starts whenever a webhook runtime is mounted; the bus works without one.
    ctx.plugin({
      name: 'event-bus-session-rule',
      inject: ['webhookRuntime'],
      apply: (child: Context) => {
        const rule: WebhookRule<typeof BUS_EVENT_KIND> = {
          id: BUS_EVENT_RULE_ID as WebhookRuleId,
          kind: BUS_EVENT_KIND,
          run: delivery => this.dispatcher.sessionRequest(delivery),
        }
        child.effect(() => child.webhookRuntime.register(rule), 'eventBus.sessionRule()')
      },
    })

    ctx.on('session/event', (session, event) => { this.turns.observe(session, event) })
  }

  /**
   * Publish one sensor observation.
   * @param input - event; `source` + `key` identify it for dedupe.
   * @returns `accepted` (queued for at least one subscription), `duplicate`, `suppressed`, or `unmatched`.
   * @throws when a required field is empty.
   */
  async publish(input: BusEventInput): Promise<PublishOutcome> {
    return this.queue.publish(input)
  }

  /**
   * Stored events, oldest first.
   * @returns snapshot of the events table.
   */
  events(): BusEventRecord[] {
    return this.status.events()
  }

  /**
   * Stored batches, oldest first.
   * @returns snapshot of the batches table.
   */
  batches(): BatchRecord[] {
    return this.status.batches()
  }

  /**
   * Number of event/subscription pairs waiting for a batch.
   * @returns pending row count.
   */
  pendingCount(): number {
    return this.status.pendingCount()
  }

  /**
   * The persistent Sessions of subscriptions with `session.persistent.enabled`.
   * @returns one row per subscription that has one; empty before the storage domain opens.
   */
  persistentSessions(): PersistentSessionView[] {
    return this.persistent.views()
  }

  /**
   * The subscription whose current persistent Session this is. Tools that may run only in that Session
   * (for example the `up` preset's note tool) ask this.
   * @param sessionId - Session to check.
   * @returns the subscription id, or undefined when the Session is no subscription's current persistent Session.
   */
  persistentSubscriptionOf(sessionId: string): string | undefined {
    return this.persistent.subscriptionOf(sessionId)
  }

  /**
   * {@link ensureProject} with this Host's Workspace registry, once per path and process.
   * @param path - absolute directory.
   * @param name - title of a new project.
   * @returns resolves once the directory exists and is a project; a registry failure is logged, not thrown.
   */
  ensureProject(path: string, name: string): Promise<void> {
    return this.projects.ensure(path, name)
  }

  /**
   * Add a routing rule at run time. It is stored durably and survives restarts.
   * @param subscription - rule; validated like a configuration row.
   * @param meta - who created the subscription, e.g. the creating Session.
   * @returns the stored subscription with its (empty) status.
   * @throws {SubscriptionError} `invalid_subscription` for a rule the bus cannot route, or `duplicate_id`
   * for an id the configuration or another stored subscription already uses.
   */
  async subscribe(subscription: Subscription, meta: SubscriptionMeta = {}): Promise<SubscriptionView> {
    return this.subscriptions.subscribe(subscription, meta)
  }

  /**
   * Remove a run-time subscription, its pending events, and its flush timer.
   * Batches already created stay in the history.
   * @param id - subscription id.
   * @returns `removed`, `not_found`, or `config_owned` for an id the configuration owns.
   */
  async unsubscribe(id: string): Promise<UnsubscribeOutcome> {
    return this.subscriptions.unsubscribe(id)
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
    return this.subscriptions.setPaused(id, paused)
  }

  /**
   * The whole notification flow: every route with where its answer goes and which routes take it, including a configuration route
   * taken out, so it can be seen and put back.
   * @returns routes in matching order, then the ones taken out.
   */
  flowRoutes(): FlowRouteView[] {
    return this.status.flowRoutes()
  }

  /**
   * Changes of the flow.
   * @param limit - most entries.
   * @returns the newest first.
   */
  flowHistory(limit: number = this.config.flowChangesKept): FlowChange[] {
    return this.flow.history(limit)
  }

  /**
   * Change the notification flow at run time. It is stored, so a restart or a deploy keeps it; a configuration route keeps its bundle
   * row and `reset` puts it back.
   * @param edit - the change.
   * @param meta - who made it and why.
   * @returns the route as it stands, the history entry, and anything worth a second look.
   * @throws {FlowError} when the change would leave a route the bus cannot run, or a loop.
   */
  async editFlow(edit: FlowEdit, meta: FlowEditMeta = {}): Promise<FlowEditResult> {
    return this.flow.edit(edit, meta)
  }

  /**
   * Keep a plugin's Sessions out of the auto-archive sweep (for example the QQ resident group Sessions or the WeChat chat
   * Session). `check` runs only for Sessions that are otherwise due; return `true` (or a short reason) to keep one. A throw keeps it.
   * Register inside an effect so a reload withdraws the claim:
   * `ctx.inject(['eventBus'], scoped => {
   *   scoped.effect(() => scoped.eventBus.protectSessions('qq', check), 'qq.archiveProtection()')
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
   * `ctx.inject(['eventBus'], scoped => { scoped.effect(() => scoped.eventBus.registerHandover('monitor', move)) })`.
   * @param kind - binding kind reported with what the mover moved, for example `monitor`.
   * @param move - the mover.
   * @returns the disposer.
   */
  registerHandover(kind: string, move: SessionHandoverMover): () => void {
    return this.handover.register(kind, move)
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
    return this.handover.handOver(from, to)
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

  /**
   * Counters for the last rolling hour and the current queue, for status pages.
   * @returns snapshot; before the storage domain opens, only the configuration rows are counted.
   */
  stats(): BusStats {
    return this.status.stats()
  }

  /**
   * Every subscription, configuration first and then run-time ones by creation time, with live status.
   * @returns snapshot; before the storage domain opens, only configuration rows with empty status.
   */
  listSubscriptions(): SubscriptionView[] {
    return this.status.listSubscriptions()
  }
}

export default EventBus
