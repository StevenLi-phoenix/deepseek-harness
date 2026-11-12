/**
 * Composition of one outgoing message as RFC 5322 text: UTF-8 plain text in base64, attachments in a
 * `multipart/mixed` body, RFC 2047 encoded words for non-ASCII headers, RFC 2231 file names, and the
 * `In-Reply-To` / `References` pair of a reply. Every header value was checked by `address.ts` or here; the
 * composer refuses a value with a line break, so nothing the model writes can add a header.
 */

import { randomBytes } from 'node:crypto'
import { AddressProblem, formatMailbox, headerSafe, type Mailbox } from './address.ts'

/** One file to attach. */
export interface Attachment {
  /** File name shown to the recipient. */
  readonly filename: string
  /** Media type, such as `application/pdf`. */
  readonly contentType: string
  /** The bytes. */
  readonly data: Uint8Array
}

/** Everything one message carries. */
export interface Composition {
  readonly from: Mailbox
  readonly to: readonly Mailbox[]
  readonly cc: readonly Mailbox[]
  readonly bcc: readonly Mailbox[]
  readonly subject: string
  /** Plain-text body. */
  readonly text: string
  /** `Message-ID` of the message this one answers. */
  readonly inReplyTo?: string | undefined
  /** `References` chain of the thread, ending in `inReplyTo`. */
  readonly references?: string | undefined
  readonly attachments: readonly Attachment[]
}

/** UTF-8 bytes per encoded word, so a word stays under 76 characters. */
const WORD_BYTES = 45
/** Base64 line length in a body. */
const LINE_CHARS = 76

/** One `<id@host>` message id; a `References` value is a run of them. */
const MESSAGE_ID = /^<[^<>\s]+>$/u

/**
 * Encode text as RFC 2047 `B` encoded words, split on character boundaries.
 * @param text - the text.
 * @returns the words, folded with CRLF + space between them.
 */
export function encodeWords(text: string): string {
  const words: number[][] = []
  let chunk: number[] = []
  for (const char of text) {
    const bytes = [...Buffer.from(char, 'utf8')]
    if (chunk.length + bytes.length > WORD_BYTES) {
      words.push(chunk)
      chunk = []
    }
    chunk.push(...bytes)
  }
  if (chunk.length > 0) words.push(chunk)
  return words.map(word => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ')
}

/**
 * A header value as sent: printable ASCII as is, anything else as encoded words.
 * @param text - the value.
 * @returns the encoded value.
 */
export function headerText(text: string): string {
  return /^[\u0020-\u007E]*$/u.test(text) && text.length <= 900 ? text : encodeWords(text)
}

/**
 * Check a `Message-ID`-style value from a received message before it goes into a reply.
 * @param value - `<id@host>`, or for `References` several separated by whitespace.
 * @returns the ids joined by one space; empty when the value holds none.
 */
export function messageIds(value: string | undefined): string {
  if (value === undefined) return ''
  return value.split(/\s+/u).filter(part => MESSAGE_ID.test(part)).join(' ')
}

/** Base64 in lines of 76 characters. */
function base64Lines(data: Uint8Array): string {
  const encoded = Buffer.from(data).toString('base64')
  const lines: string[] = []
  for (let at = 0; at < encoded.length; at += LINE_CHARS) lines.push(encoded.slice(at, at + LINE_CHARS))
  return lines.join('\r\n')
}

/** An ASCII fallback for a file name: other characters, quotes, and backslashes become `_`. */
function asciiName(name: string): string {
  return name.replace(/[^\u0020-\u007E]|["\\]/gu, '_')
}

/**
 * Compose the message.
 * @param message - recipients, subject, text, thread headers, and attachments.
 * @param boundary - multipart boundary source; tests pass a fixed one.
 * @param now - the `Date` header's time, Unix epoch milliseconds.
 * @returns the RFC 5322 text with CRLF line ends.
 * @throws AddressProblem when the subject or a thread header holds a line break or control character.
 */
export function compose(message: Composition, boundary: () => string = () => `fork-${randomBytes(12).toString('hex')}`, now: number = Date.now()): string {
  if (!headerSafe(message.subject)) throw new AddressProblem('the subject holds a line break or a control character')
  for (const value of [message.inReplyTo, message.references]) {
    if (value !== undefined && !headerSafe(value)) throw new AddressProblem('a thread header holds a line break')
  }
  const headers: string[] = [
    `From: ${formatMailbox(message.from, encodeWords)}`,
    ...message.to.length > 0 ? [`To: ${message.to.map(mailbox => formatMailbox(mailbox, encodeWords)).join(', ')}`] : [],
    ...message.cc.length > 0 ? [`Cc: ${message.cc.map(mailbox => formatMailbox(mailbox, encodeWords)).join(', ')}`] : [],
    ...message.bcc.length > 0 ? [`Bcc: ${message.bcc.map(mailbox => formatMailbox(mailbox, encodeWords)).join(', ')}`] : [],
    `Subject: ${headerText(message.subject)}`,
    `Date: ${new Date(now).toUTCString()}`,
    ...messageIds(message.inReplyTo) === '' ? [] : [`In-Reply-To: ${messageIds(message.inReplyTo)}`],
    ...messageIds(message.references) === '' ? [] : [`References: ${messageIds(message.references)}`],
    'MIME-Version: 1.0',
  ]
  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(message.text, 'utf8'))]
  if (message.attachments.length === 0) return [...headers, ...textPart, ''].join('\r\n')
  const mark = boundary()
  const parts = [textPart.join('\r\n'), ...message.attachments.map((file) => {
    const fallback = asciiName(file.filename)
    const encoded = encodeURIComponent(file.filename).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    return [
      `Content-Type: ${file.contentType}; name="${fallback}"`,
      `Content-Disposition: attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(file.data),
    ].join('\r\n')
  })]
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mark}"`,
    '',
    ...parts.map(part => `--${mark}\r\n${part}`),
    `--${mark}--`,
    '',
  ].join('\r\n')
}
