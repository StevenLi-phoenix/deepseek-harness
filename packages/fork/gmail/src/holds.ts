/**
 * The messages held for the owner's confirmation, in the `pending` table: a new hold with its code and notice, the
 * lookup a confirmation makes, discards, expiry, and the pruning of resolved holds. A held draft cannot be changed or
 * sent by the agent; it goes out only through `Gmail.confirm()`.
 */

import { randomInt } from 'node:crypto'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ActivityLog } from './activity.ts'
import type { GmailApi } from './api.ts'
import { errorText, GmailError } from './errors.ts'
import { ownerConfirms, type TurnFacts } from './gate.ts'
import { heldNotice, notePreview, type OwnerNotices } from './notices.ts'
import type { DraftFacts } from './outgoing.ts'
import type { AccountRecord, gmailDomain, PendingRecord } from './storage.ts'

/** Code alphabet: no 0/O, 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
/** Characters of a held message's code. */
const CODE_LENGTH = 6
/** Resolved held messages kept for Settings. */
const RESOLVED_KEPT = 50

/** How a held message is confirmed: from Settings, or from the owner's own turn, whose words must hold the code. */
export type Confirmation = { readonly by: 'settings' } | { readonly by: 'owner-turn'; readonly turn: TurnFacts }

/** What {@link Holds} reads and calls. */
export interface HoldDeps {
  /** Hours a held message waits for the owner before it expires. */
  readonly confirmTtlHours: number
  /**
   * A Gmail API client authorized as an account, to delete a discarded hold's draft.
   * @param account - account id.
   * @returns the client.
   */
  readonly api: (account: string) => GmailApi
  readonly activity: Pick<ActivityLog, 'record'>
  readonly notices: Pick<OwnerNotices, 'send'>
  readonly logger: { info(message: string): void }
}

/** The held and resolved messages of every account. */
export class Holds {
  /** @param deps - the hold lifetime, the API clients, the activity list, the notices, and the logger. */
  constructor(private readonly deps: HoldDeps) {}

  /**
   * Refuse a change to a held draft.
   * @param domain - the open `gmail` domain.
   * @param draftId - the draft about to be changed or sent.
   * @throws GmailError `refused` when the draft is held.
   */
  assertNotHeld(domain: Domain<typeof gmailDomain>, draftId: string): void {
    const held = Array.from(domain.table('pending').entries()).find(([, row]) => row.draftId === draftId && row.status === 'held')
    if (held !== undefined) throw new GmailError('refused', 'this draft waits for the owner\'s confirmation and cannot be changed or sent by you; write a new one instead')
  }

  /**
   * Store a held message under a new code and tell the owner.
   * @param domain - the open `gmail` domain.
   * @param row - the sending account.
   * @param facts - the draft as Gmail stores it.
   * @param reason - why it waits, as the owner reads it.
   * @param turn - the turn that asked for the send.
   * @returns whether the owner's notice went out.
   */
  async hold(domain: Domain<typeof gmailDomain>, row: AccountRecord, facts: DraftFacts, reason: string, turn: TurnFacts): Promise<boolean> {
    const table = domain.table('pending')
    let code: string
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
    } while (table.get(code) !== undefined)
    const { preview, cut } = notePreview(facts.text)
    const record: PendingRecord = {
      code, account: row.id, from: facts.from || row.email, draftId: facts.draftId, threadId: facts.threadId,
      to: [...facts.to], cc: [...facts.cc], bcc: [...facts.bcc], subject: facts.subject, preview, attachments: [...facts.attachments],
      createdAt: Date.now(), origin: turn.origin, reason, sessionId: turn.sessionId ?? null, status: 'held',
      resolvedAt: null, resolvedBy: null, messageId: null, noticeSent: false, fingerprint: facts.fingerprint,
    }
    await table.put(code, record)
    const noticeSent = await this.deps.notices.send(heldNotice(record, cut, this.deps.confirmTtlHours))
    if (noticeSent) await table.put(code, { ...record, noticeSent })
    await this.deps.activity.record(domain, row.id, 'held', `${[...record.to, ...record.cc, ...record.bcc].join(', ')}: ${reason}`)
    await this.prune(domain)
    return noticeSent
  }

  /**
   * Find the held message a confirmation names, after expiring the overdue ones.
   * @param domain - the open `gmail` domain.
   * @param code - the code, in any case.
   * @param how - from Settings, or from the owner's own turn.
   * @returns the normalized code and the held message.
   * @throws GmailError `not-found` for an unknown code, `expired` for a resolved one, `refused` when the turn does not confirm.
   */
  async claim(
    domain: Domain<typeof gmailDomain>, code: string, how: Confirmation,
  ): Promise<{ readonly key: string; readonly record: PendingRecord }> {
    await this.expire(domain, Date.now())
    const key = codeKey(code)
    const record = domain.table('pending').get(key)
    if (record === undefined) throw new GmailError('not-found', `no held message has the code ${key}`)
    if (record.status !== 'held') throw new GmailError('expired', `the message with the code ${key} was already ${record.status}`)
    if (how.by === 'owner-turn' && !ownerConfirms(how.turn, key)) {
      throw new GmailError('refused', `only the owner confirms a held message: in a turn the owner started alone whose own message holds ${key}, before any mail or web page is read in it, or in Settings → 邮箱`)
    }
    return { key, record }
  }

  /**
   * Drop a held message from Settings; its draft is deleted from Gmail, and a failed deletion drops the hold anyway.
   * @param domain - the open `gmail` domain.
   * @param code - the code, in any case.
   * @returns resolves once the hold is resolved.
   * @throws GmailError `not-found` when no message with the code is held.
   */
  async discard(domain: Domain<typeof gmailDomain>, code: string): Promise<void> {
    const key = codeKey(code)
    const record = domain.table('pending').get(key)
    if (record?.status !== 'held') throw new GmailError('not-found', `no held message has the code ${key}`)
    try {
      await this.deps.api(record.account).deleteDraft(record.draftId)
    } catch (error: unknown) {
      this.deps.logger.info(`gmail: ${record.account}: the draft of ${key} could not be deleted (${errorText(error)}); the hold is dropped anyway`)
    }
    await this.resolve(domain, record, 'discarded', 'settings')
    this.deps.logger.info(`gmail: ${record.account}: held ${key} discarded`)
  }

  /**
   * Discard every held message of a removed account; their drafts stay in Gmail.
   * @param domain - the open `gmail` domain.
   * @param account - account id.
   * @returns resolves once each hold is resolved.
   */
  async discardAccount(domain: Domain<typeof gmailDomain>, account: string): Promise<void> {
    for (const [, record] of Array.from(domain.table('pending').entries())) {
      if (record.account === account && record.status === 'held') await this.resolve(domain, record, 'discarded', 'settings')
    }
  }

  /**
   * Resolve a hold and add its activity line.
   * @param domain - the open `gmail` domain.
   * @param record - the hold.
   * @param status - how it ended.
   * @param by - who ended it.
   * @param messageId - the sent message, for `sent`.
   * @returns resolves once both are stored.
   */
  async resolve(
    domain: Domain<typeof gmailDomain>, record: PendingRecord, status: 'sent' | 'discarded' | 'expired', by: 'settings' | 'owner-turn' | 'expiry', messageId?: string,
  ): Promise<void> {
    await domain.table('pending').put(record.code, { ...record, status, resolvedAt: Date.now(), resolvedBy: by, messageId: messageId ?? null })
    const kind = status === 'sent' ? 'confirmed' : status
    await this.deps.activity.record(domain, record.account, kind, `${record.code}: ${record.subject.slice(0, 120)}`)
  }

  /**
   * Expire held messages past their time; their drafts stay in Gmail.
   * @param domain - the open `gmail` domain.
   * @param now - Unix epoch milliseconds.
   * @returns resolves once each overdue hold is resolved.
   */
  async expire(domain: Domain<typeof gmailDomain>, now: number): Promise<void> {
    const ttl = this.deps.confirmTtlHours * 3_600_000
    for (const [, record] of Array.from(domain.table('pending').entries())) {
      if (record.status === 'held' && now - record.createdAt > ttl) {
        await this.resolve(domain, record, 'expired', 'expiry')
        this.deps.logger.info(`gmail: ${record.account}: held ${record.code} expired`)
      }
    }
  }

  /**
   * The held messages.
   * @param domain - the open `gmail` domain.
   * @returns every message waiting for the owner, oldest first.
   */
  held(domain: Domain<typeof gmailDomain>): PendingRecord[] {
    return Array.from(domain.table('pending').entries(), ([, row]) => row).filter(row => row.status === 'held').sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * The messages Settings lists.
   * @param domain - the open `gmail` domain.
   * @returns held messages first (oldest first), then the kept resolved ones (newest first).
   */
  forSettings(domain: Domain<typeof gmailDomain>): PendingRecord[] {
    const resolved = Array.from(domain.table('pending').entries(), ([, row]) => row).filter(row => row.status !== 'held')
    return [...this.held(domain), ...resolved.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))]
  }

  /** Keep the latest resolved holds. */
  private async prune(domain: Domain<typeof gmailDomain>): Promise<void> {
    const resolved = Array.from(domain.table('pending').entries()).filter(([, row]) => row.status !== 'held')
    const staleHolds = resolved.sort(([, a], [, b]) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(RESOLVED_KEPT).map(([key]) => key)
    if (staleHolds.length > 0) await domain.table('pending').deleteMany(staleHolds)
  }
}

/** A code as the table keys it. */
function codeKey(code: string): string {
  return code.trim().toUpperCase()
}
