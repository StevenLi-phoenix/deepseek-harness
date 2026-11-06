/**
 * What the owner's review tools share: the memory-admin CLI and the Settings route answer waiting writes,
 * undo changes, and erase entries through these functions, so both have the same effect on the store.
 * A preview carries a token over what it computed; applying needs the token back and re-checks it under the
 * file lock, so what is applied equals what the owner was shown.
 */

import { createHash } from 'node:crypto'
import type { MemoryEntry } from './entries.ts'
import { matchesRollback, MemoryError, type MemoryStore, type PurgeResult, type RollbackFilter, type RollbackResult } from './store.ts'

/** History label of a change made from the memory-admin CLI. */
export const CLI_ORIGIN = 'memory-admin'

/** The three answers to a waiting write or a change. */
export const REVIEW_OPS = ['approve', 'discard', 'revert'] as const
/** One of {@link REVIEW_OPS}. */
export type ReviewOp = typeof REVIEW_OPS[number]

/** What {@link reviewWrite} did, for the caller to word. */
export interface ReviewResult {
  readonly op: ReviewOp
  readonly id: string
  /** `kept` for an approval, `dropped` for a discard or a reverted waiting write, `removed` or `restored` for a revert. */
  readonly outcome: 'kept' | 'dropped' | 'removed' | 'restored'
}

/**
 * Answer one waiting write or undo one entry's latest change.
 * @param store - the memory store.
 * @param op - `approve` keeps a waiting write, `discard` drops it, `revert` undoes the latest change.
 * @param id - entry or waiting-write id.
 * @param origin - who answered, kept in the history.
 * @returns the outcome for the caller to word; rejects with the store's `MemoryError` when the id is unknown.
 */
export async function reviewWrite(store: MemoryStore, op: ReviewOp, id: string, origin: string): Promise<ReviewResult> {
  if (op === 'approve') {
    await store.approve(id, { origin })
    return { op, id, outcome: 'kept' }
  }
  if (op === 'discard') {
    await store.discard(id)
    return { op, id, outcome: 'dropped' }
  }
  const reverted = await store.revert(id, { origin })
  return { op, id, outcome: reverted.outcome }
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * The token that binds a rollback preview to its application.
 * @param filter - the Session and/or time the preview was for.
 * @param planned - the dry run's answer.
 * @returns a hex SHA-256 digest of the filter and the dry run.
 */
export function rollbackToken(filter: RollbackFilter, planned: RollbackResult): string {
  return digest(['rollback', filter.session ?? null, filter.since ?? null, planned.matched, planned.restored, planned.removed, planned.ids, planned.state])
}

/** What a rollback would do to one entry. */
export interface RollbackItem {
  readonly id: string
  /** `remove` takes the entry out again, `restore` puts a removed one back, `revise` puts the earlier text back, `none` changes nothing. */
  readonly change: 'remove' | 'restore' | 'revise' | 'none'
  /** The entry now; absent when it is gone. */
  readonly now?: MemoryEntry
  /** The entry as the rollback leaves it; absent when it ends removed. */
  readonly then?: MemoryEntry
}

/**
 * Per entry, what a rollback by this filter would change: the entry now against the oldest matching record's earlier state.
 * @param store - the memory store.
 * @param filter - the Session and/or time to go back to.
 * @returns one item per affected entry id, in history order; empty when no record matches.
 */
export async function describeRollback(store: MemoryStore, filter: RollbackFilter): Promise<RollbackItem[]> {
  const matches = (await store.history()).filter(record => matchesRollback(record, filter))
  const entries = await store.list()
  const items: RollbackItem[] = []
  for (const id of new Set(matches.map(record => record.id))) {
    const oldest = matches.find(record => record.id === id)
    const now = entries.find(entry => entry.id === id)
    const then = oldest?.before
    const change = then === undefined ? (now === undefined ? 'none' : 'remove') : now === undefined ? 'restore' : JSON.stringify(now) === JSON.stringify(then) ? 'none' : 'revise'
    items.push({ id, change, ...now === undefined ? {} : { now }, ...then === undefined ? {} : { then } })
  }
  return items
}

/**
 * Roll back only what the token's preview described.
 * @param store - the memory store.
 * @param filter - the Session and/or time to go back to.
 * @param token - the preview's token.
 * @throws MemoryError `stale_preview` when the store no longer matches the preview.
 * @returns the applied rollback.
 */
export async function rollbackConfirmed(store: MemoryStore, filter: RollbackFilter, token: string): Promise<RollbackResult> {
  const planned = await store.rollback(filter, { dryRun: true })
  if (rollbackToken(filter, planned) !== token) throw new MemoryError('stale_preview', 'memory changed since the preview; preview again.')
  return await store.rollback(filter, { expect: now => rollbackToken(filter, now) === token })
}

/** What erasing one entry would remove. */
export interface PurgePlan {
  readonly id: string
  /** The entry as it is now; absent when only traces (history, snapshots, waiting writes) remain. */
  readonly entry?: MemoryEntry
  readonly planned: PurgeResult
}

/**
 * Count what erasing entries would remove, writing nothing.
 * @param store - the memory store.
 * @param ids - entry ids.
 * @returns one plan per id, in the order given.
 */
export async function planPurge(store: MemoryStore, ids: readonly string[]): Promise<PurgePlan[]> {
  const entries = await store.list()
  const plans: PurgePlan[] = []
  for (const id of ids) {
    const entry = entries.find(candidate => candidate.id === id)
    plans.push({ id, ...entry === undefined ? {} : { entry }, planned: await store.purge(id, { dryRun: true }) })
  }
  return plans
}

/**
 * The token that binds an erase preview to its application.
 * @param plans - the dry run's answers, in the order of the ids.
 * @returns a hex SHA-256 digest of the plans.
 */
export function purgeToken(plans: readonly PurgePlan[]): string {
  return digest(['purge', plans.map(plan => [plan.id, plan.entry ?? null, plan.planned])])
}

const samePurge = (left: PurgeResult, right: PurgeResult): boolean => left.entries === right.entries
  && left.history === right.history && left.snapshots === right.snapshots && left.pending === right.pending

/**
 * Erase only what the token's preview described.
 * @param store - the memory store.
 * @param ids - entry ids, as previewed.
 * @param token - the preview's token.
 * @throws MemoryError `stale_preview` when the store no longer matches the preview.
 * @returns the applied plans, in the order of the ids.
 */
export async function purgeConfirmed(store: MemoryStore, ids: readonly string[], token: string): Promise<PurgePlan[]> {
  const plans = await planPurge(store, ids)
  if (purgeToken(plans) !== token) throw new MemoryError('stale_preview', 'memory changed since the preview; preview again.')
  const done: PurgePlan[] = []
  for (const plan of plans) {
    done.push({ ...plan, planned: await store.purge(plan.id, { expect: now => samePurge(now, plan.planned) }) })
  }
  return done
}
