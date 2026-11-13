/**
 * Claude Code's peer-message format (`peerProtocol` 1, checked on 2.1.314). The format is internal and
 * undocumented: it was read from the shipped binary and confirmed end to end between real sessions.
 * Everything that depends on it lives in this file, so a Claude Code change touches one place.
 *
 * A session with messaging on listens on a unix socket recorded as `messagingSocketPath` in
 * `~/.claude/sessions/<pid>.json`. A sender writes newline-delimited JSON: an optional
 * `{"type":"auth","token":…}` line (the token is in `<pid>.<sha256 of the socket path>.key`), then a
 * `{"type":"user",…}` frame whose content is a `<cross-session-message …>` wrapper. The receiver
 * rebuilds the wrapper from its parsed attributes and ignores the message when it differs, so the
 * wrapper here is built exactly the way Claude Code builds it.
 */

import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Element name of the peer-message wrapper. */
export const TAG = 'cross-session-message'
/** Claude Code drops a connection whose line exceeds this many characters. */
export const LINE_LIMIT = 1 << 20

const ADDRESS_CHARS = String.raw`A-Za-z0-9%:_/.\\-`
const WRAPPER = new RegExp(
  `^<${TAG}(?: from="([${ADDRESS_CHARS}]+)")?(?: from-session="([A-Za-z0-9_-]{1,80})")?`
  + String.raw`(?: hop-chain="([0-9a-f]{24}(?:,[0-9a-f]{24}){0,31})")?(?: from-name="([^"<>\n\r]+)")?`
  + String.raw`(?: from-mode="(bypass|prompting)")?(?: from-plugin="([^"<>\n\r]+)")?>\n([\s\S]*)\n</${TAG}>$`,
  'u',
)

/** A parsed `<cross-session-message>` wrapper. */
export interface Wrapper {
  from?: string
  fromName?: string
  fromMode?: string
  body: string
}

/**
 * `uds:<path>`, with the characters Claude Code does not allow percent-encoded.
 * @param path - absolute unix socket path.
 * @returns the address string.
 */
export function encodeAddress(path: string): string {
  return `uds:${path.replace(/[^A-Za-z0-9:_/.\\-]/gu, c => [...Buffer.from(c)].map(b => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''))}`
}

/**
 * The socket path of a `uds:` address, or undefined.
 * @param address - an address as written in a `from` attribute.
 * @returns the decoded path; undefined when the prefix is not `uds:` or the escapes are malformed.
 */
export function addressPath(address: string): string | undefined {
  if (!address.startsWith('uds:')) return undefined
  try {
    return decodeURIComponent(address.slice(4))
  } catch {
    return undefined
  }
}

const cleanAttr = (value: string): string => value.replace(/["<>]/gu, '').split(/\s+/u).filter(Boolean).join(' ').slice(0, 64)

/**
 * Defang a closing tag inside a body the way Claude Code does (`</tag` becomes `<\/tag`).
 * @param text - message body.
 * @returns the body with every closing wrapper tag escaped.
 */
export const escapeBody = (text: string): string => text.replace(new RegExp(`<(/\\s*${TAG})`, 'giu'), '<\\$1')

/**
 * Build the `<cross-session-message>` wrapper Claude Code expects, byte for byte.
 * @param text - message body, escaped with `escapeBody`.
 * @param from - reply address, written into the `from` attribute unmodified.
 * @param fromName - sender display name; quotes, angle brackets and extra whitespace are removed and the result is cut to 64 characters.
 * @param mode - value of the `from-mode` attribute.
 * @returns the wrapper text.
 */
export function wrapMessage(text: string, from: string, fromName: string, mode: 'prompting' | 'bypass' = 'prompting'): string {
  return `<${TAG} from="${from}" from-name="${cleanAttr(fromName)}" from-mode="${mode}">\n${escapeBody(text)}\n</${TAG}>`
}

/**
 * Parse a wrapper produced by `wrapMessage` or Claude Code.
 * @param content - the full message content.
 * @returns `from`, `fromName`, `fromMode` when present, and the body; undefined when the content is not a wrapper.
 */
export function parseWrapper(content: string): Wrapper | undefined {
  const m = WRAPPER.exec(content)
  if (m === null) return undefined
  /* v8 ignore next 5 -- group 7 of the wrapper pattern is mandatory. */
  return {
    ...m[1] === undefined ? {} : { from: m[1] },
    ...m[4] === undefined ? {} : { fromName: m[4] },
    ...m[5] === undefined ? {} : { fromMode: m[5] },
    body: m[7] ?? '',
  }
}

/**
 * The frame Claude Code's own senders write, `from` being where a reply should go.
 * @param text - message body.
 * @param from - reply address, such as the result of `encodeAddress`.
 * @param fromName - sender display name.
 * @returns the frame object to serialize as one JSON line; `msg_id` is a fresh UUID on every call.
 */
export function buildFrame(text: string, from: string, fromName: string): Record<string, unknown> {
  return {
    msgV: 1, msg_id: randomUUID(), type: 'user',
    message: { role: 'user', content: wrapMessage(text, from, fromName) },
    priority: 'next', from,
  }
}

/**
 * The per-session token file path: `<pid>.<sha256 of the socket path>.key`.
 * @param sessionsDir - Claude Code's sessions directory.
 * @param pid - process id of the session.
 * @param socketPath - the session's `messagingSocketPath`.
 * @returns the path inside `sessionsDir`.
 */
export function keyPath(sessionsDir: string, pid: number, socketPath: string): string {
  return join(sessionsDir, `${String(pid)}.${createHash('sha256').update(socketPath).digest('hex')}.key`)
}

/**
 * The peer token of a session, or undefined when it has no key (a macOS sender then omits the auth line).
 * @param sessionsDir - Claude Code's sessions directory.
 * @param pid - process id of the session.
 * @param socketPath - the session's `messagingSocketPath`.
 * @returns the 32-character hex token; undefined when the file is missing, unreadable, or holds no valid `peerToken`.
 */
export async function readPeerToken(sessionsDir: string, pid: number, socketPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(keyPath(sessionsDir, pid, socketPath), 'utf8')) as { peerToken?: unknown }
    return typeof parsed.peerToken === 'string' && /^[0-9a-f]{32}$/u.test(parsed.peerToken) ? parsed.peerToken : undefined
  } catch {
    return undefined
  }
}
