/**
 * What `ctx.claudeCodeSessions` answers, as plain data types with no imports: the `./view` subpath, which the event
 * console's Host route and browser page read type-only.
 */

/** A Claude Code session of the service account. */
export interface CcSession {
  readonly name: string
  readonly pid: number
  readonly status: string | null
  readonly cwd: string | null
  readonly updatedAt: number | null
  /** The bridge started it in tmux, so it can be stopped from here. */
  readonly managed: boolean
}

/** How the account is signed in to Claude Code: `full` (a claude.ai login, which Remote Control needs), `token`, or `none`. */
export type CcLogin = 'full' | 'token' | 'none'

/** Sessions and limits as the Settings page shows them. */
export interface CcView {
  readonly enabled: boolean
  readonly login: CcLogin
  readonly sessions: readonly CcSession[]
  readonly maxSessions: number
  /** Names of tmux sessions the bridge started, including ones not yet registered. */
  readonly started: readonly string[]
}

/** Outcome of a start or stop. */
export type CcOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: 'invalid_request' | 'limit_reached' | 'not_found' | 'start_failed' | 'stop_failed'; readonly detail?: string }
