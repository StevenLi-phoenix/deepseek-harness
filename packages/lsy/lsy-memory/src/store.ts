/**
 * The memory file: `<DSH_HOME>/lsy-memory/memory.jsonl`, one entry per line. Every
 * mutation re-reads the file under a per-path lock and replaces it atomically, so
 * concurrent Sessions and hand edits between writes are never lost.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  entryFrom,
  isCategory,
  isEntryId,
  MAX_TEXT_CHARS,
  normalizeText,
  type MemoryCategory,
  type MemoryDraft,
  type MemoryEntry,
} from './entries.ts'

/** Most entries one file holds; a save beyond it is refused. */
export const MAX_ENTRIES = 1000

/** Why a store operation was refused. */
export type MemoryErrorCode = 'invalid_text' | 'invalid_category' | 'invalid_id' | 'not_found' | 'full' | 'corrupt'

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
async function serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
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

/** The memory file and its operations. */
export class MemoryStore {
  /**
   * @param file - absolute path of the JSONL file.
   * @param today - date stamp for writes; injectable for tests.
   */
  constructor(readonly file: string, private readonly today: () => string = localDate) {}

  /** Every entry in file order; a missing file is empty. */
  async list(): Promise<MemoryEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
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

  /**
   * Add an entry, or replace the text (and category) of entry `id`.
   * @param input - text, category, and the id to replace.
   */
  async save(input: { text: unknown; category: unknown; id?: unknown }): Promise<SaveResult> {
    const text = validText(input.text)
    const category = validCategory(input.category)
    if (input.id !== undefined && !isEntryId(input.id)) throw new MemoryError('invalid_id', `id ${JSON.stringify(input.id)} is not six hex digits.`)
    const id = input.id
    return await this.mutate<SaveResult>((entries) => {
      if (id !== undefined) {
        const index = entries.findIndex(entry => entry.id === id)
        if (index < 0) throw new MemoryError('not_found', `no entry with id ${id}.`)
        const entry: MemoryEntry = { id, category, date: this.today(), text }
        return { entries: entries.toSpliced(index, 1, entry), result: { entry, outcome: 'replaced' as const } }
      }
      const existing = entries.find(entry => entry.category === category && entry.text === text)
      if (existing !== undefined) return { entries, result: { entry: existing, outcome: 'unchanged' as const } }
      if (entries.length >= MAX_ENTRIES) {
        throw new MemoryError('full', `memory holds ${String(MAX_ENTRIES)} entries; forget or merge some first.`)
      }
      const entry: MemoryEntry = { id: freshId(entries), category, date: this.today(), text }
      return { entries: [...entries, entry], result: { entry, outcome: 'added' as const } }
    })
  }

  /**
   * Remove entry `id`.
   * @param id - entry id.
   * @returns the removed entry.
   */
  async forget(id: unknown): Promise<MemoryEntry> {
    if (!isEntryId(id)) throw new MemoryError('invalid_id', `id ${JSON.stringify(id)} is not six hex digits.`)
    return await this.mutate((entries) => {
      const entry = entries.find(candidate => candidate.id === id)
      if (entry === undefined) throw new MemoryError('not_found', `no entry with id ${id}.`)
      return { entries: entries.filter(candidate => candidate !== entry), result: entry }
    })
  }

  /**
   * Add dated drafts, keeping their dates; drafts whose category and text already exist are skipped.
   * @param drafts - entries to add, in order.
   */
  async importDrafts(drafts: readonly MemoryDraft[]): Promise<ImportResult> {
    const checked = drafts.map(draft => ({ ...draft, category: validCategory(draft.category), text: validText(draft.text) }))
    return await this.mutate((entries) => {
      const next = [...entries]
      let duplicates = 0
      for (const draft of checked) {
        if (next.some(entry => entry.category === draft.category && entry.text === draft.text)) {
          duplicates += 1
          continue
        }
        next.push({ id: freshId(next), ...draft })
      }
      if (next.length > MAX_ENTRIES) {
        throw new MemoryError('full', `the import would hold ${String(next.length)} entries; the limit is ${String(MAX_ENTRIES)}.`)
      }
      return { entries: next, result: { added: next.length - entries.length, duplicates } }
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

  private async mutate<T>(change: (entries: MemoryEntry[]) => { entries: MemoryEntry[]; result: T }): Promise<T> {
    return await serialized(this.file, async () => {
      const { entries, result } = change(await this.list())
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${String(process.pid)}.tmp`
      await writeFile(temporary, entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''), { mode: 0o600 })
      await rename(temporary, this.file)
      return result
    })
  }
}

function freshId(entries: readonly MemoryEntry[]): string {
  const taken = new Set(entries.map(entry => entry.id))
  for (;;) {
    const id = randomBytes(3).toString('hex')
    if (!taken.has(id)) return id
  }
}
