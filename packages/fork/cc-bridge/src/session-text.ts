/**
 * How the bridge writes a Claude Code session for the model and the log: the sender line of an inbound message, the
 * session view `cc_list` returns, and the registry directory it reads.
 */

import { join } from 'node:path'
import type { SessionView } from './registry.ts'

/**
 * One line a model or a log can read; control characters and quotes would break the frame around it.
 * @param text - the text to flatten.
 * @param limit - longest result, in UTF-16 code units.
 * @returns the text on one line, control characters, quotes, and angle brackets replaced by spaces.
 */
export function plain(text: string, limit: number): string {
  return text.replace(/[\p{Cc}\p{Cf}"<>]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit)
}

/**
 * How the main agent reads who sent an inbound message. The name comes from the relay's session
 * registry, found by the process that connected, so the sender cannot choose it.
 * @param from - the registry view of the sending session.
 * @returns one line naming the session, its pid, and its working directory when known.
 */
export function senderLabel(from: SessionView): string {
  const name = plain(from.name, 80)
  const where = from.cwd === undefined ? '' : ` working in ${plain(from.cwd, 120)}`
  return `a Claude Code session on this Mac named "${name}" (pid ${String(from.pid)}${where}), the owner's own coding agent running in the owner's account`
}

/**
 * A view of a session for the model, with how long it has been quiet.
 * @param session - the session view; its `sessionId` is dropped.
 * @param now - current time in epoch milliseconds, compared with `session.updatedAt`.
 * @returns the view plus `idleSeconds` (whole seconds, at least 0), omitted when `updatedAt` is unknown.
 */
export function sessionForModel(session: SessionView, now: number): Omit<SessionView, 'sessionId'> & { idleSeconds?: number } {
  const { sessionId: _sessionId, ...rest } = session
  const quiet = session.updatedAt === undefined ? {} : { idleSeconds: Math.max(0, Math.round((now - session.updatedAt) / 1000)) }
  return { ...rest, ...quiet }
}

/**
 * The session registry the bridge reads: this account's own, which keeps the owner's sessions out of reach.
 * @param configured - the configured directory; an empty string selects the default.
 * @param home - home directory of the account, used for the default.
 * @returns `configured`, or `<home>/.claude/sessions` when it is empty.
 */
export function resolveSessionsDir(configured: string, home: string): string {
  return configured === '' ? join(home, '.claude', 'sessions') : configured
}
