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

/** `uds:<path>`, with the characters Claude Code does not allow percent-encoded. */
export function encodeAddress(path: string): string {
  return `uds:${path.replace(/[^A-Za-z0-9:_/.\\-]/gu, c => [...Buffer.from(c)].map(b => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''))}`
}

/** The socket path of a `uds:` address, or undefined. */
export function addressPath(address: string): string | undefined {
  if (!address.startsWith('uds:')) return undefined
  try {
    return decodeURIComponent(address.slice(4))
  } catch {
    return undefined
  }
}

const cleanAttr = (value: string): string => value.replace(/["<>]/gu, '').split(/\s+/u).filter(Boolean).join(' ').slice(0, 64)

/** Defang a closing tag inside a body the way Claude Code does (`</tag` becomes `<\/tag`). */
export const escapeBody = (text: string): string => text.replace(new RegExp(`<(/\\s*${TAG})`, 'giu'), '<\\$1')

export function wrapMessage(text: string, from: string, fromName: string, mode: 'prompting' | 'bypass' = 'prompting'): string {
  return `<${TAG} from="${from}" from-name="${cleanAttr(fromName)}" from-mode="${mode}">\n${escapeBody(text)}\n</${TAG}>`
}

export function parseWrapper(content: string): Wrapper | undefined {
  const m = WRAPPER.exec(content)
  if (m === null) return undefined
  return {
    ...m[1] === undefined ? {} : { from: m[1] },
    ...m[4] === undefined ? {} : { fromName: m[4] },
    ...m[5] === undefined ? {} : { fromMode: m[5] },
    body: m[7] ?? '',
  }
}

/** The frame Claude Code's own senders write, `from` being where a reply should go. */
export function buildFrame(text: string, from: string, fromName: string): Record<string, unknown> {
  return {
    msgV: 1, msg_id: randomUUID(), type: 'user',
    message: { role: 'user', content: wrapMessage(text, from, fromName) },
    priority: 'next', from,
  }
}

/** The per-session token file name: `<pid>.<sha256 of the socket path>.key`. */
export function keyPath(sessionsDir: string, pid: number, socketPath: string): string {
  return join(sessionsDir, `${String(pid)}.${createHash('sha256').update(socketPath).digest('hex')}.key`)
}

/** The peer token of a session, or undefined when it has no key (a macOS sender then omits the auth line). */
export async function readPeerToken(sessionsDir: string, pid: number, socketPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(keyPath(sessionsDir, pid, socketPath), 'utf8')) as { peerToken?: unknown }
    return typeof parsed.peerToken === 'string' && /^[0-9a-f]{32}$/u.test(parsed.peerToken) ? parsed.peerToken : undefined
  } catch {
    return undefined
  }
}
