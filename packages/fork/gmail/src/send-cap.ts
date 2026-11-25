/**
 * The daily send cap: each account's sends of the last 24 hours in the `sends` table, the refusal of a send over
 * the cap, and the record of each send. Confirmed sends count like any other.
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ActivityLog } from './activity.ts'
import { GmailError } from './errors.ts'
import type { gmailDomain } from './storage.ts'

/** A day, in milliseconds. */
const DAY_MS = 86_400_000

/** What {@link SendCap} reads and calls. */
export interface SendCapDeps {
  /** Messages one account may send in 24 hours. */
  readonly maxSendsPerDay: number
  readonly activity: Pick<ActivityLog, 'record'>
}

/** Counts each account's sends against the daily cap. */
export class SendCap {
  /** @param deps - the cap and the activity list. */
  constructor(private readonly deps: SendCapDeps) {}

  /**
   * An account's sends in the 24 hours before `now`.
   * @param domain - the open `gmail` domain.
   * @param account - account id.
   * @param now - Unix epoch milliseconds.
   * @returns the send times, oldest first.
   */
  recent(domain: Domain<typeof gmailDomain>, account: string, now: number): number[] {
    return (domain.table('sends').get(account)?.at ?? []).filter(at => now - at < DAY_MS)
  }

  /**
   * Refuse a send over the cap, with an activity line.
   * @param domain - the open `gmail` domain.
   * @param account - account id.
   * @param origin - who asked for the send, for the activity line.
   * @returns resolves when the account may send.
   * @throws GmailError `limit` when the account reached the cap.
   */
  async assert(domain: Domain<typeof gmailDomain>, account: string, origin: string): Promise<void> {
    const recent = this.recent(domain, account, Date.now())
    if (recent.length < this.deps.maxSendsPerDay) return
    await this.deps.activity.record(domain, account, 'refused', `daily cap of ${this.deps.maxSendsPerDay} reached (${origin})`)
    throw new GmailError('limit', `this account already sent ${recent.length} messages in 24 hours, the owner's limit; nothing was sent`)
  }

  /**
   * Count a send and add its activity line.
   * @param domain - the open `gmail` domain.
   * @param account - account id.
   * @param detail - the activity line's text.
   * @returns resolves once both are stored.
   */
  async record(domain: Domain<typeof gmailDomain>, account: string, detail: string): Promise<void> {
    const now = Date.now()
    await domain.table('sends').put(account, { at: [...this.recent(domain, account, now), now] })
    await this.deps.activity.record(domain, account, 'sent', detail)
  }
}
