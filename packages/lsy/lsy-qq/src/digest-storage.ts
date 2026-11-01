/**
 * What DSH itself keeps of the QQ channel, in its storage domain `lsy_qq`: the digests, the group notes, the resident
 * digest Sessions of the groups, and a few settings of its own (the alias salt, the time the owner was last told of an
 * outage, the one-time import marker). The recorded messages are not here: they stay in the qq-recorder service and
 * arrive through its API. Reads are synchronous (the domain holds its records in memory); writes wait for the disk.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type { LegacyDigestState } from './protocol.ts'

const digestSchema = z.object({
  id: z.number().int().positive(),
  groupId: z.string(),
  /** Cursors of the first and last message the digest covers (opaque; only the recorder reads them). */
  fromCursor: z.string(),
  toCursor: z.string(),
  messageCount: z.number().int().nonnegative(),
  text: z.string(),
  model: z.string(),
  usage: z.string().nullable(),
  rawPath: z.string().nullable(),
  createdAt: z.number(),
}).strict()

const noteSchema = z.object({
  id: z.number().int().positive(),
  groupId: z.string(),
  text: z.string(),
  createdAt: z.number(),
}).strict()

const sessionSchema = z.object({
  sessionId: z.string().min(1),
  /** When this Session was made; a Session older than the retention window is replaced. */
  createdAt: z.number(),
  /** 1 for the first Session of the group, one more at each rollover. */
  generation: z.number().int().positive(),
}).strict()

const metaSchema = z.object({ value: z.string() }).strict()

/** A stored digest. */
export type DigestRecord = z.infer<typeof digestSchema>
/** A stored group note. */
export type NoteRecord = z.infer<typeof noteSchema>
/** The resident digest Session of a group. */
export type GroupSession = z.infer<typeof sessionSchema>

/** Notes one group may hold. */
export const MAX_NOTES_PER_GROUP = 30

/**
 * Domain `lsy_qq`. `digests` and `notes` are keyed by their zero-padded id, `sessions` by group number, `meta` by name
 * (`alias-salt`, `outage-notice-at`, `legacy-imported-at`, `last-digest-id`, `last-note-id`).
 */
export const qqDomain = defineDomain({
  name: 'lsy_qq',
  version: 1,
  tables: {
    digests: domainTable<string, DigestRecord>(digestSchema),
    notes: domainTable<string, NoteRecord>(noteSchema),
    sessions: domainTable<string, GroupSession>(sessionSchema),
    meta: domainTable<string, z.infer<typeof metaSchema>>(metaSchema),
  },
})

/** The open domain. */
export type QqDomain = Domain<typeof qqDomain>

const key = (id: number): string => String(id).padStart(10, '0')

/** What the one-time import carried over. */
export interface ImportResult {
  imported: boolean
  digests: number
  notes: number
  sessions: number
}

/** Typed access to the `lsy_qq` domain. */
export class DigestStore {
  /** @param domain - the open domain. */
  constructor(private readonly domain: QqDomain) {}

  // ---- digests ----

  /** @returns digests newest first, optionally of one group and/or made since `sinceMs`. */
  digests(options: { groupId?: string; sinceMs?: number; limit: number }): DigestRecord[] {
    const since = options.sinceMs ?? 0
    return [...this.domain.table('digests').entries()].map(([, row]) => row)
      .filter(row => row.createdAt >= since && (options.groupId === undefined || row.groupId === options.groupId))
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(0, options.limit)
  }

  /** @returns the cursor the group's newest digest reached, or undefined when it has none. */
  digestedUpTo(groupId: string): string | undefined {
    return this.digests({ groupId, limit: 1 })[0]?.toCursor
  }

  /** @returns when the group's newest digest was made, or 0. */
  lastDigestAt(groupId: string): number {
    return this.digests({ groupId, limit: 1 })[0]?.createdAt ?? 0
  }

  /** @returns each group's newest digest time. */
  lastDigestTimes(): Map<string, number> {
    const times = new Map<string, number>()
    for (const [, row] of this.domain.table('digests').entries()) times.set(row.groupId, Math.max(times.get(row.groupId) ?? 0, row.createdAt))
    return times
  }

  private async nextId(name: 'last-digest-id' | 'last-note-id', existing: Iterable<number>): Promise<number> {
    const stored = Number(this.getMeta(name) ?? '0')
    const id = Math.max(Number.isFinite(stored) ? stored : 0, ...existing) + 1
    await this.setMeta(name, String(id))
    return id
  }

  /** Store a digest. @returns its id. */
  async insertDigest(digest: Omit<DigestRecord, 'id'>): Promise<number> {
    const id = await this.nextId('last-digest-id', [...this.domain.table('digests').keys()].map(Number))
    await this.domain.table('digests').put(key(id), { id, ...digest })
    return id
  }

  /** Keep the newest `keep` digests of a group and delete the rest. @returns how many were deleted. */
  async capDigests(groupId: string, keep: number): Promise<number> {
    const rows = this.digests({ groupId, limit: Number.MAX_SAFE_INTEGER })
    return this.domain.table('digests').deleteMany(rows.slice(keep).map(row => key(row.id)))
  }

  /** Delete digests, of one group and/or made before `beforeMs`. @returns how many were deleted. */
  async deleteDigests(options: { groupId?: string; beforeMs?: number }): Promise<number> {
    if (options.groupId === undefined && options.beforeMs === undefined) throw new Error('deleteDigests needs a group or a date')
    const doomed = [...this.domain.table('digests').entries()].filter(([, row]) =>
      (options.groupId === undefined || row.groupId === options.groupId) && (options.beforeMs === undefined || row.createdAt < options.beforeMs))
    return this.domain.table('digests').deleteMany(doomed.map(([id]) => id))
  }

  // ---- resident Sessions ----

  /** @returns the resident digest Session of a group, if it has one. */
  groupSession(groupId: string): GroupSession | undefined {
    return this.domain.table('sessions').get(groupId)
  }

  /** @returns whether a Session is some group's current resident digest Session. */
  isResidentSession(sessionId: string): boolean {
    return [...this.domain.table('sessions').entries()].some(([, row]) => row.sessionId === sessionId)
  }

  /** Record the resident digest Session of a group, replacing the previous one. */
  setGroupSession(groupId: string, session: GroupSession): Promise<void> {
    return this.domain.table('sessions').put(groupId, session)
  }

  // ---- notes ----

  /** @returns the notes of a group, oldest first. */
  notes(groupId: string): NoteRecord[] {
    return [...this.domain.table('notes').entries()].map(([, row]) => row).filter(row => row.groupId === groupId).sort((a, b) => a.id - b.id)
  }

  /** Add a note. @returns its id; undefined when the group already has that note or has {@link MAX_NOTES_PER_GROUP}. */
  async addNote(groupId: string, text: string, now: number): Promise<number | undefined> {
    const own = this.notes(groupId)
    if (own.length >= MAX_NOTES_PER_GROUP || own.some(note => note.text === text)) return undefined
    const id = await this.nextId('last-note-id', [...this.domain.table('notes').keys()].map(Number))
    await this.domain.table('notes').put(key(id), { id, groupId, text, createdAt: now })
    return id
  }

  /** Remove a note of a group by its id (`7` or `#7`) or by its exact text. */
  async removeNote(groupId: string, which: string): Promise<boolean> {
    const asId = /^#?(\d+)$/.exec(which.trim())
    const found = this.notes(groupId).find(note => (asId === null ? note.text === which.trim() : note.id === Number(asId[1])))
    return found === undefined ? false : this.domain.table('notes').delete(key(found.id))
  }

  // ---- meta ----

  /** @returns a setting, or undefined. */
  getMeta(name: string): string | undefined {
    return this.domain.table('meta').get(name)?.value
  }

  /** Store a setting. */
  setMeta(name: string, value: string): Promise<void> {
    return this.domain.table('meta').put(name, { value })
  }

  /** Remove a setting. */
  async deleteMeta(name: string): Promise<void> {
    await this.domain.table('meta').delete(name)
  }

  /** @returns the per-install salt of member aliases, created on first use. */
  async ensureSalt(): Promise<string> {
    const stored = this.getMeta('alias-salt')
    if (stored !== undefined) return stored
    const salt = randomUUID()
    await this.setMeta('alias-salt', salt)
    return salt
  }

  /** @returns the alias salt if it exists already. */
  salt(): string | undefined {
    return this.getMeta('alias-salt')
  }

  // ---- the one-time import ----

  /** @returns whether the import of the recorder's frozen digest state has run. */
  get imported(): boolean {
    return this.getMeta('legacy-imported-at') !== undefined
  }

  /**
   * Copy the digest state the plugin kept in `qq.db` into this domain. Records get fixed ids, so a run that crashed half
   * way is repeated safely; the marker is written last, and once it is there nothing is imported again.
   * @param legacy - what the recorder reports.
   * @param now - the time to stamp the marker with.
   */
  async importLegacy(legacy: LegacyDigestState, now: number): Promise<ImportResult> {
    if (this.imported) return { imported: false, digests: 0, notes: 0, sessions: 0 }
    let id = 0
    for (const row of legacy.digests) {
      id += 1
      await this.domain.table('digests').put(key(id), { id, ...row })
    }
    await this.setMeta('last-digest-id', String(id))
    let noteId = 0
    for (const row of legacy.notes) {
      noteId += 1
      await this.domain.table('notes').put(key(noteId), { id: noteId, ...row })
    }
    await this.setMeta('last-note-id', String(noteId))
    for (const row of legacy.groupSessions) {
      await this.domain.table('sessions').put(row.groupId, { sessionId: row.sessionId, createdAt: row.createdAt, generation: row.generation })
    }
    if (legacy.aliasSalt !== null) await this.setMeta('alias-salt', legacy.aliasSalt)
    if (legacy.outageNoticeAt !== null) await this.setMeta('outage-notice-at', String(legacy.outageNoticeAt))
    await this.setMeta('legacy-imported-at', String(now))
    return { imported: true, digests: legacy.digests.length, notes: legacy.notes.length, sessions: legacy.groupSessions.length }
  }
}
