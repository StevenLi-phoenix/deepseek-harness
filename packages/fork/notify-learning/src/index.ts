/**
 * Notification rules learned from the owner's reactions. The agent tells the owner things on its own (notices,
 * reminders, watch and monitor reports); how the owner answers those messages says how that kind of message should reach
 * them. The root row (`mode: learn`) keeps each message that went out on the owner's chat channel with the owner's next
 * turns, reads them once a night with one model call, and learns a rule (`CI 失败通知 → silent`) only when the owner's own
 * words in two separate exchanges agree. The rules enter the prompt of each turn the owner did not start, as data, and
 * every change reaches the owner as a notice. A preset row (`mode: tools`) mounts `notify_rules` and
 * `notify_rules_forget`, so the owner can ask what was learned and delete a rule.
 *
 * @module @deepseek-ai/dsh-notify-learning
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
// Type-only: the compaction events' SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: ctx.sessionProjections.
import type {} from '@deepseek-ai/dsh-session-projection'
import { triggerOf } from '@deepseek-ai/dsh-turn-taint/origin'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { REVISION_TAG } from './render.ts'
import { NotifyLearning } from './service.ts'
import { LearningStore } from './store.ts'
import { registerRuleTools } from './tools.ts'

export type { Clue, Decision, Evidence, Exchange, HistoryRecord, LearnState, Reply, Rule } from './records.ts'
export type { LearnLimits, MergeResult, RejectedSignal, Signal } from './learn.ts'
export type { LearningSettings, PassReport, RulesBlock } from './service.ts'
export type { ExchangeLimits } from './store.ts'
export { LearningFileError } from './store.ts'
export { SignalsAnswerError } from './learn.ts'
export { NotifyLearning } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The learner of notification rules: the rules, their block, the owner's deletion, and the nightly pass. */
    notifyLearning: NotifyLearning
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The rules block and the nightly pass's request.
     * @persistenceAttribution
     */
    'notify-learning': { kind: 'notify-learning' } & ContextFormed
  }
}

/** Plugin name; also the source kind of the rules block. */
export const name = 'notify-learning'

/** Plugin configuration. */
export interface Config {
  /**
   * `learn` (at the root): the capture, the nightly pass, the rules block, `ctx.notifyLearning`.
   * `tools` (inside a preset): the rule tools.
   */
  mode: 'learn' | 'tools'
  /** Learn mode: `false` stops the capture and the passes and keeps the rules out of every prompt; the files stay. */
  enabled: boolean
  /** Learn mode: directory of `exchanges.json`, `rules.json`, `history.jsonl`, `raw/`; defaults to `<DSH_HOME>/notify-learning`. */
  dir?: string
  /** Learn mode: owner relay channel whose Sessions' answers reach the owner. */
  channel: string
  /** Learn mode: agent presets whose proactive turns get the rules block. */
  presets: string[]
  /** Learn mode: presets among `presets` that mount the tools row, so their block names the tools. */
  toolPresets: string[]
  /** Learn mode: IANA zone of the pass's day and hour and of the notice's dates. */
  timeZone: string
  /** Learn mode: local hour at or after which the day's pass runs. */
  hour: number
  /** Learn mode: hours after a message during which the owner's turns count as reactions to it. */
  windowHours: number
  /** Learn mode: owner turns kept per message. */
  maxReplies: number
  /** Learn mode: messages kept open at most. */
  maxExchanges: number
  /** Learn mode: messages one pass reads at most. */
  maxBatch: number
  /** Learn mode: different exchanges that must agree before a rule is learned. */
  minExchanges: number
  /** Learn mode: days a reaction counts toward a rule. */
  clueDays: number
  /** Learn mode: rules kept at most. */
  maxRules: number
  /** Learn mode: clues kept at most. */
  maxClues: number
  /** Learn mode: owner quotes kept per rule. */
  maxEvidence: number
  /** Learn mode: tell the owner what a pass changed. */
  notify: boolean
  /** Learn mode: provider of the pass's model call; with `model`, replaces the profile's default route. */
  provider?: string
  /** Learn mode: model of the pass's call. */
  model?: string
  /** Learn mode: output tokens of the pass's call at most. */
  maxOutputTokens: number
  /** Learn mode: raw model answers kept. */
  rawKept: number
}

/** Configuration schema. */
export const Config: z<Partial<Config>, Config> = z.object({
  mode: z.union(['learn', 'tools']).default('learn').description('`learn` at the root; `tools` inside a preset for notify_rules and notify_rules_forget.'),
  enabled: z.boolean().default(true).description('Capture, learn, and show the rules; off keeps the files.'),
  dir: z.string().description('Absolute directory of the learner\'s files; defaults to <DSH_HOME>/notify-learning.'),
  channel: z.string().default('wechat').description('Owner relay channel whose Sessions\' answers reach the owner.'),
  presets: z.array(z.string()).default(['unattended', 'notify']).description('Agent presets whose turns the owner did not start get the rules block.'),
  toolPresets: z.array(z.string()).default(['unattended']).description('Presets that mount the tools row, so their block names notify_rules and notify_rules_forget.'),
  timeZone: z.string().default('America/New_York').description('IANA time zone of the nightly pass and of the notice\'s dates.'),
  hour: z.natural().max(23).default(5).description('Local hour at or after which the day\'s pass runs (5 = 05:00, while the owner sleeps).'),
  windowHours: z.natural().min(1).default(12).description('Hours after a message during which the owner\'s turns count as reactions to it.'),
  maxReplies: z.natural().min(1).default(3).description('Owner turns kept per message.'),
  maxExchanges: z.natural().min(1).default(100).description('Messages kept open for a reaction at most; the oldest go first.'),
  maxBatch: z.natural().min(1).default(30).description('Messages one nightly pass reads at most; the rest wait for the next night.'),
  minExchanges: z.natural().min(2).default(2).description('Separate exchanges whose reactions must agree before a rule is learned.'),
  clueDays: z.natural().min(1).default(14).description('Days a reaction counts toward a rule.'),
  maxRules: z.natural().min(1).default(20).description('Rules kept; past it the rule with the oldest evidence goes.'),
  maxClues: z.natural().min(1).default(40).description('Reactions waiting for agreement kept, by kind and decision.'),
  maxEvidence: z.natural().min(2).default(5).description('Owner quotes kept per rule.'),
  notify: z.boolean().default(true).description('Tell the owner on WeChat what a pass changed.'),
  provider: z.string().description('Provider of the nightly call; with model, replaces the profile\'s default route.'),
  model: z.string().description('Model of the nightly call.'),
  maxOutputTokens: z.natural().min(256).default(2000).description('Output tokens of the nightly call at most.'),
  rawKept: z.natural().min(1).default(30).description('Raw model answers kept under raw/.'),
})

/** Longest kind and quote, in characters; the system prompt names the same numbers. */
const KIND_CHARS = 40
const QUOTE_CHARS = 120

/** Delay before the first check after start, and the interval of the checks. */
const FIRST_CHECK_MS = 120_000
const CHECK_MS = 10 * 60_000

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (config.dir !== undefined && !isAbsolute(config.dir)) throw new Error('notify-learning: dir must be an absolute path')
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('notify-learning: provider and model must be set together, or both left to the default route')
  }
  if (config.minExchanges > config.maxEvidence) throw new Error('notify-learning: minExchanges must not exceed maxEvidence')
  const unknown = config.toolPresets.filter(preset => !config.presets.includes(preset))
  if (unknown.length > 0) throw new Error(`notify-learning: toolPresets ${unknown.join(', ')} are not in presets`)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch (error: unknown) {
    throw new Error(`notify-learning: timeZone "${config.timeZone}" is not a valid IANA time zone`, { cause: error })
  }
}

/** The revision of the block a Session last got; a compaction may summarize it away, so it clears the mark. */
const shownSchema = zod.object({ revision: zod.number().int().nullable() })

/**
 * Put the rules block before the first step of a turn that only inputs other than the owner's started, in Sessions of
 * the listed presets that were not given the current revision since their last compaction.
 * @param ctx - the root context, with `ctx.sessionProjections`.
 * @param service - the learner.
 * @param config - the presets.
 * @returns once the projection is registered.
 */
async function mountBlock(ctx: Context, service: NotifyLearning, config: Config): Promise<void> {
  const presets = new Set(config.presets)
  const toolPresets = new Set(config.toolPresets)
  const shown = ctx.sessionProjections.register({
    key: 'notifyLearningBlock',
    stateVersion: 1,
    stateSchema: shownSchema,
    init: () => ({ revision: null }),
    apply: (state, event) => {
      if (event.type === 'user/message' && event.data.source.kind === name) {
        const [block] = event.data.content
        const revision = block?.type === 'text' ? REVISION_TAG.exec(block.text)?.[1] : undefined
        return revision === undefined ? state : { revision: Number(revision) }
      }
      if (event.type === 'compaction/end' && event.data.error === undefined && state.revision !== null) return { revision: null }
      return state
    },
  })
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const projection = await shown
    const decision = await next()
    const session = agent.session
    const preset = session.header.agentPreset ?? ''
    if (decision.kind === 'reject' || signal.aborted || step !== 1
      || session.header.origin === 'subagent' || !presets.has(preset)) return decision
    const labels = decision.messages.filter(message => messages.includes(message)).flatMap((message) => {
      const label = triggerOf(message.source)
      return label === undefined ? [] : [label]
    })
    if (labels.length === 0 || labels.some(label => label === 'owner' || label === 'guest')) return decision
    let block
    try {
      block = await service.block(toolPresets.has(preset))
    } catch (error: unknown) {
      ctx.logger.warn('notify-learning: rules not loaded for Session %s: %s', session.id, error instanceof Error ? error.message : String(error))
      return decision
    }
    if (block === undefined || projection.stateOf(session).revision === block.revision) return decision
    ctx.logger.info('notify-learning: rules block (revision %d, %d bytes) entered Session %s before a %s turn', block.revision, Buffer.byteLength(block.text), session.id, [...new Set(labels)].join('+'))
    const message = createUserMessage({ content: [{ type: 'text', text: block.text }], source: { kind: name, form: 'instructions' } })
    const lastClaimed = decision.messages.findLastIndex(candidate => messages.includes(candidate))
    return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, message) }
  })
  await shown
}

/**
 * Learn mode: the service, the capture, the block, and the nightly checks.
 * @param ctx - the root context.
 * @param config - resolved configuration.
 */
function applyLearn(ctx: Context, config: Config): void {
  const dir = config.dir ?? join(resolveDshHome(), 'notify-learning')
  const store = new LearningStore(dir, (error) => {
    ctx.logger.warn('notify-learning: capture write failed: %s', error instanceof Error ? error.message : String(error))
  })
  const service = new NotifyLearning(ctx, {
    enabled: config.enabled, channel: config.channel, timeZone: config.timeZone, hour: config.hour, notify: config.notify,
    windowHours: config.windowHours, maxReplies: config.maxReplies, maxExchanges: config.maxExchanges, maxBatch: config.maxBatch,
    minExchanges: config.minExchanges, clueDays: config.clueDays, maxRules: config.maxRules, maxClues: config.maxClues,
    maxEvidence: config.maxEvidence, kindChars: KIND_CHARS, quoteChars: QUOTE_CHARS,
    provider: config.provider, model: config.model, maxOutputTokens: config.maxOutputTokens, rawKept: config.rawKept,
  }, store)
  ctx.logger.info('notify-learning: %s, channel %s, pass at %s:00 %s, rule after %d agreeing exchanges, files in %s',
    config.enabled ? 'on' : 'off', config.channel, String(config.hour).padStart(2, '0'), config.timeZone, config.minExchanges, dir)
  // ctx.provide is itself an effect: the service goes when this plugin unloads.
  ctx.provide('notifyLearning', service)
  ctx.effect(() => async () => { await service.dispose() }, 'notify-learning: stop the pass and drain writes')
  ctx.on('session/event', (session, event) => { service.observe(session, event) })
  ctx.inject(['sessionProjections'], scope => mountBlock(scope, service, config))
  const check = (): void => {
    void service.runIfDue().catch((error: unknown) => {
      ctx.logger.warn('notify-learning: nightly pass failed (tried again in an hour, at most three times a day): %s', error instanceof Error ? error.message : String(error))
    })
  }
  ctx.effect(() => {
    const first = setTimeout(check, FIRST_CHECK_MS)
    const timer = setInterval(check, CHECK_MS)
    first.unref()
    timer.unref()
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, 'notify-learning: nightly checks')
}

/**
 * Apply the plugin in its mode.
 * @param ctx - the root context (learn mode) or a preset's scope (tools mode).
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  if (config.mode === 'tools') {
    ctx.logger.info('notify-learning: tools row (notify_rules, notify_rules_forget)')
    ctx.inject(['tools'], (scope) => { registerRuleTools(scope, () => ctx.get('notifyLearning')) })
    return
  }
  applyLearn(ctx, config)
}
