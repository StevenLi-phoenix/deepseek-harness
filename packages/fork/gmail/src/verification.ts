import { AddressProblem, parseMailbox } from './address.ts'
import type { GmailApi } from './api.ts'
import { GmailError } from './errors.ts'
import { bodyText, header, trimQuoted, type GmailMessage, type GmailPart } from './message.ts'

/** A browser-authorized sender domain and the bounded receipt window. */
export interface VerificationLookup {
  readonly domain: string
  readonly domainOf: (host: string) => string | null
  readonly allowsLinkHost: (host: string) => boolean
  /** Host of the caller's live page: a link on it outranks links on other hosts, since Workday mails every tenant from myworkday.com. */
  readonly liveHost?: string
  readonly after: number
  readonly before: number
  readonly signal: AbortSignal
}

/** The only fields read out of matching verification messages. */
export type VerificationProof = ({ readonly code: string; readonly link: null } | { readonly code: null; readonly link: string }) & {
  readonly domain: string
  readonly receivedAt: number
  readonly ambiguous: boolean
}

const CODE = /(?<![a-z0-9])[0-9]{4,8}(?![a-z0-9])/iu
const BARE_CODE = /^[0-9]{4,8}$/u
const URL_TEXT = /https?:\/\/[^\s\x00-\x08\x0e-\x1f<>\\"'()[\]]+/giu
const VERIFY = new RegExp([
  String.raw`\b(?:verif(?:y|ication)|activate(?: your)? account|magic link|(?:your|security|confirmation) code)\b`,
  String.raw`\b(?:authenticat(?:e|ion)|one[ -]time|otp|passcode|sign[ -]?in|log[ -]?in)\b`,
  String.raw`验证码|驗證碼|認証コード|인증\s*코드|c[oó]digo de verifi(?:caci[oó]n|cação)|code de v[ée]rification|bestätigungscode`,
].join('|'), 'iu')

function senderHost(payload: GmailPart | undefined): string | null {
  const senders = payload?.headers?.filter(entry => entry.name.toLowerCase() === 'from') ?? []
  if (senders.length !== 1 || senders[0] === undefined) return null
  try {
    const mailbox = parseMailbox(senders[0].value)
    if (mailbox.name.includes('@')) return null // A display-name address is not a second sender.
    return mailbox.address.slice(mailbox.address.lastIndexOf('@') + 1)
  } catch (error: unknown) {
    /* v8 ignore else -- parseMailbox throws only AddressProblem. */
    if (error instanceof AddressProblem) return null
    /* v8 ignore next -- parseMailbox throws only AddressProblem. */
    throw error
  }
}

function receivedAt(message: GmailMessage, lookup: VerificationLookup): number | null {
  if (message.labelIds?.some(label => label === 'SENT' || label === 'DRAFT' || label === 'SPAM' || label === 'TRASH') === true) return null
  if (!/^[0-9]+$/u.test(message.internalDate ?? '')) return null
  const time = Number(message.internalDate)
  if (!Number.isSafeInteger(time) || time < lookup.after || time > lookup.before) return null
  const sender = senderHost(message.payload)
  return sender !== null && lookup.domainOf(sender) === lookup.domain ? time : null
}

/** Exclude named, attached, or forwarded MIME subtrees, even when Gmail returns inline part data. */
function inlinePart(part: GmailPart | undefined): GmailPart | undefined {
  if (part === undefined || (part.filename ?? '') !== '' || part.body?.attachmentId !== undefined
    || /^attachment\b/iu.test(header(part, 'Content-Disposition').trim()) || /^message\//iu.test(part.mimeType ?? '')) return undefined
  return { ...part, parts: (part.parts ?? []).flatMap((child) => {
    const inline = inlinePart(child)
    return inline === undefined ? [] : [inline]
  }) }
}

// A code sits next to the wording that introduces it: up to 40 characters after it ("verification code: 1234",
// "本次验证码001234") or 24 before it ("Use 1234 to sign in"). A number elsewhere in a verification message, such as an
// office address or a footer year, is not one: WellSky's Workday account email (2026-11-28) lost its link to one.
const CODE_AFTER_WORDING = 40
const CODE_BEFORE_WORDING = 24
const CODES = new RegExp(CODE.source, 'giu')
const VERIFY_WORDS = new RegExp(VERIFY.source, 'giu')

function codeNearWording(text: string): string | undefined {
  const words = [...text.matchAll(VERIFY_WORDS)].map(word => ({ start: word.index, end: word.index + word[0].length }))
  for (const match of text.matchAll(CODES)) {
    const start = match.index
    const end = start + match[0].length
    if (words.some(word => (start >= word.end && start - word.end <= CODE_AFTER_WORDING)
      || (word.start >= end && word.start - end <= CODE_BEFORE_WORDING))) return match[0]
  }
  return undefined
}

function codeFrom(subject: string, body: string): string | undefined {
  subject = subject.replace(URL_TEXT, ' ')
  body = body.replace(URL_TEXT, ' ')
  // A message can legitimately consist of just the code.
  const bare = [subject.trim(), body.trim()].find(text => BARE_CODE.test(text))
  return bare ?? codeNearWording(subject) ?? codeNearWording(body)
}

const VERIFY_PATH = /(?:^|[/_-])(?:verif(?:y|ication)|activate|confirm|validate|magic[-_]?link|sso|sign[-_]?in)(?:[/.?_&-]|$)/iu

function linkFrom(subject: string, body: string, lookup: VerificationLookup): string | undefined {
  const matches = [...body.matchAll(URL_TEXT)]
  for (const match of matches) {
    const raw = match[0].replace(/[.,;!]+$/u, '')
    const url = URL.parse(raw)
    if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || !lookup.allowsLinkHost(url.hostname)) continue
    const before = body.slice(Math.max(0, match.index - 100), match.index)
    if (VERIFY_PATH.test(url.pathname) || VERIFY.test(before) || (matches.length === 1 && VERIFY.test(subject))) return url.href
  }
  return undefined
}

/**
 * Look for a recent verification code, falling back to a verification link, without opening attachments.
 * @param api - the account API.
 * @param lookup - the scoped sender and date bounds.
 * @param limit - maximum matching metadata reads; an incomplete result must not report a code.
 * @param maxHtmlChars - bound on HTML decoding.
 * @param maxBodyChars - bound on text inspected for a code.
 * @returns the newest code, with ambiguity when another code differs; or else the newest link, preferring the live host,
 * with ambiguity when a link on another host competes.
 */
export async function readVerificationCode(
  api: GmailApi, lookup: VerificationLookup, limit: number, maxHtmlChars: number, maxBodyChars: number,
): Promise<VerificationProof | null> {
  if (!/^[a-z0-9.-]+$/u.test(lookup.domain)) throw new GmailError('invalid', 'invalid verification domain')
  // Gmail documents epoch seconds; querying from one second earlier preserves the inclusive local boundary.
  const afterSeconds = Math.floor(lookup.after / 1000) - 1
  const query = `from:${lookup.domain} after:${afterSeconds} -in:sent -in:drafts`
  const page = await api.listMessages(query, limit, lookup.signal)
  if (page.nextPageToken !== undefined || (page.messages?.length ?? 0) > limit) throw new GmailError('limit', 'too many verification candidates')
  const ids = [...new Set((page.messages ?? []).map(({ id }) => id))]
  const metadata = await Promise.all(ids.map(async (id) => {
    const message = await api.verificationMessage(id, 'metadata', lookup.signal)
    const time = receivedAt(message, lookup)
    return time === null ? [] : [{ id, time, subject: header(message.payload, 'Subject') }]
  }))
  const candidates = metadata.flat().sort((a, b) => b.time - a.time || a.id.localeCompare(b.id))
  let newestCode: VerificationProof | null = null
  const links: { readonly link: string; readonly host: string; readonly time: number }[] = []
  for (const { id, time, subject } of candidates) {
    lookup.signal.throwIfAborted()
    let code = codeFrom(subject, '')
    let link: string | undefined
    if (code === undefined) {
      const full = await api.verificationMessage(id, 'full', lookup.signal)
      if (receivedAt(full, lookup) !== time) continue
      const body = trimQuoted(bodyText(inlinePart(full.payload), maxHtmlChars)).text.slice(0, maxBodyChars)
      const fullSubject = header(full.payload, 'Subject')
      code = codeFrom(fullSubject, body)
      if (code === undefined && newestCode === null) link = linkFrom(fullSubject, body, lookup)
    }
    if (code !== undefined) {
      if (newestCode === null) newestCode = { code, link: null, domain: lookup.domain, receivedAt: time, ambiguous: false }
      else if (newestCode.code !== code) return { ...newestCode, ambiguous: true }
    } else if (link !== undefined) {
      links.push({ link, host: new URL(link).hostname, time })
    }
  }
  if (newestCode !== null) return newestCode
  const onLiveHost = links.filter(entry => entry.host === lookup.liveHost)
  const pool = onLiveHost.length > 0 ? onLiveHost : links
  const newest = pool[0]
  if (newest === undefined) return null
  // A different link on the same host is an earlier send of the same verification, which a resend supersedes
  // (WellSky's Workday account email, 2026-11-28); a link on another host competes with it.
  const ambiguous = pool.some(entry => entry.host !== newest.host)
  return { code: null, link: newest.link, domain: lookup.domain, receivedAt: newest.time, ambiguous }
}
