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

import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
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
import { createBiliReader } from './bili.ts'
import { optionalService, StyleGate } from './guard.ts'
import { gatherInputs, webResultText, WebInbox, type HotSource } from './inputs.ts'
import { MemeMiner, type SearchCall } from './miner.ts'
import { createModelCall } from './model.ts'
import { recentPublicText, WEB_TOOLS } from './session-text.ts'
import { StyleCollector, type BiliReader, type CollectSettings, type QqSource } from './collect.ts'
import { normalizeLine, screenNote } from './filter.ts'
import { HotWatch, type HotMeme } from './hotwatch.ts'
import { MAX_RELATED, NotesStore, termKey } from './notes.ts'
import { BLOCK_TAG, localDay, renderStyleBlock } from './render.ts'
import { StyleError, StyleStore } from './store.ts'
import {
  registerStyleTools, STYLE_TOOLS, type LookupAnswer, type StyleNoteInput, type StyleTool, type WriteAnswer,
} from './tools.ts'
import { AnswerLog, readTrend } from './trend.ts'
import type { MineReport, NoteSource, RunReport, StyleEditAnswer, StylePanel, TrendDay } from './view.ts'

export {
  biliPairs, pickForRun, qqPairs, screenPairs, StyleCollector,
  type Accepted, type BiliComment, type BiliReader, type Pair, type QqMessage, type QqSource,
} from './collect.ts'
export { createBiliReader, parseComment } from './bili.ts'
export {
  BUILTIN_IDENTITY_MARKERS, BUILTIN_SLURS, cleanBiliText, cleanQqText, FILTER_REASONS, PII_KINDS, piiKind, screenExchange, screenLine,
  screenNote, type FilterReason, type LineRules, type PiiKind,
} from './filter.ts'
export { GUARD_UNAVAILABLE, optionalService, StyleGate, type GuardCheckOptions, type GuardLike, type GuardVerdict } from './guard.ts'
export { HotWatch, type HotMeme, type HotWatchOptions } from './hotwatch.ts'
export { gatherInputs, webLines, webResultText, WebInbox, type HotSource } from './inputs.ts'
export { MemeMiner, parseJson, screenInputs, type MineInput, type MinerSettings, type SearchCall } from './miner.ts'
export { createModelCall, type ModelCall } from './model.ts'
export { isPublicTextTool, recentPublicText, WEB_TOOLS } from './session-text.ts'
export { NotesStore, termKey, type CardVersion, type Note, type NotesLimits } from './notes.ts'
export { BLOCK_INTRO, BLOCK_TAG, blockTag, CARD_INVITE, localDay, renderStyleBlock, STYLE_INTRO, type BlockInput } from './render.ts'
export { sampleId, StyleError, StyleStore, type Candidate, type StoreLimits, type StyleRecord } from './store.ts'
export {
  registerStyleTools, STYLE_TOOLS, type LookupAnswer, type StyleNoteInput, type StyleTool, type ToolSink, type WriteAnswer,
} from './tools.ts'
export { AnswerLog, readTrend } from './trend.ts'
export * from './view.ts'

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

/** Default bili-svc address; `BILI_SVC_URL` in the service environment overrides it. */
export const DEFAULT_BILI_URL = 'http://127.0.0.1:8097'

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

/** A rendered block, its counts, and the card version it shows. */
export interface StyleBlock {
  readonly text: string
  /** Tone exchanges shown, and the owner's among them. */
  readonly shown: number
  readonly owner: number
  /** Names in the meme index. */
  readonly memes: number
  /** Card version, 0 without a card. */
  readonly card: number
}

/** What `ctx.speakingStyle.health()` answers: counts only, never text. */
export interface StyleHealth {
  /** Active tone samples. */
  readonly kept: number
  /** Tone samples waiting for the owner. */
  readonly pending: number
  readonly review: 'optional' | 'required'
  /** Epoch milliseconds of the last tone collection's start; null before the first. */
  readonly lastRefreshAt: number | null
  /** Share of answers with stock lines, the last days against the days before; null with fewer than two days of data. */
  readonly ticTrend: 'up' | 'flat' | 'down' | null
}

/**
 * The direction of the stock-line share: the last three days with answers (fewer with little data) against the days before, within a week.
 * @param days - the trend, oldest first.
 * @returns `up` or `down` when the shares differ by more than five points, `flat` otherwise, null with too little data.
 */
export function ticTrend(days: readonly TrendDay[]): StyleHealth['ticTrend'] {
  const shares = days.filter(day => day.answers > 0).slice(-7).map(day => day.withTics / day.answers)
  if (shares.length < 2) return null
  const split = Math.min(3, Math.floor(shares.length / 2))
  const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
  const delta = mean(shares.slice(-split)) - mean(shares.slice(0, shares.length - split))
  return delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'flat'
}

/** DSH's speaking style: what the root row provides as `ctx.speakingStyle`. */
export class StyleService {
  /** The rotation zone of the block. */
  readonly timeZone: string
  private readonly store: StyleStore
  private readonly notes: NotesStore
  private readonly collector: StyleCollector
  private readonly hotwatch: HotWatch | undefined
  private readonly gate: StyleGate
  private readonly inbox: WebInbox
  private readonly miner: MemeMiner
  private readonly abort = new AbortController()
  private latest: StyleHealth = { kept: 0, pending: 0, review: 'optional', lastRefreshAt: null, ticTrend: null }

  /**
   * @param ctx - the root context: logger, `ctx.qq`, `ctx.biliEvidence`, `ctx.credentials`, `ctx.ownerNotifier`, each read when needed.
   * @param config - resolved configuration.
   * @param paths - the data directory and integrity-watch's stock-line counts.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly paths: { readonly dir: string; readonly ticsFile: string },
  ) {
    this.timeZone = config.timeZone
    this.store = new StyleStore(join(paths.dir, 'samples.jsonl'), { maxActive: config.maxActive, maxOwner: config.maxOwner, maxPending: config.maxPending, maxTombstones: 3000 })
    this.notes = new NotesStore(join(paths.dir, 'notes.json'), {
      maxMemes: config.memes.maxStored, maxTraits: config.traits.max,
      expireDays: config.memes.expireDays, maxVersions: config.persona.maxVersions,
    })
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
    this.collector = new StyleCollector({
      store: this.store, settings, logger: ctx.logger, stateFile: join(paths.dir, 'state.json'),
      qq: (): QqSource | undefined => ctx.get('qq'),
      bili: async (): Promise<BiliReader | 'no-token'> => {
        const credentials = ctx.get('credentials')
        const token = credentials === undefined ? undefined : (await credentials.resolve(credentialRef(config.bili.tokenEnv)))?.value
        if (token === undefined || token === '') return 'no-token'
        return createBiliReader({ baseUrl: biliUrl, token, timeoutMs: config.bili.timeoutMs, fetch: (...args) => fetch(...args) })
      },
    })
    this.hotwatch = config.hotwatch.enabled && config.memes.enabled
      ? new HotWatch({
        url: config.hotwatch.url, limit: config.hotwatch.limit, ttlMs: config.hotwatch.ttlMs, timeoutMs: config.hotwatch.timeoutMs,
        fetch: (...args) => fetch(...args), warn: (message) => { ctx.logger.warn(message) },
      })
      : undefined
    this.gate = new StyleGate(ctx, (message) => { ctx.logger.warn('%s', message) }, (message) => { ctx.logger.info('%s', message) })
    const { miner } = config
    this.inbox = new WebInbox(join(paths.dir, 'web-inbox.json'), miner.inbox)
    const search: SearchCall = async (query, signal) => {
      const web = ctx.get('web')
      if (web === undefined) return undefined
      const result = await web.search({ query, maxResults: 5 }, signal)
      const text = [result.content, ...result.sources.map(source => [source.title, source.summary ?? source.snippet].filter(part => part !== undefined && part !== '').join('：'))]
        .filter(part => part !== undefined && part !== '').join('\n')
      return { text, raw: result }
    }
    this.miner = new MemeMiner({
      notes: this.notes, hotwatch: this.hotwatch, gate: this.gate, search,
      model: createModelCall(ctx, { provider: miner.provider, model: miner.model, maxOutputTokens: miner.maxOutputTokens }),
      webMaterial: async term => await this.inbox.around(term, 900),
      settings: {
        minLikes: miner.minLikes, maxInputs: miner.maxInputs, maxNew: miner.maxNew, maxSearches: miner.maxSearches,
        termChars: config.notes.termChars, exampleChars: config.notes.textChars, meaningChars: miner.meaningChars,
        blocklist: config.blocklist, rawKept: miner.rawKept, commonShare: miner.commonShare, commonFrom: miner.commonFrom,
      },
      rawDir: join(paths.dir, 'raw'),
      logger: { info: (message) => { ctx.logger.info('%s', message) }, warn: (message) => { ctx.logger.warn('%s', message) } },
    })
  }

  /**
   * Remember the text of a web search or fetch a Session just ran, for the miner (when mining is on).
   * @param text - the tool result's text; the query and URL never reach this.
   */
  async feedWeb(text: string): Promise<void> {
    if (!this.config.enabled || !this.config.memes.enabled || !this.config.miner.enabled) return
    await this.inbox.add([text])
    this.ctx.logger.debug('speaking-style: web inbox took a page of %d characters', Array.from(text).length)
  }

  /** Stop a run in progress (its Bilibili reads end). */
  dispose(): void {
    this.abort.abort()
  }

  /**
   * Counts for the Settings overview, without any text; refreshed whenever the panel is read, after each run, and on the
   * schedule check.
   * @returns active and pending tone samples, the review mode, the last run's start, and the stock-line trend.
   */
  health(): StyleHealth {
    return { ...this.latest, review: this.config.review }
  }

  /** HotWatch's memes the owner did not block; empty when HotWatch or memes are off. */
  private async hotMemes(): Promise<HotMeme[]> {
    if (this.hotwatch === undefined) return []
    const [memes, blocked] = await Promise.all([this.hotwatch.memes(), this.notes.blocked()])
    return memes.filter(meme => !blocked.has(termKey(meme.title)))
  }

  /** The current card text, or undefined. */
  private async currentCard(): Promise<{ card: string | undefined; version: number }> {
    const last = (await this.notes.cards()).at(-1)
    return { card: last === undefined || last.card === '' ? undefined : last.card, version: last?.version ?? 0 }
  }

  /**
   * The block for a day.
   * @param day - `YYYY-MM-DD`, the rotation seed.
   * @param invite - invite the agent to write a card when there is none (its preset mounts `persona_update`).
   * @returns the block, its counts, and the card version it shows, or undefined when it is off or empty.
   */
  async block(day: string, invite: boolean): Promise<StyleBlock | undefined> {
    if (!this.config.enabled) return undefined
    const { memes: memesOn, traits: traitsOn, tone, persona } = this.config
    const [records, notes, card, hotMemes] = await Promise.all([this.store.all(), this.notes.notes(), this.currentCard(), this.hotMemes()])
    const hot = hotMemes.map(meme => meme.title)
    const block = renderStyleBlock({
      day, card: persona.enabled ? card.card : undefined, cardVersion: card.version, invite: persona.enabled && invite,
      traits: traitsOn.enabled ? notes.filter(note => note.kind === 'trait') : [],
      memes: memesOn.enabled ? notes.filter(note => note.kind === 'meme') : [], hot: memesOn.enabled ? hot : [],
      samples: tone.enabled ? records : [], toneShown: tone.maxShown, toneChars: tone.maxChars,
      memeIndex: memesOn.maxIndex, hotIndex: this.config.hotwatch.maxIndex,
    })
    return block === undefined ? undefined : { ...block, card: card.version }
  }

  /**
   * When the next scheduled run is due.
   * @returns epoch milliseconds; undefined while collection is off.
   */
  async nextRunAt(): Promise<number | undefined> {
    if (!this.config.enabled) return undefined
    return ((await this.collector.lastRun())?.at ?? 0) + this.config.everyHours * 3_600_000
  }

  /**
   * Run a collection and the meme miner when one is due and none is running.
   * @returns the tone collection's report, or undefined when nothing ran.
   */
  async runIfDue(): Promise<RunReport | undefined> {
    const at = await this.nextRunAt()
    if (at === undefined || Date.now() < at || this.collector.busy || this.miner.busy) {
      await this.panel()
      return undefined
    }
    const report = await this.collector.run('schedule', this.abort.signal)
    await this.mine()
    await this.panel()
    return report
  }

  /**
   * One meme-mining run over the public text of the last hours: QQ groups, Bilibili hot comments and hot-search words
   * (`ctx.biliHot`, absent until the bili package provides it), and the pages the main agent searched or fetched.
   * Nothing runs while mining is off or another run is going.
   * @returns the run's counts, or undefined when nothing ran.
   */
  async mine(): Promise<MineReport | undefined> {
    const { config } = this
    if (!config.enabled || !config.memes.enabled || !config.miner.enabled || this.miner.busy) return undefined
    const now = Date.now()
    const warn = (message: string): void => { this.ctx.logger.warn('%s', message) }
    const hot = optionalService(this.ctx, 'biliHot')
    const inputs = await gatherInputs({
      qq: this.ctx.get('qq'), hot: isHotSource(hot) ? hot : undefined, web: await this.inbox.lines(),
      window: { hours: config.miner.windowHours, limit: config.miner.qqMessages, settleMs: config.qq.settleMinutes * 60_000 },
      sinceMs: now - config.miner.windowHours * 3_600_000, now, warn,
    })
    const report = await this.miner.run(inputs, this.abort.signal)
    await this.saveMine(report)
    return report
  }

  private get mineFile(): string {
    return join(this.paths.dir, 'mine.json')
  }

  private async saveMine(report: MineReport): Promise<void> {
    try {
      await writeFile(this.mineFile, `${JSON.stringify(report)}\n`, { mode: 0o600 })
    } catch (error: unknown) {
      this.ctx.logger.warn('speaking-style: could not save the miner report: %s', error instanceof Error ? error.message : String(error))
    }
  }

  private async lastMine(): Promise<MineReport | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.mineFile, 'utf8'))
      return typeof parsed === 'object' && parsed !== null && 'at' in parsed && typeof parsed.at === 'number' ? parsed as MineReport : null
    } catch {
      return null
    }
  }

  /**
   * Everything the Settings section shows.
   * @returns the samples, notes, HotWatch's index, card versions, the last runs, the next run, and the trend.
   */
  async panel(): Promise<StylePanel> {
    const [records, notes, cards, lastRun, trend, next, hot, lastMine] = await Promise.all([
      this.store.live(), this.notes.notes(), this.notes.cards(), this.collector.lastRun(),
      readTrend(this.paths.ticsFile, join(this.paths.dir, 'answers.json')), this.nextRunAt(), this.hotMemes(), this.lastMine(),
    ])
    this.latest = {
      kept: records.filter(record => record.status === 'active').length,
      pending: records.filter(record => record.status === 'pending').length,
      review: this.config.review, lastRefreshAt: lastRun?.at ?? null, ticTrend: ticTrend(trend),
    }
    const { config } = this
    /* v8 ignore next -- a live record always has a reply. */
    const replyOf = (reply: string | undefined): string => reply ?? ''
    return {
      enabled: config.enabled,
      parts: {
        tone: config.tone.enabled, memes: config.memes.enabled, traits: config.traits.enabled, persona: config.persona.enabled,
        miner: config.memes.enabled && config.miner.enabled,
      },
      review: config.review,
      limits: {
        maxActive: config.maxActive, maxOwner: config.maxOwner,
        maxMemes: config.memes.maxIndex, maxTraits: config.traits.max, cardChars: config.persona.maxChars,
      },
      samples: records.map(record => ({
        id: record.id, source: record.source, owner: record.owner, status: record.status === 'pending' ? 'pending' : 'active', addedAt: record.addedAt,
        ...record.prompt === undefined ? {} : { prompt: record.prompt }, reply: replyOf(record.reply), origin: record.origin,
      })),
      notes,
      hot: hot.slice(0, config.hotwatch.maxIndex).map(meme => ({ title: meme.title, heat: meme.heat })),
      cards,
      running: this.collector.busy || this.miner.busy,
      lastRun: lastRun ?? null,
      lastMine,
      nextRunAt: next ?? null,
      trend,
    }
  }

  /**
   * Apply one edit the owner made on the Settings page. An owner's card edit, rollback, or deletion becomes the new
   * baseline and restarts the agent's revision wait.
   * @param input - `{ op: 'remove' | 'keep', id }`, `{ op: 'block', term }`, `{ op: 'card', card }`,
   * `{ op: 'rollback', version }`, or `{ op: 'deleteVersion', version }`, as the page sent it; validated here.
   * @returns the panel after the edit, or the refusal (`not_found`, `invalid_input`, `current_version`) with the unchanged panel.
   */
  async edit(input: unknown): Promise<StyleEditAnswer> {
    const body = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
    const refuse = async (error: string): Promise<StyleEditAnswer> => ({ ok: false, error, panel: await this.panel() })
    try {
      switch (body['op']) {
        case 'remove': {
          const id = typeof body['id'] === 'string' ? body['id'] : ''
          const note = await this.notes.remove(id)
          const record = note === undefined ? await this.store.remove(id) : undefined
          /* v8 ignore next -- store.remove throws when the note is absent. */
          this.ctx.logger.info('speaking-style: the owner removed %s (%s); it is blocked', id, note?.kind ?? record?.source ?? 'sample')
          break
        }
        case 'keep': {
          const record = await this.store.keep(typeof body['id'] === 'string' ? body['id'] : '')
          this.ctx.logger.info('speaking-style: the owner kept %s (%s)', record.id, record.source)
          break
        }
        case 'block': {
          if (typeof body['term'] !== 'string' || termKey(body['term']) === '') return await refuse('invalid_input')
          await this.notes.block(body['term'])
          this.ctx.logger.info('speaking-style: the owner blocked a meme title')
          break
        }
        case 'card': {
          const card = typeof body['card'] === 'string' ? normalizeCard(body['card']) : undefined
          if (card === undefined || Array.from(card).length > this.config.persona.maxChars) return await refuse('invalid_input')
          const version = await this.notes.setCard({ card, author: 'owner', reason: card === '' ? 'deleted on the Settings page' : 'edited on the Settings page' })
          this.ctx.logger.info('speaking-style: the owner wrote card version %d (%d chars)', version.version, Array.from(card).length)
          break
        }
        case 'rollback': {
          const target = (await this.notes.cards()).find(card => card.version === body['version'])
          if (target === undefined) return await refuse('not_found')
          const version = await this.notes.setCard({ card: target.card, author: 'owner', reason: `rolled back to version ${String(target.version)}` })
          this.ctx.logger.info('speaking-style: the owner rolled the card back to version %d (now version %d)', target.version, version.version)
          break
        }
        case 'deleteVersion': {
          const version = body['version']
          const cards = await this.notes.cards()
          if (typeof version !== 'number' || !cards.some(card => card.version === version)) return await refuse('not_found')
          if (cards.at(-1)?.version === version) return await refuse('current_version')
          await this.notes.dropVersion(version)
          this.ctx.logger.info('speaking-style: the owner deleted card version %d from the history', version)
          break
        }
        default:
          return await refuse('invalid_input')
      }
    } catch (error: unknown) {
      if (!(error instanceof StyleError)) throw error
      return await refuse(error.code)
    }
    return { ok: true, panel: await this.panel() }
  }

  /**
   * Start a tone collection and then a meme-mining run without waiting for them; the panel says `running` until they
   * end. Nothing runs while off.
   * @returns the panel right after the start.
   */
  async collect(): Promise<StylePanel> {
    if (this.config.enabled && !this.collector.busy && !this.miner.busy) {
      void this.collector.run('manual', this.abort.signal)
        .then(async () => { await this.mine() })
        .then(async () => { await this.panel() })
        .catch((error: unknown) => { this.ctx.logger.warn('speaking-style: manual run failed: %s', error instanceof Error ? error.message : String(error)) })
    }
    return await this.panel()
  }

  /**
   * A `style_note` call: the platform comes from the calling Session's preset, the example must appear verbatim in what
   * that Session just read (QQ messages shown to a digest Session, or the results of the public-text tools in its log),
   * every field passes the note filter, and the guard allows the whole note.
   * @param input - the calling Session (and its log) and preset, the kind, the term, the meaning, the example, and related memes.
   * @returns `recorded`, `refreshed`, or `rejected` with a reason code.
   */
  async note(input: StyleNoteInput): Promise<WriteAnswer> {
    const answer = await this.admitNote(input)
    this.ctx.logger.info('speaking-style: style_note %s from session %s (%s): %s', input.kind, input.sessionId, input.preset, answer.status === 'rejected' ? `rejected (${answer.reason})` : answer.status)
    this.ctx.logger.debug('speaking-style: style_note %s', JSON.stringify({ term: input.term, meaning: input.meaning, example: input.example }))
    return answer
  }

  /** What a Session just read on `source`, for the verbatim check; undefined when the platform cannot be read. */
  private readOf(source: NoteSource, input: StyleNoteInput): string[] | undefined {
    const session = input.session === undefined ? [] : recentPublicText(input.session, source === 'web' ? { tools: WEB_TOOLS } : {})
    if (source !== 'qq') return input.session === undefined ? undefined : session
    const shown = this.ctx.get('qq')?.recentTextOf(input.sessionId)
    return shown === undefined && input.session === undefined ? undefined : [...shown ?? [], ...session]
  }

  private async admitNote(input: StyleNoteInput): Promise<WriteAnswer> {
    const reject = (reason: string): WriteAnswer => ({ status: 'rejected', reason })
    const on = input.kind === 'meme' ? this.config.memes.enabled : this.config.traits.enabled
    if (!this.config.enabled || !on) return reject('off')
    const source = this.config.notes.sources[input.preset]
    if (source === undefined) return reject('not_a_reader')
    // A trait describes a group's talk; a web page has no group.
    if (source === 'web' && input.kind === 'trait') return reject('not_a_reader')
    const texts = this.readOf(source, input)
    if (texts === undefined) return reject('unavailable')
    const term = normalizeLine(input.term)
    const meaning = input.kind === 'meme' && input.meaning !== undefined ? normalizeLine(input.meaning) : undefined
    const example = normalizeLine(input.example)
    if (input.kind === 'meme' && (meaning === undefined || meaning === '')) return reject('meaning_missing')
    const { termChars, textChars } = this.config.notes
    const related = input.kind === 'meme'
      ? (input.related ?? []).map(normalizeLine).filter((other, index, all) => termKey(other) !== '' && termKey(other) !== termKey(term)
        && all.findIndex(candidate => termKey(candidate) === termKey(other)) === index
        && screenNote(other, termChars, this.config.blocklist) === undefined).slice(0, MAX_RELATED)
      : []
    const refused = screenNote(term, termChars, this.config.blocklist) ?? screenNote(example, textChars, this.config.blocklist)
      ?? (meaning === undefined ? undefined : screenNote(meaning, textChars, this.config.blocklist))
    if (refused !== undefined) return reject(refused)
    if (!texts.some(text => normalizeLine(text).includes(example))) return reject('not_verbatim')
    const refusal = await this.gate.check([term, meaning ?? '', example, ...related].join('\n'), 'style_note', input.sessionId)
    if (refusal !== undefined) return reject(refusal)
    const outcome = await this.notes.note({
      kind: input.kind, term, ...meaning === undefined ? {} : { meaning }, example, source,
      ...related.length === 0 ? {} : { related }, ...input.kind === 'meme' ? { meaningSource: 'agent' as const } : {},
    })
    if (outcome === 'blocked') return reject('removed')
    await this.panel()
    return { status: outcome === 'added' ? 'recorded' : 'refreshed' }
  }

  /**
   * A `meme_lookup` call: the groups' own memes first, then HotWatch.
   * @param term - the meme as the index lists it (or one of its `related` terms).
   * @returns the meaning and where it came from, or `found: false`.
   */
  async lookup(term: string): Promise<LookupAnswer> {
    if (!this.config.enabled || !this.config.memes.enabled) return { found: false }
    const key = termKey(term)
    const memes = (await this.notes.notes()).filter(candidate => candidate.kind === 'meme')
    const note = memes.find(candidate => termKey(candidate.term) === key)
      ?? memes.find(candidate => candidate.related?.some(other => termKey(other) === key) ?? false)
    if (note !== undefined) {
      return {
        found: true, from: 'groups', term: note.term, meaning: note.meaning ?? '', example: note.example,
        ...note.related === undefined ? {} : { related: [...note.related] }, source: note.source,
        ...note.meaningSource === undefined ? {} : { meaningSource: note.meaningSource },
      }
    }
    if ((await this.notes.blocked()).has(key)) return { found: false }
    const hot = await this.hotwatch?.lookup(term)
    return hot === undefined ? { found: false } : { found: true, from: 'hotwatch', term: hot.title, meaning: hot.summary }
  }

  /**
   * A `persona_update` call: at most `persona.maxChars` characters, the note filter, the guard, and at least
   * `persona.minIntervalHours` since the last version (the agent's or the owner's; an owner edit on the Settings page
   * is never limited). The owner is told which version it became and how much changed, never the text, through
   * `ctx.ownerNotifier`, whose channel holds the notice while the owner sleeps.
   * @param input - the whole card, a one-line reason, and the writing Session.
   * @returns `recorded`, or `rejected` with a reason code.
   */
  async updateCard(input: { readonly card: string; readonly reason: string; readonly sessionId?: string }): Promise<WriteAnswer> {
    const reject = (reason: string): WriteAnswer => {
      this.ctx.logger.info('speaking-style: persona_update rejected (%s)', reason)
      return { status: 'rejected', reason }
    }
    if (!this.config.enabled || !this.config.persona.enabled) return reject('off')
    const card = normalizeCard(input.card)
    const refused = screenNote(card.replace(/\s+/gu, ' '), this.config.persona.maxChars, this.config.blocklist)
    if (refused !== undefined) return reject(refused)
    const last = (await this.notes.cards()).at(-1)
    if (last !== undefined && Date.now() - last.at < this.config.persona.minIntervalHours * 3_600_000) return reject('too_soon')
    const reason = Array.from(normalizeLine(input.reason)).slice(0, 120).join('')
    const refusal = await this.gate.check(`${card}\n${reason}`, 'persona', input.sessionId)
    if (refusal !== undefined) return reject(refusal)
    const version = await this.notes.setCard({ card, author: 'agent', reason })
    const before = Array.from(last?.card ?? '').length
    const after = Array.from(card).length
    this.ctx.logger.info('speaking-style: persona card version %d by the agent (%d → %d chars)', version.version, before, after)
    const notifier = this.ctx.get('ownerNotifier')
    if (notifier !== undefined) {
      await notifier.send({
        title: `人设卡更新到第 ${String(version.version)} 版`, body: `${String(before)} → ${String(after)} 字（设置 → 说话风格 可回滚）`,
        safety: true, origin: 'speaking-style (the persona card; size only)',
      }).catch((error: unknown) => { this.ctx.logger.warn('speaking-style: card notice failed: %s', error instanceof Error ? error.message : String(error)) })
    }
    return { status: 'recorded' }
  }
}

const isHotSource = (value: object | undefined): value is HotSource =>
  value !== undefined && 'comments' in value && typeof value.comments === 'function' && 'words' in value && typeof value.words === 'function'

/** A card with its lines trimmed and empty lines collapsed. */
function normalizeCard(text: string): string {
  return text.split('\n').map(line => line.trim()).filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== '')).join('\n').trim()
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
