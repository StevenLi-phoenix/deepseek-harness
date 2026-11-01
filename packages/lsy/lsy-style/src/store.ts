/**
 * The sample container: `<dir>/samples.jsonl`, one record per line, written whole through a temporary file. Active
 * samples are capped (the owner's own pinned up to their own cap, the rest newest first), pending ones wait for the
 * owner when review is required, and removed or retired samples keep only their id, so the same exchange never
 * returns. The id is a hash of the exchange text, so the same words from another group or a later run are the same
 * sample.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeLine } from './filter.ts'
import { SAMPLE_SOURCES, SAMPLE_STATUSES, type Origin, type SampleSource, type SampleStatus } from './view.ts'

/** A stored record. A removed or retired record has no text. */
export interface StyleRecord {
  readonly id: string
  readonly source: SampleSource
  /** A reply the owner's public Bilibili account wrote by hand: pinned first, tone only. */
  readonly owner: boolean
  readonly status: SampleStatus
  /** ISO time it entered the store. */
  readonly addedAt: string
  /** ISO time of the last status change, for removed and retired records. */
  readonly changedAt?: string
  /** Epoch milliseconds the exchange was said. */
  readonly at?: number
  readonly prompt?: string
  readonly reply?: string
  /** How widely it was seen, as counts; kept on tombstones too. */
  readonly origin: Origin
}

/** A sample that passed the filters, before the store sees it. */
export interface Candidate {
  readonly source: SampleSource
  readonly owner?: boolean
  readonly origin: Origin
  readonly at?: number
  readonly prompt?: string
  readonly reply: string
}

/** Caps of the container. */
export interface StoreLimits {
  /** Active samples in all. */
  readonly maxActive: number
  /** Active samples of the owner's own (pinned ahead of the rest). */
  readonly maxOwner: number
  /** Pending samples. */
  readonly maxPending: number
  /** Ids of removed and retired samples remembered. */
  readonly maxTombstones: number
}

/** A refused store operation. */
export class StyleError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_input', message: string) {
    super(message)
    this.name = 'StyleError'
  }
}

/**
 * The id of an exchange: twelve hex digits of a hash of its normalized words.
 * @param prompt - what the other person said, if any.
 * @param reply - the reply.
 * @returns the id.
 */
export function sampleId(prompt: string | undefined, reply: string): string {
  return createHash('sha256').update(`${normalizeLine(prompt ?? '')}\u0000${normalizeLine(reply)}`).digest('hex').slice(0, 12)
}

/**
 * Sources of the first release of this file (before samples carried an origin), mapped to today's: a record from it
 * keeps its place with the least spread it could have had. A line the owner typed (`owner-manual`) has no place any more.
 */
const LEGACY_SOURCES: Readonly<Record<string, { readonly source: SampleSource; readonly owner: boolean } | undefined>> = {
  'qq-group': { source: 'qq', owner: false },
  'bili-viewer': { source: 'bili', owner: false },
  'owner-bili': { source: 'bili', owner: true },
}

function recordFrom(value: unknown): StyleRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const fields = value as Record<string, unknown>
  const legacy = typeof fields['source'] === 'string' ? LEGACY_SOURCES[fields['source']] : undefined
  const { id, source, owner, status, addedAt, changedAt, at, prompt, reply, origin } = legacy === undefined ? fields : {
    ...fields, source: legacy.source, owner: legacy.owner,
    origin: { platform: legacy.source, groups: 1, speakers: 2, days: 1 },
  }
  if (typeof id !== 'string' || !/^[0-9a-f]{12}$/u.test(id) || typeof addedAt !== 'string') return undefined
  if (!(SAMPLE_SOURCES as readonly unknown[]).includes(source)) return undefined
  if (!(SAMPLE_STATUSES as readonly unknown[]).includes(status)) return undefined
  const live = status === 'active' || status === 'pending'
  if (live && (typeof reply !== 'string' || reply === '')) return undefined
  const parsed = originFrom(origin, source as SampleSource)
  if (parsed === undefined) return undefined
  return {
    id, source: source as SampleSource, owner: owner === true && source === 'bili', status: status as SampleStatus, addedAt, origin: parsed,
    ...typeof changedAt === 'string' ? { changedAt } : {},
    ...typeof at === 'number' && Number.isFinite(at) ? { at } : {},
    ...live && typeof prompt === 'string' && prompt !== '' ? { prompt } : {},
    ...live ? { reply: reply as string } : {},
  }
}

/**
 * An origin read back from disk; its platform must be the record's source.
 * @param value - the stored field.
 * @param source - the record's source.
 * @returns the origin, or undefined when it is malformed.
 */
export function originFrom(value: unknown, source: SampleSource): Origin | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { platform, groups, speakers, days } = value as Record<string, unknown>
  const count = (field: unknown): field is number => typeof field === 'number' && Number.isInteger(field) && field >= 0
  if (platform !== source || !count(groups) || !count(speakers) || !count(days)) return undefined
  return { platform: source, groups, speakers, days }
}

const tombstone = (record: StyleRecord, status: 'removed' | 'retired', at: string): StyleRecord => ({
  id: record.id, source: record.source, owner: record.owner, status, addedAt: record.addedAt, changedAt: at, origin: record.origin,
  ...record.at === undefined ? {} : { at: record.at },
})

const newestFirst = (a: StyleRecord, b: StyleRecord): number => b.addedAt.localeCompare(a.addedAt) || (b.at ?? 0) - (a.at ?? 0)

/** Writers in this process, chained per file. */
const chains = new Map<string, Promise<unknown>>()

/** The container and its operations. */
export class StyleStore {
  /**
   * @param file - absolute path of the JSONL file.
   * @param limits - caps.
   * @param now - clock; injectable for tests.
   */
  constructor(readonly file: string, private readonly limits: StoreLimits, private readonly now: () => Date = () => new Date()) {}

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = chains.get(this.file) ?? Promise.resolve()
    const next = previous.then(work, work)
    chains.set(this.file, next.catch(() => undefined))
    return next
  }

  /** Every record, newest first; a damaged line costs that record only. */
  async all(): Promise<StyleRecord[]> {
    let raw = ''
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const records: StyleRecord[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = recordFrom(JSON.parse(line))
        if (record !== undefined) records.push(record)
      } catch {
        // A torn line is skipped.
      }
    }
    return records.toSorted(newestFirst)
  }

  /** Active and pending samples, newest first. */
  async live(): Promise<StyleRecord[]> {
    return (await this.all()).filter(record => record.status === 'active' || record.status === 'pending')
  }

  private async write(records: readonly StyleRecord[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${String(process.pid)}.tmp`
    await writeFile(temporary, records.map(record => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''), { mode: 0o600 })
    await rename(temporary, this.file)
  }

  /** Apply the caps: the owner's own first, then the rest, then pending, then the tombstones. @returns records and the retired count. */
  private capped(records: readonly StyleRecord[]): { records: StyleRecord[]; retired: number } {
    const at = this.now().toISOString()
    const sorted = records.toSorted(newestFirst)
    const owner = sorted.filter(record => record.status === 'active' && record.owner)
    const keptOwner = new Set(owner.slice(0, this.limits.maxOwner).map(record => record.id))
    const others = sorted.filter(record => record.status === 'active' && !record.owner)
    const keptOthers = new Set(others.slice(0, Math.max(0, this.limits.maxActive - keptOwner.size)).map(record => record.id))
    const pending = sorted.filter(record => record.status === 'pending')
    const keptPending = new Set(pending.slice(0, this.limits.maxPending).map(record => record.id))
    let retired = 0
    const out = sorted.map((record) => {
      if (record.status === 'active' && !keptOwner.has(record.id) && !keptOthers.has(record.id)) {
        retired += 1
        return tombstone(record, 'retired', at)
      }
      if (record.status === 'pending' && !keptPending.has(record.id)) {
        retired += 1
        return tombstone(record, 'retired', at)
      }
      return record
    })
    const dead = out.filter(record => record.status === 'removed' || record.status === 'retired')
    const lastChange = (record: StyleRecord): string => record.changedAt ?? record.addedAt
    const newestDead = dead.toSorted((a, b) => lastChange(b).localeCompare(lastChange(a)))
    const keptDead = new Set(newestDead.slice(0, this.limits.maxTombstones).map(record => record.id))
    return { records: out.filter(record => (record.status === 'active' || record.status === 'pending') || keptDead.has(record.id)), retired }
  }

  /**
   * Store new samples from a collection run.
   * @param candidates - samples that passed the filters, in the order of preference.
   * @param review - `required` stores strangers' samples as pending; the owner's own always go active.
   * @returns the added records, how many were known already (`duplicate`) or deleted before (`removed`), and how many old ones retired.
   */
  async ingest(candidates: readonly Candidate[], review: 'optional' | 'required'): Promise<{ added: StyleRecord[]; duplicate: number; removed: number; retired: number }> {
    return await this.serialized(async () => {
      const records = await this.all()
      const known = new Map(records.map(record => [record.id, record]))
      const added: StyleRecord[] = []
      let duplicate = 0
      let removed = 0
      const at = this.now().toISOString()
      for (const candidate of candidates) {
        const id = sampleId(candidate.prompt, candidate.reply)
        const earlier = known.get(id)
        if (earlier !== undefined) {
          if (earlier.status === 'removed') removed += 1
          else duplicate += 1
          continue
        }
        const record: StyleRecord = {
          id, source: candidate.source, owner: candidate.owner === true && candidate.source === 'bili', origin: candidate.origin,
          status: review === 'required' && candidate.owner !== true ? 'pending' : 'active', addedAt: at,
          ...candidate.at === undefined ? {} : { at: candidate.at },
          ...candidate.prompt === undefined ? {} : { prompt: normalizeLine(candidate.prompt) },
          reply: normalizeLine(candidate.reply),
        }
        known.set(id, record)
        added.push(record)
      }
      const { records: next, retired } = this.capped([...records, ...added])
      await this.write(next)
      const survived = new Set(next.filter(record => record.status === 'active' || record.status === 'pending').map(record => record.id))
      return { added: added.filter(record => survived.has(record.id)), duplicate, removed, retired }
    })
  }

  /**
   * Retire strangers' samples said before a time (the owner's own stay).
   * @param beforeMs - epoch milliseconds.
   * @returns how many were retired.
   */
  async expire(beforeMs: number): Promise<number> {
    return await this.serialized(async () => {
      const records = await this.all()
      const at = this.now().toISOString()
      let count = 0
      const next = records.map((record) => {
        if ((record.status === 'active' || record.status === 'pending') && !record.owner && record.at !== undefined && record.at < beforeMs) {
          count += 1
          return tombstone(record, 'retired', at)
        }
        return record
      })
      if (count > 0) await this.write(this.capped(next).records)
      return count
    })
  }

  /**
   * Delete a sample for good: it leaves the prompt, its text is dropped, and its id stays so it never returns.
   * @param id - the sample's id.
   * @returns the record as it was.
   */
  async remove(id: string): Promise<StyleRecord> {
    return await this.serialized(async () => {
      const records = await this.all()
      const found = records.find(record => record.id === id && (record.status === 'active' || record.status === 'pending'))
      if (found === undefined) throw new StyleError('not_found', `no sample under id ${id}`)
      const at = this.now().toISOString()
      await this.write(this.capped(records.map(record => (record.id === id ? tombstone(record, 'removed', at) : record))).records)
      return found
    })
  }

  /**
   * Keep a pending sample: it becomes active.
   * @param id - the sample's id.
   * @returns the record as it is now.
   */
  async keep(id: string): Promise<StyleRecord> {
    return await this.serialized(async () => {
      const records = await this.all()
      const found = records.find(record => record.id === id && record.status === 'pending')
      if (found === undefined) throw new StyleError('not_found', `no pending sample under id ${id}`)
      const kept: StyleRecord = { ...found, status: 'active', addedAt: this.now().toISOString() }
      await this.write(this.capped(records.map(record => (record.id === id ? kept : record))).records)
      return kept
    })
  }
}
