/**
 * `ctx.notifyLearning`: the capture's writes, the nightly pass, the rules block, and the owner's deletion. The pass runs
 * once a local day, at or after the configured hour: it reads the exchanges whose reaction window has closed, makes one
 * model call, keeps the raw answer before reading it, merges what code accepts, and tells the owner what changed. A
 * failed call keeps the exchanges and is tried again an hour later, at most three times a day.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-event-bus'
import { callModelOnce } from '@deepseek-ai/dsh-service-kit'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-owner-relay'
import { Capture } from './capture.ts'
import { checkSignals, LEARN_SYSTEM, learnRequest, mergeSignals, parseSignals, type LearnLimits, type RejectedSignal } from './learn.ts'
import type { Exchange, LearnState, Rule } from './records.ts'
import { changeNotice, renderRulesBlock } from './render.ts'
import { LearningStore, type ExchangeLimits } from './store.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'notify-learning': true
  }
}

/** Failed passes tried in one local day. */
const MAX_ATTEMPTS = 3
/** Wait after a failed pass before the next try. */
const RETRY_MS = 3_600_000

/** The settings the service runs by. */
export interface LearningSettings extends LearnLimits, ExchangeLimits {
  /** Capture, learn, and show rules at all. */
  readonly enabled: boolean
  /** The owner relay channel whose Sessions count. */
  readonly channel: string
  /** IANA zone of the pass's day and hour and of the notice's dates. */
  readonly timeZone: string
  /** Local hour at or after which the day's pass runs. */
  readonly hour: number
  /** Exchanges one pass reads at most, oldest first. */
  readonly maxBatch: number
  /** Tell the owner what a pass changed. */
  readonly notify: boolean
  /** Explicit model route; the profile's default route when either is unset. */
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly maxOutputTokens: number
  /** Raw answers kept. */
  readonly rawKept: number
}

/** What one pass did. */
export type PassReport =
  | { readonly outcome: 'nothing'; readonly dropped: number }
  | {
    readonly outcome: 'learned'
    readonly read: number
    readonly dropped: number
    readonly accepted: number
    readonly rejected: readonly RejectedSignal[]
    readonly added: readonly Rule[]
    readonly removed: readonly Rule[]
    readonly model: string
  }

/** The rules block and the revision it shows. */
export interface RulesBlock {
  readonly revision: number
  readonly text: string
}

/**
 * The local day and hour of a time.
 * @param date - the time.
 * @param timeZone - an IANA zone.
 * @returns `YYYY-MM-DD` and the hour, 0 to 23.
 */
export function localClock(date: Date, timeZone: string): { day: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]))
  return { day: `${String(parts.year)}-${String(parts.month)}-${String(parts.day)}`, hour: Number(parts.hour) }
}

/** The learner of notification rules. */
export class NotifyLearning {
  readonly #capture: Capture
  readonly #abort = new AbortController()
  #running: Promise<PassReport> | undefined

  /**
   * @param ctx - the root context: the logger, `ctx.ownerRelay`, `ctx.ownerNotifier`, and the LLM service.
   * @param settings - the resolved settings.
   * @param store - the learner's files.
   */
  constructor(private readonly ctx: Context, readonly settings: LearningSettings, readonly store: LearningStore) {
    this.#capture = new Capture(settings.channel, id => ctx.get('ownerRelay')?.ownerOf(id), {
      output: (exchange) => {
        store.track(store.addExchange(exchange, settings).then(() => {
          ctx.logger.info('notify-learning: kept %s from Session %s (%s, %d chars) for the owner\'s reaction', exchange.id, exchange.session, exchange.trigger, exchange.sent.length)
        }))
      },
      reply: (reply) => {
        store.track(store.addReply(reply, settings).then((taken) => {
          if (taken > 0) ctx.logger.info('notify-learning: the owner\'s turn (%d chars) follows %d open message(s)', reply.owner.length, taken)
        }))
      },
    })
  }

  /**
   * Take one committed Session event; nothing while learning is off.
   * @param session - the Session.
   * @param event - the event.
   */
  observe(session: Session, event: SessionEvent): void {
    if (this.settings.enabled) this.#capture.observe(session, event)
  }

  /**
   * The rules, newest first, and their revision.
   * @returns them.
   * @throws when `rules.json` is damaged.
   */
  async rules(): Promise<{ revision: number; rules: readonly Rule[] }> {
    const state = await this.store.state()
    return { revision: state.revision, rules: state.rules }
  }

  /**
   * The rules block for a proactive turn.
   * @param tools - whether the Session has the rule tools.
   * @returns the block; undefined while learning is off or no rule exists.
   * @throws when `rules.json` is damaged.
   */
  async block(tools: boolean): Promise<RulesBlock | undefined> {
    if (!this.settings.enabled) return undefined
    const { revision, rules } = await this.rules()
    const text = renderRulesBlock(revision, rules, tools)
    return text === undefined ? undefined : { revision, text }
  }

  /**
   * Delete one rule; the owner asked for it.
   * @param id - the rule's id.
   * @returns the deleted rule, or undefined when no rule has the id.
   */
  async forget(id: string): Promise<Rule | undefined> {
    let forgotten: Rule | undefined
    await this.store.update((state) => {
      forgotten = state.rules.find(rule => rule.id === id)
      if (forgotten === undefined) return undefined
      const next: LearnState = { ...state, revision: state.revision + 1, rules: state.rules.filter(rule => rule !== forgotten) }
      return { state: next, history: { at: new Date().toISOString(), revision: next.revision, by: 'owner', added: [], removed: [forgotten] } }
    })
    if (forgotten !== undefined) this.ctx.logger.info('notify-learning: the owner deleted rule %s (%s)', forgotten.id, forgotten.decision)
    return forgotten
  }

  /**
   * Run the day's pass when it is due: learning is on, the local hour has come, no pass finished today, and fewer than
   * three passes failed today, the last one more than an hour ago.
   * @param now - the time.
   * @returns the report, or undefined when nothing was due.
   */
  async runIfDue(now = new Date()): Promise<PassReport | undefined> {
    if (!this.settings.enabled || this.#running !== undefined) return undefined
    const { day, hour } = localClock(now, this.settings.timeZone)
    const state = await this.store.state()
    if (hour < this.settings.hour || state.lastRunDay === day) return undefined
    const { attempts } = state
    if (attempts?.day === day && (attempts.count >= MAX_ATTEMPTS || now.getTime() - Date.parse(attempts.at) < RETRY_MS)) return undefined
    try {
      return await this.run(now)
    } catch (error: unknown) {
      await this.store.update((current) => {
        const count = (current.attempts?.day === day ? current.attempts.count : 0) + 1
        return { state: { ...current, attempts: { day, count, at: now.toISOString() } } }
      })
      throw error
    }
  }

  /**
   * Run one pass now, whatever the hour.
   * @param now - the time.
   * @returns what it did.
   * @throws when the model call fails or its answer is not the JSON asked for; the exchanges stay for the next try.
   */
  run(now = new Date()): Promise<PassReport> {
    this.#running ??= this.pass(now).finally(() => { this.#running = undefined })
    return this.#running
  }

  /**
   * Stop a running pass's model call and wait for it and for every queued write.
   * @returns resolves once all of it settled.
   */
  async dispose(): Promise<void> {
    this.#abort.abort()
    await this.#running?.catch(() => undefined)
    await this.store.drain()
  }

  private async pass(now: Date): Promise<PassReport> {
    const { settings, ctx } = this
    const { day } = localClock(now, settings.timeZone)
    const closed = (exchange: Exchange): boolean =>
      exchange.replies.length >= settings.maxReplies || now.getTime() - Date.parse(exchange.at) >= settings.windowHours * 3_600_000
    const [state, exchanges] = await Promise.all([this.store.state(), this.store.exchanges()])
    const done = exchanges.filter(closed)
    const silent = done.filter(exchange => exchange.replies.length === 0)
    const batch = done.filter(exchange => exchange.replies.length > 0).slice(0, settings.maxBatch)
    const finished = new Set([...silent, ...batch].map(exchange => exchange.id))
    if (batch.length === 0) {
      await this.store.update((current, open) => ({
        state: { ...current, lastRunDay: day, attempts: undefined },
        exchanges: open.filter(exchange => !finished.has(exchange.id)),
      }))
      ctx.logger.info('notify-learning: pass of %s: no replies to read; %d message(s) without one dropped', day, silent.length)
      return { outcome: 'nothing', dropped: silent.length }
    }
    const answer = await callModelOnce(ctx, {
      provider: settings.provider, model: settings.model, maxOutputTokens: settings.maxOutputTokens,
      noRoute: 'no model route: set provider and model, or mount agentDefaultModel',
    }, {
      system: LEARN_SYSTEM, user: learnRequest(state, batch), source: { kind: 'notify-learning' }, purpose: 'notify-learning', signal: this.#abort.signal,
    })
    await this.store.saveRaw(now.toISOString(), { model: answer.model, text: answer.text, raw: answer.raw }, settings.rawKept)
    const { accepted, rejected } = checkSignals(batch, parseSignals(answer.text), settings)
    const merged = await this.store.update((current, open) => {
      const result = mergeSignals(current, accepted, now, settings)
      const changed = result.added.length > 0 || result.removed.length > 0
      return {
        ...result,
        state: { ...result.state, lastRunDay: day, attempts: undefined },
        exchanges: open.filter(exchange => !finished.has(exchange.id)),
        ...changed ? { history: { at: now.toISOString(), revision: result.state.revision, by: 'nightly' as const, added: [...result.added], removed: [...result.removed], model: answer.model } } : {},
      }
    })
    ctx.logger.info('notify-learning: pass of %s on %s read %d exchange(s): %d signal(s) taken, %d refused (%s), %d rule(s) added, %d removed, revision %d',
      day, answer.model, batch.length, accepted.length, rejected.length, rejected.map(item => item.why).join(',') || 'none', merged.added.length, merged.removed.length, merged.state.revision)
    await this.announce(merged.added, merged.removed)
    return { outcome: 'learned', read: batch.length, dropped: silent.length, accepted: accepted.length, rejected, added: merged.added, removed: merged.removed, model: answer.model }
  }

  /** Tell the owner what changed, as written: a change to what the owner hears is a safety notice, never a turn. */
  private async announce(added: readonly Rule[], removed: readonly Rule[]): Promise<void> {
    const notice = this.settings.notify ? changeNotice(added, removed, this.settings.timeZone) : undefined
    if (notice === undefined) return
    const notifier = this.ctx.get('ownerNotifier')
    if (notifier === undefined) {
      this.ctx.logger.warn('notify-learning: no owner notifier; the owner was not told of %d new and %d dropped rule(s)', added.length, removed.length)
      return
    }
    await notifier.send({ ...notice, safety: true, origin: 'the notification-rule learner (its nightly pass)' })
  }
}
