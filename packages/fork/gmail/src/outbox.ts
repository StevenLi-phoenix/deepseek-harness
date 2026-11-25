/**
 * Drafts, sends, and confirmed sends on one account: the read-only refusal, the send gate's decision over a composed
 * message or a stored draft, the daily cap, and the hold of a message the owner must confirm. A confirmed hold is sent
 * only when its draft still matches the fingerprint taken when the owner was asked.
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ActivityLog } from './activity.ts'
import { AddressProblem, parseMailbox } from './address.ts'
import { GmailApiError, type GmailApi } from './api.ts'
import { assertNever, GmailError, READ_ONLY_REFUSAL } from './errors.ts'
import { decideSend, namedByOwner, type TurnFacts } from './gate.ts'
import type { Holds } from './holds.ts'
import { draftFacts, prepareOutgoing, type DraftFacts, type Prepared } from './outgoing.ts'
import type { SendCap } from './send-cap.ts'
import type { AccountRecord, gmailDomain, PendingRecord } from './storage.ts'
import type { DraftOutcome, Outgoing, SendOutcome, SendRequest } from './types.ts'

/** What {@link Outbox} reads and calls. */
export interface OutboxDeps {
  readonly ready: Promise<Domain<typeof gmailDomain>>
  /** Addresses that never need a confirmation, besides the connected accounts themselves. */
  readonly trustedRecipients: readonly string[]
  /** Bytes of all attachments of one outgoing message. */
  readonly maxAttachmentBytes: number
  readonly holds: Pick<Holds, 'assertNotHeld' | 'hold' | 'resolve'>
  readonly cap: Pick<SendCap, 'assert' | 'record'>
  readonly activity: Pick<ActivityLog, 'record'>
}

/** Writes and sends mail as an account, by its policy and the turn. */
export class Outbox {
  /** @param deps - the domain, the trusted addresses, the attachment limit, the holds, the cap, and the activity list. */
  constructor(private readonly deps: OutboxDeps) {}

  /**
   * Write a draft, or replace one.
   * @param api - the account's API client.
   * @param row - the account.
   * @param message - the message.
   * @param draftId - the draft to replace; a held one cannot be changed.
   * @returns the draft.
   * @throws GmailError `refused` on a read-only account or a held draft.
   */
  async draft(api: GmailApi, row: AccountRecord, message: Outgoing, draftId: string | undefined): Promise<DraftOutcome> {
    if (row.policy === 'read-only') throw new GmailError('refused', READ_ONLY_REFUSAL)
    if (draftId !== undefined) this.deps.holds.assertNotHeld(await this.deps.ready, draftId)
    const prepared = await prepareOutgoing(api, row, message, this.deps.maxAttachmentBytes)
    const draft = draftId === undefined
      ? await api.createDraft(prepared.raw, prepared.threadId)
      : await api.updateDraft(draftId, prepared.raw, prepared.threadId)
    const domain = await this.deps.ready
    await this.deps.activity.record(domain, row.id, 'drafted', `${prepared.recipients.join(', ') || '(no recipients)'}: ${prepared.subject.slice(0, 120)}`)
    const threadId = draft.message?.threadId ?? prepared.threadId ?? null
    return { draftId: draft.id, threadId, recipients: prepared.recipients, subject: prepared.subject }
  }

  /**
   * Send a message or a draft, or hold it for the owner, by the account's policy and the turn.
   * @param api - the account's API client.
   * @param row - the account.
   * @param request - a new message, or a draft id.
   * @param turn - the turn's facts, read from the Session log.
   * @returns sent, or held with its reason.
   * @throws GmailError `refused` on a read-only account or a held draft, `limit` over the daily cap.
   */
  async send(api: GmailApi, row: AccountRecord, request: SendRequest, turn: TurnFacts): Promise<SendOutcome> {
    const domain = await this.deps.ready
    if (row.policy === 'read-only') {
      await this.deps.activity.record(domain, row.id, 'refused', `read-only account (${turn.origin})`)
      throw new GmailError('refused', READ_ONLY_REFUSAL)
    }
    if (request.kind === 'draft') this.deps.holds.assertNotHeld(domain, request.draftId)
    const outgoing: Prepared | DraftFacts = request.kind === 'new'
      ? await prepareOutgoing(api, row, request.message, this.deps.maxAttachmentBytes)
      : await draftFacts(api, request.draftId)
    const recipients = 'raw' in outgoing ? outgoing.recipients : [...outgoing.to, ...outgoing.cc, ...outgoing.bcc]
    if (recipients.length === 0) throw new AddressProblem('the message has no recipient')
    const trusted = this.trusted(domain)
    const vouched = row.policy === 'confirm-untrusted' && turn.clean ? await vouchedFor(api, turn, recipients, trusted) : new Set<string>()
    const decision = decideSend(row.policy, turn, recipients, { trusted, vouched })
    switch (decision.kind) {
      /* v8 ignore next 3 -- the read-only refusal above returns first; decideSend refuses nothing else today. */
      case 'refuse':
        await this.deps.activity.record(domain, row.id, 'refused', decision.reason)
        throw new GmailError('refused', decision.reason)
      case 'send': {
        await this.deps.cap.assert(domain, row.id, turn.origin)
        const sent = 'raw' in outgoing ? await api.send(outgoing.raw, outgoing.threadId) : await api.sendDraft(outgoing.draftId)
        await this.deps.cap.record(domain, row.id, `${recipients.join(', ')} (${turn.origin})`)
        return { kind: 'sent', messageId: sent.id, threadId: sent.threadId, recipients }
      }
      case 'hold': {
        const facts = 'raw' in outgoing ? await draftFacts(api, (await api.createDraft(outgoing.raw, outgoing.threadId)).id) : outgoing
        const noticeSent = await this.deps.holds.hold(domain, row, facts, decision.reason, turn)
        return { kind: 'held', reason: decision.reason, draftId: facts.draftId, noticeSent, recipients }
      }
      /* v8 ignore next 2 -- GateDecision is a closed union; the default only makes a new kind a compile error. */
      default:
        return assertNever(decision)
    }
  }

  /**
   * Send a held message the owner confirmed. A deleted draft or one changed since the notice discards the hold.
   * @param api - the account's API client.
   * @param row - the account.
   * @param domain - the open `gmail` domain.
   * @param key - the hold's code.
   * @param record - the hold.
   * @param by - how the owner confirmed it.
   * @returns the sent message.
   * @throws GmailError `refused` on a read-only account or a changed draft, `not-found` for a deleted draft, `limit` over the daily cap.
   */
  async confirm(
    api: GmailApi, row: AccountRecord, domain: Domain<typeof gmailDomain>, key: string, record: PendingRecord, by: 'settings' | 'owner-turn',
  ): Promise<{ readonly account: string; readonly messageId: string; readonly threadId: string }> {
    if (row.policy === 'read-only') throw new GmailError('refused', 'the account became read-only; the held message was not sent')
    let facts: DraftFacts
    try {
      facts = await draftFacts(api, record.draftId)
    } catch (error: unknown) {
      if (!(error instanceof GmailApiError && error.failure === 'not-found')) throw error
      await this.deps.holds.resolve(domain, record, 'discarded', by)
      throw new GmailError('not-found', 'the held draft is no longer in Gmail; nothing was sent')
    }
    if (facts.fingerprint !== record.fingerprint) {
      await this.deps.holds.resolve(domain, record, 'discarded', by)
      await this.deps.activity.record(domain, record.account, 'refused', `held draft ${key} changed after the notice`)
      throw new GmailError('refused', 'the held draft was changed after the owner was asked; nothing was sent, and the hold is discarded')
    }
    await this.deps.cap.assert(domain, record.account, by)
    const sent = await api.sendDraft(record.draftId)
    await this.deps.holds.resolve(domain, record, 'sent', by, sent.id)
    await this.deps.cap.record(domain, record.account, `${[...record.to, ...record.cc, ...record.bcc].join(', ')} (confirmed ${key} via ${by})`)
    return { account: record.account, messageId: sent.id, threadId: sent.threadId }
  }

  /** The owner's own addresses and the configured list, lower-cased. */
  private trusted(domain: Domain<typeof gmailDomain>): Set<string> {
    return new Set([
      ...Array.from(domain.table('accounts').entries(), ([, row]) => row.email.toLowerCase()),
      ...this.deps.trustedRecipients.map(address => parseMailbox(address).address.toLowerCase()),
    ])
  }
}

/** The recipients the owner vouched for: named this turn, or written to from this account before. */
async function vouchedFor(
  api: GmailApi, turn: TurnFacts, recipients: readonly string[], trusted: ReadonlySet<string>,
): Promise<Set<string>> {
  const vouched = new Set<string>()
  for (const address of recipients) {
    if (trusted.has(address)) continue
    if (namedByOwner(turn, address)) {
      vouched.add(address)
      continue
    }
    const sent = await api.listThreads(`in:sent (to:"${address}" OR cc:"${address}" OR bcc:"${address}")`, 1)
    if ((sent.threads ?? []).length > 0) vouched.add(address)
  }
  return vouched
}
