/**
 * Claude Code of the service account, as `fork-cc-admin` provides it (`ctx.forkClaudeCode`). This page reads it through the
 * shape below instead of importing that package, so the browser-facing package carries no runtime import of a peer; a deployment
 * without the service shows the cards as not loaded.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ActionErrorCode, CcView } from './views.ts'

/** Outcome of a start or stop. */
export type CcOutcome = { readonly ok: true } | { readonly ok: false; readonly error: ActionErrorCode; readonly detail?: string }

/** What the page uses of `ctx.forkClaudeCode`. */
export interface ClaudeCodeService {
  /** Whether the service is switched on. */
  readonly enabled: boolean
  /** Live sessions, the tmux sessions it started, and the login state. */
  view(): Promise<CcView>
  /** Start a session with an optional first task. */
  start(name: string, task: string | undefined): Promise<CcOutcome>
  /** Stop a session it started. */
  stop(name: string): Promise<CcOutcome>
}

/**
 * Look up the Claude Code admin service on the Host context.
 * @param ctx - Host context.
 * @returns the service, or undefined when `fork-cc-admin` is not mounted.
 */
export function claudeCodeOf(ctx: Context): ClaudeCodeService | undefined {
  const found = (ctx.get as (name: string) => unknown)('forkClaudeCode')
  return typeof found === 'object' && found !== null ? found as ClaudeCodeService : undefined
}
