/**
 * The bus storage domain as the collaborators share it, and the conversions between its stored rows and the routes and
 * views built from them.
 */

import type { BackgroundWork } from '@deepseek-ai/dsh-service-kit'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { busDomain, BatchRecord, BusEventRecord, PersistentRecord, RouteOverrideRecord, SubscriptionRecord } from './storage.ts'
import type { BatchEvent, BatchSummary, PersistentSessionView, SessionAction, Subscription, SubscriptionMeta } from './types.ts'

/** The open bus storage domain. */
export type BusDomain = Domain<typeof busDomain>

/** The bus storage domain and the chain that serializes its writes. */
export interface BusStore {
  /** Resolves once the domain is open. */
  readonly ready: Promise<BusDomain>
  /** The open domain, or undefined before it opens; synchronous reads use it. */
  current(): BusDomain | undefined
  /** Every read-modify-write of the domain runs on its `serialize()` chain. */
  readonly background: BackgroundWork
}

/**
 * Values of one table.
 * @param table - the table, or undefined before the domain opens.
 * @returns its values in key order; none before the domain opens.
 */
export function rowsOf<V>(table: KvTable<string, V> | undefined): V[] {
  return table === undefined ? [] : [...table.entries()].map(([, value]) => value)
}

/**
 * When and by whom a configuration route last changed.
 * @param override - the route's stored override.
 * @returns the time and, when recorded, the author.
 */
export function changedOf(override: RouteOverrideRecord): { at: number; by?: string } {
  return { at: override.updatedAt, ...(override.updatedBy === undefined ? {} : { by: override.updatedBy }) }
}

/**
 * Copy a validated subscription into its stored row; a `notify` row keeps no Session settings.
 * @param subscription - the validated subscription.
 * @param meta - who created it.
 * @param createdAt - creation time of the row.
 * @returns the row to store.
 */
export function toRecord(subscription: Subscription, meta: SubscriptionMeta, createdAt: number): SubscriptionRecord {
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

/**
 * The routing fields of a stored run-time subscription.
 * @param record - the stored row.
 * @returns the subscription it routes as.
 */
export function toSubscription(record: SubscriptionRecord): Subscription {
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

/**
 * The outcome fields of one stored batch.
 * @param batch - the stored batch.
 * @returns its summary.
 */
export function summarize(batch: BatchRecord): BatchSummary {
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
 * The public fields of a stored persistent Session.
 * @param record - the stored row.
 * @returns its view.
 */
export function persistentView(record: PersistentRecord): PersistentSessionView {
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

/**
 * Project a stored event into the fields batches carry.
 * @param record - the stored event.
 * @returns the batch event.
 */
export function toBatchEvent(record: BusEventRecord): BatchEvent {
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
