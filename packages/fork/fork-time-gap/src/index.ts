/**
 * Time check for every Session. When an incoming input (a prompt, a bus or webhook event, monitor
 * output, a reminder) starts a turn after at least `thresholdMs` of silence, the model reads a short
 * notice just before it: the current time and zone, how long the Session was quiet, when the last
 * exchange was, and that the input is to be read on its own terms with outside state checked again.
 *
 * The notice is an ordinary sourced `user/message` (`form: 'notice'`) added to the turn's first
 * step, after the cached history; the system prompt never changes. Chat shows it as a collapsed
 * context row, not as a message the owner wrote.
 *
 * @module @deepseek-ai/dsh-fork-time-gap
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-owner-relay'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { formatGap } from './format.ts'
import { classifyArrival, incomingKind, measureGap, timeGapNotice, timeGapSummary } from './notice.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'fork-time-gap': { kind: 'fork-time-gap' } & ContextFormed
  }
}

export { formatGap, formatStamp } from './format.ts'
export { classifyArrival, incomingKind, measureGap, timeGapNotice, timeGapSummary } from './notice.ts'
export type { Activity, Arrival, Gap, IncomingKind } from './notice.ts'

/** Plugin name; also the source kind of the notice. */
export const name = 'fork-time-gap'

/** Pre-step listeners and the Session projection the gap is read from. */
export const inject = ['agents', 'sessionProjections']

/** Settings, edited in Settings → 订阅与监控 through the All settings card. */
export interface Config {
  /** Add the notice at all. */
  enabled: boolean
  /** Shortest silence, in milliseconds, after which an incoming input gets the notice. */
  thresholdMs: number
  /** IANA zone of the times in the notice. */
  timeZone: string
  /** Presets whose Sessions never get the notice. */
  excludePresets: string[]
  /** Presets whose prompts carry someone else's words (a channel bot), so the notice says "the sender". */
  senderPresets: string[]
  /** Owner-relay channels that write their own time check before the owner's messages in the Sessions they claim. */
  deferChannels: string[]
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('Add the time check before an input that arrives after a quiet spell.'),
  thresholdMs: z.natural().min(1).default(300_000).description('Shortest silence in milliseconds (300000 = 5 minutes) that counts as a quiet spell.'),
  timeZone: z.string().default('America/New_York').description('IANA time zone of the times in the notice.'),
  excludePresets: z.array(z.string()).default(['qq-digest']).description('Agent presets whose Sessions never get the notice.'),
  senderPresets: z.array(z.string()).default(['qqbot']).description('Agent presets whose prompts carry someone else\'s words; the notice calls them "the sender", not "the owner".'),
  deferChannels: z.array(z.string()).default(['wechat']).description('Owner-relay channels that write their own time check before the owner\'s messages (WeChat: fork-wechat timeGapMs).'),
})

const activitySchema = zod.object({
  lastIncomingAt: zod.number().nullable(),
  lastReplyAt: zod.number().nullable(),
})

/**
 * Register the projection and the pre-step listener.
 * @param ctx - the root context; the listener sees every agent's steps.
 * @param config - validated settings.
 * @throws when `timeZone` is not an IANA zone the runtime knows.
 * @returns when the projection is registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch (error: unknown) {
    throw new Error(`fork-time-gap: timeZone ${JSON.stringify(config.timeZone)} is not a known IANA zone`, { cause: error })
  }
  if (!config.enabled) {
    ctx.logger.info('fork-time-gap: off')
    return
  }
  const excluded = new Set(config.excludePresets)
  const senderPresets = new Set(config.senderPresets)
  const deferred = new Set(config.deferChannels)
  ctx.logger.info('fork-time-gap: notice after %s of silence (%s); presets excluded: %s; sender presets: %s; channels with their own check: %s',
    formatGap(config.thresholdMs), config.timeZone, [...excluded].join(', ') || 'none', [...senderPresets].join(', ') || 'none', [...deferred].join(', ') || 'none')

  const projectionReady = ctx.sessionProjections.register({
    key: 'forkTimeGap',
    stateVersion: 1,
    stateSchema: activitySchema,
    init: () => ({ lastIncomingAt: null, lastReplyAt: null }),
    apply: (state, event) => {
      if (event.type === 'assistant/message') return state.lastReplyAt === event.time ? state : { ...state, lastReplyAt: event.time }
      if (event.type === 'user/message' && incomingKind(event.data.source) !== undefined) {
        return state.lastIncomingAt === event.time ? state : { ...state, lastIncomingAt: event.time }
      }
      return state
    },
  })

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const projection = await projectionReady
    ctx.fiber.assertActive()
    const decision = await next()
    // Only the first step of a turn: a steered message joins a running turn, which is not a silence.
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    const session = agent.session
    if (session.header.origin === 'subagent') return decision
    const preset = session.header.agentPreset
    if (preset !== undefined && excluded.has(preset)) return decision
    if (decision.messages.some(message => message.source.kind === name)) return decision
    const index = decision.messages.findIndex(message => messages.includes(message) && incomingKind(message.source) !== undefined)
    const incoming = decision.messages[index]
    const arrival = incoming === undefined ? undefined : classifyArrival(incoming.source, preset, senderPresets)
    if (arrival === undefined) return decision
    if (arrival === 'owner') {
      const channel = ctx.get('ownerRelay')?.ownerOf(session.id)
      if (channel !== undefined && deferred.has(channel)) {
        ctx.logger.debug('fork-time-gap: Session %s belongs to %s, which writes its own time check', session.id, channel)
        return decision
      }
    }
    const now = Date.now()
    const gap = measureGap(now, projection.stateOf(session), config.thresholdMs)
    if (gap === undefined) return decision
    const notice = createUserMessage({
      content: [{ type: 'text', text: timeGapNotice(arrival, now, gap, config.timeZone) }],
      source: { kind: name, form: 'notice', summary: timeGapSummary(gap) },
    })
    ctx.logger.info('fork-time-gap: Session %s, %s input after %s of silence', session.id, arrival, formatGap(gap.gapMs))
    return { ...decision, messages: decision.messages.toSpliced(index, 0, notice) }
  })
  await projectionReady
}
