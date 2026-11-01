/**
 * The shared text guard (`ctx.forkGuard`, package fork-guard) as fork-tool-up uses it. Only the call a channel note makes
 * is declared here, and the service is looked up by name, so this package builds before and without fork-guard.
 */

import type { Context } from '@deepseek-ai/cordis'

/** What the guard is asked about a text. */
export interface GuardPurpose {
  /** Why the text is written: `bili-channel-note`. */
  readonly purpose: 'bili-channel-note'
  /** Who will read it: `channel` for text kept about the channel as a whole. */
  readonly audience: 'channel'
  /** The Session that wrote it. */
  readonly sessionId: string
}

/** The guard's answer. `rule` names the rule that fired; it is logged on the host and never shown to a model. */
export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: string; readonly publicReason: string }

/** The part of `ctx.forkGuard` this package calls. */
export interface TextGuard {
  check(text: string, purpose: GuardPurpose): Promise<GuardVerdict>
}

/**
 * The guard service, when it is mounted.
 * @param ctx - any scope's context.
 * @returns the guard, or undefined without fork-guard.
 */
export function guardOf(ctx: Context): TextGuard | undefined {
  const found = (ctx as unknown as { get(name: string): unknown }).get('forkGuard')
  return typeof (found as TextGuard | undefined)?.check === 'function' ? found as TextGuard : undefined
}
