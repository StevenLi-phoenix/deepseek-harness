/**
 * DSH's own speaking style, learned as data. Three parts, each with its own switch: tone samples (short real exchanges
 * from the recorded QQ groups and public Bilibili comments, collected daily without a model), notes (memes and jargon,
 * and traits of the groups' overall tone, written with `style_note` by the Sessions that read the groups, each example
 * checked verbatim against what that Session read; HotWatch's trending memes supplement the meme index), the meme miner
 * (code-side: after each collection it reads Bilibili hot comments and hot-search words, the QQ groups, and pages the
 * main agent searched or fetched, lets a cheap model propose memes, and keeps one only when code confirms it and a
 * search explains it), and the persona card the agent writes for itself with `persona_update`. Every public write
 * (card, note, mined meme) passes `ctx.contentGuard` first and is refused without it. The root row (`mode: collect`) keeps all of it under
 * `<DSH_HOME>/speaking-style` and provides `ctx.speakingStyle` (read by speaking-style-settings, Settings → 说话风格). A preset row
 * (`mode: prompt`) puts the style block in front of each root Session of the listed presets and mounts its listed tools.
 *
 * Inputs are the QQ groups and public Bilibili text only, never owner memory or WeChat; outputs are style, not facts
 * about anyone. Strangers' words reach the listed presets' prompts this way, outside turn-taint's turn-origin tracking;
 * the filters, the verbatim checks, the caps, the quoted framing, the system persona's precedence, the owner's view and
 * deletion, `review: required`, and the switches are the mitigations.
 *
 * @module @deepseek-ai/dsh-speaking-style
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: ctx.credentials.
import type {} from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
// Type-only: ctx.web, the miner's search.
import type {} from '@deepseek-ai/dsh-web'
// Type-only: ctx.ownerNotifier, for the card revision notice.
import type {} from '@deepseek-ai/dsh-event-bus'
// Type-only: ctx.qq, the QQ observer collection and notes read.
import type {} from '@deepseek-ai/dsh-qq'
import type {} from '@deepseek-ai/dsh-session'
// Type-only: the compaction events' SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-compaction'
import z from '@deepseek-ai/schemastery'
import { webResultText } from './inputs.ts'
import { BLOCK_TAG, localDay } from './render.ts'
import { StyleService } from './service.ts'
import { registerStyleTools, STYLE_TOOLS, type StyleTool } from './tools.ts'
import { AnswerLog } from './trend.ts'
import type { NoteSource } from './view.ts'

export type { Accepted, BiliComment, BiliReader, Pair, QqMessage, QqSource } from './collect.ts'
export type { FilterReason, LineRules, PiiKind } from './filter.ts'
export type { GuardCheckOptions, GuardLike, GuardVerdict } from './guard.ts'
export type { HotMeme, HotWatchOptions } from './hotwatch.ts'
export type { HotSource } from './inputs.ts'
export type { MineInput, MinerSettings, SearchCall } from './miner.ts'
export type { ModelCall } from './model.ts'
export type { CardVersion, Note, NotesLimits } from './notes.ts'
export type { BlockInput } from './render.ts'
export { StyleError, type Candidate, type StoreLimits, type StyleRecord } from './store.ts'
export type { LookupAnswer, StyleNoteInput, StyleTool, ToolSink, WriteAnswer } from './tools.ts'
export type * from './view.ts'
export type { StyleBlock, StyleHealth, StyleService } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DSH's speaking style: the block for the preset rows, the tools' rules, and the Settings section's reads and edits. */
    speakingStyle: StyleService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Requests and context of the speaking-style plugin.
     * @persistenceAttribution
     */
    'speaking-style': { kind: 'speaking-style' } & ContextFormed
  }
}

/** Plugin name; also the source kind of the style message. */
export const name = 'speaking-style'

/** Plugin configuration. */
export interface Config {
  /** `collect` (at the root): the stores, collection, `ctx.speakingStyle`. `prompt` (inside a preset): the block and the listed tools. */
  mode: 'collect' | 'prompt'
  /** Prompt mode: put the style block in front of root Sessions (qq-digest turns it off, so digests do not learn from their own notes). */
  block: boolean
  /** Prompt mode: the tools this preset mounts. */
  tools: StyleTool[]
  /** Collect mode: `false` stops collection, refuses notes and card updates, and keeps the block out of every prompt; the data stays. */
  enabled: boolean
  /** Collect mode: directory of `samples.jsonl`, `notes.json`, `state.json`, `answers.json`; defaults to `<DSH_HOME>/speaking-style`. */
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
  /** QQ groups (through `ctx.qq`). */
  qq: {
    /** Read the recorded groups at all. */
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
    /** Read the comments at all. */
    enabled: boolean
    /** bili-svc's address; unset uses `BILI_SVC_URL` or `http://127.0.0.1:8097`. */
    url?: string
    /** Credential holding a bili-svc token with the `read` scope. */
    tokenEnv: string
    /** bili-svc's id of the owner's own account (猫灯): its hand-written replies become tone samples marked `owner`. */
    ownerAccount: string
    /** Newest comments read per run. */
    comments: number
    /** Comment threads read per run (each is one live read through bili-svc). */
    maxThreads: number
    /** Deadline of one read, in milliseconds. */
    timeoutMs: number
  }
  /** Tone samples in the block. */
  tone: {
    /** Show tone samples at all; collection keeps running. */
    enabled: boolean
    /** Exchanges shown at most. */
    maxShown: number
    /** Characters of the shown exchanges at most. */
    maxChars: number
  }
  /** Memes: the index in the block, `meme_lookup`, and the meme notes. */
  memes: {
    /** Put the meme index in the block, answer `meme_lookup`, and take meme notes. */
    enabled: boolean
    /** Names in the index at most. */
    maxIndex: number
    /** Meme notes kept at most, most recently seen first. */
    maxStored: number
    /** A meme not seen for this many days expires. */
    expireDays: number
  }
  /** Traits of the groups' overall tone. */
  traits: {
    /** Show traits in the block and take trait notes. */
    enabled: boolean
    /** Traits kept and shown at most. */
    max: number
  }
  /** The persona card the agent writes for itself. */
  persona: {
    /** Show the card in the block and take `persona_update`. */
    enabled: boolean
    /** Longest card, in characters. */
    maxChars: number
    /** Hours between two of the agent's revisions; an owner edit restarts the wait. */
    minIntervalHours: number
    /** Card versions kept. */
    maxVersions: number
  }
  /** The meme miner: runs after each collection and by hand. */
  miner: {
    /** Mine at all; needs `memes.enabled`. */
    enabled: boolean
    /** Provider of the miner's model calls; with `model`, replaces the profile's default route. */
    provider?: string
    /** Model of the miner's calls. */
    model?: string
    /** Output tokens per call at most. */
    maxOutputTokens: number
    /** Texts sent to the model at most. */
    maxInputs: number
    /** New memes one run keeps at most. */
    maxNew: number
    /** Web searches one run makes at most (the meaning of a new meme, when no page the main agent read explains it). */
    maxSearches: number
    /** Likes that make one Bilibili hot comment evidence on its own. */
    minLikes: number
    /** A term in more than this share of the texts (from `commonFrom` texts on) is an ordinary word. */
    commonShare: number
    /** Texts needed before `commonShare` applies. */
    commonFrom: number
    /** Hours of Bilibili hot rows and QQ messages one run reads. */
    windowHours: number
    /** QQ messages read per group at most. */
    qqMessages: number
    /** Longest one-line meaning of a mined meme, in characters. */
    meaningChars: number
    /** Raw model and search responses kept on disk. */
    rawKept: number
    /** Pages the main agent searched or fetched, kept for the miner (result text only, never the query). */
    inbox: {
      /** Pages kept at most. */
      items: number
      /** Characters kept per page. */
      chars: number
      /** Days a page is kept. */
      days: number
    }
  }
  /** `style_note`: which preset writes for which platform, the longest fields, and the calls per turn. */
  notes: {
    /** Preset of the calling Session → the platform of what it reads (`web`: pages the Session searched or fetched). */
    sources: Record<string, NoteSource>
    /** Longest term, in characters. */
    termChars: number
    /** Longest meaning or example, in characters. */
    textChars: number
    /** Calls one Session may make in one turn. */
    perTurn: number
  }
  /** HotWatch, the trending-topics service: its `meme` domain supplements the meme index. */
  hotwatch: {
    /** Ask HotWatch at all. */
    enabled: boolean
    /** Address, on the tailnet. */
    url: string
    /** Titles fetched, by heat. */
    limit: number
    /** Of them, names put in the index at most. */
    maxIndex: number
    /** How long a list or a summary is kept, in milliseconds. */
    ttlMs: number
    /** Deadline of one call, in milliseconds. */
    timeoutMs: number
  }
  /** Agent presets whose root Sessions get the block (the prompt row checks the Session's preset). */
  presets: string[]
  /** Presets whose answer lengths the page's trend counts. */
  answerPresets: string[]
  /** IANA zone of the day the block rotates on. */
  timeZone: string
  /** integrity-watch's per-day stock-line counts; defaults to `<DSH_HOME>/integrity-watch/tics.json`. */
  ticsFile?: string
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  mode: z.union(['collect', 'prompt']).default('collect'),
  block: z.boolean().default(true),
  tools: z.array(z.union([...STYLE_TOOLS])).default(['meme_lookup']),
  enabled: z.boolean().default(true),
  dir: z.string(),
  review: z.union(['optional', 'required']).default('optional'),
  everyHours: z.natural().min(1).default(24),
  maxChars: z.natural().min(4).default(30),
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
  tone: z.object({
    enabled: z.boolean().default(true),
    maxShown: z.natural().min(1).default(8),
    maxChars: z.natural().min(100).default(600),
  }),
  memes: z.object({
    enabled: z.boolean().default(true),
    maxIndex: z.natural().min(1).default(40),
    maxStored: z.natural().min(1).default(80),
    expireDays: z.natural().min(1).default(14),
  }),
  traits: z.object({
    enabled: z.boolean().default(true),
    max: z.natural().min(1).default(10),
  }),
  persona: z.object({
    enabled: z.boolean().default(true),
    maxChars: z.natural().min(100).default(600),
    minIntervalHours: z.natural().default(6),
    maxVersions: z.natural().min(1).default(30),
  }),
  miner: z.object({
    enabled: z.boolean().default(true),
    provider: z.string(),
    model: z.string(),
    maxOutputTokens: z.natural().min(256).default(2000),
    maxInputs: z.natural().min(10).default(120),
    maxNew: z.natural().min(1).default(6),
    maxSearches: z.natural().default(6),
    minLikes: z.natural().min(1).default(20),
    commonShare: z.number().min(0.05).max(1).default(0.35),
    commonFrom: z.natural().min(2).default(10),
    windowHours: z.natural().min(1).default(72),
    qqMessages: z.natural().min(10).default(400),
    meaningChars: z.natural().min(20).default(80),
    rawKept: z.natural().default(30),
    inbox: z.object({
      items: z.natural().min(1).default(30),
      chars: z.natural().min(200).default(6000),
      days: z.natural().min(1).default(3),
    }),
  }),
  notes: z.object({
    sources: z.dict(z.union(['qq', 'bili', 'web'])).default({ 'qq-digest': 'qq', 'up': 'bili', 'unattended': 'web' }),
    termChars: z.natural().min(2).default(20),
    textChars: z.natural().min(10).default(60),
    perTurn: z.natural().min(1).default(5),
  }),
  hotwatch: z.object({
    enabled: z.boolean().default(true),
    url: z.string().default('http://100.97.163.18:8000'),
    limit: z.natural().min(1).default(30),
    maxIndex: z.natural().default(15),
    ttlMs: z.natural().min(1000).default(3_600_000),
    timeoutMs: z.natural().min(500).default(8000),
  }),
  presets: z.array(z.string()).default(['unattended', 'up', 'bili', 'qqbot']),
  answerPresets: z.array(z.string()).default(['unattended']),
  timeZone: z.string().default('America/New_York'),
  ticsFile: z.string(),
})

/** Seconds after start before the first scheduled run. */
const FIRST_RUN_DELAY_MS = 120_000
const SCHEDULE_CHECK_MS = 10 * 60_000

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (config.dir !== undefined && !isAbsolute(config.dir)) throw new Error('speaking-style: dir must be an absolute path')
  if (config.ticsFile !== undefined && !isAbsolute(config.ticsFile)) throw new Error('speaking-style: ticsFile must be an absolute path')
  for (const url of [config.bili.url, config.hotwatch.url]) {
    if (url !== undefined && !/^https?:\/\//u.test(url)) throw new Error(`speaking-style: ${url} must be an http(s) address`)
  }
  if (config.maxOwner > config.maxActive) throw new Error('speaking-style: maxOwner must not exceed maxActive')
  if ((config.miner.provider === undefined) !== (config.miner.model === undefined)) {
    throw new Error('speaking-style: miner.provider and miner.model must be set together, or both left to the default route')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch {
    throw new Error(`speaking-style: timeZone "${config.timeZone}" is not a valid IANA time zone`)
  }
}

function textOf(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return ''
  return (message.content as Array<{ type?: string; text?: string }>).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/**
 * Prompt mode: the block in front of root Sessions of the listed presets, and the listed tools.
 * @param ctx - the preset scope's context.
 * @param config - the presets, whether this row shows the block, and its tools.
 */
function applyPrompt(ctx: Context, config: Config): void {
  const presets = new Set(config.presets)
  const invite = config.tools.includes('persona_update')
  ctx.logger.info('speaking-style: preset row, block %s, tools %s', config.block ? 'on' : 'off', config.tools.join(', ') || 'none')
  if (config.tools.length > 0) {
    ctx.inject(['tools'], (scope) => { registerStyleTools(scope, config.tools, config.notes.perTurn, () => ctx.get('speakingStyle')) })
  }
  if (!config.block) return
  let warned = false
  // The day and card version each Session last got, from the events as they are committed. A compaction may summarize
  // the block away, so it clears the mark; a restart clears all marks and each Session gets the block again.
  const shown = new Map<string, string>()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message' && event.data.source.kind === name) {
      const tag = BLOCK_TAG.exec(textOf(event.data))
      /* v8 ignore next -- the tag pattern's groups are mandatory. */
      if (tag !== null) shown.set(session.id, `${tag[1] ?? ''}:${tag[2] ?? ''}`)
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
    const source = ctx.get('speakingStyle')
    if (source === undefined) {
      if (!warned) ctx.logger.warn('speaking-style: preset row without the root speaking-style plugin; no style block is added')
      warned = true
      return decision
    }
    const day = localDay(new Date(), source.timeZone)
    let block: Awaited<ReturnType<StyleService['block']>>
    try {
      block = await source.block(day, invite)
    } catch (error: unknown) {
      ctx.logger.warn('speaking-style: style block not loaded for session %s: %s', session.id, error instanceof Error ? error.message : String(error))
      return decision
    }
    if (block === undefined || shown.get(session.id) === `${day}:${String(block.card)}`) return decision
    ctx.logger.info('speaking-style: style block (card v%d, %d memes, %d tone exchanges, %d bytes, day %s) entered session %s', block.card, block.memes, block.shown, Buffer.byteLength(block.text), day, session.id)
    const message = createUserMessage({ content: [{ type: 'text', text: block.text }], source: { kind: name, form: 'instructions' } })
    const lastClaimed = decision.messages.findLastIndex(candidate => messages.includes(candidate))
    return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, message) }
  })
}

/**
 * Collect mode: the service, the schedule, and the answer-length log.
 * @param ctx - the root context.
 * @param config - resolved configuration.
 */
function applyCollect(ctx: Context, config: Config): void {
  const home = resolveDshHome()
  const dir = config.dir ?? join(home, 'speaking-style')
  const service = new StyleService(ctx, config, { dir, ticsFile: config.ticsFile ?? join(home, 'integrity-watch', 'tics.json') })
  ctx.logger.info('speaking-style: collect mode, %s, review %s, every %d h, data in %s', config.enabled ? 'on' : 'off', config.review, config.everyHours, dir)
  // ctx.provide is itself an effect: the service goes when this plugin unloads.
  ctx.provide('speakingStyle', service)
  ctx.effect(() => () => { service.dispose() }, 'speaking-style: stop collection')
  void service.panel().catch((error: unknown) => { ctx.logger.warn('speaking-style: first read failed: %s', error instanceof Error ? error.message : String(error)) })

  // Answer lengths for the page's trend: the turn's last assistant text, counted when the turn ends.
  const answers = new AnswerLog(join(dir, 'answers.json'))
  const presets = new Set(config.answerPresets)
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

  // The miner's web inbox: the text of each web search or fetch any Session runs (never the query or the URL).
  const open = new Map<string, string>()
  ctx.on('session/event', (_session, event) => {
    const text = webResultText(open, event)
    /* v8 ignore next -- the map holds more than 200 entries here. */
    if (open.size > 200) open.delete(open.keys().next().value ?? '')
    if (text !== undefined) {
      void service.feedWeb(text).catch((error: unknown) => { ctx.logger.warn('speaking-style: web inbox write failed: %s', error instanceof Error ? error.message : String(error)) })
    }
  })

  // Scheduled runs: a check every ten minutes, the first two minutes after start.
  const check = (): void => {
    void service.runIfDue().catch((error: unknown) => { ctx.logger.warn('speaking-style: scheduled run failed: %s', error instanceof Error ? error.message : String(error)) })
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
  }, 'speaking-style: schedule')
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
