/**
 * The write ledger and its rules. Every write is recorded as `reserved`
 * before its request goes out and settled as `accepted`, `failed`, or
 * `uncertain` after; `reserved` and `uncertain` rows count against the daily
 * caps exactly like accepted ones, and nothing uncertain is ever sent again.
 * Writes share one slot: after each, the next waits a random gap.
 */
import { randomUUID } from 'node:crypto'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { SPEECH_ACTIONS, WRITE_ACTIONS, type biliDomain, type LedgerRecord, type PauseRecord, type WriteAction } from './storage.ts'
import { dayKey } from './time.ts'

/** Default daily caps. */
export const DEFAULT_CAPS: Readonly<Record<WriteAction, number>> = {
  follow: 10, unfollow: 10, favorite: 20, like: 30, watchlater: 30, comment: 3, reply: 5, dynamic: 1, dmOwner: 5,
}
/** Caps no configuration can exceed. */
export const HARD_CAPS: Readonly<Record<WriteAction, number>> = {
  follow: 30, unfollow: 30, favorite: 60, like: 100, watchlater: 100, comment: 10, reply: 20, dynamic: 3, dmOwner: 20,
}

/** Ledger states that count against a cap. */
const COUNTED: ReadonlySet<LedgerRecord['state']> = new Set(['reserved', 'accepted', 'uncertain'])
/** Rows kept; the oldest settled rows go first, except comments and replies. */
const MAX_LEDGER_ROWS = 2000

type BiliDomain = Domain<typeof biliDomain>

/** All ledger rows, oldest first. */
export function ledgerRows(domain: BiliDomain): LedgerRecord[] {
  return [...domain.table('ledger').entries()].map(([, row]) => row).sort((a, b) => a.reservedAt - b.reservedAt)
}

/**
 * Writes counted against each cap on one local day.
 * @param domain - account storage.
 * @param day - local day key.
 */
export function usage(domain: BiliDomain, day: string): Record<WriteAction, number> {
  const used = Object.fromEntries(WRITE_ACTIONS.map(action => [action, 0])) as Record<WriteAction, number>
  for (const [, row] of domain.table('ledger').entries()) {
    if (row.day === day && COUNTED.has(row.state)) used[row.action] += 1
  }
  return used
}

/**
 * Writes left today per action.
 * @param domain - account storage.
 * @param caps - configured caps.
 * @param now - current time.
 * @param timeZone - zone of the day boundary.
 */
export function remaining(
  domain: BiliDomain, caps: Readonly<Record<WriteAction, number>>, now: number, timeZone: string,
): Record<WriteAction, number> {
  const used = usage(domain, dayKey(now, timeZone))
  return Object.fromEntries(WRITE_ACTIONS.map(action => [action, Math.max(0, caps[action] - used[action])])) as Record<WriteAction, number>
}

/**
 * Why a pause stops an action, if it does.
 * @param pause - the stored pause, if any.
 * @param action - the write.
 */
export function pauseRefusal(pause: PauseRecord | undefined, action: WriteAction): string | undefined {
  if (pause === undefined) return undefined
  if (pause.scope === 'all') return `writes are paused (${pause.reason}) until the owner resumes them in Settings`
  if (SPEECH_ACTIONS.has(action)) return `public speech is paused (${pause.reason}) until the owner resumes it in Settings`
  return undefined
}

/**
 * Whether an earlier write already took this target for good: one comment per
 * video ever, one reply per comment ever. Failed rows do not count; uncertain ones do.
 * @param domain - account storage.
 * @param action - the write.
 * @param target - its target key.
 */
export function alreadyTaken(domain: BiliDomain, action: WriteAction, target: string): boolean {
  if (action !== 'comment' && action !== 'reply') return false
  for (const [, row] of domain.table('ledger').entries()) {
    if (row.action === action && row.target === target && COUNTED.has(row.state)) return true
  }
  return false
}

/**
 * Whether an earlier attempt of the same write ended `uncertain`: it may have
 * happened, so it is never sent again.
 * @param domain - account storage.
 * @param action - the write.
 * @param target - its target key.
 */
export function uncertainBefore(domain: BiliDomain, action: WriteAction, target: string): boolean {
  for (const [, row] of domain.table('ledger').entries()) {
    if (row.action === action && row.target === target && row.state === 'uncertain') return true
  }
  return false
}

/**
 * Record a write before its request goes out.
 * @param domain - account storage.
 * @param row - the write without id, state, or time.
 * @param now - current time.
 * @param timeZone - zone of the day boundary.
 * @returns the stored row.
 */
export async function reserve(
  domain: BiliDomain, row: Omit<LedgerRecord, 'id' | 'state' | 'reservedAt' | 'day'>, now: number, timeZone: string,
): Promise<LedgerRecord> {
  const record: LedgerRecord = { ...row, id: randomUUID(), state: 'reserved', reservedAt: now, day: dayKey(now, timeZone) }
  await domain.table('ledger').put(record.id, record)
  await prune(domain)
  return record
}

/**
 * Settle a reserved write.
 * @param domain - account storage.
 * @param id - ledger id.
 * @param patch - new state and details.
 * @returns the stored row, or undefined when it is gone.
 */
export async function settle(domain: BiliDomain, id: string, patch: Partial<Omit<LedgerRecord, 'id'>>): Promise<LedgerRecord | undefined> {
  const current = domain.table('ledger').get(id)
  if (current === undefined) return undefined
  const next: LedgerRecord = { ...current, ...patch }
  await domain.table('ledger').put(id, next)
  return next
}

/**
 * After a restart, a write still `reserved` may or may not have reached
 * Bilibili: it becomes `uncertain`, keeps counting, and is never sent again.
 * @param domain - account storage.
 * @param now - current time.
 * @returns how many rows changed.
 */
export async function settleInterrupted(domain: BiliDomain, now: number): Promise<number> {
  let changed = 0
  for (const row of ledgerRows(domain)) {
    if (row.state !== 'reserved') continue
    await settle(domain, row.id, { state: 'uncertain', settledAt: now, detail: 'the host stopped while the request was in flight' })
    changed += 1
  }
  return changed
}

/**
 * When the next write may go out.
 * @param domain - account storage.
 */
export function nextSlot(domain: BiliDomain): number {
  return domain.table('slots').get('write')?.nextAt ?? 0
}

/**
 * Push the next write slot a random gap past `now`.
 * @param domain - account storage.
 * @param now - when this write finished.
 * @param gap - minimum and maximum gap.
 * @param random - uniform source in [0, 1).
 */
export async function takeSlot(
  domain: BiliDomain, now: number, gap: { minMs: number; maxMs: number }, random: () => number,
): Promise<void> {
  const nextAt = now + gap.minMs + Math.floor(random() * Math.max(0, gap.maxMs - gap.minMs))
  await domain.table('slots').put('write', { nextAt })
}

/**
 * Drop the oldest settled rows beyond the retention bound. Reserved rows, and
 * comment and reply rows (the memory behind "one per target ever"), stay.
 */
async function prune(domain: BiliDomain): Promise<void> {
  const table = domain.table('ledger')
  const excess = table.size - MAX_LEDGER_ROWS
  if (excess <= 0) return
  const victims = ledgerRows(domain).filter(row => row.state !== 'reserved' && row.action !== 'comment' && row.action !== 'reply').slice(0, excess)
  for (const row of victims) await table.delete(row.id)
}
