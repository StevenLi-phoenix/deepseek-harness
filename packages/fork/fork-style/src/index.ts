/**
 * Speaking style learned from real people, as data. The root plugin collects short conversational exchanges from the
 * recorded QQ groups and from the comments under the owner's Bilibili videos (deterministic filters, no model), keeps
 * them in a bounded file the owner sees and edits in Settings → 说话风格, and renders a small block of them. The same
 * plugin mounted in a preset with `mode: prompt` puts that block in front of each root Session of the listed
 * presets, once a day, as quoted data that only calibrates length, rhythm, and register.
 *
 * Strangers' short lines reach the main agent's prompt this way every day, outside fork-taint's turn-origin
 * tracking; the length cap, the filters, the quoted framing, the persona's precedence, the owner's view and one-tap
 * deletion, review `required`, and `enabled: false` are the mitigations.
 *
 * @module @deepseek-ai/dsh-fork-style
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: ctx.credentials.
import type {} from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
// Type-only: ctx.forkQq, the QQ observer collection reads.
import type {} from '@deepseek-ai/dsh-fork-qq'
import type {} from '@deepseek-ai/dsh-session'
// Type-only: the compaction events' SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-compaction'
import z from '@deepseek-ai/schemastery'
import { createBiliReader } from './bili.ts'
import { StyleCollector, type BiliReader, type CollectSettings, type QqSource } from './collect.ts'
import { localDay, renderStyleBlock } from './render.ts'
import { StyleError, StyleStore } from './store.ts'
import { AnswerLog, readTrend } from './trend.ts'
import { STYLE_COLLECT_PATH, STYLE_EDIT_PATH, STYLE_PATH, type StyleEditAnswer, type StylePanel } from './view.ts'

export { biliPairs, pickForRun, qqPairs, screenPairs, StyleCollector, type Accepted, type BiliComment, type BiliReader, type Pair, type QqMessage, type QqSource } from './collect.ts'
export { createBiliReader, parseComment } from './bili.ts'
export { BUILTIN_IDENTITY_MARKERS, BUILTIN_SLURS, cleanBiliText, cleanQqText, FILTER_REASONS, screenExchange, screenLine, type FilterReason, type LineRules } from './filter.ts'
export { dayTag, localDay, renderStyleBlock, STYLE_INTRO } from './render.ts'
export { sampleId, StyleError, StyleStore, type Candidate, type StoreLimits, type StyleRecord } from './store.ts'
export { AnswerLog, readTrend } from './trend.ts'
export * from './view.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'fork-style': { kind: 'fork-style' } & ContextFormed
  }
}

/** Plugin name; also the source kind of the style message. */
export const name = 'fork-style'

/** Plugin configuration. */
export interface Config {
  /** `collect` (at the root): collection, the store, the Settings routes, and the block. `prompt` (inside a preset): injection only. */
  mode: 'collect' | 'prompt'
  /** Collect mode: `false` stops collection and keeps the block out of every prompt; the samples stay and the page still opens. */
  enabled: boolean
  /** Collect mode: directory of `samples.jsonl`, `state.json`, and `answers.json`; defaults to `<DSH_HOME>/fork-style`. */
  dir?: string
  /**
   * `optional`: strangers' samples that pass the filters go active and the owner deletes bad ones. `required`: they wait as
   * pending until the owner keeps them.
   */
  review: 'optional' | 'required'
  /** Hours between scheduled collection runs. */
  everyHours: number
  /** Longest side of a collected exchange, in characters. */
  maxChars: number
  /** Longest side of a line the owner types on the page. */
  ownerMaxChars: number
  /** Active samples in all. */
  maxActive: number
  /** Active samples of the owner's own, pinned ahead of the rest. */
  maxOwner: number
  /** Pending samples kept while review is required. */
  maxPending: number
  /** Strangers' samples one run adds at most. */
  perRun: number
  /** Strangers' samples one run takes from one group or comment thread at most. */
  perGroup: number
  /** Strangers' samples said longer ago than this many days are retired (QQ keeps raw messages 30 days). */
  maxAgeDays: number
  /** Words that identify the owner (a real name, other handles) on top of the built-in list; a line containing one is left out. */
  identityMarkers: string[]
  /** Blocked words on top of the built-in slur list. */
  blocklist: string[]
  /** QQ groups (through `ctx.forkQq`). */
  qq: {
    enabled: boolean
    /** Hours of messages read per group in one run. */
    windowHours: number
    /** Messages read per group at most. */
    maxMessages: number
    /** Longest gap, in seconds, between a message and an unquoted answer by another member. */
    gapSec: number
    /** Messages newer than this many minutes wait for the next run (a sender can recall a message for 2 minutes). */
    settleMinutes: number
  }
  /** Comments under the owner's Bilibili videos (through bili-svc's read API). */
  bili: {
    enabled: boolean
    /** bili-svc's address; unset uses `BILI_SVC_URL` or `http://127.0.0.1:8097`. */
    url?: string
    /** Credential holding a bili-svc token with the `read` scope. */
    tokenEnv: string
    /** bili-svc's id of the owner's own account (猫灯): its hand-written replies become `owner-bili`. */
    ownerAccount: string
    /** Newest comments read per run. */
    comments: number
    /** Comment threads read per run (each is one live read through bili-svc). */
    maxThreads: number
    timeoutMs: number
  }
  /** Agent presets whose root Sessions get the block. */
  presets: string[]
  /** Cap on the block, in bytes. */
  maxBytes: number
  /** Exchanges shown in the block at most. */
  maxShown: number
  /** IANA zone of the day the block rotates on. */
  timeZone: string
  /** fork-integrity's per-day stock-line counts; defaults to `<DSH_HOME>/fork-integrity/tics.json`. */
  ticsFile?: string
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  mode: z.union(['collect', 'prompt']).default('collect'),
  enabled: z.boolean().default(true),
  dir: z.string(),
  review: z.union(['optional', 'required']).default('optional'),
  everyHours: z.natural().min(1).default(24),
  maxChars: z.natural().min(4).default(30),
  ownerMaxChars: z.natural().min(4).default(60),
  maxActive: z.natural().min(1).default(60),
  maxOwner: z.natural().default(20),
  maxPending: z.natural().min(1).default(40),
  perRun: z.natural().min(1).default(15),
  perGroup: z.natural().min(1).default(3),
  maxAgeDays: z.natural().min(1).default(30),
  identityMarkers: z.array(z.string()).default([]),
  blocklist: z.array(z.string()).default([]),
  qq: z.object({
    enabled: z.boolean().default(true),
    windowHours: z.natural().min(1).default(26),
    maxMessages: z.natural().min(10).default(2000),
    gapSec: z.natural().min(1).default(60),
    settleMinutes: z.natural().default(10),
  }),
  bili: z.object({
    enabled: z.boolean().default(true),
    url: z.string(),
    tokenEnv: z.string().role('credential-ref').default('BILI_SVC_TOKEN_UP'),
    ownerAccount: z.string().default('maodeng'),
    comments: z.natural().min(1).max(100).default(100),
    maxThreads: z.natural().default(12),
    timeoutMs: z.natural().min(1000).default(20_000),
  }),
  presets: z.array(z.string()).default(['unattended']),
  maxBytes: z.natural().min(512).default(1600),
  maxShown: z.natural().min(1).default(16),
  timeZone: z.string().default('America/New_York'),
  ticsFile: z.string(),
})

/** Default bili-svc address; `BILI_SVC_URL` in the service environment overrides it. */
export const DEFAULT_BILI_URL = 'http://127.0.0.1:8097'

/**
 * What the root plugin offers the prompt-mode instances (registered as the `forkStyle` service value; a plain
 * interface, not a typed Context property, because only this package reads it).
 */
export interface StyleBlockSource {
  /**
   * The block for a day, or undefined when it is off or empty.
   * @param day - `YYYY-MM-DD`, the rotation seed.
   */
  block(day: string): Promise<{ text: string; shown: number; owner: number } | undefined>
  /** The configured rotation zone. */
  readonly timeZone: string
}

const SERVICE = 'forkStyle'
/** Seconds after start before the first scheduled run. */
const FIRST_RUN_DELAY_MS = 120_000
const SCHEDULE_CHECK_MS = 10 * 60_000

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (config.dir !== undefined && !isAbsolute(config.dir)) throw new Error('fork-style: dir must be an absolute path')
  if (config.ticsFile !== undefined && !isAbsolute(config.ticsFile)) throw new Error('fork-style: ticsFile must be an absolute path')
  if (config.bili.url !== undefined && !/^https?:\/\//u.test(config.bili.url)) throw new Error('fork-style: bili.url must be an http(s) address')
  if (config.maxOwner > config.maxActive) throw new Error('fork-style: maxOwner must not exceed maxActive')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch {
    throw new Error(`fork-style: timeZone "${config.timeZone}" is not a valid IANA time zone`)
  }
}

function textOf(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return ''
  return (message.content as Array<{ type?: string; text?: string }>).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/**
 * Prompt mode: the pre-step injection of the day's block into root Sessions of the listed presets.
 * @param ctx - the preset scope's context.
 * @param config - the presets to serve.
 */
function applyPrompt(ctx: Context, config: Config): void {
  const presets = new Set(config.presets)
  ctx.logger.info('fork-style: prompt mode for presets %s', [...presets].join(', '))
  let warned = false
  // The day each Session last got its block, from the events as they are committed: a block the Session's own log
  // shows once is not looked up again. A compaction may summarize it away, so it clears the mark; a restart clears
  // all marks and the next turn of each Session gets the day's block again.
  const shown = new Map<string, string>()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message' && event.data.source.kind === name) {
      const day = /<style-samples day="(\d{4}-\d{2}-\d{2})">/u.exec(textOf(event.data))?.[1]
      if (day !== undefined) shown.set(session.id, day)
    } else if (event.type === 'compaction/end' && event.data.error === undefined) {
      shown.delete(session.id)
    }
  })
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    const session = agent.session
    if (decision.kind === 'reject' || signal.aborted
      || session.header.origin === 'subagent'
      || !presets.has(session.header.agentPreset ?? '')
      || (step === 1 && decision.messages.length === 0)) return decision
    const source = ctx.get(SERVICE) as StyleBlockSource | undefined
    if (source === undefined) {
      if (!warned) ctx.logger.warn('fork-style: prompt mode without the root fork-style plugin; no style block is added')
      warned = true
      return decision
    }
    const day = localDay(new Date(), source.timeZone)
    if (shown.get(session.id) === day) return decision
    let block: Awaited<ReturnType<StyleBlockSource['block']>>
    try {
      block = await source.block(day)
    } catch (error: unknown) {
      ctx.logger.warn('fork-style: style block not loaded for session %s: %s', session.id, error instanceof Error ? error.message : String(error))
      return decision
    }
    if (block === undefined) return decision
    ctx.logger.info('fork-style: style block (%d exchanges, %d the owner\'s, %d bytes, day %s) entered session %s', block.shown, block.owner, Buffer.byteLength(block.text), day, session.id)
    const message = createUserMessage({ content: [{ type: 'text', text: block.text }], source: { kind: name, form: 'instructions' } })
    const lastClaimed = decision.messages.findLastIndex(candidate => messages.includes(candidate))
    return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, message) }
  })
}

/** The slice of the connection service this plugin uses. */
interface StyleConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Collect mode: the store, scheduled and on-demand collection, the answer-length log, the block source, and the
 * Settings routes.
 * @param ctx - the root context.
 * @param config - resolved configuration.
 */
function applyCollect(ctx: Context, config: Config): void {
  const home = resolveDshHome()
  const dir = config.dir ?? join(home, 'fork-style')
  const ticsFile = config.ticsFile ?? join(home, 'fork-integrity', 'tics.json')
  const store = new StyleStore(join(dir, 'samples.jsonl'), { maxActive: config.maxActive, maxOwner: config.maxOwner, maxPending: config.maxPending, maxTombstones: 3000 })
  const answers = new AnswerLog(join(dir, 'answers.json'))
  const settings: CollectSettings = {
    rules: { maxChars: config.maxChars, identityMarkers: config.identityMarkers, blocklist: config.blocklist },
    qq: {
      enabled: config.qq.enabled, windowHours: config.qq.windowHours, maxMessages: config.qq.maxMessages,
      gapMs: config.qq.gapSec * 1000, settleMs: config.qq.settleMinutes * 60_000,
    },
    bili: {
      enabled: config.bili.enabled, ownerAccount: config.bili.ownerAccount,
      comments: config.bili.comments, maxThreads: config.bili.maxThreads,
    },
    maxAgeMs: config.maxAgeDays * 86_400_000,
    perRun: config.perRun,
    perKey: config.perGroup,
    review: config.review,
  }
  const biliUrl = config.bili.url ?? process.env['BILI_SVC_URL'] ?? DEFAULT_BILI_URL
  const collector = new StyleCollector({
    store, settings, logger: ctx.logger, stateFile: join(dir, 'state.json'),
    qq: (): QqSource | undefined => ctx.get('forkQq'),
    bili: async (): Promise<BiliReader | 'no-token'> => {
      const credentials = ctx.get('credentials')
      const token = credentials === undefined ? undefined : (await credentials.resolve(credentialRef(config.bili.tokenEnv)))?.value
      if (token === undefined || token === '') return 'no-token'
      return createBiliReader({ baseUrl: biliUrl, token, timeoutMs: config.bili.timeoutMs, fetch: (...args) => fetch(...args) })
    },
  })
  ctx.logger.info('fork-style: collect mode, %s, review %s, every %d h, samples in %s', config.enabled ? 'on' : 'off (no collection, no block)', config.review, config.everyHours, dir)

  // ctx.provide is itself an effect: the value goes when this plugin unloads.
  ctx.provide(SERVICE, {
    timeZone: config.timeZone,
    async block(day: string) {
      if (!config.enabled) return undefined
      return renderStyleBlock(await store.all(), { day, maxBytes: config.maxBytes, maxShown: config.maxShown })
    },
  } satisfies StyleBlockSource)

  // Answer lengths of the presets that get the block, for the page's trend: the turn's last assistant text, counted
  // when the turn ends.
  const presets = new Set(config.presets)
  const lastAnswer = new Map<string, string>()
  ctx.on('session/event', (session, event) => {
    if (!presets.has(session.header.agentPreset ?? '') || session.header.origin === 'subagent') return
    if (event.type === 'turn/start') lastAnswer.delete(session.id)
    else if (event.type === 'assistant/message') lastAnswer.set(session.id, textOf(event.data.message).trim())
    else if (event.type === 'turn/end') {
      const answer = lastAnswer.get(session.id) ?? ''
      lastAnswer.delete(session.id)
      if (answer === '' || answer === 'NO_REPLY') return
      void answers.record(new Date().toISOString().slice(0, 10), Array.from(answer).length)
    }
  })

  // Scheduled runs: a check every ten minutes, the first two minutes after start.
  const abort = new AbortController()
  ctx.effect(() => () => { abort.abort() }, 'fork-style: stop collection')
  const due = async (): Promise<number | undefined> => {
    if (!config.enabled) return undefined
    const last = await collector.lastRun()
    return (last?.at ?? 0) + config.everyHours * 3_600_000
  }
  const check = (): void => {
    void (async () => {
      const at = await due()
      if (at === undefined || Date.now() < at || collector.busy) return
      await collector.run('schedule', abort.signal)
    })().catch((error: unknown) => { ctx.logger.warn('fork-style: scheduled run failed: %s', error instanceof Error ? error.message : String(error)) })
  }
  ctx.effect(() => {
    const first = setTimeout(check, FIRST_RUN_DELAY_MS)
    const timer = setInterval(check, SCHEDULE_CHECK_MS)
    first.unref()
    timer.unref()
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, 'fork-style: schedule')

  const panel = async (): Promise<StylePanel> => {
    const [records, lastRun, trend, next] = await Promise.all([store.live(), collector.lastRun(), readTrend(ticsFile, join(dir, 'answers.json')), due()])
    return {
      enabled: config.enabled,
      review: config.review,
      limits: { maxActive: config.maxActive, maxOwner: config.maxOwner, maxChars: config.ownerMaxChars },
      samples: records.map(record => ({
        id: record.id, source: record.source, status: record.status === 'pending' ? 'pending' : 'active', addedAt: record.addedAt,
        ...record.prompt === undefined ? {} : { prompt: record.prompt }, reply: record.reply ?? '',
      })),
      running: collector.busy,
      lastRun: lastRun ?? null,
      nextRunAt: next ?? null,
      trend,
    }
  }
  const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  const edit = async (request: Request): Promise<Response> => {
    let body: Record<string, unknown>
    try {
      const parsed: unknown = await request.json()
      body = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    } catch {
      return json({ ok: false, error: 'invalid_input', panel: await panel() } satisfies StyleEditAnswer, 400)
    }
    const id = typeof body['id'] === 'string' ? body['id'] : ''
    try {
      switch (body['op']) {
        case 'remove': {
          const record = await store.remove(id)
          ctx.logger.info('fork-style: the owner removed %s (%s)', record.id, record.source)
          break
        }
        case 'keep': {
          const record = await store.keep(id)
          ctx.logger.info('fork-style: the owner kept %s (%s)', record.id, record.source)
          break
        }
        case 'add': {
          const record = await store.addManual({ prompt: body['prompt'], reply: body['reply'] }, config.ownerMaxChars)
          ctx.logger.info('fork-style: the owner added %s (%d chars)', record.id, Array.from(record.reply ?? '').length)
          break
        }
        default:
          return json({ ok: false, error: 'invalid_input', panel: await panel() } satisfies StyleEditAnswer, 400)
      }
    } catch (error: unknown) {
      if (!(error instanceof StyleError)) throw error
      return json({ ok: false, error: error.code, panel: await panel() } satisfies StyleEditAnswer, error.code === 'not_found' ? 404 : 400)
    }
    return json({ ok: true, panel: await panel() } satisfies StyleEditAnswer)
  }

  ctx.inject(['connection'], (scope) => {
    const connection = Reflect.get(scope, 'connection') as StyleConnection
    scope.effect(() => connection.fetch.register({
      path: STYLE_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async () => json(await panel()),
    }), `fork-style: ${STYLE_PATH}`)
    scope.effect(() => connection.fetch.register({
      path: STYLE_EDIT_PATH, methods: ['POST'], requestBody: 'buffered', fetch: edit,
    }), `fork-style: ${STYLE_EDIT_PATH}`)
    scope.effect(() => connection.fetch.register({
      path: STYLE_COLLECT_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: async () => {
        // The page does not wait for the run: it answers at once and the panel shows `running` until it ends.
        if (config.enabled) void collector.run('manual', abort.signal).catch((error: unknown) => { ctx.logger.warn('fork-style: manual run failed: %s', error instanceof Error ? error.message : String(error)) })
        return json(await panel())
      },
    }), `fork-style: ${STYLE_COLLECT_PATH}`)
  })
}

/**
 * Apply the plugin in its mode.
 * @param ctx - the root context (collect mode) or a preset's scope (prompt mode).
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  if (config.mode === 'prompt') applyPrompt(ctx, config)
  else applyCollect(ctx, config)
}
