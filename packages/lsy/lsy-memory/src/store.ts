/**
 * The memory file: `<DSH_HOME>/lsy-memory/memory.jsonl`, one entry per line. Every
 * mutation re-reads the file under a per-path lock and replaces it atomically, so
 * concurrent Sessions and hand edits between writes are never lost.
 */

import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  entryFrom,
  isCategory,
  isEntryId,
  MAX_LABEL_CHARS,
  MAX_TEXT_CHARS,
  normalizeText,
  pendingFrom,
  type MemoryCategory,
  type MemoryDraft,
  type MemoryEntry,
  type PendingEntry,
  type WriteMeta,
} from './entries.ts'

/** Most entries one file holds; a save beyond it is refused. */
export const MAX_ENTRIES = 1000

/** Most protected writes that may wait for the owner; a further one is refused until some are answered. */
export const MAX_PENDING = 50

/** Days a pending write waits before it is dropped. */
export const PENDING_DAYS = 14

/** Daily snapshots of the memory file that are kept. */
export const SNAPSHOTS_KEPT = 30

/** Why a store operation was refused. */
export type MemoryErrorCode = 'invalid_text' | 'invalid_category' | 'invalid_id' | 'not_found' | 'full' | 'corrupt' | 'pending_full' | 'nothing_to_revert'

/** A refused store operation; `message` is safe to show the model. */
export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string) {
    super(message)
    this.name = 'MemoryError'
  }
}

/** What {@link MemoryStore.save} did. */
export interface SaveResult {
  readonly entry: MemoryEntry
  /** `added` for a new entry, `replaced` for an id given, `unchanged` when the same text already exists. */
  readonly outcome: 'added' | 'replaced' | 'unchanged'
}

/** What {@link MemoryStore.importDrafts} did. */
export interface ImportResult {
  readonly added: number
  /** Drafts whose category and text already exist. */
  readonly duplicates: number
}

/** What changed an entry, as the history records it. */
export type HistoryOp = 'add' | 'replace' | 'forget' | 'import' | 'approve' | 'revert' | 'rollback'

/** One line of `memory.history.jsonl`: the full before and after of an entry that changed. */
export interface HistoryRecord extends WriteMeta {
  /** ISO time of the change. */
  readonly at: string
  readonly op: HistoryOp
  readonly id: string
  readonly before?: MemoryEntry
  readonly after?: MemoryEntry
  /** SHA-256 of the memory file right after the change, so a hand edit between writes is detectable. */
  readonly sha: string
}

/** Which history records {@link MemoryStore.rollback} undoes. */
export interface RollbackFilter {
  /** Changes written by this Session's turns. */
  readonly session?: string
  /** Changes at or after this ISO time. */
  readonly since?: string
}

/** What {@link MemoryStore.rollback} did. */
export interface RollbackResult {
  /** History records matched. */
  readonly matched: number
  /** Entries put back as they were. */
  readonly restored: number
  /** Entries removed again. */
  readonly removed: number
  /** Ids of the entries it touched. */
  readonly ids: readonly string[]
}

/** What {@link MemoryStore.search} found. */
export interface SearchResult {
  readonly entries: MemoryEntry[]
  /** Matches beyond `limit`. */
  readonly more: number
}

/**
 * Default memory file of a DSH home.
 * @param env - environment holding `DSH_HOME`; defaults to `process.env`.
 */
export function defaultMemoryFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(undefined, env), 'lsy-memory', 'memory.jsonl')
}

/** Today as `YYYY-MM-DD` in the process time zone. */
export function localDate(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const locks = new Map<string, Promise<void>>()

/** Run `task` after every earlier task on the same file has settled. */
export async function serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve()
  const run = previous.then(task)
  const settled = run.then(() => {}, () => {})
  locks.set(file, settled)
  void settled.then(() => {
    if (locks.get(file) === settled) locks.delete(file)
  })
  return await run
}

function validText(raw: unknown): string {
  if (typeof raw !== 'string') throw new MemoryError('invalid_text', 'text must be a string.')
  const text = normalizeText(raw)
  if (text.length === 0) throw new MemoryError('invalid_text', 'text is empty.')
  if (text.length > MAX_TEXT_CHARS) {
    throw new MemoryError('invalid_text', `text is ${String(text.length)} characters; the limit is ${String(MAX_TEXT_CHARS)}. Split it into separate facts.`)
  }
  return text
}

function validCategory(raw: unknown): MemoryCategory {
  if (!isCategory(raw)) throw new MemoryError('invalid_category', `unknown category ${JSON.stringify(raw)}.`)
  return raw
}

/** Search terms: lowercase, whitespace-separated, deduplicated. */
function termsOf(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/u).filter(term => term.length > 0))]
}

/** Entries as the file holds them: one JSON object per line. */
function serialize(entries: readonly MemoryEntry[]): string {
  return entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '')
}

/** What a mutation decided: the next entries, the caller's result, and the history operation. */
interface Change<T> {
  entries: MemoryEntry[]
  result: T
  op: HistoryOp
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const sameEntry = (left: MemoryEntry | undefined, right: MemoryEntry | undefined): boolean => JSON.stringify(left) === JSON.stringify(right)

/** Meta fields that exist, so an absent one never appears as `undefined` in a stored line. */
function metaOf(meta: WriteMeta | undefined): WriteMeta {
  return {
    ...meta?.source === undefined ? {} : { source: meta.source },
    ...meta?.session === undefined ? {} : { session: meta.session },
    ...meta?.origin === undefined ? {} : { origin: meta.origin },
  }
}

/** The memory file and its operations. */
export class MemoryStore {
  /** `memory.history.jsonl` beside the memory file: before and after of every change. */
  readonly historyFile: string
  /** `memory.pending.jsonl`: protected writes waiting for the owner. */
  readonly pendingFile: string
  /** Daily copies of the memory file. */
  readonly snapshotDir: string

  /**
   * @param file - absolute path of the JSONL file.
   * @param today - date stamp for writes; injectable for tests.
   * @param now - clock for history times and pending expiry; injectable for tests.
   */
  constructor(
    readonly file: string,
    private readonly today: () => string = localDate,
    private readonly now: () => Date = () => new Date(),
  ) {
    const dir = dirname(file)
    this.historyFile = join(dir, 'memory.history.jsonl')
    this.pendingFile = join(dir, 'memory.pending.jsonl')
    this.snapshotDir = join(dir, 'snapshots')
  }

  /** Every entry in file order; a missing file is empty. */
  async list(): Promise<MemoryEntry[]> {
    const raw = await this.read(this.file)
    const entries: MemoryEntry[] = []
    for (const [index, line] of raw.split('\n').entries()) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = undefined
      }
      const entry = entryFrom(parsed)
      // Refuse rather than skip: the next write would silently drop a hand-edited line.
      if (entry === undefined) throw new MemoryError('corrupt', `${this.file} line ${String(index + 1)} is not a valid entry.`)
      entries.push(entry)
    }
    return entries
  }

  /** The file's text, or empty when it does not exist. */
  private async read(file: string): Promise<string> {
    try {
      return await readFile(file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  /** SHA-256 of the memory file's current text, or of nothing when it does not exist. */
  async sha(): Promise<string> {
    return sha256(await this.read(this.file))
  }

  /** Writes waiting for the owner, oldest first; expired ones are left out. */
  async listPending(): Promise<PendingEntry[]> {
    const pending: PendingEntry[] = []
    const cutoff = this.now().getTime() - PENDING_DAYS * 86_400_000
    for (const line of (await this.read(this.pendingFile)).split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const entry = pendingFrom(parsed)
      if (entry !== undefined && Date.parse(`${entry.date}T00:00:00`) >= cutoff - 86_400_000) pending.push(entry)
    }
    return pending
  }

  /**
   * Add an entry, or replace the text (and category) of entry `id`.
   * @param input - text, category, and the id to replace.
   * @param meta - who wrote it, kept with the entry and in the history.
   */
  async save(input: { text: unknown; category: unknown; id?: unknown }, meta?: WriteMeta): Promise<SaveResult> {
    const text = validText(input.text)
    const category = validCategory(input.category)
    if (input.id !== undefined && !isEntryId(input.id)) throw new MemoryError('invalid_id', `id ${JSON.stringify(input.id)} is not six hex digits.`)
    const id = input.id
    const stamp = metaOf(meta)
    return await this.mutate<SaveResult>(stamp, async (entries) => {
      if (id !== undefined) {
        const index = entries.findIndex(entry => entry.id === id)
        if (index < 0) throw new MemoryError('not_found', `no entry with id ${id}.`)
        const entry: MemoryEntry = { id, category, date: this.today(), text, ...stamp }
        return { entries: entries.toSpliced(index, 1, entry), result: { entry, outcome: 'replaced' as const }, op: 'replace' }
      }
      const existing = entries.find(entry => entry.category === category && entry.text === text)
      if (existing !== undefined) return { entries, result: { entry: existing, outcome: 'unchanged' as const }, op: 'add' }
      if (entries.length >= MAX_ENTRIES) {
        throw new MemoryError('full', `memory holds ${String(MAX_ENTRIES)} entries; forget or merge some first.`)
      }
      const entry: MemoryEntry = { id: freshId([...entries, ...await this.listPending()]), category, date: this.today(), text, ...stamp }
      return { entries: [...entries, entry], result: { entry, outcome: 'added' as const }, op: 'add' }
    })
  }

  /**
   * Hold a write for the owner instead of making it: nothing reaches the memory file until {@link approve}.
   * @param input - text, category, and the id of the entry it would replace.
   * @param meta - who wrote it.
   * @returns the pending entry; asking again for the same fact returns the one already waiting.
   */
  async savePending(input: { text: unknown; category: unknown; id?: unknown }, meta?: WriteMeta): Promise<PendingEntry> {
    const text = validText(input.text)
    const category = validCategory(input.category)
    if (input.id !== undefined && !isEntryId(input.id)) throw new MemoryError('invalid_id', `id ${JSON.stringify(input.id)} is not six hex digits.`)
    const target = input.id
    const stamp = metaOf(meta)
    return await serialized(this.file, async () => {
      const entries = await this.list()
      if (target !== undefined && !entries.some(entry => entry.id === target)) throw new MemoryError('not_found', `no entry with id ${target}.`)
      const pending = await this.listPending()
      const twin = pending.find(entry => entry.category === category && entry.text === text && entry.target === target)
      if (twin !== undefined) return twin
      if (pending.length >= MAX_PENDING) {
        throw new MemoryError('pending_full', `${String(MAX_PENDING)} writes already wait for the owner; they must be answered first.`)
      }
      const entry: PendingEntry = target === undefined
        ? { id: freshId([...entries, ...pending]), category, date: this.today(), text, ...stamp, op: 'add' }
        : { id: freshId([...entries, ...pending]), category, date: this.today(), text, ...stamp, op: 'replace', target }
      await this.writePending([...pending, entry])
      return entry
    })
  }

  /**
   * Make a waiting write: the entry is added (or replaces its target) and marked as confirmed by the owner.
   * @param id - id of the pending entry.
   * @param meta - Session and origin of the confirming turn.
   * @returns the resulting entry.
   */
  async approve(id: unknown, meta?: Pick<WriteMeta, 'session' | 'origin'>): Promise<MemoryEntry> {
    if (!isEntryId(id)) throw new MemoryError('invalid_id', `id ${JSON.stringify(id)} is not six hex digits.`)
    const stamp = metaOf({ ...meta, source: 'owner-confirmed' })
    return await this.mutate<MemoryEntry>(stamp, async (entries) => {
      const pending = await this.listPending()
      const waiting = pending.find(entry => entry.id === id)
      if (waiting === undefined) throw new MemoryError('not_found', `nothing waits under id ${id}.`)
      const { op, target, session: _session, origin: waitingOrigin, source: _source, ...base } = waiting
      const via = waitingOrigin === undefined ? undefined : `${stamp.origin ?? 'owner'} via ${waitingOrigin}`.slice(0, MAX_LABEL_CHARS)
      const entry: MemoryEntry = { ...base, date: this.today(), ...stamp, ...via === undefined ? {} : { origin: via } }
      let next: MemoryEntry[]
      let resultId = entry.id
      if (op === 'replace' && target !== undefined) {
        const index = entries.findIndex(candidate => candidate.id === target)
        if (index < 0) throw new MemoryError('not_found', `entry ${target} is gone, so the waiting change cannot be made.`)
        next = entries.toSpliced(index, 1, { ...entry, id: target })
        resultId = target
      } else {
        if (entries.length >= MAX_ENTRIES) throw new MemoryError('full', `memory holds ${String(MAX_ENTRIES)} entries; forget or merge some first.`)
        next = [...entries, entry]
      }
      const made = next.find(candidate => candidate.id === resultId)
      if (made === undefined) throw new MemoryError('corrupt', `entry ${resultId} was not made.`)
      await this.writePending(pending.filter(candidate => candidate.id !== id))
      return { entries: next, result: made, op: 'approve' }
    })
  }

  /**
   * Drop a waiting write.
   * @param id - id of the pending entry.
   * @returns the dropped entry.
   */
  async discard(id: unknown): Promise<PendingEntry> {
    if (!isEntryId(id)) throw new MemoryError('invalid_id', `id ${JSON.stringify(id)} is not six hex digits.`)
    return await serialized(this.file, async () => {
      const pending = await this.listPending()
      const dropped = pending.find(entry => entry.id === id)
      if (dropped === undefined) throw new MemoryError('not_found', `nothing waits under id ${id}.`)
      await this.writePending(pending.filter(entry => entry.id !== id))
      return dropped
    })
  }

  /**
   * Remove entry `id`.
   * @param id - entry id.
   * @param meta - who removed it.
   * @returns the removed entry.
   */
  async forget(id: unknown, meta?: WriteMeta): Promise<MemoryEntry> {
    if (!isEntryId(id)) throw new MemoryError('invalid_id', `id ${JSON.stringify(id)} is not six hex digits.`)
    return await this.mutate<MemoryEntry>(metaOf(meta), (entries) => {
      const entry = entries.find(candidate => candidate.id === id)
      if (entry === undefined) throw new MemoryError('not_found', `no entry with id ${id}.`)
      return { entries: entries.filter(candidate => candidate !== entry), result: entry, op: 'forget' }
    })
  }

  /**
   * Undo the latest change to an entry: remove one that was added, put back the text a change replaced.
   * @param id - entry id (a waiting write is dropped instead).
   * @param meta - who asked.
   * @returns what happened to the entry.
   */
  async revert(id: unknown, meta?: WriteMeta): Promise<{ outcome: 'removed' | 'restored' | 'dropped'; entry: MemoryEntry }> {
    if (!isEntryId(id)) throw new MemoryError('invalid_id', `id ${JSON.stringify(id)} is not six hex digits.`)
    const waiting = (await this.listPending()).find(entry => entry.id === id)
    if (waiting !== undefined) return { outcome: 'dropped', entry: await this.discard(id) }
    return await this.mutate<{ outcome: 'removed' | 'restored'; entry: MemoryEntry }>(metaOf(meta), async (entries) => {
      const records = (await this.history()).filter(record => record.id === id)
      const last = records.at(-1)
      const current = entries.find(entry => entry.id === id)
      if (last === undefined || last.op === 'revert' || last.op === 'rollback') throw new MemoryError('nothing_to_revert', `entry ${id} has no change to undo.`)
      if (current === undefined) {
        // The last change removed it: put it back.
        if (last.op !== 'forget' || last.before === undefined) throw new MemoryError('nothing_to_revert', `entry ${id} has no change to undo.`)
        if (entries.length >= MAX_ENTRIES) throw new MemoryError('full', `memory holds ${String(MAX_ENTRIES)} entries; forget or merge some first.`)
        return { entries: [...entries, last.before], result: { outcome: 'restored' as const, entry: last.before }, op: 'revert' }
      }
      if (last.before === undefined) {
        return { entries: entries.filter(entry => entry.id !== id), result: { outcome: 'removed' as const, entry: current }, op: 'revert' }
      }
      const restored = last.before
      return {
        entries: entries.map(entry => (entry.id === id ? restored : entry)),
        result: { outcome: 'restored' as const, entry: restored },
        op: 'revert',
      }
    })
  }

  /** The history, oldest first; a damaged line is skipped. */
  async history(): Promise<HistoryRecord[]> {
    const records: HistoryRecord[] = []
    for (const line of (await this.read(this.historyFile)).split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as HistoryRecord
        if (typeof parsed.id === 'string' && typeof parsed.op === 'string' && typeof parsed.at === 'string') records.push(parsed)
      } catch {
        // A torn line costs one record, not the history.
      }
    }
    return records
  }

  /**
   * Undo every change a Session's turns made, or every change since a time, newest first.
   * @param filter - the Session id and/or the ISO time to go back to.
   * @param options - `dryRun` only counts.
   */
  async rollback(filter: RollbackFilter, options: { dryRun?: boolean } = {}): Promise<RollbackResult> {
    if (filter.session === undefined && filter.since === undefined) throw new MemoryError('invalid_id', 'give a session or a since time to roll back.')
    const matches = (await this.history()).filter(record =>
      (filter.session === undefined || record.session === filter.session)
      && (filter.since === undefined || record.at >= filter.since)
      && record.op !== 'rollback')
    const ids = [...new Set(matches.map(record => record.id))]
    const result = (entries: MemoryEntry[]): { entries: MemoryEntry[]; restored: number; removed: number } => {
      let next = [...entries]
      let restored = 0
      let removed = 0
      for (const record of matches.toReversed()) {
        const index = next.findIndex(entry => entry.id === record.id)
        if (record.before === undefined) {
          if (index >= 0) { next = next.filter(entry => entry.id !== record.id); removed += 1 }
        } else if (index >= 0) {
          next = next.toSpliced(index, 1, record.before)
          restored += 1
        } else {
          next = [...next, record.before]
          restored += 1
        }
      }
      return { entries: next, restored, removed }
    }
    if (options.dryRun === true) {
      const outcome = result(await this.list())
      return { matched: matches.length, restored: outcome.restored, removed: outcome.removed, ids }
    }
    return await this.mutate({}, (entries) => {
      const outcome = result(entries)
      const summary = { matched: matches.length, restored: outcome.restored, removed: outcome.removed, ids }
      return { entries: outcome.entries, result: summary, op: 'rollback' }
    })
  }

  /**
   * Erase an entry and every trace of it: the file, the history, the snapshots, and the waiting writes.
   * @param id - entry id.
   * @returns the number of places it was removed from.
   */
  async purge(id: unknown): Promise<{ entries: number; history: number; snapshots: number; pending: number }> {
    if (!isEntryId(id)) throw new MemoryError('invalid_id', `id ${JSON.stringify(id)} is not six hex digits.`)
    return await serialized(this.file, async () => {
      const entries = await this.list()
      const kept = entries.filter(entry => entry.id !== id)
      if (kept.length !== entries.length) await this.writeEntries(kept)
      const history = await this.history()
      const keptHistory = history.filter(record => record.id !== id)
      if (keptHistory.length !== history.length) {
        const temporary = `${this.historyFile}.${String(process.pid)}.tmp`
        await writeFile(temporary, keptHistory.map(record => JSON.stringify(record)).join('\n') + (keptHistory.length > 0 ? '\n' : ''), { mode: 0o600 })
        await rename(temporary, this.historyFile)
      }
      let snapshots = 0
      for (const name of await this.snapshotNames()) {
        const path = join(this.snapshotDir, name)
        const lines = (await this.read(path)).split('\n').filter(line => line.trim() !== '')
        const left = lines.filter((line) => {
          try { return (JSON.parse(line) as { id?: unknown }).id !== id } catch { return true }
        })
        if (left.length !== lines.length) {
          await writeFile(path, left.join('\n') + (left.length > 0 ? '\n' : ''), { mode: 0o600 })
          snapshots += 1
        }
      }
      const pending = await this.listPending()
      const keptPending = pending.filter(entry => entry.id !== id && entry.target !== id)
      if (keptPending.length !== pending.length) await this.writePending(keptPending)
      return {
        entries: entries.length - kept.length,
        history: history.length - keptHistory.length,
        snapshots,
        pending: pending.length - keptPending.length,
      }
    })
  }

  /**
   * Add dated drafts, keeping their dates; drafts whose category and text already exist are skipped.
   * @param drafts - entries to add, in order; they are marked as imported.
   */
  async importDrafts(drafts: readonly MemoryDraft[]): Promise<ImportResult> {
    const checked = drafts.map(draft => ({ ...draft, category: validCategory(draft.category), text: validText(draft.text) }))
    return await this.mutate<ImportResult>({ source: 'import' }, (entries) => {
      const next = [...entries]
      let duplicates = 0
      for (const draft of checked) {
        if (next.some(entry => entry.category === draft.category && entry.text === draft.text)) {
          duplicates += 1
          continue
        }
        next.push({ id: freshId(next), ...draft, source: 'import' })
      }
      if (next.length > MAX_ENTRIES) {
        throw new MemoryError('full', `the import would hold ${String(next.length)} entries; the limit is ${String(MAX_ENTRIES)}.`)
      }
      return { entries: next, result: { added: next.length - entries.length, duplicates }, op: 'import' }
    })
  }

  /**
   * Entries containing any query term, case-insensitively, most terms first, then newest.
   * An empty query lists the category (or everything), newest first.
   * @param query - whitespace-separated terms; an entry id also matches.
   * @param options - category filter and result cap.
   */
  async search(query: string, options: { category?: MemoryCategory; limit: number }): Promise<SearchResult> {
    const terms = termsOf(query)
    const scoped = (await this.list()).filter(entry => options.category === undefined || entry.category === options.category)
    const scored = scoped
      .map((entry, order) => {
        const haystack = entry.text.toLowerCase()
        const score = terms.length === 0 ? 1 : terms.filter(term => haystack.includes(term) || entry.id === term).length
        return { entry, order, score }
      })
      .filter(candidate => candidate.score > 0)
      .toSorted((left, right) => right.score - left.score
        || right.entry.date.localeCompare(left.entry.date)
        || right.order - left.order)
    return { entries: scored.slice(0, options.limit).map(candidate => candidate.entry), more: Math.max(0, scored.length - options.limit) }
  }

  /** Ids and categories of every entry and every waiting write: what the owner reviews without reading text. */
  async index(): Promise<{
    entries: Array<{ id: string; category: MemoryCategory; source: string }>
    pending: Array<{ id: string; category: MemoryCategory; op: string }>
  }> {
    return {
      entries: (await this.list()).map(entry => ({ id: entry.id, category: entry.category, source: entry.source ?? 'legacy' })),
      pending: (await this.listPending()).map(entry => ({ id: entry.id, category: entry.category, op: entry.op })),
    }
  }

  private async writeEntries(entries: readonly MemoryEntry[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${String(process.pid)}.tmp`
    await writeFile(temporary, serialize(entries), { mode: 0o600 })
    await rename(temporary, this.file)
  }

  private async writePending(pending: readonly PendingEntry[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.pendingFile}.${String(process.pid)}.tmp`
    await writeFile(temporary, pending.map(entry => JSON.stringify(entry)).join('\n') + (pending.length > 0 ? '\n' : ''), { mode: 0o600 })
    await rename(temporary, this.pendingFile)
  }

  private async snapshotNames(): Promise<string[]> {
    try {
      return (await readdir(this.snapshotDir)).filter(name => /^memory-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name)).toSorted()
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async mutate<T>(
    meta: WriteMeta,
    change: (entries: MemoryEntry[]) => Change<T> | Promise<Change<T>>,
  ): Promise<T> {
    return await serialized(this.file, async () => {
      const before = await this.list()
      const { entries, result, op } = await change(before)
      const changed = entries.length !== before.length || entries.some((entry, index) => !sameEntry(entry, before[index]))
      if (!changed) return result
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      await this.snapshotOnce(before)
      await this.writeEntries(entries)
      const text = serialize(entries)
      const at = this.now().toISOString()
      const sha = sha256(text)
      const byId = new Map(before.map(entry => [entry.id, entry]))
      const after = new Map(entries.map(entry => [entry.id, entry]))
      const records: HistoryRecord[] = []
      for (const id of new Set([...byId.keys(), ...after.keys()])) {
        const was = byId.get(id)
        const now = after.get(id)
        if (sameEntry(was, now)) continue
        const record: HistoryRecord = {
          at, op: op === 'add' && was !== undefined ? 'replace' : op, id, ...was === undefined ? {} : { before: was }, ...now === undefined ? {} : { after: now }, ...meta, sha,
        }
        records.push(record)
      }
      if (records.length > 0) await appendFile(this.historyFile, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 })
      return result
    })
  }

  /** Copy the pre-change file once per day, and prune the oldest copies. */
  private async snapshotOnce(before: readonly MemoryEntry[]): Promise<void> {
    if (before.length === 0) return
    const name = `memory-${this.today()}.jsonl`
    await mkdir(this.snapshotDir, { recursive: true, mode: 0o700 })
    const names = await this.snapshotNames()
    if (!names.includes(name)) {
      await writeFile(join(this.snapshotDir, name), serialize(before), { mode: 0o600 })
      names.push(name)
    }
    for (const old of names.toSorted().slice(0, Math.max(0, names.length - SNAPSHOTS_KEPT))) {
      await rm(join(this.snapshotDir, old), { force: true })
    }
  }
}

export function freshId(entries: readonly { readonly id: string }[]): string {
  const taken = new Set(entries.map(entry => entry.id))
  for (;;) {
    const id = randomBytes(3).toString('hex')
    if (!taken.has(id)) return id
  }
}
