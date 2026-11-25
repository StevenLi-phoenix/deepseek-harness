/**
 * The account's journal: short dated entries the account's Session keeps about itself, bounded
 * in length and per local day, stored in the `bili` storage domain and read back newest first.
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { seqKey, type biliDomain } from './storage.ts'
import { codePoints } from './text.ts'
import { dayKey } from './time.ts'

/** Journal limits. */
const JOURNAL_LIMITS = { chars: 600, perDay: 8, pageSize: 10 } as const

/** What the journal needs of the account. */
export interface JournalHost {
  readonly ready: Promise<Domain<typeof biliDomain>>
  /** Storage work, one piece at a time. */
  serialize<T>(work: () => Promise<T>): Promise<T>
  /** IANA time zone of the journal's days. */
  readonly timeZone: string
  /** Info log line. */
  info(message: string): void
}

/** The account's dated journal entries. */
export class Journal {
  /** @param host - storage, the time zone, and the logger. */
  constructor(private readonly host: JournalHost) {}

  /**
   * Keep one dated entry.
   * @param text - at most {@link JOURNAL_LIMITS}`.chars` characters.
   * @returns the stored entry's number and what is left today, or why it was refused.
   */
  async write(text: string): Promise<{ saved: true; seq: number; leftToday: number } | { refused: string }> {
    const entry = text.trim()
    if (entry === '') return { refused: 'the entry is empty' }
    if (codePoints(entry) > JOURNAL_LIMITS.chars) return { refused: `the entry is ${codePoints(entry)} characters; the limit is ${JOURNAL_LIMITS.chars}` }
    return this.host.serialize(async () => {
      const domain = await this.host.ready
      const now = Date.now()
      const day = dayKey(now, this.host.timeZone)
      const rows = [...domain.table('journal').entries()].map(([, row]) => row)
      const today = rows.filter(row => row.day === day).length
      if (today >= JOURNAL_LIMITS.perDay) return { refused: `today already has ${JOURNAL_LIMITS.perDay} entries` }
      const seq = Math.max(0, ...rows.map(row => row.seq)) + 1
      await domain.table('journal').put(seqKey(seq), { seq, day, at: now, text: entry })
      this.host.info(`bili: journal entry ${seq} (${codePoints(entry)} chars)`)
      return { saved: true as const, seq, leftToday: JOURNAL_LIMITS.perDay - today - 1 }
    })
  }

  /**
   * Recent entries, newest first.
   * @param page - from 1; clamped to the pages there are.
   * @returns up to {@link JOURNAL_LIMITS}`.pageSize` entries and the page count.
   */
  async read(page: number): Promise<{ entries: { seq: number; day: string; text: string }[]; page: number; pages: number }> {
    const domain = await this.host.ready
    const rows = [...domain.table('journal').entries()].map(([, row]) => row).sort((a, b) => b.seq - a.seq)
    const pages = Math.max(1, Math.ceil(rows.length / JOURNAL_LIMITS.pageSize))
    const index = Math.min(Math.max(1, Math.floor(page)), pages)
    const entries = rows
      .slice((index - 1) * JOURNAL_LIMITS.pageSize, index * JOURNAL_LIMITS.pageSize)
      .map(({ seq, day, text }) => ({ seq, day, text }))
    return { entries, page: index, pages }
  }
}
