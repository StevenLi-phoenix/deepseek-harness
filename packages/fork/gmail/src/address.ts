/**
 * Mail addresses as the tools take them and as headers carry them: a list of `name <user@host>` or bare `user@host`
 * entries, checked before anything is composed. A value with a line break, a control character, or an address outside
 * the simple dot-atom form is refused, so no argument can add a header or a hidden recipient.
 */

/** One recipient: the address (lower-cased for comparison) and an optional display name. */
export interface Mailbox {
  /** The address as given, trimmed. */
  readonly address: string
  /** Display name without quotes; empty when none was given. */
  readonly name: string
}

/** A problem with an address argument, worded for the model. */
export class AddressProblem extends Error {}

/** Characters no header value may carry: CR, LF, and the other C0 controls except tab. */
const CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F]/u

/** `local@domain` with a dot-atom local part and a dotted domain; quoted local parts are not accepted. */
const ADDRESS = new RegExp(String.raw`^[A-Za-z0-9!#$%&'*+/=?^_\x60{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_\x60{|}~-]+)*`
  + String.raw`@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$`, 'u')

/** Longest address the tools accept (RFC 5321 path limit). */
const MAX_ADDRESS_CHARS = 254

/**
 * Whether a header value is free of line breaks and control characters.
 * @param value - the value.
 * @returns true when it can go into a header as is.
 */
export function headerSafe(value: string): boolean {
  return !CONTROL.test(value)
}

/**
 * Parse one recipient.
 * @param raw - `user@host`, `<user@host>`, or `Name <user@host>`.
 * @returns the mailbox.
 * @throws AddressProblem when it is not one plain address.
 */
export function parseMailbox(raw: string): Mailbox {
  const text = raw.trim()
  if (!headerSafe(text)) throw new AddressProblem(`"${text.slice(0, 80)}" holds a line break or a control character`)
  const angled = /^(.*)<([^<>]+)>$/u.exec(text)
  const address = (angled?.[2] ?? text).trim()
  const name = (angled?.[1] ?? '').trim().replace(/^"(.*)"$/u, '$1').trim()
  if (address.length > MAX_ADDRESS_CHARS || !ADDRESS.test(address)) throw new AddressProblem(`"${text.slice(0, 80)}" is not an email address`)
  if (/[<>"\\]/u.test(name)) throw new AddressProblem(`the name in "${text.slice(0, 80)}" holds <, >, ", or \\`)
  return { address, name }
}

/**
 * Parse a recipient list: an array of entries, each of which may itself hold several comma-separated entries.
 * @param value - the model's argument (a string or an array of strings).
 * @returns the mailboxes in order, without repeats of the same address.
 * @throws AddressProblem on any entry that is not one plain address, or on a value that is neither a string nor strings.
 */
export function parseMailboxes(value: unknown): Mailbox[] {
  if (value === undefined || value === null) return []
  const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined
  if (items === undefined || items.some(item => typeof item !== 'string')) throw new AddressProblem('recipients are a list of email addresses')
  const seen = new Set<string>()
  const out: Mailbox[] = []
  for (const piece of (items as string[]).flatMap(item => splitList(item))) {
    const mailbox = parseMailbox(piece)
    const key = mailbox.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(mailbox)
  }
  return out
}

/** Split a comma- or semicolon-separated list, keeping commas inside a quoted display name. */
function splitList(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (const char of text) {
    if (char === '"') quoted = !quoted
    if (!quoted && (char === ',' || char === ';')) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/**
 * Read the addresses out of a header such as `From` or `To` from a received message (never used to compose).
 * @param header - the header value.
 * @returns the lower-cased addresses it names, in order; parts that hold no address are skipped.
 */
export function addressesIn(header: string): string[] {
  return Array.from(header.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+[A-Za-z0-9]/gu), match => match[0].toLowerCase())
}

/**
 * Format a mailbox for a header, encoding a non-ASCII display name.
 * @param mailbox - the mailbox.
 * @param encode - the RFC 2047 encoder for non-ASCII words.
 * @returns `address`, or `"Name" <address>`.
 */
export function formatMailbox(mailbox: Mailbox, encode: (text: string) => string): string {
  if (mailbox.name === '') return mailbox.address
  const name = /^[\u0020-\u007E]*$/u.test(mailbox.name) ? `"${mailbox.name}"` : encode(mailbox.name)
  return `${name} <${mailbox.address}>`
}
