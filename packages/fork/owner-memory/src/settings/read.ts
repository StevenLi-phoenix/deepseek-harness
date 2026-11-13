/**
 * The Memory settings read model: what the memory file, its history, the waiting writes, and the feedback
 * file hold, shaped for the page. Reading writes nothing.
 */

import { isProtected, type MemoryEntry, type MemorySource, type PendingEntry } from '../entries.ts'
import type { FeedbackEntry, FeedbackStore } from '../feedback.ts'
import { PENDING_DAYS, type HistoryRecord, type MemoryStore } from '../store.ts'
import {
  CATEGORIES, CLIP_CHARS,
  type Category, type DetailView, type EntrySource, type EntryView, type FeedbackView, type HistoryView, type MemoryQuery, type MemoryView,
  type PendingView, type SessionView,
} from './view.ts'

/** Sessions the rollback picker lists. */
const SESSIONS_SHOWN = 30
/** History lines one detail answer carries. */
const HISTORY_SHOWN = 50

/**
 * Cut text to `chars` characters.
 * @param text - the text.
 * @param chars - the most characters kept.
 * @returns the text unchanged, or its first `chars` characters followed by an ellipsis.
 */
export function clip(text: string, chars: number = CLIP_CHARS): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}…`
}

const sourceOf = (source: MemorySource | undefined): EntrySource => source ?? 'legacy'

/** `{ key: value }` when the value exists, else nothing, so an absent field never appears as `undefined`. */
const optional = <K extends string>(key: K, value: string | undefined): { [P in K]?: string } => (
  value === undefined ? {} : { [key]: value } as { [P in K]: string }
)

/** Whether a Session's turn was the owner's alone, as the store recorded it. */
const isTainted = (source: MemorySource | undefined): boolean => source === 'tainted-turn'

function entryView(entry: MemoryEntry, revertible: boolean, full: boolean): EntryView {
  const clipped = !full && entry.text.length > CLIP_CHARS
  return {
    id: entry.id,
    category: entry.category,
    date: entry.date,
    text: clipped ? clip(entry.text) : entry.text,
    clipped,
    source: sourceOf(entry.source),
    ...optional('session', entry.session),
    ...optional('origin', entry.origin),
    protected: isProtected(entry.category),
    revertible,
  }
}

function pendingView(entry: PendingEntry, entries: readonly MemoryEntry[]): PendingView {
  const target = entry.target === undefined ? undefined : entries.find(candidate => candidate.id === entry.target)
  const expires = new Date(`${entry.date}T00:00:00Z`)
  expires.setUTCDate(expires.getUTCDate() + PENDING_DAYS)
  return {
    id: entry.id,
    op: entry.op,
    ...optional('target', entry.target),
    ...target === undefined ? {} : { replaces: clip(target.text) },
    category: entry.category,
    date: entry.date,
    text: entry.text,
    source: sourceOf(entry.source),
    ...optional('session', entry.session),
    ...optional('origin', entry.origin),
    tainted: isTainted(entry.source),
    expiresOn: expires.toISOString().slice(0, 10),
  }
}

function feedbackView(entry: FeedbackEntry): FeedbackView {
  return {
    id: entry.id, scope: entry.scope, verdict: entry.verdict, kind: entry.kind, text: entry.text,
    ...optional('ref', entry.ref), ...optional('note', entry.note), at: entry.at,
  }
}

/** Last history record per entry id. */
function lastByEntry(history: readonly HistoryRecord[]): Map<string, HistoryRecord> {
  const last = new Map<string, HistoryRecord>()
  for (const record of history) last.set(record.id, record)
  return last
}

const canRevert = (record: HistoryRecord | undefined): boolean => record !== undefined && record.op !== 'revert' && record.op !== 'rollback'

function sessionViews(history: readonly HistoryRecord[]): SessionView[] {
  const bySession = new Map<string, {
    changes: number
    ids: Set<string>
    firstAt: string
    lastAt: string
    /** Position in the history of the newest record; breaks a tie when two changes share a millisecond. */
    lastIndex: number
    origin: string | undefined
  }>()
  for (const [index, record] of history.entries()) {
    if (record.session === undefined) continue
    const found = bySession.get(record.session)
    if (found === undefined) {
      bySession.set(record.session, {
        changes: 1, ids: new Set([record.id]), firstAt: record.at, lastAt: record.at, lastIndex: index, origin: record.origin,
      })
    } else {
      found.changes += 1
      found.ids.add(record.id)
      if (record.at < found.firstAt) found.firstAt = record.at
      if (record.at >= found.lastAt) {
        found.lastAt = record.at
        found.lastIndex = index
        found.origin = record.origin ?? found.origin
      }
    }
  }
  return [...bySession]
    .toSorted(([, left], [, right]) => right.lastAt.localeCompare(left.lastAt) || right.lastIndex - left.lastIndex)
    .map(([id, value]): SessionView => ({
      id, changes: value.changes, entries: value.ids.size, firstAt: value.firstAt, lastAt: value.lastAt, ...optional('origin', value.origin),
    }))
    .slice(0, SESSIONS_SHOWN)
}

/**
 * Entries matching a query, newest change first.
 * @param entries - every entry in file order.
 * @param last - last history record per id.
 * @param query - the list's filter.
 */
function matching(entries: readonly MemoryEntry[], last: ReadonlyMap<string, HistoryRecord>, query: MemoryQuery): MemoryEntry[] {
  const terms = [...new Set(query.q.toLowerCase().split(/\s+/u).filter(term => term.length > 0))]
  return entries
    .map((entry, order) => ({ entry, order, changed: last.get(entry.id)?.at ?? `${entry.date}T00:00:00.000Z` }))
    .filter(({ entry }) => (query.category === 'all' || entry.category === query.category)
      && terms.every(term => entry.text.toLowerCase().includes(term) || entry.id === term))
    .toSorted((left, right) => right.changed.localeCompare(left.changed) || right.order - left.order)
    .map(({ entry }) => entry)
}

/**
 * Build the page's data.
 * @param store - the memory store.
 * @param feedback - the feedback store.
 * @param query - the list's filter and page.
 * @param now - epoch milliseconds, injectable for tests.
 * @returns the page's data.
 */
export async function readView(
  store: MemoryStore,
  feedback: FeedbackStore,
  query: MemoryQuery,
  now: number = Date.now(),
): Promise<MemoryView> {
  const [entries, pending, history, verdicts] = await Promise.all([store.list(), store.listPending(), store.history(), feedback.list()])
  const last = lastByEntry(history)
  const found = matching(entries, last, query)
  const counts = Object.fromEntries(
    CATEGORIES.map(category => [category, entries.filter(entry => entry.category === category).length]),
  ) as Record<Category, number>
  return {
    generatedAt: now,
    query,
    total: entries.length,
    counts,
    pending: pending.map(entry => pendingView(entry, entries)),
    entries: {
      items: found.slice(query.offset, query.offset + query.limit).map(entry => entryView(entry, canRevert(last.get(entry.id)), false)),
      matched: found.length,
    },
    sessions: sessionViews(history),
    feedback: verdicts.map(feedbackView),
  }
}

const historyView = (record: HistoryRecord): HistoryView => ({
  at: record.at,
  op: record.op,
  ...optional('session', record.session),
  ...optional('origin', record.origin),
  ...record.source === undefined ? {} : { source: record.source },
  ...record.before === undefined ? {} : { before: record.before.text },
  ...record.after === undefined ? {} : { after: record.after.text },
})

/**
 * One entry or waiting write in full, with its history.
 * @param store - the memory store.
 * @param id - entry or waiting-write id.
 * @returns the detail, or undefined when no entry or waiting write has the id.
 */
export async function readDetail(store: MemoryStore, id: string): Promise<DetailView | undefined> {
  const [entries, pending, history] = await Promise.all([store.list(), store.listPending(), store.history()])
  const mine = history.filter(record => record.id === id)
  const entry = entries.find(candidate => candidate.id === id)
  if (entry !== undefined) {
    const lines = mine.toReversed().slice(0, HISTORY_SHOWN).map(historyView)
    return { entry: entryView(entry, canRevert(mine.at(-1)), true), waiting: false, history: lines }
  }
  const waiting = pending.find(candidate => candidate.id === id)
  if (waiting === undefined) return undefined
  return { entry: entryView(waiting, false, true), waiting: true, history: [] }
}
