/**
 * The activity list Settings shows: one line per connection, send, hold, refusal, and other change, the newest kept.
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { SerialQueue } from './serial.ts'
import type { ActivityRecord, gmailDomain } from './storage.ts'

/** Activity lines kept. */
const ACTIVITY_KEPT = 200
/** Activity lines Settings shows. */
const ACTIVITY_SHOWN = 50

/** Appends activity lines one at a time, so each line gets the next sequence number. */
export class ActivityLog {
  private readonly queue = new SerialQueue()

  /**
   * Append one line after every line appended before it, and drop the oldest past the kept count.
   * @param domain - the open `gmail` domain.
   * @param account - account id.
   * @param kind - what happened.
   * @param detail - the line's text, cut to 500 characters.
   * @returns resolves once the line is stored.
   */
  record(domain: Domain<typeof gmailDomain>, account: string, kind: ActivityRecord['kind'], detail: string): Promise<void> {
    return this.queue.run(() => append(domain, account, kind, detail))
  }
}

/**
 * The lines Settings shows.
 * @param domain - the open `gmail` domain.
 * @returns the newest lines, newest first.
 */
export function latestActivity(domain: Domain<typeof gmailDomain>): ActivityRecord[] {
  return Array.from(domain.table('activity').entries(), ([, row]) => row).sort((a, b) => b.seq - a.seq).slice(0, ACTIVITY_SHOWN)
}

async function append(domain: Domain<typeof gmailDomain>, account: string, kind: ActivityRecord['kind'], detail: string): Promise<void> {
  const table = domain.table('activity')
  const entries = Array.from(table.entries())
  const seq = Math.max(0, ...entries.map(([, row]) => row.seq)) + 1
  await table.put(String(seq).padStart(10, '0'), { seq, at: Date.now(), account, kind, detail: detail.slice(0, 500) })
  if (entries.length + 1 > ACTIVITY_KEPT) {
    await table.deleteMany(entries.sort(([, a], [, b]) => a.seq - b.seq).slice(0, entries.length + 1 - ACTIVITY_KEPT).map(([key]) => key))
  }
}
