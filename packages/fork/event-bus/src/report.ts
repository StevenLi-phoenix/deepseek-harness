/**
 * What happens to a finished turn's answer: a bus-started turn's answer goes where its route's `result` says (the
 * notifier, the main agent, an event for later routes, or nowhere), and an unattended reminder turn's answer goes to
 * the notifier. The silent reply and a turn the owner stopped send nothing.
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { FLOW_SOURCE, flowResultKind, resultOf } from './flow.ts'
import type { HostServices } from './host.ts'
import { errorText, type BusLogger } from './log.ts'
import { SILENT_REPLY, formatReminderNote, formatResultNote, isSilentReply } from './prompt.ts'
import type { EventQueue } from './queue.ts'
import type { BusDomain } from './records.ts'
import type { RouteSet } from './routes.ts'
import type { BusEventInput, PublishOutcome, SessionDelivery } from './types.ts'

/** A bus-started turn waiting for its end: the first turn of a new Session, or a batch's turn in a persistent one. */
export interface TrackedSession {
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

/** A Session running a turn started by a Host-schedule reminder or woken by a monitor. */
export interface TrackedReminder {
  /** Task title (a reminder's, read from `ctx.schedule` while the turn runs) or monitor label. */
  label: string | Promise<string>
  /** ⏰ for a reminder, 📡 for a monitor-woken turn. */
  icon: string
  text: string | undefined
}

/** What the reports read and call. */
export interface TurnReporterDeps {
  host: Pick<HostServices, 'notifier'>
  routes: Pick<RouteSet, 'byId'>
  /** The open storage domain, or undefined before it opens. */
  current(): BusDomain | undefined
  batches: Pick<EventQueue, 'markBatch'>
  /** Publish a route's answer as an event for the routes after it. */
  publish(input: BusEventInput): Promise<PublishOutcome>
  /** Send each bus-started Session's result to the notifier. */
  notifySessionResult: boolean
  /** Web UI link attached to the notes. */
  webUrl: string | undefined
  logger: BusLogger
}

/** Sends or passes on the answers of finished turns. */
export class TurnReporter {
  /** @param deps - Host services, routes, batch records, and the publish path. */
  constructor(private readonly deps: TurnReporterDeps) {}

  /**
   * Send a reminder turn's final answer to the notifier unless it is the silent reply.
   * @param sessionId - the Session that ran the turn.
   * @param reminder - the followed turn.
   * @param outcome - the turn's end reason kind.
   * @param detail - why it failed, when it did.
   * @param stoppedByOwner - the owner stopped the turn.
   * @returns resolves once the note is sent or skipped.
   */
  async reportReminder(
    sessionId: string, reminder: TrackedReminder, outcome: string, detail: string | undefined, stoppedByOwner: boolean,
  ): Promise<void> {
    const { icon, text } = reminder
    const label = await reminder.label
    if (stoppedByOwner) {
      this.deps.logger.info(`event-bus: reminder turn of Session ${sessionId} (${icon} ${label}) was stopped by the owner; nothing sent`)
      return
    }
    if (isSilentReply(text)) {
      this.deps.logger.info(`event-bus: reminder turn of Session ${sessionId} (${icon} ${label}) answered ${SILENT_REPLY}; nothing sent`)
      return
    }
    const notifier = this.deps.host.notifier()
    if (notifier === undefined) return
    this.deps.logger.info(`event-bus: reminder turn of Session ${sessionId} reported as ${icon} ${label}`)
    await notifier.send(formatReminderNote({ sessionId, label, icon, outcome, text, url: this.deps.webUrl, detail }))
  }

  /**
   * Record the Session outcome on its batch and send the answer where its route's `result` says, unless it is the
   * silent reply or the owner stopped the turn.
   * @param tracked - the followed turn.
   * @param outcome - the turn's end reason kind.
   * @param detail - why it failed, when it did.
   * @param stoppedByOwner - the owner stopped the turn.
   * @returns resolves once the batch is recorded and the answer sent or skipped.
   */
  async reportResult(tracked: TrackedSession, outcome: string, detail: string | undefined, stoppedByOwner: boolean): Promise<void> {
    const { batches, logger } = this.deps
    const silent = isSilentReply(tracked.text)
    await batches.markBatch(tracked.batchId, { status: 'completed', outcome, ...(silent ? { silent } : {}), ...(detail === undefined ? {} : { error: detail }) })
    if (stoppedByOwner) {
      logger.info(`event-bus: Session of ${tracked.batchId} was stopped by the owner; nothing sent`)
      return
    }
    if (silent) {
      logger.info(`event-bus: Session of ${tracked.batchId} answered ${SILENT_REPLY}; nothing sent`)
      return
    }
    const route = this.deps.routes.byId(tracked.subscription)
    const result = route === undefined ? 'notify' : resultOf(route)
    if (result === 'quiet') {
      await batches.markBatch(tracked.batchId, { notSent: true })
      logger.info(`event-bus: Session of ${tracked.batchId} belongs to a quiet subscription; nothing sent`)
      return
    }
    if (result === 'event' && await this.passOn(tracked)) return
    if (result === 'main' && await this.tellMain(tracked)) return
    if (!this.deps.notifySessionResult) return
    const notifier = this.deps.host.notifier()
    if (notifier === undefined) return
    const note = formatResultNote({
      subscription: tracked.subscription,
      title: tracked.title,
      outcome,
      text: tracked.text,
      url: this.deps.webUrl,
      detail,
    })
    await notifier.send(result === 'urgent' ? { ...note, urgent: true } : note)
  }

  /** Publish a route's answer as an event for the routes after it. False when nothing takes it, so the answer is not lost. */
  private async passOn(tracked: TrackedSession): Promise<boolean> {
    const text = tracked.text ?? ''
    const subject = this.deps.current()?.table('batches').get(tracked.batchId)?.subject ?? tracked.subscription
    const firstLine = text.split('\n', 1)[0]?.trim()
    const outcome = await this.deps.publish({
      source: FLOW_SOURCE,
      kind: flowResultKind(tracked.subscription),
      key: tracked.batchId,
      subject,
      title: firstLine === undefined || firstLine === '' ? tracked.title : firstLine,
      text,
    })
    this.deps.logger.info(`event-bus: answer of ${tracked.batchId} went on as ${flowResultKind(tracked.subscription)}: ${outcome}`)
    if (outcome !== 'accepted') return false
    await this.deps.batches.markBatch(tracked.batchId, { notSent: true })
    return true
  }

  /** Give a route's answer to the owner's main agent. False when there is none or it refused, so the owner still hears it. */
  private async tellMain(tracked: TrackedSession): Promise<boolean> {
    const notifier = this.deps.host.notifier()
    if (notifier?.tellMainAgent === undefined) return false
    try {
      await notifier.tellMainAgent({
        text: tracked.text ?? '',
        from: `the notification route ${tracked.subscription} (an unattended Session that read outside events)`,
        origin: 'flow',
      })
    } catch (error: unknown) {
      this.deps.logger.warn(`event-bus: main agent refused the answer of ${tracked.batchId}: ${errorText(error)}`)
      return false
    }
    await this.deps.batches.markBatch(tracked.batchId, { notSent: true })
    return true
  }
}
