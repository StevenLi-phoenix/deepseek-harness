/**
 * The content guard as speaking-style uses it. Every text this package writes for others to read (the persona card, a
 * meme or trait note, the miner's output and meanings) goes through `ctx.contentGuard.check(text, { purpose, audience:
 * 'public', sessionId })` before it is stored. The guard is the content-guard package's optional service, looked up at
 * call time: without it every public write is refused (fail closed), with one warning. The refusal reason handed to
 * the writer is the guard's generic `publicReason`; the matched text is never echoed, and the log carries the rule
 * and a short hash of the text only.
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

/** What a caller says about a text (the content-guard package's `GuardCheckOptions`, public audience only). */
export interface GuardCheckOptions {
  readonly purpose: string
  readonly audience: 'public'
  readonly sessionId?: string | undefined
}

/** The guard's answer. */
export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: string; readonly publicReason: string }

/** The slice of `ctx.contentGuard` this package calls. */
export interface GuardLike {
  check(text: string, options: GuardCheckOptions): Promise<GuardVerdict>
}

/**
 * A service another package declares on `Context`, looked up by name without a type augmentation of its own: the
 * content-guard and bili packages declare `contentGuard` and `biliHot` themselves, and a second declaration here could
 * conflict with theirs.
 * @param ctx - the context to read from.
 * @param name - the service name.
 * @returns the service, or undefined when nothing provides it.
 */
export function optionalService(ctx: Context, name: string): object | undefined {
  const get: unknown = Reflect.get(ctx, 'get')
  if (typeof get !== 'function') return undefined
  const service: unknown = Reflect.apply(get, ctx, [name])
  return typeof service === 'object' && service !== null ? service : undefined
}

/** What a write tool says when the guard is missing or broken. */
export const GUARD_UNAVAILABLE = 'guard_unavailable'

const isGuard = (value: object | undefined): value is GuardLike => value !== undefined && 'check' in value && typeof value.check === 'function'

/** The guard seen from the style service. */
export class StyleGate {
  private warned = false

  /**
   * @param ctx - the root context; `contentGuard` is read per check.
   * @param warn - the warning sink.
   * @param info - the log sink for refusals.
   */
  constructor(
    private readonly ctx: Context,
    private readonly warn: (message: string) => void,
    private readonly info: (message: string) => void,
  ) {}

  /**
   * Ask the guard whether a text may be stored for public readers.
   * @param text - everything the write would store, joined.
   * @param purpose - `persona` (the card), `style_note`, or `meme_miner`.
   * @param sessionId - the writing Session, when there is one.
   * @returns undefined when the guard allows it, else the reason to hand back (`guard_unavailable`, or `guard: <publicReason>`).
   */
  async check(text: string, purpose: string, sessionId?: string): Promise<string | undefined> {
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 10)
    const guard = optionalService(this.ctx, 'contentGuard')
    if (!isGuard(guard)) {
      if (!this.warned) this.warn('speaking-style: ctx.contentGuard is not mounted; every public write (persona card, notes, miner) is refused until it is')
      this.warned = true
      this.info(`speaking-style: ${purpose} refused, no guard (sha256 ${digest})`)
      return GUARD_UNAVAILABLE
    }
    try {
      const verdict = await guard.check(text, { purpose, audience: 'public', ...sessionId === undefined ? {} : { sessionId } })
      if (verdict.ok) return undefined
      this.info(`speaking-style: ${purpose} refused by the guard (rule ${verdict.rule}, sha256 ${digest})`)
      return `guard: ${verdict.publicReason}`
    } catch (error: unknown) {
      this.warn(`speaking-style: the guard failed on ${purpose} (sha256 ${digest}): ${error instanceof Error ? error.message : String(error)}`)
      return GUARD_UNAVAILABLE
    }
  }
}
