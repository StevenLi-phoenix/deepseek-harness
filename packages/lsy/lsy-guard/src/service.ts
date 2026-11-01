/**
 * `ctx.lsyGuard`: one content validator for every writer of shared or public text. Four layers run in order and the
 * first refusal ends the check: patterns, canaries, overlap with the owner's memory, and a model. A layer that fails
 * to run refuses too. A refusal carries a rule name and a generic reason, never the text or what matched.
 */

import { existsSync } from 'node:fs'
import { MemoryStore } from '@deepseek-ai/dsh-lsy-memory'
import {
  GUARD_PROMPT_VERSION, GUARD_SYSTEM_PROMPT, guardUserMessage, parseGuardAnswer, rawId, RawStore, sha256,
  type GuardModel, type ParsedAnswer,
} from './classifier.ts'
import { CanarySet } from './canary.ts'
import { scanPatterns } from './patterns.ts'
import type { GuardAudience, GuardCheckOptions, GuardHealth, GuardVerdict } from './types.ts'

/** The slice of a logger the service uses. */
export interface GuardLogger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

/** Resolved settings of the service. */
export interface GuardSettings {
  readonly layers: { readonly patterns: boolean; readonly canary: boolean; readonly memory: boolean; readonly llm: boolean }
  readonly blockLinks: boolean
  readonly timeoutMs: number
  readonly maxChars: number
  readonly cacheMs: number
}

/** What the service is built from; the parts are injectable for tests. */
export interface GuardDeps {
  readonly settings: GuardSettings
  readonly canaries: CanarySet
  readonly memory: MemoryStore
  readonly model: GuardModel
  readonly raw: RawStore
  readonly logger: GuardLogger
  readonly now?: () => number
  /** Reads the model's answer; injectable so a test can make parsing fail. */
  readonly parse?: (text: string) => ParsedAnswer | undefined
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const MAX_CACHE = 2000
const PURPOSE = /^[a-z0-9][a-z0-9_.-]{0,39}$/u

/** What the model layer decided, as cached. */
type ModelOutcome = { readonly kind: 'verdict'; readonly verdict: GuardVerdict } | { readonly kind: 'error'; readonly rule: string; readonly message: string }

const refuse = (rule: string, publicReason: string): GuardVerdict => ({ ok: false, rule, publicReason })

const ERRORS: Record<string, string> = {
  'canary.unavailable': 'The check could not run, so the text is held back.',
  'memory.unavailable': 'The check could not run, so the text is held back.',
  'pattern.error': 'The check could not run, so the text is held back.',
  'llm.unavailable': 'The review could not run, so the text is held back.',
}

/** The validator. */
export class GuardService {
  private readonly cache = new Map<string, { readonly verdict: GuardVerdict; readonly until: number }>()
  private readonly inflight = new Map<string, Promise<ModelOutcome>>()
  private readonly events: Array<{ at: number; ok: boolean; rule: string }> = []
  private lastError: GuardHealth['lastError'] = null
  private lastCheckAt: number | null = null
  private warnedPublicLlm = false
  private warnedNoMemory = false
  private readonly now: () => number
  private readonly parse: (text: string) => ParsedAnswer | undefined

  constructor(private readonly deps: GuardDeps) {
    this.now = deps.now ?? Date.now
    this.parse = deps.parse ?? parseGuardAnswer
  }

  /**
   * Check a text before it is written where others can read it.
   * @param text - the text as it would be written.
   * @param options - purpose, audience, and the Session that wrote it.
   * @returns `{ ok: true }`, or the rule that refused it and a reason that never repeats the text. Never rejects.
   */
  async check(text: string, options: GuardCheckOptions): Promise<GuardVerdict> {
    const started = this.now()
    const stats = { cache: false }
    let verdict: GuardVerdict
    try {
      verdict = await this.run(text, options, stats)
    } catch (error: unknown) {
      // Nothing above should throw; if it does the text is held back.
      verdict = this.failed('guard.error', error)
    }
    const at = this.now()
    this.lastCheckAt = at
    this.events.push({ at, ok: verdict.ok, rule: verdict.ok ? '' : verdict.rule })
    this.trim(at)
    this.deps.logger.info(
      'lsy-guard: check purpose=%s audience=%s verdict=%s rule=%s text=%s ms=%d cache=%s%s',
      safeLabel(options.purpose), options.audience, verdict.ok ? 'ok' : 'rejected', verdict.ok ? '-' : verdict.rule, sha256(text).slice(0, 12), at - started,
      stats.cache ? 'hit' : 'miss', options.sessionId === undefined ? '' : ` session=${options.sessionId}`,
    )
    return verdict
  }

  /**
   * Counts for the Settings overview, last 24 hours, without any text.
   * @returns checks, refusals by rule, the last layer failure, and the latest check.
   */
  health(): GuardHealth {
    this.trim(this.now())
    const byRule: Record<string, number> = {}
    let rejected = 0
    for (const event of this.events) {
      if (event.ok) continue
      rejected += 1
      byRule[event.rule] = (byRule[event.rule] ?? 0) + 1
    }
    return { checked: this.events.length, rejected, byRule, lastError: this.lastError, lastCheckAt: this.lastCheckAt }
  }

  private trim(now: number): void {
    const cutoff = now - DAY_MS
    let drop = 0
    while (drop < this.events.length && (this.events[drop]?.at ?? Infinity) < cutoff) drop += 1
    if (drop > 0) this.events.splice(0, drop)
  }

  private failed(rule: string, error: unknown): GuardVerdict {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 200)
    this.lastError = { at: this.now(), rule, message }
    this.deps.logger.warn('lsy-guard: %s: %s', rule, message)
    return refuse(rule, ERRORS[rule] ?? 'The check could not run, so the text is held back.')
  }

  private async run(text: string, options: GuardCheckOptions, stats: { cache: boolean }): Promise<GuardVerdict> {
    const { settings } = this.deps
    const audience: string = options.audience
    if (typeof text !== 'string' || !PURPOSE.test(options.purpose) || (audience !== 'public' && audience !== 'channel')) {
      return refuse('guard.bad_input', 'The check needs a text, a purpose, and an audience.')
    }
    if (Array.from(text).length > settings.maxChars) return refuse('guard.too_long', 'The text is too long to check.')
    if (text.trim() === '') return { ok: true }

    if (settings.layers.patterns) {
      try {
        const hit = scanPatterns(text, { blockLinks: settings.blockLinks })
        if (hit !== undefined) return refuse(hit.rule, hit.publicReason)
      } catch (error: unknown) {
        return this.failed('pattern.error', error)
      }
    }
    if (settings.layers.canary) {
      try {
        if (await this.deps.canaries.matches(text)) return refuse('canary', 'The text contains a string that must stay private.')
      } catch (error: unknown) {
        return this.failed('canary.unavailable', error)
      }
    }
    if (settings.layers.memory) {
      if (!this.warnedNoMemory && !existsSync(this.deps.memory.file)) {
        this.warnedNoMemory = true
        this.deps.logger.info('lsy-guard: no memory file at %s, so the memory layer has nothing to compare against until lsy-memory writes one', this.deps.memory.file)
      }
      try {
        if (await this.deps.memory.containsSpanOf(text)) return refuse('memory_overlap', 'The text repeats something the agent knows about its owner.')
      } catch (error: unknown) {
        return this.failed('memory.unavailable', error)
      }
    }
    // The model layer cannot be switched off for text anyone can read.
    if (!settings.layers.llm && options.audience !== 'public') return { ok: true }
    if (!settings.layers.llm && !this.warnedPublicLlm) {
      this.warnedPublicLlm = true
      this.deps.logger.warn('lsy-guard: layers.llm is off, but the model layer still runs for audience public')
    }
    return await this.review(text, options, stats)
  }

  private async review(text: string, options: GuardCheckOptions, stats: { cache: boolean }): Promise<GuardVerdict> {
    const key = sha256(`${text}\u0000${options.purpose}\u0000${options.audience}\u0000${GUARD_PROMPT_VERSION}`)
    const now = this.now()
    const cached = this.cache.get(key)
    if (cached !== undefined && cached.until > now) {
      stats.cache = true
      return cached.verdict
    }
    let pending = this.inflight.get(key)
    if (pending === undefined) {
      pending = this.ask(text, options, key).finally(() => { this.inflight.delete(key) })
      this.inflight.set(key, pending)
    } else {
      stats.cache = true
    }
    const outcome = await pending
    return outcome.kind === 'verdict' ? outcome.verdict : this.failed(outcome.rule, new Error(outcome.message))
  }

  private async ask(text: string, options: GuardCheckOptions, key: string): Promise<ModelOutcome> {
    const { settings } = this.deps
    const signal = AbortSignal.timeout(settings.timeoutMs)
    let answer
    try {
      const user = guardUserMessage(text, options.purpose, options.audience)
      answer = await this.deps.model({ system: GUARD_SYSTEM_PROMPT, user, signal })
    } catch (error: unknown) {
      const partial = (error as { raw?: unknown } | null)?.raw
      if (partial !== undefined) await this.save(text, options, 'unknown', partial)
      return { kind: 'error', rule: 'llm.unavailable', message: signal.aborted ? `the model call timed out after ${String(settings.timeoutMs)} ms` : error instanceof Error ? error.message : String(error) }
    }
    // The raw response is on disk before anything reads it.
    await this.save(text, options, answer.model, answer.raw)
    let parsed: ParsedAnswer | undefined
    try {
      parsed = this.parse(answer.text)
    } catch {
      parsed = undefined
    }
    if (parsed === undefined) return { kind: 'verdict', verdict: refuse('llm.unparseable', 'The review gave no usable answer, so the text is held back.') }
    const verdict: GuardVerdict = parsed.label === 'clear'
      ? { ok: true }
      : parsed.label === 'unsure'
        ? refuse('llm.unsure', 'The review could not tell whether the text is private, so it is held back.')
        : refuse(`llm.${parsed.categories[0] ?? 'pii'}`, 'The review found something that looks like private information.')
    this.remember(key, verdict)
    return { kind: 'verdict', verdict }
  }

  private async save(text: string, options: GuardCheckOptions, model: string, response: unknown): Promise<void> {
    try {
      const now = new Date(this.now())
      await this.deps.raw.save({
        id: rawId(now), at: now.toISOString(), promptVersion: GUARD_PROMPT_VERSION, purpose: options.purpose, audience: options.audience,
        textSha256: sha256(text), model, response,
      })
    } catch (error: unknown) {
      // Losing a debugging copy does not change the verdict.
      this.deps.logger.warn('lsy-guard: raw response not saved: %s', error instanceof Error ? error.message : String(error))
    }
  }

  private remember(key: string, verdict: GuardVerdict): void {
    if (this.cache.size >= MAX_CACHE) {
      const oldest = this.cache.keys().next()
      if (!oldest.done) this.cache.delete(oldest.value)
    }
    this.cache.set(key, { verdict, until: this.now() + this.deps.settings.cacheMs })
  }
}

function safeLabel(purpose: string): string {
  return PURPOSE.test(purpose) ? purpose : 'invalid'
}

export type { GuardAudience }
