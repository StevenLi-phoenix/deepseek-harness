/**
 * An outgoing message in its two forms: a new message composed from the tool's arguments (recipients, reply headers,
 * attachments), and a draft read back from Gmail, which is what the send gate decides on and the owner is asked about.
 */

import { createHash } from 'node:crypto'
import { AddressProblem, addressesIn, parseMailbox, parseMailboxes, type Mailbox } from './address.ts'
import type { GmailApi } from './api.ts'
import { AttachmentProblem, readAttachments } from './attachments.ts'
import { header, messageView } from './message.ts'
import { compose, messageIds } from './mime.ts'
import type { AccountRecord } from './storage.ts'
import type { Outgoing } from './types.ts'

/** A composed message, before it is sent or drafted. */
export interface Prepared {
  /** The RFC 5322 text. */
  readonly raw: string
  readonly threadId: string | undefined
  /** Every To, Cc, and Bcc address, lower-cased. */
  readonly recipients: string[]
  readonly subject: string
}

/** A draft's recipients, subject, text, and attachments as the gate and the notice read them. */
export interface DraftFacts {
  readonly draftId: string
  readonly threadId: string | null
  readonly from: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  readonly text: string
  readonly attachments: readonly string[]
  /** SHA-256 of the draft's RFC 5322 text, hex. */
  readonly fingerprint: string
}

/**
 * Compose an outgoing message: recipients, reply headers, attachments. A reply without recipients answers the
 * original's sender (or, for the account's own message, its recipients), and with `replyAll` also copies the rest.
 * @param api - the account's API client, to read the original of a reply.
 * @param row - the sending account.
 * @param message - the message.
 * @param maxAttachmentBytes - bytes of all attachments together.
 * @returns the RFC 5322 text, its thread, recipients, and subject.
 * @throws AddressProblem for a bad address or a new message without a subject; AttachmentProblem for a file that may not be attached.
 */
export async function prepareOutgoing(api: GmailApi, row: AccountRecord, message: Outgoing, maxAttachmentBytes: number): Promise<Prepared> {
  let to = parseMailboxes(message.to)
  let cc = parseMailboxes(message.cc)
  const bcc = parseMailboxes(message.bcc)
  let subject = message.subject
  let threadId: string | undefined
  let inReplyTo: string | undefined
  let references: string | undefined
  if (message.replyTo !== undefined) {
    const original = await api.message(message.replyTo, 'metadata')
    const payload = original.payload
    threadId = original.threadId
    inReplyTo = messageIds(header(payload, 'Message-ID'))
    references = [messageIds(header(payload, 'References')), inReplyTo].filter(part => part !== '').join(' ')
    if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
      const own = row.email.toLowerCase()
      const sender = mailboxesOf(header(payload, 'Reply-To') || header(payload, 'From'))
      const fromSelf = sender.every(mailbox => mailbox.address.toLowerCase() === own)
      to = fromSelf ? mailboxesOf(header(payload, 'To')) : sender
      if (message.replyAll === true) {
        const taken = new Set([own, ...to.map(mailbox => mailbox.address.toLowerCase())])
        cc = [...mailboxesOf(header(payload, 'To')), ...mailboxesOf(header(payload, 'Cc'))].filter((mailbox) => {
          const key = mailbox.address.toLowerCase()
          if (taken.has(key)) return false
          taken.add(key)
          return true
        })
      }
    }
    const originalSubject = cleanHeader(header(payload, 'Subject'))
    subject ??= /^re:/iu.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`
  }
  if (subject === undefined || subject.trim() === '') throw new AddressProblem('a new message needs a subject')
  const attachments = message.attachments.length === 0
    ? []
    : await readAttachments(message.attachments, cwdOf(message), maxAttachmentBytes)
  const raw = compose({
    from: { address: row.email, name: row.name }, to, cc, bcc, subject, text: message.body, inReplyTo, references, attachments,
  })
  const recipients = [...to, ...cc, ...bcc].map(mailbox => mailbox.address.toLowerCase())
  return { raw, threadId, recipients, subject }
}

/**
 * Read a draft back: what Gmail holds is what the gate decides on, what the owner is asked about, and what the
 * fingerprint covers. The recipients come from the draft's RFC 5322 text, which `drafts.send` sends from.
 * @param api - the account's API client.
 * @param draftId - the draft.
 * @returns the draft's facts.
 */
export async function draftFacts(api: GmailApi, draftId: string): Promise<DraftFacts> {
  const [draft, raw] = await Promise.all([api.draft(draftId), api.draftRaw(draftId)])
  const headers = rawHeaders(raw)
  const payload = draft.message?.payload
  const view = messageView({ id: draft.message?.id ?? draft.id, threadId: draft.message?.threadId ?? '', payload }, { maxChars: Number.MAX_SAFE_INTEGER, maxHtmlChars: 1_000_000, keepQuotes: true })
  return {
    draftId: draft.id,
    threadId: draft.message?.threadId ?? null,
    from: header(payload, 'From'),
    to: addressesIn(headers('To')),
    cc: addressesIn(headers('Cc')),
    bcc: addressesIn(headers('Bcc')),
    subject: header(payload, 'Subject'),
    text: view.text,
    attachments: view.attachments.map(entry => `${entry.filename} (${entry.size} B)`),
    fingerprint: createHash('sha256').update(raw, 'latin1').digest('hex'),
  }
}

function cwdOf(message: Outgoing): string {
  if (message.cwd === undefined) throw new AttachmentProblem('this Session has no working directory to attach files from')
  return message.cwd
}

/** A header value from a received message, made safe for a new header. */
function cleanHeader(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim()
}

/** The mailboxes a received header names, the ones that are plain addresses. */
function mailboxesOf(value: string): Mailbox[] {
  const out: Mailbox[] = []
  for (const address of addressesIn(value)) {
    try {
      out.push(parseMailbox(address))
    } catch {
      // AddressProblem: an address outside the plain form is left out of the reply rather than written as is.
      continue
    }
  }
  return out
}

/**
 * The header lookup of an RFC 5322 text: folded lines joined, names compared without case.
 * @param raw - the message text.
 * @returns a function from a header name to its values joined by `, `.
 */
function rawHeaders(raw: string): (name: string) => string {
  const end = raw.search(/\r?\n\r?\n/u)
  const lines = (end === -1 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/gu, ' ').split(/\r?\n/u)
  return (name) => {
    const wanted = `${name.toLowerCase()}:`
    return lines.filter(line => line.toLowerCase().startsWith(wanted)).map(line => line.slice(wanted.length).trim()).join(', ')
  }
}
