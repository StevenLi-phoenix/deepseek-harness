/**
 * Received messages as the tools show them: the Gmail API's `format=full` resource reduced to its headers, the plain
 * text of its body (the `text/plain` parts, or the HTML parts converted when there are none), decoded in the charset
 * each part declares, the quoted history of a reply cut off, and the list of attachments by id. Nothing here trusts
 * the content: the tools wrap it as strangers' data.
 */

import { z } from 'zod'
import { decodeEntities, htmlToText, tidy } from './html.ts'

/** One MIME part of the Gmail API's message resource. */
export interface GmailPart {
  readonly partId?: string | undefined
  readonly mimeType?: string | undefined
  readonly filename?: string | undefined
  readonly headers?: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined
  readonly body?: {
    readonly size?: number | undefined
    readonly data?: string | undefined
    readonly attachmentId?: string | undefined
  } | undefined
  readonly parts?: readonly GmailPart[] | undefined
}

const partSchema: z.ZodType<GmailPart> = z.lazy(() => z.object({
  partId: z.string().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  body: z.object({ size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional() }).optional(),
  parts: z.array(partSchema).optional(),
}))

/** The Gmail API's message resource, the fields the tools read. */
export const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: partSchema.optional(),
})

/** A Gmail API message resource. */
export type GmailMessage = z.infer<typeof gmailMessageSchema>

/** One attachment of a received message. */
export interface AttachmentInfo {
  /**
   * The MIME part id (`1`, `2.1`), for `gmail_attachment`. Gmail's own attachment id changes on every read of the
   * message, so the part id is the stable name.
   */
  readonly part: string
  readonly filename: string
  readonly mimeType: string
  /** Size in bytes, as Gmail reports it. */
  readonly size: number
}

/** One received message, reduced. */
export interface MessageView {
  readonly id: string
  readonly threadId: string
  readonly labels: readonly string[]
  /** Unix epoch milliseconds Gmail received it; null when absent. */
  readonly date: number | null
  readonly from: string
  readonly to: string
  readonly cc: string
  readonly replyTo: string
  readonly subject: string
  /** The `Message-ID` header, for a reply's `In-Reply-To`. */
  readonly messageId: string
  /** The `References` header. */
  readonly references: string
  /** The body text, possibly cut at `maxChars`. */
  readonly text: string
  /** Characters of the full body text before the cut. */
  readonly textChars: number
  /** Whether quoted history was removed from the end. */
  readonly quoteTrimmed: boolean
  readonly attachments: readonly AttachmentInfo[]
  readonly snippet: string
}

/** Options of {@link messageView}. */
export interface ViewOptions {
  /** Characters of body text kept. */
  readonly maxChars: number
  /** Characters of an HTML part read at most. */
  readonly maxHtmlChars: number
  /** Keep the quoted history of a reply. */
  readonly keepQuotes: boolean
}

/**
 * The first value of a header, by case-insensitive name.
 * @param part - the part holding the headers.
 * @param name - header name.
 * @returns the value, or an empty string.
 */
export function header(part: GmailPart | undefined, name: string): string {
  const wanted = name.toLowerCase()
  return part?.headers?.find(entry => entry.name.toLowerCase() === wanted)?.value ?? ''
}

/** The charset a part's `Content-Type` declares, `utf-8` by default. */
function charsetOf(part: GmailPart): string {
  const match = /charset\s*=\s*"?([^";\s]+)"?/iu.exec(header(part, 'Content-Type'))
  return match?.[1]?.toLowerCase() ?? 'utf-8'
}

/**
 * Decode a part body: base64url bytes in the part's charset; an unknown charset reads as UTF-8.
 * @param data - the base64url data.
 * @param charset - the declared charset.
 * @returns the text.
 */
export function decodeBody(data: string, charset: string): string {
  const bytes = Buffer.from(data, 'base64url')
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset)
  } catch {
    // RangeError: a charset the runtime does not know; UTF-8 shows most of such a message correctly.
    decoder = new TextDecoder('utf-8')
  }
  return decoder.decode(bytes)
}

/** Every part, depth first. */
function* walk(part: GmailPart | undefined): Generator<GmailPart> {
  if (part === undefined) return
  yield part
  for (const child of part.parts ?? []) yield* walk(child)
}

/** A line that opens the quoted history of a reply. */
const QUOTE_OPENERS: readonly RegExp[] = [
  /^On .{4,300}wrote:$/u,
  /^在.{2,200}写道[:：]$/u,
  /^.{2,200}于.{2,200}写道[:：]$/u,
  /^-{2,}\s*(?:Original Message|Forwarded message|原始邮件|转发的邮件)\s*-{2,}$/iu,
  /^_{8,}$/u,
]

/** The line at an index; the callers stay inside the array. */
function lineAt(lines: readonly string[], index: number): string {
  /* v8 ignore next -- every caller passes an index inside the array; ?? only satisfies the indexed-access type. */
  return lines[index] ?? ''
}

/** Outlook-style quoted header block: a `From:` line with a date line soon after. */
function outlookHeaderAt(lines: readonly string[], index: number): boolean {
  if (!/^(?:From|发件人)\s*[:：]/iu.test(lineAt(lines, index))) return false
  return lines.slice(index + 1, index + 4).some(line => /^(?:Sent|Date|发送时间|时间)\s*[:：]/iu.test(line))
}

/**
 * Cut the quoted history off the end of a reply.
 * @param text - the body text.
 * @returns the text before the history, and whether anything was cut; a message that is only a quote is kept whole.
 */
export function trimQuoted(text: string): { text: string; trimmed: boolean } {
  const lines = text.split('\n')
  for (let index = 1; index < lines.length; index++) {
    const line = lineAt(lines, index).trim()
    const joined = index + 1 < lines.length ? `${line} ${lineAt(lines, index + 1).trim()}` : line
    if (QUOTE_OPENERS.some(pattern => pattern.test(line) || (line.startsWith('On ') && pattern.test(joined))) || outlookHeaderAt(lines, index)) {
      const head = lines.slice(0, index).join('\n').trim()
      if (head !== '') return { text: head, trimmed: true }
    }
  }
  let end = lines.length
  while (end > 0 && (lineAt(lines, end - 1).startsWith('>') || lineAt(lines, end - 1).trim() === '')) end--
  if (end < lines.length && end > 0 && lines.slice(end).some(line => line.startsWith('>'))) return { text: lines.slice(0, end).join('\n').trim(), trimmed: true }
  return { text, trimmed: false }
}

/**
 * The body text of a message: its `text/plain` parts, else its HTML parts as text.
 * @param payload - the message payload.
 * @param maxHtmlChars - characters of one HTML part read at most.
 * @returns the text.
 */
export function bodyText(payload: GmailPart | undefined, maxHtmlChars: number): string {
  const parts = [...walk(payload)].filter(hasData).filter(part => (part.filename ?? '') === '')
  const plain = parts.filter(part => (part.mimeType ?? '').toLowerCase() === 'text/plain')
  if (plain.length > 0) return tidy(plain.map(part => decodeBody(part.body.data, charsetOf(part))).join('\n\n'))
  const html = parts.filter(part => (part.mimeType ?? '').toLowerCase() === 'text/html')
  return html.map(part => htmlToText(decodeBody(part.body.data, charsetOf(part)), maxHtmlChars)).join('\n\n')
}

/** A part whose body carries its data inline. */
type DataPart = GmailPart & { readonly body: { readonly data: string } }

/** Whether a part's body carries its data inline. */
function hasData(part: GmailPart): part is DataPart {
  return part.body?.data !== undefined
}

/** A part that is an attachment. */
type AttachmentPart = GmailPart & { readonly partId: string; readonly filename: string }

/** A part that is an attachment: it has a part id, a file name, and either an attachment id or inline data. */
function isAttachment(part: GmailPart): part is AttachmentPart {
  return part.partId !== undefined && (part.filename ?? '') !== '' && (part.body?.attachmentId !== undefined || part.body?.data !== undefined)
}

/**
 * The attachments of a message.
 * @param payload - the message payload.
 * @returns one entry per attachment part.
 */
export function attachmentsOf(payload: GmailPart | undefined): AttachmentInfo[] {
  return [...walk(payload)]
    .filter(isAttachment)
    .map(part => ({ part: part.partId, filename: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', size: part.body?.size ?? 0 }))
}

/**
 * The attachment part with a given part id.
 * @param payload - the message payload.
 * @param partId - the part id `attachmentsOf` listed.
 * @returns the part, or undefined when the message has no such attachment.
 */
export function attachmentPart(payload: GmailPart | undefined, partId: string): AttachmentPart | undefined {
  return [...walk(payload)].filter(isAttachment).find(part => part.partId === partId)
}

/**
 * Reduce a message resource.
 * @param message - the resource (`format=full`, or `format=metadata` for headers only).
 * @param options - body limits and quote handling.
 * @returns the view.
 */
export function messageView(message: GmailMessage, options: ViewOptions): MessageView {
  const payload = message.payload
  const full = bodyText(payload, options.maxHtmlChars)
  const quoted = options.keepQuotes ? { text: full, trimmed: false } : trimQuoted(full)
  const chars = Array.from(quoted.text)
  const date = Number(message.internalDate)
  return {
    id: message.id,
    threadId: message.threadId,
    labels: message.labelIds ?? [],
    date: Number.isFinite(date) && message.internalDate !== undefined ? date : null,
    from: header(payload, 'From'),
    to: header(payload, 'To'),
    cc: header(payload, 'Cc'),
    replyTo: header(payload, 'Reply-To'),
    subject: header(payload, 'Subject'),
    messageId: header(payload, 'Message-ID'),
    references: header(payload, 'References'),
    text: chars.length > options.maxChars ? `${chars.slice(0, options.maxChars).join('')}…` : quoted.text,
    textChars: chars.length,
    quoteTrimmed: quoted.trimmed,
    attachments: attachmentsOf(payload),
    snippet: decodeEntities(message.snippet ?? ''),
  }
}
