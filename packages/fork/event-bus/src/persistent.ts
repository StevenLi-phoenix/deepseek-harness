/**
 * Persistent Sessions: a batch of a subscription with `session.persistent.enabled` enters the subscription's stored
 * Session as a new turn, or starts, rolls over, or replaces that Session; the stored row follows the Session's first
 * message and its compactions.
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WebhookDeliveryId, WebhookRuleId, WebhookSourceId } from '@deepseek-ai/dsh-webhook'
import { BUS_EVENT_KIND, BUS_EVENT_RULE_ID, persistentKey } from './delivery.ts'
import type { BatchDispatcher } from './dispatch.ts'
import type { HostServices } from './host.ts'
import { errorText, type BusLogger } from './log.ts'
import { batchTitle, buildBatchPrompt, clip, type CarriedOver } from './prompt.ts'
import type { EventQueue, FlushedBatch } from './queue.ts'
import { persistentView, rowsOf, type BusStore } from './records.ts'
import type { BatchRecord } from './storage.ts'
import type { BatchEvent, PersistentSessionView, SessionAction, SessionDelivery } from './types.ts'

const DAY_MS = 86_400_000

/** The stored Session of a persistent subscription, as the Host resolves it now. */
type StoredSession =
  | { kind: 'agent'; agent: { followup(message: ReturnType<typeof createUserMessage>): void } }
  /** Not found or archived: a new Session replaces it, seeded with its last compaction summary when there is one. */
  | { kind: 'gone'; reason: string }
  /** Exists but cannot take a turn now (busy writer, no controller): this batch gets a one-off Session. */
  | { kind: 'unavailable'; reason: string }

/** What the persistent Sessions read and call. */
export interface PersistentSessionsDeps {
  store: BusStore
  host: Pick<HostServices, 'sessionController' | 'workspaceRegistry'>
  sessions: Pick<BatchDispatcher, 'expect' | 'forget' | 'start'>
  batches: Pick<EventQueue, 'markBatch'>
  logger: BusLogger
}

/** Reads and writes the `persistent` table; one row per subscription, or per subject with `key: subject`. */
export class PersistentSessions {
  /** @param deps - storage, Host services, Session dispatch, and batch records. */
  constructor(private readonly deps: PersistentSessionsDeps) {}

  /**
   * The persistent Sessions of subscriptions with `session.persistent.enabled`.
   * @returns one row per subscription (or subject) that has one; empty before the storage domain opens.
   */
  views(): PersistentSessionView[] {
    return rowsOf(this.deps.store.current()?.table('persistent')).map(persistentView)
  }

  /**
   * The subscription whose current persistent Session this is.
   * @param sessionId - Session to check.
   * @returns the subscription id, or undefined when the Session is no subscription's current persistent Session.
   */
  subscriptionOf(sessionId: string): string | undefined {
    return rowsOf(this.deps.store.current()?.table('persistent')).find(record => record.sessionId === sessionId)?.subscription
  }

  /**
   * Deliver one batch of a persistent subscription. With `key: subject` the batch is split by event subject and each
   * part goes to that subject's Session; the first part keeps the batch id, the others get child batch rows.
   * @param flushed - the persisted batch.
   * @param session - the subscription's Session settings.
   * @returns resolves once every part entered a Session or its failure is recorded.
   */
  async deliver(flushed: FlushedBatch, session: SessionAction): Promise<void> {
    if (session.persistent?.key !== 'subject') {
      await this.deliverOne(flushed, session, undefined)
      return
    }
    const { store } = this.deps
    const groups = new Map<string, BatchEvent[]>()
    for (const event of flushed.events) groups.set(event.subject, [...groups.get(event.subject) ?? [], event])
    const parts = [...groups]
    const prefix = session.titlePrefix ?? flushed.subscription.id
    const batches = await store.background.serialize(async () => {
      const domain = await store.ready
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
    if (parts.length > 1) this.deps.logger.info(`event-bus: batch ${flushed.batch.id} of ${flushed.subscription.id} split by subject into ${parts.length}: ${parts.map(([subject, events]) => `${subject} (${events.length})`).join(', ')}`)
    for (const [index, [subject, events]] of parts.entries()) {
      // One row per part was written above.
      const batch = batches[index] as BatchRecord
      await this.deliverOne({ batch, events, subscription: flushed.subscription }, session, subject)
    }
  }

  /**
   * Make a newly created Session its subscription's persistent Session, then archive the one it replaces
   * (the rollover's old Session, or one a concurrent batch created).
   * @param subscriptionId - the subscription.
   * @param sessionId - the new Session.
   * @param delivery - how its batch was delivered.
   * @param subject - the Session's subject, for `key: subject`.
   * @returns resolves once the row is stored and a replaced Session is archived or its failure logged.
   */
  async adopt(subscriptionId: string, sessionId: string, delivery: SessionDelivery, subject: string | undefined): Promise<void> {
    const { store } = this.deps
    const domain = await store.ready
    const key = persistentKey(subscriptionId, subject)
    const adopted = await store.background.serialize(async () => {
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
    this.deps.logger.info(`event-bus: Session ${sessionId} is now the persistent Session of ${label} (${delivery})${previous === undefined ? '' : `, replacing ${previous}`}`)
    if (previous !== undefined) await this.archiveReplaced(previous, label)
  }

  /**
   * Keep the latest compaction summary of a persistent Session for its rollover, and count compactions.
   * @param sessionId - the compacted Session; a Session that is no subscription's persistent Session is ignored.
   * @param summary - text of the compaction summary, or undefined when it has none.
   * @returns resolves once the row is stored.
   */
  async recordCompaction(sessionId: string, summary: string | undefined): Promise<void> {
    const { store } = this.deps
    const domain = await store.ready
    await store.background.serialize(async () => {
      const table = domain.table('persistent')
      const current = rowsOf(table).find(record => record.sessionId === sessionId)
      if (current === undefined) return
      await table.put(persistentKey(current.subscription, current.subject), {
        ...current,
        compactions: current.compactions + 1,
        ...(summary === undefined ? {} : { lastSummary: summary }),
      })
      this.deps.logger.info(`event-bus: persistent Session ${sessionId} of ${current.subscription} compacted (#${current.compactions + 1}${summary === undefined ? ', no summary text' : `, ${summary.length}-char summary kept for the rollover`})`)
    })
  }

  /**
   * Deliver one batch to its persistent Session: a new turn of the stored Session, a new Session when there is none,
   * a seeded new Session at a rollover or when the stored one is gone, or a one-off Session when it cannot take a turn.
   */
  private async deliverOne(flushed: FlushedBatch, session: SessionAction, subject: string | undefined): Promise<void> {
    const { store, sessions, batches, logger } = this.deps
    const { batch, events, subscription } = flushed
    /* v8 ignore next -- actuate() checked enabled; schemastery materializes the defaults. */
    const persistent = session.persistent ?? { enabled: true, key: 'subscription', rolloverDays: 30, maxSeedChars: 20_000 }
    const key = persistentKey(subscription.id, subject)
    const label = subject === undefined ? subscription.id : `${subscription.id} (${subject})`
    const prefix = session.titlePrefix ?? subscription.id
    const fresh = { ...(subject === undefined ? {} : { subject }), title: clip(subject === undefined ? prefix : `${prefix}: ${subject}`, 119) }
    const domain = await store.ready
    const stored = domain.table('persistent').get(key)
    if (stored === undefined) {
      logger.info(`event-bus: ${label} has no persistent Session yet; batch ${batch.id} starts one`)
      await sessions.start(flushed, 'persistent-new', fresh)
      return
    }
    const seed = (): CarriedOver => ({
      sessionId: stored.sessionId,
      summary: stored.lastSummary === undefined ? undefined : clip(stored.lastSummary, persistent.maxSeedChars),
    })
    const ageDays = (Date.now() - stored.createdAt) / DAY_MS
    if (ageDays >= persistent.rolloverDays) {
      const carried = seed()
      logger.info(`event-bus: ${label} rolls over Session ${stored.sessionId} after ${ageDays.toFixed(1)} day(s) and ${stored.batches} batch(es); ${carried.summary === undefined ? 'it left no compaction summary' : `its ${carried.summary.length}-char compaction summary is carried over`}`)
      await sessions.start(flushed, 'rollover', { ...fresh, carried })
      return
    }
    const resolved = await this.resolve(stored.sessionId)
    if (resolved.kind === 'gone') {
      if (stored.lastSummary !== undefined) {
        logger.info(`event-bus: persistent Session ${stored.sessionId} of ${label} is ${resolved.reason}; batch ${batch.id} starts a new one seeded with its last compaction summary`)
        await sessions.start(flushed, 'rollover', { ...fresh, carried: seed() })
        return
      }
      logger.info(`event-bus: persistent Session ${stored.sessionId} of ${label} is ${resolved.reason}; batch ${batch.id} starts a new one`)
      await store.background.serialize(async () => { await domain.table('persistent').delete(key) })
      await sessions.start(flushed, 'persistent-new', fresh)
      return
    }
    if (resolved.kind === 'unavailable') {
      logger.warn(`event-bus: persistent Session ${stored.sessionId} of ${label} cannot take batch ${batch.id} now (${resolved.reason}); it gets a one-off Session`)
      await sessions.start(flushed, 'detached')
      return
    }
    const prompt = buildBatchPrompt(subscription.id, session, events)
    sessions.expect(batch.id, { delivery: 'persistent', ...(subject === undefined ? {} : { subject }) })
    try {
      resolved.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        // The same source the webhook runtime gives a new Session's first message, so turn-origin checks
        // (turn-taint: `event`) and this bus's own tracking treat both alike.
        source: {
          kind: 'webhook',
          provider: BUS_EVENT_KIND,
          source: subscription.id as WebhookSourceId,
          deliveryId: batch.id as WebhookDeliveryId,
          ruleId: BUS_EVENT_RULE_ID as WebhookRuleId,
          form: 'notice',
          summary: boundContextSummary(`${BUS_EVENT_KIND} batch of ${label} for its persistent Session`),
        },
      }))
    } catch (error: unknown) {
      sessions.forget(batch.id)
      logger.warn(`event-bus: batch ${batch.id} did not enter persistent Session ${stored.sessionId}: ${errorText(error)}`)
      await batches.markBatch(batch.id, { status: 'failed', error: errorText(error), delivery: 'persistent' })
      return
    }
    await batches.markBatch(batch.id, { delivery: 'persistent', sessionId: stored.sessionId })
    const count = await store.background.serialize(async () => {
      const current = domain.table('persistent').get(key)
      /* v8 ignore next -- a rollover or replacement recorded between the follow-up and this count. */
      if (current?.sessionId !== stored.sessionId) return stored.batches + 1
      await domain.table('persistent').put(key, { ...current, batches: current.batches + 1 })
      return current.batches + 1
    })
    logger.info(`event-bus: batch ${batch.id} (${events.length} event(s)) entered persistent Session ${stored.sessionId} of ${label} as its batch #${count} (${ageDays.toFixed(1)} day(s) old, rollover at ${persistent.rolloverDays})`)
  }

  /** Resolve a persistent subscription's stored Session to its live Agent. */
  private async resolve(sessionId: string): Promise<StoredSession> {
    const controller = this.deps.host.sessionController()
    if (controller === undefined) return { kind: 'unavailable', reason: 'no sessionController service is mounted' }
    if (this.deps.host.workspaceRegistry()?.archivedSessionIds.includes(sessionId as SessionId) === true) return { kind: 'gone', reason: 'archived' }
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

  /** Archive a replaced persistent Session; its log stays readable in the Web UI's archive. */
  private async archiveReplaced(sessionId: string, subscriptionId: string): Promise<void> {
    const registry = this.deps.host.workspaceRegistry()
    if (registry === undefined) {
      this.deps.logger.warn(`event-bus: replaced Session ${sessionId} of ${subscriptionId} is not archived: no workspaceRegistry service is mounted`)
      return
    }
    try {
      await registry.archiveSession(sessionId as SessionId)
      this.deps.logger.info(`event-bus: archived replaced Session ${sessionId} of ${subscriptionId}`)
    } catch (error: unknown) {
      this.deps.logger.warn(`event-bus: replaced Session ${sessionId} of ${subscriptionId} is not archived: ${errorText(error)}`)
    }
  }
}
