/**
 * Follow bus-started turns and unattended reminder or monitor turns through their Session events, and hand each one to
 * the reports when it ends. What is followed lives in memory only, so a restart loses the report of a running turn.
 */

// Type-only: the `compaction/summary` Session event and the `webhook` message source.
import type {} from '@deepseek-ai/dsh-compaction'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
// ctx.schedule names the task behind a reminder turn; its title, not its instruction, labels the report.
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-webhook'
import type { BackgroundWork } from '@deepseek-ai/dsh-service-kit'
import { BUS_EVENT_KIND } from './delivery.ts'
import type { BatchDispatcher } from './dispatch.ts'
import type { HostServices } from './host.ts'
import { errorText, type BusLogger } from './log.ts'
import type { PersistentSessions } from './persistent.ts'
import { failureDetail, monitorLabel, reminderScheduleIds, reminderTitle } from './prompt.ts'
import type { EventQueue } from './queue.ts'
import type { BusDomain } from './records.ts'
import type { TrackedReminder, TrackedSession, TurnReporter } from './report.ts'

/** What the observer reads and calls. */
export interface TurnObserverDeps {
  /** The open storage domain, or undefined before it opens. */
  current(): BusDomain | undefined
  deliveries: Pick<BatchDispatcher, 'take'>
  persistent: Pick<PersistentSessions, 'adopt' | 'recordCompaction'>
  reporter: Pick<TurnReporter, 'reportReminder' | 'reportResult'>
  batches: Pick<EventQueue, 'markBatch'>
  host: Pick<HostServices, 'relayOwner' | 'schedule'>
  /** Keeps the writes and reports a Session event starts alive until the bus stops. */
  background: Pick<BackgroundWork, 'track'>
  /** Follow and report unattended reminder and monitor turns. */
  reportScheduledTurns: boolean
  logger: BusLogger
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

/** Holds the followed turns by Session id until each one's `turn/end`. */
export class TurnObserver {
  private readonly tracked = new Map<string, TrackedSession>()
  private readonly reminders = new Map<string, TrackedReminder>()

  /** @param deps - storage, deliveries, persistent Sessions, reports, and Host services. */
  constructor(private readonly deps: TurnObserverDeps) {}

  /**
   * Sessions running a followed turn.
   * @returns bus-started Sessions, then reminder and monitor Sessions.
   */
  runningSessionIds(): string[] {
    return [...this.tracked.keys(), ...this.reminders.keys()]
  }

  /**
   * Follow one Session event of any Session.
   * @param session - the Session that recorded the event.
   * @param event - the event.
   */
  observe(session: Session, event: SessionEvent): void {
    const { background, batches, logger, reporter } = this.deps
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        // `schedule` is declared by the Host schedule service, which this package does not import.
        const kind: string = source.kind
        if (kind === 'schedule') {
          const ids = reminderScheduleIds(messageText(event.data.content))
          this.trackReminder(session.id, () => (ids.length === 0 ? undefined : this.reminderLabel(ids)), '⏰')
          return
        }
        // A turn woken by a monitor's output (tool-monitor) is reported like a reminder turn.
        if (kind === 'tool-monitor') {
          const label = monitorLabel(messageText(event.data.content))
          this.trackReminder(session.id, () => label, '📡')
          return
        }
        if (source.kind !== 'webhook' || source.provider !== BUS_EVENT_KIND || this.tracked.has(session.id)) return
        const batch = this.deps.current()?.table('batches').get(source.deliveryId)
        const pending = this.deps.deliveries.take(source.deliveryId)
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
        background.track(batches.markBatch(source.deliveryId, { sessionId: session.id }))
        if (delivery === 'persistent-new' || delivery === 'rollover') background.track(this.deps.persistent.adopt(source.source, session.id, delivery, pending?.subject ?? batch?.subject))
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
        background.track(this.deps.persistent.recordCompaction(session.id, summary === '' ? undefined : summary))
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
          logger.info(`event-bus: ${tracked.subscription} batch ${tracked.batchId} in Session ${session.id} (${tracked.delivery}) ended: ${ended}; context ${formatContext(tracked.usage)}; compaction ${tracked.compactions === 0 ? 'did not run' : `ran ${tracked.compactions} time(s)`}; tool calls ${formatToolCalls(tracked.toolCalls)}`)
          background.track(reporter.reportResult(tracked, outcome, detail, stoppedByOwner))
        } else if (reminder !== undefined) {
          logger.info(`event-bus: reminder turn of Session ${session.id} ended: ${ended}`)
          background.track(reporter.reportReminder(session.id, reminder, outcome, detail, stoppedByOwner))
        }
        return
      }
      default:
        return
    }
  }

  /**
   * Start following a reminder turn unless reports are off, the bus already follows the Session, or a relay channel
   * claimed it. `label` runs only for a followed turn.
   */
  private trackReminder(sessionId: string, label: () => string | Promise<string> | undefined, icon: string): void {
    if (!this.deps.reportScheduledTurns || this.tracked.has(sessionId) || this.reminders.has(sessionId)) return
    const owner = this.deps.host.relayOwner(sessionId)
    if (owner !== undefined) {
      this.deps.logger.info(`event-bus: Session ${sessionId} is relayed by ${owner}; its ${icon} turn is not reported`)
      return
    }
    this.reminders.set(sessionId, { label: label() ?? `Session ${sessionId}`, icon, text: undefined })
  }

  /**
   * The label of a reminder turn: the titles of its schedule tasks, read when the turn starts (a one-shot task may be
   * gone by its end). A task `ctx.schedule` cannot read, or a Host without it, leaves {@link reminderTitle}'s fallback.
   */
  private async reminderLabel(ids: readonly string[]): Promise<string> {
    const schedule = this.deps.host.schedule()
    const titles = await Promise.all(ids.map(async (id) => {
      if (schedule === undefined) return undefined
      try {
        const view = await schedule.view({ id: ScheduleId(id) })
        if ('code' in view) {
          this.deps.logger.info(`event-bus: schedule task ${id} is gone; its reminder report has no title`)
          return undefined
        }
        return view.title
      } catch (error: unknown) {
        this.deps.logger.warn(`event-bus: schedule task ${id} could not be read: ${errorText(error)}`)
        return undefined
      }
    }))
    return reminderTitle(titles)
  }
}
