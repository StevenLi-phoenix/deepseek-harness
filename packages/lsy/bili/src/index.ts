/**
 * The agent's own Bilibili account (`ctx.bili`). The owner signs it in once
 * by scanning a web QR code from Settings; the cookies and refresh token live
 * in one credential record and are refreshed daily. The account's long-lived
 * Session wakes on a body clock and when its inbox has something new, and
 * `ctx.ownerRelay` hands each woken turn's final answer to the account's DM
 * channel (`src/dm.ts`), which messages the owner. Every write passes one
 * host-side guard (identity check, daily caps, one comment per video, a
 * random gap, a durable ledger), and risk-control answers pause writes until
 * the owner resumes them in Settings. Nothing here can be cleared by the model.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
// Type-only: ctx.agentDefaultModel, the profile's default model route.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
// Type-only: the ctx.lsyNotifier service the WeChat channel provides.
import type {} from '@deepseek-ai/dsh-lsy-event-bus'
// Type-only: ctx.ownerRelay, which relays the account's turns through its DM channel.
import type {} from '@deepseek-ai/dsh-owner-relay'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: ctx.sessionProjections, where an explicit model pick waits for its first request.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { encode } from 'uqr'
import {
  addReply, addWatchLater, bvidOf, coinsGiven, commentRows, comments, createDynamic, dailyRewards, dealFavorite, folders, followingFeed,
  danmaku, giveCoin, hasLiked, homeFeed, hotSearches, inboxItems, likeVideo, ranking, modifyRelation, navInfo, ownerMessages, popular,
  relationStat, relationTo,
  removeWatchLater, reportShare, reportWatch, search, sendMessage, subtitles, thread, threadRows, tripleLike, unreadCounts, videoInfo,
  VIDEO_AREA, watchLaterAids,
  type CommentView, type DanmakuLine, type FeedPost, type Folder, type HotSearch, type InboxItem, type OwnerMessage, type SearchOrder,
  type SubtitleView, type VideoCard, type VideoDetail,
} from './api.ts'
import type { DailyRewards } from './api.ts'
import {
  REFRESH_PUBLIC_KEY, buvidFp, confirmRefresh, deviceCookies, devicePayload, enrollDevice, exchangeRefresh, newDeviceIds, parseGrant,
  pollQr, webTicket,
  refreshNeeded, startQr, type BiliGrant, type QrPoll,
} from './auth.ts'
import { BiliApiError, BiliClient, BiliRefused, BiliRiskError, BiliTransportError, BiliVerifyError, USER_AGENT } from './client.ts'
import { nextPlanned, rollPlan, settlePlan, windowProblem, type WakeWindow } from './clock.ts'
import type { CookieJar } from './cookies.ts'
import { BILI_AGENT_ORIGIN, BILI_NOTICE_ORIGIN, BILI_RELAY_CHANNEL, DmChannel } from './dm.ts'
import { ENDPOINTS, type Endpoint, type EndpointName } from './endpoints.ts'
import { WEEKDAYS, nextOffPeak, peakAt, pricingProblem, routeOf, ruleFor, type PricingRule, type Route } from './pricing.ts'
import {
  DEFAULT_CAPS, HARD_CAPS, alreadyTaken, lastWrite, ledgerRows, nextSlot, pauseRefusal, remaining, reserve, settle,
  settleInterrupted, takeSlot,
  uncertainBefore, usage,
} from './guard.ts'
import {
  SPEECH_ACTIONS, TRIPLE_PARTS, biliDomain, seqKey,
  type AccountRecord, type FindRecord, type LedgerRecord, type PendingRecord, type PlanRecord, type SeenRecord, type TasteRecord,
  type TrendRecord, type TriplePart, type WriteAction,
} from './storage.ts'
import { NOTICES, TEXT_LIMITS, clean, codePoints, continuePrompt, inboxPrompt, wakePrompt } from './text.ts'
import { dayKey, formatGap, formatStamp, isTimeZone, localTime, nextDayStart } from './time.ts'
import {
  BILI_PATH, CAPPED_ACTIONS, GRADES, HOST_REPORTS, MAX_INTERESTS_CHARS, MAX_KEYWORDS_CHARS, TASTE_LIMITS, TREND_LIMITS,
  VERDICT_CHARS, VERIFY_KINDS, type Grade, type SeenView, type BiliView, type ProgressView, type LoginView, type ManualWakeView,
  type RouteView,
  type VerifyKind, type WakeReason, type CappedAction,
} from './view.ts'

export { BiliApiError, BiliClient, BiliRefused, BiliRiskError, BiliTransportError, allowedEndpoint, parseJson, RISK_CODES, USER_AGENT } from './client.ts'
export { ENDPOINTS, type Endpoint, type EndpointName } from './endpoints.ts'
export { DEFAULT_CAPS, HARD_CAPS } from './guard.ts'
export { COVERAGE, LIMITS, type CommentView, type FeedPost, type Folder, type HotSearch, type InboxItem, type OwnerMessage, type SearchOrder, type SubtitleView, type VideoCard, type VideoDetail } from './api.ts'
export { REFRESH_PUBLIC_KEY, correspondPath, refreshCsrf, type BiliGrant } from './auth.ts'
export { TEXT_LIMITS, UNTRUSTED_NOTE, UNTRUSTED_TAG, clean, untrusted } from './text.ts'
export { signQuery, mixinKey } from './wbi.ts'
export { WEEKDAYS, nextOffPeak, offPeakParts, peakAt, routeOf, type PeakSpan, type PricingRule, type Route, type Weekday } from './pricing.ts'
export * from './view.ts'
export type { LedgerRecord, PlanRecord } from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The agent's own Bilibili account. */
    bili: BiliAccount
  }
}

/** How the account's Session is created. */
export interface SessionConfig {
  /** Absolute directory the Session works in; created before every wake. */
  workspacePath: string
  /** Agent preset of the Session; the bundle defines `bili` with only the Bilibili tools. */
  agentPreset: string
  /** Permission preset set on a new Session; the `bili` preset mounts no shell or file tools, and nobody approves calls. */
  permissionPreset: string
  /** Session title. */
  title: string
}

/**
 * Daily write caps; each is bounded by a hard maximum in code. Coins have no
 * daily cap: the coin balance and Bilibili's per-video rule limit them.
 */
export interface CapsConfig {
  /** Accounts followed per day. */
  follow: number
  /** Accounts unfollowed per day. */
  unfollow: number
  /** Favorite additions and removals per day. */
  favorite: number
  /** Videos liked per day. */
  like: number
  /** Watch-later additions and removals per day. */
  watchlater: number
  /** Top-level comments per day; one per video ever. */
  comment: number
  /** Replies per day; one per answered comment ever. */
  reply: number
  /** Text dynamics per day. */
  dynamic: number
  /**
   * Messages the account sends the owner's main account on its own (a turn's share, or
   * `bili_dm_owner`) per day; answers to the owner's own messages have no cap.
   */
  dmOwner: number
  /** Watch reports per day: one per video whose subtitles the account read. */
  watch: number
  /** Share reports per day: one per video ever, for a link the host delivered to the owner. */
  share: number
}

/** The watch floor of a wake. */
export interface DepthConfig {
  /** Distinct videos opened with `video()` before an answer goes out. */
  minWatched: number
  /** Continuation turns at most per wake. */
  maxRounds: number
}

/** Plugin configuration. */
export interface Config {
  /**
   * The owner's main account (UID); the only account this one may message. The UID set in
   * Settings wins, so a deployment can keep it out of committed files. Unset, messaging is off.
   */
  ownerMid?: number
  /** IANA time zone of the body clock, day boundaries for caps, and prompt times. */
  timeZone: string
  /** Daily wake windows in `timeZone` (`HH:MM`, start inclusive, end exclusive, same day); one random wake in each. */
  wakes: WakeWindow[]
  /** Probability (0-1) that a window gets no wake on a given day. */
  skipChance: number
  /**
   * How much a body-clock or Wake-now wake watches before its answer goes out: a turn that ends
   * with fewer than `minWatched` distinct videos opened is held back, and the Session is asked to
   * keep browsing, at most `maxRounds` times; then the last answer goes out. `minWatched` 0 holds nothing.
   */
  depth: DepthConfig
  /** What the owner is interested in, shown in every wake prompt until edited in Settings. */
  interests: string
  /** Search keywords every wake searches first, newest first, until the owner edits them in Settings. */
  keywords: string[]
  /** Videos graded must that may go to the owner per day (the day's picks); 0 sets no quota. */
  picksPerDay: number
  /** Messages the account's Session may send the owner's main agent per day (`bili_tell_main_agent`); 0 turns them off. */
  mainAgentPerDay: number
  /** The account's Session. */
  session: SessionConfig
  /** Daily write caps. */
  caps: CapsConfig
  /** Shortest gap between two writes, in milliseconds. */
  writeGapMinMs: number
  /** Longest gap between two writes, in milliseconds; each gap is random between the two. */
  writeGapMaxMs: number
  /** How long a write waits for its slot before it answers "try later", in milliseconds. */
  writeWaitMs: number
  /** Shortest gap before a reply to the owner's message, in milliseconds; a conversation needs no minutes-long gap. */
  dmReplyGapMinMs: number
  /** Longest gap before a reply to the owner's message, in milliseconds. */
  dmReplyGapMaxMs: number
  /** Shortest gap between two requests, in milliseconds. */
  requestGapMs: number
  /** Extra random gap of up to this many milliseconds per request. */
  requestJitterMs: number
  /** Deadline of one request, in milliseconds. */
  requestTimeoutMs: number
  /** Inbox check period, in milliseconds; checks cost no model tokens. */
  inboxPollMs: number
  /** Most inbox wakes per rolling hour; later items wait. */
  inboxWakesPerHour: number
  /** How long reads back off after a risk-control answer, in milliseconds. */
  readBackoffMs: number
  /** Delay before checking that an accepted comment or reply is visible to others, in milliseconds. */
  visibilityCheckMs: number
  /** Cookie check period, in milliseconds; a refresh happens when Bilibili asks for one. */
  refreshCheckMs: number
  /** PEM public key Bilibili's web client uses for the cookie-refresh path; change it only if Bilibili rotates it. */
  refreshPublicKey: string
  /**
   * Time-of-day pricing of model routes, in UTC. While the account's Session runs on a listed
   * provider, body-clock wakes fall only outside `peak` (a window is clipped to its off-peak part, or
   * moved past the peak it lies in), and wakes and inbox items that come due in a peak wait for it to
   * end. Empty: wakes ignore pricing.
   */
  pricing: PricingRule[]
}

const capsSchema = z.object(Object.fromEntries(CAPPED_ACTIONS.map(action => [
  action, z.natural().max(HARD_CAPS[action]).default(DEFAULT_CAPS[action]),
]))) as unknown as z<CapsConfig>

/** Configuration schema. */
export const Config: z<Config> = z.object({
  ownerMid: z.natural(),
  timeZone: z.string().default('America/New_York'),
  wakes: z.array(z.object({ start: z.string(), end: z.string() })).default([{ start: '12:00', end: '14:00' }, { start: '19:30', end: '23:30' }]),
  skipChance: z.number().min(0).max(1).default(0.15),
  depth: z.object({
    minWatched: z.natural().max(30).default(0),
    maxRounds: z.natural().max(6).default(3),
  }),
  interests: z.string().default(''),
  keywords: z.array(z.string()).default([]),
  picksPerDay: z.natural().max(50).default(0),
  mainAgentPerDay: z.natural().max(20).default(5),
  session: z.object({
    workspacePath: z.string().default('/Users/dsh-runtime/bili'),
    agentPreset: z.string().default('bili'),
    permissionPreset: z.string().default('danger-full-access'),
    title: z.string().default('B站'),
  }),
  caps: capsSchema,
  writeGapMinMs: z.natural().min(60_000).default(60_000),
  writeGapMaxMs: z.natural().min(60_000).default(180_000),
  writeWaitMs: z.natural().max(600_000).default(200_000),
  dmReplyGapMinMs: z.natural().min(1000).default(3000),
  dmReplyGapMaxMs: z.natural().min(1000).default(10_000),
  requestGapMs: z.natural().min(1000).default(1200),
  requestJitterMs: z.natural().default(800),
  requestTimeoutMs: z.natural().min(1000).default(15_000),
  inboxPollMs: z.natural().min(120_000).default(600_000),
  inboxWakesPerHour: z.natural().max(6).default(2),
  readBackoffMs: z.natural().min(60_000).default(1_800_000),
  visibilityCheckMs: z.natural().min(30_000).default(300_000),
  refreshCheckMs: z.natural().min(3_600_000).default(86_400_000),
  refreshPublicKey: z.string().default(REFRESH_PUBLIC_KEY),
  pricing: z.array(z.object({
    providers: z.array(z.string()),
    peak: z.array(z.object({ days: z.array(z.union(WEEKDAYS)), start: z.string(), end: z.string() })),
    noPeakDates: z.array(z.string()),
  })).default([]),
})

/** The credential record of the account. */
export const GRANT_KEY: CredentialKey = credentialKey('bili', 'account')
/** QR codes expire after this long. */
const QR_LIFETIME_MS = 180_000
/** QR poll period. */
const QR_POLL_MS = 2000
/** First cookie check after start. */
const FIRST_SESSION_CHECK_MS = 60_000
/** Resolve failures that keep the stored Session: it exists and is only unavailable right now. */
const TRANSIENT_RESOLVE_CODES: ReadonlySet<string> = new Set(['session/agent-busy', 'session/writer-held'])
/** Inbox ids remembered per kind. */
const MAX_SEEN = 500
/** Inbox items waiting for a wake; the oldest are dropped first. */
const MAX_PENDING = 100
/** Comments the account may answer; the oldest are forgotten first. */
const MAX_TARGETS = 2000
/** Inbox items handed over per wake. */
const MAX_WAKE_ITEMS = 20
/** Wake log rows kept. */
const MAX_WAKE_ROWS = 400
/** After a message from the owner, messages are checked this often ... */
const FAST_POLL_MS = 60_000
/** ... for this long after the latest one. */
const CONVERSATION_MS = 900_000
/** A second Wake now within this long of a started one is refused (a double click). */
const MANUAL_WAKE_DEBOUNCE_MS = 60_000
/** A deferred wake not fired within this long after its new time is missed. */
const DEFER_GRACE_MS = 3_600_000
/** Plans kept, in days. */
const PLAN_DAYS = 14
/** Journal limits. */
export const JOURNAL_LIMITS = { chars: 600, perDay: 8, pageSize: 10 } as const
/** Code points of one message to the owner's main agent. */
export const MAIN_AGENT_MAX_CHARS = 2000
/** Finds kept; the oldest go first. */
const MAX_FINDS = 30
/** Finds a wake prompt lists. */
const FINDS_IN_PROMPT = 5
/** Finds Settings shows. */
const FINDS_IN_VIEW = 10
/** Hot-search keywords read at once. */
const HOT_SEARCHES = 30
/** A web ticket this close to expiring is renewed. */
const TICKET_RENEW_MS = 86_400_000
/** Graded videos kept; the oldest go first. */
const MAX_SEEN_VIDEOS = 2000
/** Graded videos Settings shows. */
const SEEN_IN_VIEW = 100
/** Videos whose subtitles were read, remembered as the evidence a must grade needs. */
const MAX_READ = 500
/** Keywords a wake lists. */
const MAX_KEYWORDS = 12
/** Danmaku lines one read returns. */
const DANMAKU_LINES = 40
/** Fresh trends a wake prompt lists. */
const TRENDS_IN_PROMPT = 15
/** The owner's first message within this long after a find is kept as how they took it. */
const REACTION_WINDOW_MS = 86_400_000
/** Code points of a kept reaction. */
const REACTION_CHARS = 200
/** Titles of watched videos remembered for the finds that link them. */
const MAX_TITLES = 200
/** Pause between a held turn's end and its continuation prompt, so the Session is idle again. */
const CONTINUE_DELAY_MS = 3000

/** A body-clock or Wake-now wake in progress: what it opened, and how many continuations it had. */
interface WakeRun {
  readonly sessionId: string
  readonly reason: WakeReason
  /** Distinct BV ids opened with `video()` since the wake's prompt. */
  readonly watched: Set<string>
  rounds: number
}

/** What a write tool learns. */
export type WriteOutcome =
  | { readonly outcome: 'sent'; readonly detail: string; readonly receipt?: string }
  | { readonly outcome: 'already'; readonly detail: string }
  /** `verification` carries Bilibili's words when it refused for want of a verified phone number. */
  | { readonly outcome: 'refused'; readonly detail: string; readonly verification?: string }
  | { readonly outcome: 'uncertain'; readonly detail: string }

/** A write the guard runs. */
interface WriteSpec {
  action: WriteAction
  target: string
  text?: string
  area?: { type: number; oid: string; root?: string }
  /** Refusals that need a read (relation, ownership); checked before the slot. */
  check?: () => Promise<string | undefined>
  /** Whether it is already done; checked before the slot, so an idempotent write costs nothing. */
  preRead?: () => Promise<string | undefined>
  /** Send the one request; returns the receipt. */
  perform: () => Promise<string | undefined>
  /** Check later that others can see it. */
  visibility?: boolean
  /** How long it may wait for its slot; `writeWaitMs` by default. */
  maxWaitMs?: number
  /** Coins it gives, recorded on its ledger row. */
  coins?: () => number | undefined
  /** Triple parts it adds: read at reservation (what the pre-read found missing) and again once Bilibili answered. */
  adds?: () => readonly TriplePart[]
  /** The `sent` outcome's detail; `<action> sent` by default. */
  sentDetail?: () => string
}

/** The account card and budget the `bili_me` tool shows. */
export interface MeView {
  signedIn: boolean
  mid?: number
  uname?: string
  level?: number
  following?: number
  followers?: number
  folders?: Folder[]
  /** EXP: the current total, the level's floor, and the next level's threshold (null at LV6). */
  exp?: { current: number; min: number; next: number | null }
  /** Coin balance. */
  coins?: number
  /** Today's daily rewards (5 EXP each for login, watch, share; up to 50 EXP from coins). */
  rewards?: DailyRewards
  budget: Record<CappedAction, number>
  pause?: string
  readsResumeAt?: string
}

/** The inbox the `bili_inbox` tool shows. */
export interface InboxView {
  unread: { replies: number; mentions: number; messages: number }
  replies: Omit<InboxItem, 'type' | 'oid' | 'root'>[]
  mentions: Omit<InboxItem, 'type' | 'oid' | 'root'>[]
  ownerMessages: OwnerMessage[]
}

/** A login attempt in progress. */
interface LoginAttempt {
  view: LoginView
  key?: string
}

/** The slice of the connection service the Settings route uses. */
interface BiliConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** Human-readable error text; client errors never carry request data. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (!isAbsolute(config.session.workspacePath)) throw new Error('bili: session.workspacePath must be an absolute path')
  if (config.session.title.trim() === '') throw new Error('bili: session.title must be non-empty')
  if (!isTimeZone(config.timeZone)) throw new Error(`bili: timeZone "${config.timeZone}" is not a valid IANA time zone`)
  const problem = windowProblem(config.wakes)
  if (problem !== undefined) throw new Error(`bili: ${problem}`)
  if (config.writeGapMaxMs < config.writeGapMinMs) throw new Error('bili: writeGapMaxMs must not be below writeGapMinMs')
  if (config.dmReplyGapMaxMs < config.dmReplyGapMinMs) throw new Error('bili: dmReplyGapMaxMs must not be below dmReplyGapMinMs')
  if (!config.refreshPublicKey.includes('BEGIN PUBLIC KEY')) throw new Error('bili: refreshPublicKey must be a PEM public key')
  const pricing = pricingProblem(config.pricing)
  if (pricing !== undefined) throw new Error(`bili: ${pricing}`)
}

/** A route as the clock decides by: where it came from and whether it is priced. */
type CheckedRoute = Route & { rule: PricingRule | undefined }

/** How a log line names a route. */
function routeText(route: CheckedRoute | undefined): string {
  if (route === undefined) return 'an unknown model route (no time-of-day pricing)'
  return `${route.provider}/${route.model} (${route.source} route, ${route.rule === undefined ? 'no time-of-day pricing' : 'off-peak pricing'})`
}

/** Ledger fields of a comment area. */
/** The daily cap of an action, or undefined for coins, which have none. */
function capOf(caps: CapsConfig, action: WriteAction): number | undefined {
  return (caps as Partial<Record<WriteAction, number>>)[action]
}

/** Which phone-verification hint a write belongs to: messages to the owner, or public speech. */
function verifyKind(action: WriteAction): VerifyKind | undefined {
  if (action === 'dmOwner' || action === 'dmReply') return 'message'
  return SPEECH_ACTIONS.has(action) ? 'speech' : undefined
}

/** `1 coin`, `2 coins`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Why the balance cannot cover a coin write, or nothing. */
function balanceRefusal(balance: number, needed: number): string | undefined {
  return balance < needed ? `the account has ${plural(balance, 'coin')}; this needs ${needed} (about one comes each day from signing in)` : undefined
}

/** What a triple did: the parts it added, and those done before. */
function tripleDetail(added: readonly TriplePart[], before: readonly TriplePart[], coins: number): string {
  const words: Record<TriplePart, string> = { like: 'liked', coin: `gave ${plural(coins, 'coin')}`, favorite: 'saved to the default folder' }
  const head = added.length === 0 ? 'Bilibili applied none of the missing parts' : added.map(part => words[part]).join(', ')
  return before.length === 0 ? head : `${head}; already done before: ${before.join(', ')}`
}

/** Bilibili's coin refusals, explained. */
const COIN_CODES: Readonly<Record<number, string>> = {
  [-104]: 'not enough coins',
  34002: 'an account cannot coin its own video',
  34003: 'that coin count is not allowed for this video',
  34004: 'coins were given too quickly',
  34005: 'this video already has the most coins this account may give',
}

/** A hint after a coin or triple refusal code, or nothing. */
function coinCodeHint(action: WriteAction, code: number): string {
  const hint = action === 'coin' || action === 'triple' ? COIN_CODES[code] : undefined
  return hint === undefined ? '' : `: ${hint}`
}

function areaFields(area: WriteSpec['area']): Partial<Pick<LedgerRecord, 'type' | 'oid' | 'root'>> {
  if (area === undefined) return {}
  return { type: area.type, oid: area.oid, ...(area.root === undefined ? {} : { root: area.root }) }
}

/** The account card of the Settings view. */
function accountView(account: AccountRecord): BiliView['account'] {
  const { state, mid, uname, level, loggedInAt, refreshedAt, checkedAt, reason } = account
  return {
    state, mid, uname, level, loggedInAt, refreshedAt,
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(reason === undefined ? {} : { reason }),
  }
}

/** QR modules as rows of `0`/`1`. */
function qrModules(text: string): string[] {
  return encode(text, { border: 1 }).data.map(row => row.map(dark => (dark ? '1' : '0')).join(''))
}

/**
 * The agent's own Bilibili account: sign-in, cookie refresh, guarded writes,
 * the body clock, the inbox poll, the DM channel of the owner relay, and the Settings route.
 */
export class BiliAccount extends Service {
  static inject = ['timer', 'storageDomain', 'credentials', 'sessionController', 'permissionPresets', 'sessionTitle']
  static Config = Config

  private readonly ready: Promise<Domain<typeof biliDomain>>
  private readonly client: BiliClient
  private readonly abort = new AbortController()
  private readonly inflight = new Set<Promise<void>>()
  private readonly visibilityTimers = new Map<string, () => void>()
  private readonly timers = new Set<() => void>()
  private domain: Domain<typeof biliDomain> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private writes: Promise<unknown> = Promise.resolve()
  private stopping = false
  private clockTimer: (() => void) | undefined
  private login: LoginAttempt = { view: { state: 'idle' } }
  private sessionCheck: Promise<void> | undefined
  private feedIndex = 0
  /** The model route of the last check, for the Settings view. */
  private lastRoute: CheckedRoute | undefined
  /** Delivers waiting inbox items when a peak ends. */
  private inboxTimer: { at: number; dispose: () => void } | undefined
  /** The owner's last Wake now, for the Settings view. */
  private manual: ManualWakeView | undefined
  /** When the last Wake now that was not refused began; it debounces double clicks. */
  private manualStartedAt = -Infinity
  /** The account's channel of `ctx.ownerRelay`: woken turns' answers as Bilibili messages to the owner. */
  private readonly dm: DmChannel
  /** The owner's conversation keeps the fast message check until then. */
  private conversationUntil = 0
  /** The next fast message check, while the owner is messaging. */
  private fastPoll: (() => void) | undefined
  /** An inbox check is running; another one waits for the next tick. */
  private inboxPolling = false
  /** The body-clock or Wake-now wake in progress, until its answer goes out or it ends. */
  private wakeRun: WakeRun | undefined
  /** Titles and uploaders of videos the account opened, for finds and grades; oldest first. */
  private readonly titles = new Map<string, { title: string; author: string }>()
  /** Videos whose subtitles the account read: the evidence a must grade needs; oldest first. */
  private readonly read = new Set<string>()

  /**
   * @param ctx - Host services owning timers, storage, credentials, and Sessions.
   * @param config - owner account, body clock, caps, pacing, and Session settings.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'bili')
    assertConfig(config)
    this.client = new BiliClient({
      jar: () => this.jar(),
      admit: (name, entry) => { this.admit(name, entry) },
      onRisk: (name, _entry, reason) => { this.track(this.brake(name, reason)) },
      sleep: ms => this.sleep(ms),
      random: () => Math.random(),
      debug: (message) => { ctx.logger.debug(`bili: ${message}`) },
      info: (message) => { ctx.logger.info(`bili: ${message}`) },
    }, { gapMs: config.requestGapMs, jitterMs: config.requestJitterMs, timeoutMs: config.requestTimeoutMs })
    this.ready = ctx.storageDomain.open(biliDomain)
    this.dm = new DmChannel({
      messageOwner: (action, text, maxWaitMs) => this.messageOwner(action, text, maxWaitMs),
      reportShares: (text) => { this.delivered(text) },
      hold: work => this.hold(work),
      continueWake: (sessionId, origin, draft) => this.continueWake(sessionId, origin.reason, draft),
      endWake: (sessionId) => { this.endWake(sessionId, 'its turn did not complete') },
      notifier: () => this.ctx.get('lsyNotifier'),
      logger: { info: (message) => { ctx.logger.info(message) }, warn: (message) => { ctx.logger.warn(message) } },
    })

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const cleanup = ctx.effect(() => async () => {
        this.stopping = true
        this.abort.abort(new Error('bili is stopping'))
        this.clockTimer?.()
        this.inboxTimer?.dispose()
        this.fastPoll?.()
        for (const dispose of [...this.timers, ...this.visibilityTimers.values()]) dispose()
        await Promise.allSettled([...this.inflight])
        await this.chain
        await this.writes
        await domain.close()
      }, 'bili.lifecycle()')
      await this.restore(domain)
      return cleanup
    }, 'bili.init()')

    // The relay delivers the account's answers through the DM channel whenever it is mounted.
    ctx.plugin({
      name: 'bili-owner-relay',
      inject: ['ownerRelay'],
      apply: (child: Context) => {
        child.effect(() => this.joinRelay(child), 'bili: ownerRelay')
      },
    })

    // The Settings route mounts whenever the connection service is present; the account works without it.
    ctx.plugin({
      name: 'bili-settings-route',
      inject: ['connection'],
      apply: (child: Context) => {
        const connection = Reflect.get(child, 'connection') as BiliConnection
        child.effect(() => connection.fetch.register({
          path: BILI_PATH,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: request => this.route(request),
        }), 'bili: /api/bili')
      },
    })
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Settle interrupted writes, re-arm visibility checks, and start the clock, inbox poll, and cookie checks. */
  private async restore(domain: Domain<typeof biliDomain>): Promise<void> {
    const interrupted = await this.serialize(() => settleInterrupted(domain, Date.now()))
    if (interrupted > 0) this.ctx.logger.warn(`bili: ${interrupted} write(s) were in flight when the host stopped; recorded as uncertain and never retried`)
    for (const row of ledgerRows(domain)) {
      if (row.visibility === 'pending') this.armVisibility(row)
    }
    const account = domain.table('account').get('current')
    this.ctx.logger.info(account === undefined
      ? 'bili: no account signed in; sign in from Settings → Bilibili account'
      : `bili: account ${account.uname} (${account.mid}) is ${account.state}`)
    await this.armClock()
    this.every(this.config.inboxPollMs, () => this.pollInbox())
    // An account signed in before enrollment, or whose enrollment failed, enrolls once the start check is done.
    this.after(FIRST_SESSION_CHECK_MS, async () => {
      try {
        await this.checkSession('start')
      } finally {
        await this.enroll('start')
        await this.ticket('start')
      }
    })
    this.every(this.config.refreshCheckMs, async () => {
      await this.checkSession('daily')
      await this.ticket('daily')
    })
  }

  /**
   * Keep the jar's `bili_ticket` (and `bili_ticket_expires`) fresh, as a browser does: a new ticket
   * from GenWebTicket when there is none or it expires within a day. A failure is logged; the next
   * check tries again.
   */
  private async ticket(why: string): Promise<void> {
    const grant = await this.grant()
    // Signed in (a session cookie), whether or not sign-in has finished recording the account.
    if (grant?.cookies['SESSDATA'] === undefined || this.account()?.state === 'login-needed') return
    const expires = Number(grant.cookies['bili_ticket_expires'] ?? 0) * 1000
    if (grant.cookies['bili_ticket'] !== undefined && expires - Date.now() > TICKET_RENEW_MS) return
    let fresh: { bili_ticket: string; bili_ticket_expires: string }
    try {
      fresh = await webTicket(this.client, Date.now())
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: could not get a web ticket (${why}): ${errorText(error)}`)
      return
    }
    const current = await this.grant()
    if (current === undefined) return
    await this.storeGrant({ ...current, cookies: { ...current.cookies, ...fresh } })
    this.ctx.logger.info(`bili: got a web ticket until ${formatStamp(Number(fresh.bili_ticket_expires) * 1000, this.config.timeZone)} (${why})`)
  }

  /** Run storage work one piece at a time; rejections reach the caller without breaking the chain. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work)
    this.chain = result.catch(() => undefined)
    return result
  }

  /** Keep background work alive until teardown drains it. */
  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.ctx.logger.warn(`bili: background work failed: ${errorText(error)}`)
    }).finally(() => this.inflight.delete(tracked))
    this.inflight.add(tracked)
  }

  /** Keep work another service awaits alive until teardown drains it; its outcome stays the caller's. */
  private hold<T>(work: Promise<T>): Promise<T> {
    const held = work.then(() => undefined, () => undefined).finally(() => this.inflight.delete(held))
    this.inflight.add(held)
    return work
  }

  /** Run `work` once after `ms`. */
  private after(ms: number, work: () => Promise<void>): void {
    const dispose = this.ctx.timeout(() => {
      this.timers.delete(dispose)
      if (!this.stopping) this.track(work())
    }, ms)
    this.timers.add(dispose)
  }

  /** Run `work` every `ms`, never two at once. */
  private every(ms: number, work: () => Promise<void>): void {
    let running = false
    const dispose = this.ctx.interval(() => {
      if (running || this.stopping) return
      running = true
      this.track(work().finally(() => { running = false }))
    }, ms)
    this.timers.add(dispose)
  }

  /** Resolve after `ms`; rejects when the plugin stops. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.abort.signal
      if (signal.aborted) {
        reject(signal.reason as Error)
        return
      }
      const done = (): void => {
        signal.removeEventListener('abort', stop)
        resolve()
      }
      const dispose = this.ctx.timeout(done, ms)
      const stop = (): void => {
        dispose()
        reject(signal.reason as Error)
      }
      signal.addEventListener('abort', stop, { once: true })
    })
  }

  // ── Credentials and account state ──────────────────────────────────────

  /** The stored session, read per use. */
  private async grant(): Promise<BiliGrant | undefined> {
    const record = await this.ctx.credentials.readRecord(GRANT_KEY)
    return record?.kind === 'grant' ? parseGrant(record.payload) : undefined
  }

  /** Replace the stored session in one write. */
  private async storeGrant(grant: BiliGrant): Promise<void> {
    await this.ctx.credentials.modifyRecord(GRANT_KEY, () => Promise.resolve({ kind: 'grant', payload: grant }))
  }

  /** Cookies for the client while the account is usable. */
  private async jar(): Promise<CookieJar | undefined> {
    return (await this.grant())?.cookies
  }

  /** The stored account facts. */
  private account(): AccountRecord | undefined {
    return this.domain?.table('account').get('current')
  }

  /** Merge facts into the stored account. */
  private async updateAccount(change: Partial<AccountRecord>): Promise<void> {
    await this.serialize(async () => {
      const domain = await this.ready
      const current = domain.table('account').get('current')
      if (current !== undefined) await domain.table('account').put('current', { ...current, ...change })
    })
  }

  /** Refuse reads while they back off after a risk signal. */
  private admit(name: EndpointName, entry: Endpoint): void {
    if (entry.kind !== 'read') return
    const backoff = this.domain?.table('backoff').get('reads')
    if (backoff !== undefined && backoff.until > Date.now()) {
      throw new BiliRefused(`reads are backing off for ${formatGap(backoff.until - Date.now())} after risk control (${backoff.reason}); ${name} was not sent`)
    }
  }

  /** Tell the owner on WeChat, labelled as a host notice; a missing or failing channel only costs the message. */
  private async notify(title: string): Promise<void> {
    const notifier = this.ctx.get('lsyNotifier')
    if (notifier === undefined) {
      this.ctx.logger.warn(`bili: no lsyNotifier to tell the owner: ${title}`)
      return
    }
    try {
      await notifier.send({ title, origin: BILI_NOTICE_ORIGIN })
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: notifying the owner failed: ${errorText(error)}`)
    }
  }

  /**
   * Risk control answered, and the owner hears once per pause. A read (or sign-in step) backs reads
   * off and pauses every write; a message to the owner pauses every write; any other write (a like,
   * favorite, follow, comment) pauses only public writes, so messages to the owner and reading go on.
   * Each pause lasts until the owner resumes it in Settings; a wider one replaces a narrower one.
   */
  private async brake(name: EndpointName, reason: string): Promise<void> {
    const now = Date.now()
    const endpoint = ENDPOINTS[name]
    const scope: 'all' | 'public' = endpoint.kind === 'write' && name !== 'dmSend' ? 'public' : 'all'
    const reads = endpoint.kind !== 'write'
    const fresh = await this.serialize(async () => {
      const domain = await this.ready
      if (reads) await domain.table('backoff').put('reads', { until: now + this.config.readBackoffMs, reason })
      const current = domain.table('pause').get('writes')?.scope
      if (current === 'all' || current === scope) return false
      await domain.table('pause').put('writes', { scope, reason, since: now })
      return true
    })
    const what = scope === 'all' ? 'writes are paused' : 'public writes are paused (messages to the owner still go)'
    this.ctx.logger.error(`bili: risk control on ${name} (${reason}); ${reads ? `reads back off for ${formatGap(this.config.readBackoffMs)}, ` : ''}${what} until the owner resumes them in Settings`)
    if (fresh) await this.notify(scope === 'all' ? NOTICES.riskPaused(reason) : NOTICES.publicPaused(reason))
  }

  /** The session is gone and cannot be refreshed: stop writes and tell the owner once. */
  private async loginNeeded(reason: string): Promise<void> {
    const account = this.account()
    if (account === undefined) return
    await this.updateAccount({ state: 'login-needed', reason, noticeSent: true })
    this.ctx.logger.warn(`bili: ${account.uname} (${account.mid}) needs a new login: ${reason}`)
    if (account.noticeSent !== true || account.state !== 'login-needed') await this.notify(NOTICES.loginNeeded)
  }

  /**
   * Check the cookies against `cookie/info` and refresh them when Bilibili
   * asks. Concurrent triggers share one check.
   */
  private checkSession(trigger: string): Promise<void> {
    this.sessionCheck ??= this.runSessionCheck(trigger).finally(() => { this.sessionCheck = undefined })
    return this.sessionCheck
  }

  private async runSessionCheck(trigger: string): Promise<void> {
    const account = this.account()
    const grant = await this.grant()
    if (account?.state !== 'active' || grant === undefined) return
    let facts: { refresh: boolean; timestamp: number }
    try {
      facts = await refreshNeeded(this.client)
    } catch (error: unknown) {
      if (error instanceof BiliApiError && error.code === -101) return this.loginNeeded('Bilibili no longer accepts the session (code -101)')
      this.ctx.logger.warn(`bili: cookie check (${trigger}) failed: ${errorText(error)}; trying again later`)
      return
    }
    if (!facts.refresh) {
      await this.updateAccount({ checkedAt: Date.now() })
      this.ctx.logger.info(`bili: cookies of ${account.uname} are current (${trigger})`)
      await this.refreshProgress()
      return
    }
    let fresh: Awaited<ReturnType<typeof exchangeRefresh>>
    try {
      fresh = await exchangeRefresh(this.client, grant, this.config.refreshPublicKey, facts.timestamp)
    } catch (error: unknown) {
      if (error instanceof BiliRiskError) return
      if (error instanceof BiliTransportError) {
        this.ctx.logger.warn(`bili: cookie refresh (${trigger}) did not complete: ${errorText(error)}; trying again later`)
        return
      }
      return this.refreshRefused(trigger, errorText(error))
    }
    const now = Date.now()
    await this.storeGrant({ ...grant, cookies: fresh.cookies, refreshToken: fresh.refreshToken, refreshedAt: now })
    await this.updateAccount({ refreshedAt: now, checkedAt: now })
    this.ctx.logger.info(`bili: refreshed the cookies of ${account.uname} (${account.mid})`)
    try {
      await confirmRefresh(this.client, grant.refreshToken)
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: retiring the old refresh token failed (${errorText(error)}); the new cookies are stored and work`)
    }
  }

  /**
   * Bilibili refused a refresh. A refusal does not end the session: `cookie/refresh` answers -101
   * for a refresh token it rejects while `nav` still says signed in. `nav` decides: signed in keeps
   * the session until the next check tries again; signed out needs a new login; no answer leaves the
   * account as it is.
   * @param trigger - what started the check, for the log.
   * @param refusal - Bilibili's refusal, for the log and the login-needed reason.
   */
  private async refreshRefused(trigger: string, refusal: string): Promise<void> {
    let nav: Awaited<ReturnType<typeof navInfo>>
    try {
      nav = await navInfo(this.client)
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: cookie refresh (${trigger}) was refused (${refusal}) and nav could not confirm the session: ${errorText(error)}; trying again later`)
      return
    }
    if (!nav.isLogin) return this.loginNeeded(`the cookie refresh failed (${refusal}) and Bilibili says the session is signed out`)
    await this.updateAccount({ checkedAt: Date.now() })
    this.ctx.logger.warn(`bili: cookie refresh (${trigger}) was refused (${refusal}); the session still works, so it stays in use and the next check tries again`)
  }

  /** A read met code -101: check the session in the background and say so. */
  private async reading<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error: unknown) {
      if (error instanceof BiliApiError && error.code === -101) {
        this.track(this.checkSession(`code -101 from ${error.endpoint}`))
        throw new Error('Bilibili says the account is signed out; the host is checking its session and will tell the owner if a new login is needed')
      }
      throw error
    }
  }

  /** Reads need a signed-in, active account. */
  private requireActive(): AccountRecord {
    const account = this.account()
    if (account === undefined) throw new Error('no Bilibili account is signed in yet; the owner signs it in from Settings')
    if (account.state !== 'active') throw new Error(`the Bilibili login needs renewing (${account.reason ?? 'expired'}); the owner has been told`)
    return account
  }

  // ── QR login ──────────────────────────────────────────────────────────

  /** Start a QR login unless one is live. */
  private async startLogin(): Promise<void> {
    const live = this.login.view
    if ((live.state === 'waiting' || live.state === 'scanned') && (live.qr?.expiresAt ?? 0) > Date.now()) return
    let code: Awaited<ReturnType<typeof startQr>>
    try {
      code = await startQr(this.client)
    } catch (error: unknown) {
      this.login = { view: { state: 'failed', error: errorText(error) } }
      this.ctx.logger.warn(`bili: could not start a QR login: ${errorText(error)}`)
      return
    }
    const attempt: LoginAttempt = { key: code.key, view: { state: 'waiting', qr: { modules: qrModules(code.url), expiresAt: Date.now() + QR_LIFETIME_MS } } }
    this.login = attempt
    this.ctx.logger.info('bili: QR login started; waiting for a scan')
    this.after(QR_POLL_MS, () => this.pollLogin(attempt))
  }

  /** Poll one attempt until it ends, it expires, or another replaces it. */
  private async pollLogin(attempt: LoginAttempt): Promise<void> {
    if (this.login !== attempt || attempt.key === undefined) return
    if ((attempt.view.qr?.expiresAt ?? 0) <= Date.now()) {
      attempt.view = { state: 'expired' }
      this.ctx.logger.info('bili: the QR code expired before it was confirmed')
      return
    }
    let poll: QrPoll
    try {
      poll = await pollQr(this.client, attempt.key)
    } catch (error: unknown) {
      // A business code or risk control is Bilibili's answer about this login: polling on repeats it.
      if (error instanceof BiliApiError || error instanceof BiliRiskError) {
        if (this.login !== attempt) return
        const said = error instanceof BiliApiError ? `${error.detail === '' ? '未知原因' : error.detail}（${error.code}）` : `风控（${error.reason}）`
        attempt.view = { state: 'failed', error: `B站拒绝了这次登录：${said}` }
        this.ctx.logger.warn(`bili: Bilibili refused the QR login: ${error instanceof BiliApiError ? `code ${error.code} (${error.detail})` : error.reason}`)
        return
      }
      this.ctx.logger.warn(`bili: QR poll failed: ${errorText(error)}; trying again`)
      this.after(QR_POLL_MS, () => this.pollLogin(attempt))
      return
    }
    if (this.login !== attempt) return
    switch (poll.state) {
      case 'waiting':
      case 'scanned':
        if (poll.state !== attempt.view.state) this.ctx.logger.info(`bili: QR login ${poll.state}`)
        attempt.view = { ...attempt.view, state: poll.state }
        this.after(QR_POLL_MS, () => this.pollLogin(attempt))
        return
      case 'expired':
        attempt.view = { state: 'expired' }
        this.ctx.logger.info('bili: the QR code expired before it was confirmed')
        return
      case 'failed':
        attempt.view = { state: 'failed', error: poll.reason }
        this.ctx.logger.warn(`bili: QR login failed: ${poll.reason}`)
        return
      case 'done':
        await this.completeLogin(attempt, poll)
    }
  }

  /**
   * Enroll the stored jar's device unless it is enrolled: a jar without `_uuid` or `b_nut` gets
   * them first, keeping its buvid3. A failure is logged and tried again at the next start.
   * @param why - what asked for it, for the log.
   */
  private async enroll(why: string): Promise<void> {
    const grant = await this.grant()
    if (grant === undefined || grant.cookies['buvid3'] === undefined) return
    const nut = grant.cookies['b_nut']
    const kept = nut === undefined ? undefined : grant.cookies['_uuid']
    // A device enrolled before buvid_fp existed is enrolled again, with the full report.
    if (kept !== undefined && grant.cookies['buvid_fp'] !== undefined && this.domain?.table('device').get('current') !== undefined) return
    const now = Date.now()
    const ids = kept === undefined || nut === undefined ? newDeviceIds(now, Math.random) : { _uuid: kept, b_nut: nut }
    const body = { payload: JSON.stringify(devicePayload(ids._uuid, now, Math.random, USER_AGENT)) }
    // The fingerprint cookie is the hash of this very report, and goes with it.
    await this.storeGrant({ ...grant, cookies: { ...grant.cookies, ...ids, buvid_fp: buvidFp(JSON.stringify(body)) } })
    if (kept === undefined) this.ctx.logger.info(`bili: gave the stored device its browser ids (${why})`)
    try {
      await enrollDevice(this.client, body)
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: could not enroll the device (${why}): ${errorText(error)}; likes may be refused until it is enrolled at the next start`)
      return
    }
    await this.serialize(async () => { await (await this.ready).table('device').put('current', { enrolledAt: Date.now() }) })
    this.ctx.logger.info(`bili: enrolled the device with Bilibili (${why})`)
  }

  /** Store a confirmed login, add device cookies, and confirm the account through `nav`. */
  private async completeLogin(attempt: LoginAttempt, poll: Extract<QrPoll, { state: 'done' }>): Promise<void> {
    let device: CookieJar = {}
    try {
      device = await deviceCookies(this.client)
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: could not get device cookies (${errorText(error)}); search may refuse requests until the next login`)
    }
    const now = Date.now()
    const cookies = { ...poll.cookies, ...device, ...newDeviceIds(now, Math.random) }
    await this.storeGrant({ version: 1, mid: poll.mid, cookies, refreshToken: poll.refreshToken, loggedInAt: now, refreshedAt: now })
    this.client.resetWbi()
    // A new login brings a new buvid3, which needs its own enrollment.
    await this.serialize(async () => { await (await this.ready).table('device').delete('current') })
    await this.enroll('sign-in')
    await this.ticket('sign-in')
    let nav: Awaited<ReturnType<typeof navInfo>>
    try {
      nav = await navInfo(this.client)
    } catch (error: unknown) {
      attempt.view = { state: 'failed', error: `Bilibili did not confirm the new session: ${errorText(error)}` }
      this.ctx.logger.warn(`bili: ${attempt.view.error}`)
      return
    }
    if (!nav.isLogin || nav.mid !== poll.mid) {
      attempt.view = { state: 'failed', error: 'Bilibili did not confirm the new session' }
      this.ctx.logger.warn('bili: the new session was not confirmed by nav')
      return
    }
    await this.serialize(async () => {
      const domain = await this.ready
      await domain.table('account').put('current', {
        state: 'active', mid: poll.mid, uname: nav.uname ?? String(poll.mid), level: nav.level ?? 0, loggedInAt: now, refreshedAt: now, checkedAt: now,
      })
    })
    attempt.view = { state: 'done' }
    this.ctx.logger.info(`bili: signed in as ${nav.uname ?? '?'} (${poll.mid})`)
  }

  // ── The account's Session and its DM channel ──────────────────────────

  /**
   * Whether this plugin created a Session; each one is claimed by the DM channel.
   * @param sessionId - Session to check.
   * @returns true for every Session this plugin created.
   */
  ownsSession(sessionId: string): boolean {
    return this.domain?.table('sessions').get(sessionId) !== undefined
  }

  /**
   * Register the DM channel and claim every stored Session once storage is open.
   * @returns a disposer that unregisters the channel, which releases its claims.
   */
  private joinRelay(child: Context): () => void {
    const relay = child.ownerRelay
    const unregister = relay.registerChannel(this.dm)
    let joined = true
    this.ready.then((domain) => {
      if (!joined) return
      const ids = [...domain.table('sessions').keys()]
      for (const id of ids) relay.claim(id, BILI_RELAY_CHANNEL)
      this.ctx.logger.info(`bili: the relay carries ${ids.length} Session(s) through channel ${BILI_RELAY_CHANNEL}`)
    }, (error: unknown) => {
      this.ctx.logger.warn(`bili: Sessions not claimed with the relay: ${errorText(error)}`)
    })
    return () => {
      joined = false
      unregister()
    }
  }

  /** The account's Session: the stored one while it resolves, otherwise a new one. */
  private async accountSession(): Promise<SessionId> {
    const domain = await this.ready
    const stored = domain.table('current').get('session')
    if (stored !== undefined) {
      const sessionId = stored.sessionId as SessionId
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      if ('agent' in resolved) return sessionId
      if (TRANSIENT_RESOLVE_CODES.has(resolved.error.code)) throw resolved.error
      this.ctx.logger.info(`bili: Session ${sessionId} is unavailable (${resolved.error.code}); starting a new one`)
    }
    const session = this.config.session
    // Fails on an unknown preset before a Session exists.
    this.ctx.permissionPresets.resolve(session.permissionPreset)
    const created = await this.ctx.sessionController.create({ cwd: session.workspacePath, agentPreset: session.agentPreset })
    const resolved = await this.ctx.sessionController.resolveAgent(created.sessionId)
    if ('error' in resolved) throw resolved.error
    this.ctx.permissionPresets.set(resolved.agent.session, session.permissionPreset)
    this.ctx.sessionTitle.rename(resolved.agent.session, session.title)
    const now = Date.now()
    // Claimed before the first prompt, so the relay follows the Session's first turn.
    this.ctx.get('ownerRelay')?.claim(created.sessionId, BILI_RELAY_CHANNEL)
    await this.serialize(async () => {
      await domain.table('sessions').put(created.sessionId, { sessionId: created.sessionId, createdAt: now })
      await domain.table('current').put('session', { sessionId: created.sessionId, createdAt: now })
    })
    this.ctx.logger.info(`bili: created Session ${created.sessionId} in ${session.workspacePath} (${session.agentPreset}, ${session.permissionPreset})`)
    return created.sessionId
  }

  /**
   * Prompt the account's Session unless it is busy. A body-clock or Wake-now prompt starts a wake
   * run that counts what it watches; a continuation belongs to the run already going and is not a
   * new wake.
   * @returns whether the prompt went in.
   */
  private async promptSession(text: string, reason: WakeReason, owner = false, continuation = false): Promise<boolean> {
    mkdirSync(this.config.session.workspacePath, { recursive: true })
    const sessionId = await this.accountSession()
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const status = (resolved.agent as { status?: string }).status
    if (status !== undefined && status !== 'idle') {
      this.ctx.logger.info(`bili: Session ${sessionId} is ${status}; ${reason} ${continuation ? 'continuation' : 'wake'} skipped`)
      return false
    }
    // Known before the turn can end: its answer goes back by the channel of what started it.
    this.dm.setOrigin(sessionId, { reason, owner })
    const run = !continuation && (reason === 'clock' || reason === 'manual') && this.config.depth.minWatched > 0
    if (run) this.wakeRun = { sessionId, reason, watched: new Set(), rounds: 0 }
    try {
      await this.ctx.sessionController.prompt({
        requestId: randomUUID() as SessionRequestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: this.config.timeZone,
      }, this.abort.signal)
    } catch (error: unknown) {
      this.dm.dropOrigin(sessionId)
      if (run) this.wakeRun = undefined
      throw error
    }
    if (continuation) {
      this.ctx.logger.info(`bili: ${reason} wake continued in Session ${sessionId} (${text.length} chars)`)
      return true
    }
    const now = Date.now()
    await this.serialize(async () => {
      const domain = await this.ready
      const wakes = domain.table('wakes')
      await wakes.put(seqKey(now), { at: now, reason, sessionId, ...(owner ? { owner } : {}) })
      const excess = [...wakes.keys()].sort().slice(0, Math.max(0, wakes.size - MAX_WAKE_ROWS))
      for (const key of excess) await wakes.delete(key)
    })
    this.ctx.logger.info(`bili: ${reason} wake prompted Session ${sessionId} (${text.length} chars)`)
    return true
  }

  /**
   * A completed turn of a body-clock or Wake-now wake ended: below the watch floor, and with
   * continuations left, hold its answer back and ask the Session to keep browsing.
   * @param draft - the answer, or undefined for NO_REPLY or no text.
   * @returns whether the answer is held (a continuation follows).
   */
  private continueWake(sessionId: string, reason: WakeReason, draft: string | undefined): boolean {
    const run = this.wakeRun
    if (run === undefined || run.sessionId !== sessionId || run.reason !== reason) return false
    const { minWatched, maxRounds } = this.config.depth
    const watched = run.watched.size
    // A link to a video not graded must never goes out while a continuation is left.
    const unjudged = this.unjudged(draft)
    if ((watched >= minWatched && unjudged.length === 0) || run.rounds >= maxRounds || this.stopping) {
      this.wakeRun = undefined
      this.ctx.logger.info(`bili: the ${reason} wake ends after ${watched} video(s) watched and ${run.rounds} continuation(s)${unjudged.length === 0 ? '' : `; ${unjudged.length} link(s) not graded must go out anyway`}`)
      return false
    }
    run.rounds += 1
    const text = continuePrompt({ watched, minWatched, round: run.rounds, rounds: maxRounds, draft, unjudged })
    const why = watched < minWatched ? `watched ${watched} of ${minWatched} video(s)` : `links ${unjudged.length} video(s) not graded must`
    this.ctx.logger.info(`bili: the ${reason} wake ${why}; asking for more (continuation ${run.rounds} of ${maxRounds})`)
    this.after(CONTINUE_DELAY_MS, async () => {
      let prompted = false
      try {
        prompted = await this.promptSession(text, reason, false, true)
      } catch (error: unknown) {
        this.ctx.logger.warn(`bili: the continuation of the ${reason} wake failed: ${errorText(error)}`)
      }
      if (!prompted) this.endWake(sessionId, 'its continuation did not go in')
    })
    return true
  }

  /** End the wake run of a Session, saying why. */
  private endWake(sessionId: string, why: string): void {
    const run = this.wakeRun
    if (run?.sessionId !== sessionId) return
    this.wakeRun = undefined
    this.ctx.logger.info(`bili: the ${run.reason} wake ends: ${why} (${run.watched.size} video(s) watched)`)
  }

  // ── Body clock ─────────────────────────────────────────────────────────

  /**
   * The model route the account's Session will use, by the Session Controller's
   * precedence: an explicit pick not yet used, else the Session's last request,
   * else the profile default. A Session is resolved only when one exists.
   */
  private async checkRoute(): Promise<CheckedRoute | undefined> {
    let pick: { provider: string; model: string } | undefined
    let header: { provider: string; model: string } | undefined
    const stored = this.domain?.table('current').get('session')
    if (stored !== undefined) {
      try {
        const resolved = await this.ctx.sessionController.resolveAgent(stored.sessionId as SessionId)
        if ('agent' in resolved) {
          const session = resolved.agent.session
          pick = this.ctx.get('sessionProjections')?.stateOf(session, 'modelSelection')?.pending ?? undefined
          header = (session as Partial<Pick<Session, 'requestHeader'>>).requestHeader?.()?.config
        }
      } catch (error: unknown) {
        this.ctx.logger.debug(`bili: could not read the route of Session ${stored.sessionId}: ${errorText(error)}`)
      }
    }
    const route = routeOf({ pick, header, fallback: this.ctx.get('agentDefaultModel')?.currentSelection() })
    this.lastRoute = route === undefined ? undefined : { ...route, rule: ruleFor(this.config.pricing, route.provider) }
    return this.lastRoute
  }

  /** The local day before the one containing `now`. */
  private previousDay(now: number): string {
    const { timeZone } = this.config
    return dayKey(localTime(dayKey(now, timeZone), 0, timeZone) - 1, timeZone)
  }

  /**
   * Today's plan, rolled once (for the route's pricing) and settled against the
   * clock, and yesterday's settled too: a wake moved or deferred past local
   * midnight still belongs to the day it was planned for.
   */
  private async currentPlans(
    now: number, route: CheckedRoute | undefined = this.lastRoute,
  ): Promise<{ today: PlanRecord; yesterday?: PlanRecord }> {
    return this.serialize(async () => {
      const domain = await this.ready
      const { wakes, skipChance, timeZone } = this.config
      const day = dayKey(now, timeZone)
      const plans = domain.table('plans')
      const stored = plans.get(day)
      const rolled = stored ?? {
        ...rollPlan(day, wakes, skipChance, timeZone, Math.random, route?.rule),
        ...(route === undefined ? {} : { route: { provider: route.provider, model: route.model, priced: route.rule !== undefined } }),
      }
      const today = settlePlan(rolled, wakes, now, timeZone)
      if (today !== stored) await plans.put(day, today)
      if (stored === undefined) {
        const count = (state: string): number => today.wakes.filter(wake => wake.state === state).length
        const changed = (kind: string): number => today.wakes.filter(wake => wake.adjusted === kind).length
        const notes = [`${count('planned')} wake(s)`, `${count('skipped')} window(s) skipped`]
        if (changed('clipped') > 0) notes.push(`${changed('clipped')} clipped to off-peak`)
        if (changed('moved') > 0) notes.push(`${changed('moved')} moved past a peak`)
        this.ctx.logger.info(`bili: body clock for ${day} on ${routeText(route)}: ${notes.join(', ')}`)
        for (const key of [...plans.keys()].sort().slice(0, Math.max(0, plans.size - PLAN_DAYS))) await plans.delete(key)
      }
      const before = plans.get(this.previousDay(now))
      const yesterday = before === undefined ? undefined : settlePlan(before, wakes, now, timeZone)
      if (yesterday !== undefined && yesterday !== before) await plans.put(yesterday.day, yesterday)
      return yesterday === undefined ? { today } : { today, yesterday }
    })
  }

  /** The earliest planned wake of today's and yesterday's plans. */
  private nextWake(plans: { today: PlanRecord; yesterday?: PlanRecord }): number | undefined {
    const times = [plans.today, plans.yesterday]
      .flatMap(plan => (plan === undefined ? [] : [nextPlanned(plan)?.at]))
      .filter((at): at is number => at !== undefined)
    return times.length === 0 ? undefined : Math.min(...times)
  }

  /** Arm the timer for the next planned wake or the next local midnight. */
  private async armClock(): Promise<void> {
    if (this.stopping) return
    const now = Date.now()
    const plans = await this.currentPlans(now, await this.checkRoute())
    const at = Math.min(this.nextWake(plans) ?? Infinity, nextDayStart(now, this.config.timeZone))
    this.clockTimer?.()
    this.clockTimer = this.ctx.timeout(() => {
      this.clockTimer = undefined
      this.track(this.onClock())
    }, Math.max(0, at - now))
  }

  /**
   * Fire the wakes that are due (at most one prompt), then re-arm. While the
   * route is priced and in a peak, due wakes move to the next off-peak start
   * instead; they stay planned, so they still fire exactly once.
   */
  private async onClock(): Promise<void> {
    try {
      const now = Date.now()
      const route = await this.checkRoute()
      const deferTo = route?.rule === undefined || peakAt(route.rule, now) === undefined ? undefined : nextOffPeak(route.rule, now)
      const settled = await this.serialize(async () => {
        const domain = await this.ready
        let fired = 0
        let deferred = 0
        let missed = 0
        // At most once: a wake is marked done before its prompt, so a restart never repeats it. With
        // no signed-in account it cannot happen at all, so it is marked missed rather than done.
        const active = this.account()?.state === 'active'
        for (const day of [this.previousDay(now), dayKey(now, this.config.timeZone)]) {
          const plan = domain.table('plans').get(day)
          if (plan === undefined) continue
          const wakes = plan.wakes.map((wake) => {
            if (wake.state !== 'planned' || wake.at === undefined || wake.at > now) return wake
            if (!active) {
              missed += 1
              return { ...wake, state: 'missed' as const }
            }
            if (deferTo !== undefined) {
              deferred += 1
              return { ...wake, at: deferTo, adjusted: 'deferred' as const, closes: Math.max(wake.closes ?? 0, deferTo + DEFER_GRACE_MS) }
            }
            fired += 1
            return { ...wake, state: 'done' as const }
          })
          if (wakes.some((wake, index) => wake !== plan.wakes[index])) await domain.table('plans').put(day, { ...plan, wakes })
        }
        return { fired, deferred, missed }
      })
      if (settled.missed > 0) this.ctx.logger.info('bili: body-clock wake skipped: no active account')
      if (settled.deferred > 0 && deferTo !== undefined) {
        this.ctx.logger.info(`bili: ${settled.deferred} body-clock wake(s) deferred to ${formatStamp(deferTo, this.config.timeZone)} (${route?.provider ?? '?'} is in a peak period)`)
      }
      if (settled.fired > 0) await this.clockWake(now)
    } finally {
      await this.armClock()
    }
  }

  /** One body-clock wake. */
  private async clockWake(now: number): Promise<void> {
    const account = this.account()
    if (account?.state !== 'active') {
      this.ctx.logger.info('bili: body-clock wake skipped: no active account')
      return
    }
    try {
      await this.promptSession(await this.wakeText(now), 'clock')
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: body-clock wake failed: ${errorText(error)}`)
    }
  }

  /** The body-clock prompt: time, budget, inbox counts (best effort), interests, and any pause. */
  private async wakeText(now: number): Promise<string> {
    let inbox = { replies: 0, mentions: 0, ownerMessages: 0, otherMessages: 0 }
    try {
      const counts = await unreadCounts(this.client)
      const owner = this.domain === undefined ? 0 : [...this.domain.table('pending').entries()].filter(([, row]) => row.kind === 'dm').length
      inbox = {
        replies: counts.replies, mentions: counts.mentions, ownerMessages: owner, otherMessages: Math.max(0, counts.messages - owner),
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: unread counts for the wake failed: ${errorText(error)}`)
    }
    const domain = await this.ready
    return wakePrompt({
      now,
      timeZone: this.config.timeZone,
      lastWakeAt: this.lastWake()?.at,
      budget: remaining(domain, this.config.caps, now, this.config.timeZone),
      inbox,
      interests: this.interests().text,
      pause: domain.table('pause').get('writes'),
      taste: this.tasteNotes(),
      finds: this.recentFinds().slice(0, FINDS_IN_PROMPT),
      trends: this.trendNotes(true).slice(0, TRENDS_IN_PROMPT),
      keywords: this.keywords().list,
      minWatched: this.config.depth.minWatched,
      ...(this.config.picksPerDay === 0 ? {} : { picks: { sent: this.picksToday(now), perDay: this.config.picksPerDay } }),
    })
  }

  /**
   * The owner's Wake now from Settings: the body-clock prompt, now, outside
   * today's plan. It is the owner's explicit request, so a priced route's peak
   * does not stop it (the outcome says so); it never steers into a running turn
   * and ignores a second request within a minute of a started one.
   */
  private async manualWake(): Promise<ManualWakeView> {
    const now = Date.now()
    const refuse = (reason: NonNullable<ManualWakeView['reason']>, detail?: string): ManualWakeView => {
      this.ctx.logger.info(`bili: manual wake refused (${reason}${detail === undefined ? '' : `: ${detail}`})`)
      return { at: now, outcome: 'refused', reason, ...(detail === undefined ? {} : { detail }) }
    }
    const account = this.account()
    if (account === undefined) return refuse('signed-out')
    if (account.state !== 'active') return refuse('login-needed')
    if (now - this.manualStartedAt < MANUAL_WAKE_DEBOUNCE_MS) return refuse('recent')
    // Set before any await, so a second click arriving meanwhile is refused.
    const previous = this.manualStartedAt
    this.manualStartedAt = now
    const route = await this.checkRoute()
    const peak = route?.rule === undefined || peakAt(route.rule, now) === undefined
      ? undefined
      : { provider: route.provider, offPeakAt: nextOffPeak(route.rule, now) ?? null }
    const backoff = this.domain?.table('backoff').get('reads')
    const readsResumeAt = backoff !== undefined && backoff.until > now ? backoff.until : undefined
    let prompted: boolean
    try {
      prompted = await this.promptSession(await this.wakeText(now), 'manual')
    } catch (error: unknown) {
      this.manualStartedAt = previous
      return refuse('failed', errorText(error))
    }
    if (!prompted) {
      this.manualStartedAt = previous
      return refuse('busy')
    }
    const sessionId = this.domain?.table('current').get('session')?.sessionId ?? '?'
    const notes = [peak === undefined ? '' : `, in a peak period of ${peak.provider}`, readsResumeAt === undefined ? '' : '; reads are backing off'].join('')
    this.ctx.logger.info(`bili: the owner woke the Session (${sessionId}) from Settings${notes}`)
    return { at: now, outcome: 'started', ...(peak === undefined ? {} : { peak }), ...(readsResumeAt === undefined ? {} : { readsResumeAt }) }
  }

  /** The latest wake, if any. */
  private lastWake(): { at: number; reason: WakeReason } | undefined {
    const wakes = this.domain?.table('wakes')
    if (wakes === undefined) return undefined
    const last = [...wakes.keys()].sort().at(-1)
    const row = last === undefined ? undefined : wakes.get(last)
    return row === undefined ? undefined : { at: row.at, reason: row.reason }
  }

  /** The owner's main account: the UID set in Settings, else the configured one. */
  private ownerMid(): number | undefined {
    return this.domain?.table('owner').get('main')?.mid ?? this.config.ownerMid
  }

  /** The interests text: the owner's Settings edit, else the configured one. */
  private interests(): { text: string; updatedAt: number | null } {
    const row = this.domain?.table('settings').get('interests')
    return row === undefined ? { text: this.config.interests, updatedAt: null } : { text: row.text, updatedAt: row.updatedAt }
  }

  // ── Inbox ──────────────────────────────────────────────────────────────

  /** Check the inbox (no model involved) and wake the Session for new items. */
  private async pollInbox(): Promise<void> {
    const account = this.account()
    const backoff = this.domain?.table('backoff').get('reads')
    if (account?.state !== 'active' || (backoff !== undefined && backoff.until > Date.now()) || this.inboxPolling) return
    this.inboxPolling = true
    try {
      await this.checkInbox()
    } finally {
      this.inboxPolling = false
    }
  }

  /** One inbox check: collect, then deliver. */
  private async checkInbox(): Promise<void> {
    try {
      await this.collectInbox()
    } catch (error: unknown) {
      if (error instanceof BiliApiError && error.code === -101) {
        await this.checkSession(`code -101 from ${error.endpoint}`)
        return
      }
      if (!(error instanceof BiliRiskError)) this.ctx.logger.warn(`bili: inbox check failed: ${errorText(error)}`)
      return
    }
    await this.deliverInbox()
  }

  /** Fetch what changed and queue new items; the first look at each kind only records a baseline. */
  private async collectInbox(): Promise<void> {
    const domain = await this.ready
    const counts = await unreadCounts(this.client)
    const baselined = (kind: PendingRecord['kind']): boolean => domain.table('inbox').get(kind) !== undefined
    if (counts.replies > 0 || !baselined('reply')) await this.queueItems('reply', await inboxItems(this.client, 'reply'))
    if (counts.mentions > 0 || !baselined('at')) await this.queueItems('at', await inboxItems(this.client, 'at'))
    const ownerMid = this.ownerMid()
    if (ownerMid !== undefined && (counts.messages > 0 || !baselined('dm'))) await this.queueItems('dm', await ownerMessages(this.client, ownerMid))
  }

  /** Queue unseen items of one kind and remember reply targets. */
  private async queueItems(kind: PendingRecord['kind'], items: readonly (InboxItem | OwnerMessage)[]): Promise<void> {
    await this.serialize(async () => {
      const domain = await this.ready
      const row = domain.table('inbox').get(kind)
      const seen = new Set(row?.seen ?? [])
      let queued = 0
      for (const item of items) {
        if ('rpid' in item) await this.rememberTarget(item)
        if (seen.has(item.id)) continue
        seen.add(item.id)
        if (row === undefined) continue
        const fields: Record<string, string | number> = 'rpid' in item
          ? { kind: kind === 'reply' ? 'reply to you' : 'mention', from: item.from, fromMid: item.fromMid, text: item.text, about: item.about, rpid: item.rpid }
          : { kind: 'message from the owner\'s account', text: item.text }
        await domain.table('pending').put(`${kind}:${item.id}`, { kind, id: item.id, at: item.at, item: fields })
        queued += 1
      }
      await domain.table('inbox').put(kind, { seen: [...seen].slice(-MAX_SEEN) })
      await this.trimTable(domain, 'pending', MAX_PENDING)
      await this.trimTable(domain, 'targets', MAX_TARGETS)
      if (row === undefined) this.ctx.logger.info(`bili: inbox baseline for ${kind}: ${items.length} item(s) already there`)
      else if (queued > 0) this.ctx.logger.info(`bili: ${queued} new ${kind} item(s) in the inbox`)
      if (row !== undefined && queued > 0 && kind === 'dm') {
        await this.keepReaction(domain, items.filter((item): item is OwnerMessage => !('rpid' in item) && !(row.seen.includes(item.id))))
        this.ownerSpoke(Date.now())
      }
    })
  }

  /**
   * The owner's first message after the latest find, within a day of it, is how they took it:
   * kept on the find in their words, so every later wake sees it whatever the Session remembers.
   * Runs inside `serialize`.
   */
  private async keepReaction(domain: Domain<typeof biliDomain>, messages: readonly OwnerMessage[]): Promise<void> {
    const latest = [...domain.table('finds').entries()].map(([, find]) => find).sort((a, b) => b.at - a.at)[0]
    if (latest === undefined || latest.reaction !== undefined) return
    const first = [...messages].sort((a, b) => a.at - b.at)
      .find(message => message.at >= latest.at && message.at - latest.at < REACTION_WINDOW_MS)
    const text = first === undefined ? '' : clean(first.text, REACTION_CHARS, true)
    if (first === undefined || text === '') return
    await domain.table('finds').put(latest.bvid, { ...latest, reaction: { text, at: first.at } })
    this.ctx.logger.info(`bili: kept the owner's reply to the find ${latest.bvid} (${codePoints(text)} chars)`)
  }

  /**
   * The owner sent a message: check messages every minute until 15 minutes
   * after the latest one, so a conversation does not wait for the 10-minute check.
   */
  private ownerSpoke(now: number): void {
    const quiet = this.conversationUntil <= now
    this.conversationUntil = now + CONVERSATION_MS
    if (quiet) this.ctx.logger.info(`bili: the owner is messaging; checking messages every 60 s until ${formatStamp(this.conversationUntil, this.config.timeZone)} (extended by each new message)`)
    if (this.fastPoll === undefined) this.armFastPoll()
  }

  /** Arm the next fast check, or end the conversation window. */
  private armFastPoll(): void {
    if (this.stopping) return
    if (Date.now() >= this.conversationUntil) {
      this.fastPoll = undefined
      this.ctx.logger.info('bili: the owner\'s conversation went quiet; back to the 10-minute inbox check')
      return
    }
    this.fastPoll = this.ctx.timeout(() => {
      this.track(this.pollInbox().finally(() => { this.armFastPoll() }))
    }, FAST_POLL_MS)
  }

  /** Drop the oldest rows (by their `at`) of a table beyond `max`. */
  private async trimTable(domain: Domain<typeof biliDomain>, name: 'pending' | 'targets', max: number): Promise<void> {
    const table = domain.table(name)
    const excess = table.size - max
    if (excess <= 0) return
    const victims = [...table.entries()].sort(([, a], [, b]) => a.at - b.at).slice(0, excess)
    for (const [key] of victims) await table.delete(key)
    this.ctx.logger.info(`bili: dropped the ${excess} oldest ${name} row(s)`)
  }

  /** A comment that replied to or mentioned the account, so `reply` may answer it. */
  private async rememberTarget(item: InboxItem): Promise<void> {
    const domain = await this.ready
    await domain.table('targets').put(item.rpid, { oid: item.oid, type: item.type, root: item.root, mid: item.fromMid, at: item.at })
  }

  /** Hand waiting inbox items over once a priced route's peak ends; one timer, armed once per peak. */
  private waitForOffPeak(route: CheckedRoute, count: number, now: number): void {
    const at = route.rule === undefined ? undefined : nextOffPeak(route.rule, now)
    if (at === undefined || this.inboxTimer?.at === at) return
    this.inboxTimer?.dispose()
    const dispose = this.ctx.timeout(() => {
      this.inboxTimer = undefined
      if (!this.stopping) this.track(this.deliverInbox())
    }, Math.max(0, at - now))
    this.inboxTimer = { at, dispose }
    this.ctx.logger.info(`bili: ${count} inbox item(s) wait for off-peak at ${formatStamp(at, this.config.timeZone)} (${route.provider} is in a peak period)`)
  }

  /**
   * Hand queued items to the Session. Messages from the owner's account wake it
   * at once, however many they send (a conversation they started: no hourly cap
   * and no off-peak rule); other items wait for the hourly cap and a priced
   * route's off-peak time.
   */
  private async deliverInbox(): Promise<void> {
    const domain = await this.ready
    const pending = [...domain.table('pending').entries()].map(([key, row]) => ({ key, row })).sort((a, b) => a.row.at - b.row.at)
    if (pending.length === 0) return
    const owner = pending.some(({ row }) => row.kind === 'dm')
    if (!owner) {
      const hourAgo = Date.now() - 3_600_000
      const recent = [...domain.table('wakes').entries()].filter(([, wake]) => wake.reason === 'inbox' && wake.owner !== true && wake.at > hourAgo).length
      if (recent >= this.config.inboxWakesPerHour) {
        this.ctx.logger.info(`bili: ${pending.length} inbox item(s) wait: ${recent} inbox wake(s) in the last hour`)
        return
      }
    }
    const now = Date.now()
    if (!owner) {
      const route = await this.checkRoute()
      if (route?.rule !== undefined && peakAt(route.rule, now) !== undefined) {
        this.waitForOffPeak(route, pending.length, now)
        return
      }
    }
    // The owner's messages come first, so a full batch never leaves one behind.
    const ordered = owner ? [...pending.filter(({ row }) => row.kind === 'dm'), ...pending.filter(({ row }) => row.kind !== 'dm')] : pending
    const batch = ordered.slice(0, MAX_WAKE_ITEMS)
    const prompt = inboxPrompt({
      now,
      timeZone: this.config.timeZone,
      budget: remaining(domain, this.config.caps, now, this.config.timeZone),
      pause: domain.table('pause').get('writes'),
      items: batch.map(({ row }) => row.item),
      owner,
      taste: this.tasteNotes(),
      lastFind: this.recentFinds().find(find => now - find.at < REACTION_WINDOW_MS),
    })
    let prompted = false
    try {
      prompted = await this.promptSession(prompt, 'inbox', owner)
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: inbox wake failed: ${errorText(error)}`)
    }
    if (!prompted) return
    await this.serialize(async () => {
      for (const { key } of batch) await domain.table('pending').delete(key)
    })
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  /** Why a write cannot start, before any request. */
  private writeRefusal(spec: WriteSpec): string | undefined {
    const domain = this.domain
    const account = this.account()
    if (domain === undefined || account === undefined) return 'no Bilibili account is signed in'
    if (account.state !== 'active') return `the Bilibili login needs renewing (${account.reason ?? 'expired'}); the owner has been told`
    const paused = pauseRefusal(domain.table('pause').get('writes'), spec.action)
    if (paused !== undefined) return paused
    const limit = (TEXT_LIMITS as Partial<Record<WriteAction, number>>)[spec.action]
    if (limit !== undefined) {
      const text = spec.text?.trim() ?? ''
      if (text === '') return 'the text is empty'
      if (codePoints(text) > limit) return `the text is ${codePoints(text)} characters; the limit is ${limit}`
    }
    const now = Date.now()
    const used = usage(domain, dayKey(now, this.config.timeZone))[spec.action]
    const cap = capOf(this.config.caps, spec.action)
    if (cap !== undefined && used >= cap) return `today's ${spec.action} budget (${cap}) is used up`
    if (uncertainBefore(domain, spec.action, spec.target, spec.text)) return `an earlier ${spec.action} of ${spec.target} has an unknown outcome; it is never sent again`
    if (alreadyTaken(domain, spec.action, spec.target, dayKey(now, this.config.timeZone))) {
      const taken: Partial<Record<WriteAction, string>> = {
        comment: `this account already commented on ${spec.target}; one comment per video`,
        reply: `this account already replied to comment ${spec.target}`,
        coin: `this account already gave ${spec.target} coins; one coin write per video`,
        triple: `this account already gave ${spec.target} a triple (一键三连); one per video`,
        share: `${spec.target} was already reported as shared`,
        watch: `${spec.target} was already reported as watched today`,
      }
      return taken[spec.action] ?? `${spec.action} ${spec.target} is already done`
    }
    return undefined
  }

  /**
   * Run one write through the guard: refusals, identity, idempotent pre-read,
   * the shared slot, a durable reservation, the one request, and settlement.
   * Writes run one at a time and are never retried.
   */
  private write(spec: WriteSpec): Promise<WriteOutcome> {
    const result = this.writes.then(() => this.runWrite(spec))
    this.writes = result.catch(() => undefined)
    return result
  }

  private async runWrite(spec: WriteSpec): Promise<WriteOutcome> {
    const refused = (detail: string): WriteOutcome => {
      this.ctx.logger.info(`bili: ${spec.action} ${spec.target} refused: ${detail}`)
      return { outcome: 'refused', detail }
    }
    const early = this.writeRefusal(spec)
    const account = this.account()
    if (early !== undefined || account === undefined) return refused(early ?? 'no Bilibili account is signed in')
    try {
      const nav = await navInfo(this.client)
      if (!nav.isLogin) {
        this.track(this.checkSession('signed out before a write'))
        return refused('Bilibili says the account is signed out; the host is checking its session')
      }
      if (nav.mid !== account.mid) return refused(`the cookies belong to account ${String(nav.mid)}, not ${account.mid}`)
      const check = await spec.check?.()
      if (check !== undefined) return refused(check)
      const already = await spec.preRead?.()
      if (already !== undefined) {
        this.ctx.logger.info(`bili: ${spec.action} ${spec.target}: ${already}`)
        return { outcome: 'already', detail: already }
      }
    } catch (error: unknown) {
      return refused(`could not check before writing: ${errorText(error)}`)
    }
    const domain = await this.ready
    // A reply to the owner keeps a conversation's pace: a few seconds after the previous write, not minutes.
    const replyGap = this.config.dmReplyGapMinMs + Math.floor(Math.random() * (this.config.dmReplyGapMaxMs - this.config.dmReplyGapMinMs))
    // Watch and share reports describe what the account did; they neither wait for the slot nor take it.
    const wait = HOST_REPORTS.has(spec.action) ? 0
      : spec.action === 'dmReply' ? (lastWrite(domain) ?? -Infinity) + replyGap - Date.now()
        : nextSlot(domain) - Date.now()
    if (wait > (spec.maxWaitMs ?? this.config.writeWaitMs)) return refused(`the next write slot opens in ${formatGap(wait)}; try later`)
    if (wait > 0) {
      this.ctx.logger.info(`bili: ${spec.action} ${spec.target} waits ${Math.ceil(wait / 1000)} s for its slot`)
      await this.sleep(wait)
    }
    // A risk answer to another request can arrive while this write waits.
    const late = this.writeRefusal(spec)
    if (late !== undefined) return refused(late)
    const coins = spec.coins?.()
    const row = await this.serialize(() => reserve(domain, {
      action: spec.action,
      target: spec.target,
      ...(spec.text === undefined ? {} : { text: spec.text.trim() }),
      ...areaFields(spec.area),
      ...(coins === undefined ? {} : { coins }),
      ...(spec.adds === undefined ? {} : { adds: [...spec.adds()] }),
    }, Date.now(), this.config.timeZone))
    let outcome: WriteOutcome
    try {
      const receipt = await spec.perform()
      const now = Date.now()
      const given = spec.coins?.()
      await this.serialize(() => settle(domain, row.id, {
        state: 'accepted', settledAt: now,
        ...(receipt === undefined ? {} : { receipt }),
        ...(spec.visibility === true && receipt !== undefined ? { visibility: 'pending' as const, visibilityDueAt: now + this.config.visibilityCheckMs } : {}),
        ...(spec.adds === undefined ? {} : { adds: [...spec.adds()] }),
        ...(given === undefined ? {} : { coins: given }),
      }))
      outcome = { outcome: 'sent', detail: spec.sentDetail?.() ?? `${spec.action} sent`, ...(receipt === undefined ? {} : { receipt }) }
      await this.verified(spec.action)
      const settled = domain.table('ledger').get(row.id)
      if (spec.visibility === true && receipt !== undefined && settled !== undefined) this.armVisibility(settled)
    } catch (error: unknown) {
      const now = Date.now()
      if (error instanceof BiliTransportError) {
        await this.serialize(() => settle(domain, row.id, { state: 'uncertain', settledAt: now, detail: error.message }))
        outcome = { outcome: 'uncertain', detail: `the outcome is unknown (${error.message}); it counts against today's budget and will not be sent again` }
      } else if (error instanceof BiliVerifyError) {
        // Not risk control: nothing happened, writes stay open, and the owner sees a hint in Settings.
        const detail = `Bilibili refused it until the account verifies a phone number: code ${error.code}${error.detail === '' ? '' : ` (${error.detail})`}`
        await this.serialize(() => settle(domain, row.id, { state: 'failed', settledAt: now, detail }))
        await this.needsVerification(spec.action, error.detail === '' ? `code ${error.code}` : error.detail)
        outcome = { outcome: 'refused', detail, verification: error.detail === '' ? `code ${error.code}` : error.detail }
      } else {
        // Risk control on a message pauses every write; on any other write, only public ones (see brake).
        const paused = spec.action === 'dmOwner' || spec.action === 'dmReply' ? 'writes are paused until the owner resumes them'
          : 'public writes are paused (messages to the owner still go) until the owner resumes them'
        const detail = error instanceof BiliRiskError
          ? `Bilibili's risk control stopped it (${error.reason}); ${paused}`
          : error instanceof BiliApiError ? `Bilibili refused it: code ${error.code}${error.detail === '' ? '' : ` (${error.detail})`}${coinCodeHint(spec.action, error.code)}` : errorText(error)
        await this.serialize(() => settle(domain, row.id, { state: 'failed', settledAt: now, detail }))
        if (error instanceof BiliApiError && error.code === -101) this.track(this.checkSession(`code -101 from ${error.endpoint}`))
        outcome = { outcome: 'refused', detail }
      }
    }
    const gap = { minMs: this.config.writeGapMinMs, maxMs: this.config.writeGapMaxMs }
    if (!HOST_REPORTS.has(spec.action)) await this.serialize(() => takeSlot(domain, Date.now(), gap, Math.random))
    if (outcome.outcome === 'sent' && (spec.action === 'coin' || spec.action === 'triple' || HOST_REPORTS.has(spec.action))) this.track(this.refreshProgress())
    const used = usage(domain, dayKey(Date.now(), this.config.timeZone))[spec.action]
    const cap = capOf(this.config.caps, spec.action)
    this.ctx.logger.info(`bili: ${spec.action} ${spec.target} ${outcome.outcome} (${used}${cap === undefined ? '' : `/${cap}`} today)`)
    return outcome
  }

  /** Remember that Bilibili wants a verified phone number for this kind of write; Settings shows it until one goes through. */
  private async needsVerification(action: WriteAction, message: string): Promise<void> {
    const kind = verifyKind(action)
    const domain = this.domain
    if (kind === undefined || domain === undefined) return
    this.ctx.logger.warn(`bili: Bilibili wants a verified phone number before ${action} (${message}); Settings shows a hint until a ${kind} goes through`)
    await this.serialize(() => domain.table('verify').put(kind, { message, since: domain.table('verify').get(kind)?.since ?? Date.now() }))
  }

  /** A write of this kind went through: the verification hint, if any, is gone. */
  private async verified(action: WriteAction): Promise<void> {
    const kind = verifyKind(action)
    const domain = this.domain
    if (kind === undefined || domain?.table('verify').get(kind) === undefined) return
    this.ctx.logger.info(`bili: a ${kind} went through; the phone-verification hint is cleared`)
    await this.serialize(() => domain.table('verify').delete(kind))
  }

  /** Schedule the visibility check of an accepted comment or reply. */
  private armVisibility(row: LedgerRecord): void {
    if (this.stopping || this.visibilityTimers.has(row.id)) return
    const dispose = this.ctx.timeout(() => {
      this.visibilityTimers.delete(row.id)
      this.track(this.checkVisibility(row.id))
    }, Math.max(0, (row.visibilityDueAt ?? Date.now()) - Date.now()))
    this.visibilityTimers.set(row.id, dispose)
  }

  /**
   * Look for an accepted comment as a signed-out visitor would. Not found, or
   * found but hidden, means others may not see it: public speech pauses until
   * the owner resumes it.
   */
  private async checkVisibility(id: string): Promise<void> {
    const domain = await this.ready
    const row = domain.table('ledger').get(id)
    if (row?.visibility !== 'pending' || row.receipt === undefined || row.oid === undefined) return
    const area = { type: row.type ?? VIDEO_AREA, oid: row.oid }
    let rows: Record<string, unknown>[] = []
    try {
      if (row.root === undefined) {
        const first = await commentRows(this.client, area, { order: 'new', anonymous: true })
        rows = first.rows
        if (first.next !== undefined) rows = [...rows, ...(await commentRows(this.client, area, { order: 'new', offset: first.next, anonymous: true })).rows]
      } else {
        const page = await threadRows(this.client, { ...area, root: row.root }, 1, true)
        rows = [...(page.root === undefined ? [] : [page.root]), ...page.rows]
      }
    } catch (error: unknown) {
      await this.serialize(() => settle(domain, id, { visibility: 'unknown' }))
      this.ctx.logger.warn(`bili: visibility check of ${row.action} ${row.receipt} failed: ${errorText(error)}`)
      return
    }
    const hit = rows.find(candidate => String(candidate['rpid_str'] ?? candidate['rpid']) === row.receipt)
    const visible = hit !== undefined && hit['invisible'] !== true && hit['state'] !== 17
    await this.serialize(() => settle(domain, id, { visibility: visible ? 'visible' : 'hidden' }))
    if (visible) {
      this.ctx.logger.info(`bili: ${row.action} ${row.receipt} on ${row.target} is visible to others`)
      return
    }
    this.ctx.logger.warn(`bili: ${row.action} ${row.receipt} on ${row.target} is not visible to signed-out visitors; public speech pauses`)
    const fresh = await this.serialize(async () => {
      if (domain.table('pause').get('writes') !== undefined) return false
      await domain.table('pause').put('writes', { scope: 'speech', reason: `${row.action} ${row.receipt} possibly hidden`, since: Date.now() })
      return true
    })
    if (fresh) await this.notify(NOTICES.speechPaused(row.target))
  }

  /** A refusal that needs no request (state, pause, text, cap, dedupe), checked before looking a video up. */
  private precheck(action: WriteAction, target: string, text?: string): WriteOutcome | undefined {
    const perform = (): Promise<undefined> => Promise.resolve(undefined)
    const refusal = this.writeRefusal({ action, target, ...(text === undefined ? {} : { text }), perform })
    return refusal === undefined ? undefined : { outcome: 'refused', detail: refusal }
  }

  /** A video to write on, or why not. */
  private async aidOf(bvid: string): Promise<{ aid: string; video: VideoDetail } | { refusal: string }> {
    if (bvidOf(bvid) === undefined) return { refusal: `${JSON.stringify(bvid)} is not a BV id` }
    let video: VideoDetail
    try {
      video = await videoInfo(this.client, bvid, this.config.timeZone)
    } catch (error: unknown) {
      return { refusal: `could not read ${bvid}: ${errorText(error)}` }
    }
    return { aid: video.aid, video }
  }

  /**
   * Give a video coins, never with a like. Bilibili takes at most 2 coins per
   * video from one account for an original and 1 otherwise; `count` defaults to
   * that most. One coin write per video ever, and no daily cap: the balance
   * limits it. A refusal code from Bilibili is reported, never retried.
   * @param bvid - BV id.
   * @param count - 1 or 2; default the most the video takes.
   * @returns the write guard's outcome.
   */
  async coin(bvid: string, count?: number): Promise<WriteOutcome> {
    if (count !== undefined && count !== 1 && count !== 2) return { outcome: 'refused', detail: 'count must be 1 or 2' }
    const early = this.precheck('coin', bvid)
    if (early !== undefined) return early
    const target = await this.aidOf(bvid)
    if ('refusal' in target) return { outcome: 'refused', detail: target.refusal }
    const most = target.video.original ? 2 : 1
    const coins: 1 | 2 = count === undefined ? most : count
    if (coins > most) return { outcome: 'refused', detail: `${bvid} is not marked original, so Bilibili takes at most 1 coin for it` }
    let given = 0
    return this.write({
      action: 'coin', target: bvid,
      coins: () => coins,
      check: async () => {
        given = await coinsGiven(this.client, bvid)
        if (given > 0) return undefined
        return balanceRefusal((await navInfo(this.client)).coins ?? 0, coins)
      },
      preRead: () => Promise.resolve(given > 0 ? `this account already gave this video ${plural(given, 'coin')}; one coin write per video` : undefined),
      perform: async () => { await giveCoin(this.client, target.aid, bvid, coins); return undefined },
      sentDetail: () => `gave ${plural(coins, 'coin')}`,
    })
  }

  /**
   * 一键三连: like, coins (2 for an original, 1 otherwise), and a favorite in the
   * default folder, in one request. One per video ever, with the normal write
   * gap. Parts already done are reported and not counted; the like and favorite
   * it adds count against those daily caps, and it is refused when either cap
   * it would need is used up, or when the coins it would give exceed the balance.
   * @param bvid - BV id.
   * @returns the write guard's outcome.
   */
  async triple(bvid: string): Promise<WriteOutcome> {
    const early = this.precheck('triple', bvid)
    if (early !== undefined) return early
    const target = await this.aidOf(bvid)
    if ('refusal' in target) return { outcome: 'refused', detail: target.refusal }
    const most = target.video.original ? 2 : 1
    let adds: TriplePart[] = []
    let done: TriplePart[] = []
    let coins = most
    return this.write({
      action: 'triple', target: bvid,
      adds: () => adds,
      coins: () => (adds.includes('coin') ? coins : undefined),
      check: async () => {
        const mid = this.account()?.mid
        if (mid === undefined) return 'no Bilibili account is signed in'
        const liked = await hasLiked(this.client, bvid)
        const given = await coinsGiven(this.client, bvid)
        const saved = (await folders(this.client, mid, target.aid)).some(folder => folder.contains)
        const state: Record<TriplePart, boolean> = { like: liked, coin: given > 0, favorite: saved }
        done = TRIPLE_PARTS.filter(part => state[part])
        adds = TRIPLE_PARTS.filter(part => !state[part])
        if (adds.length === 0) return undefined
        const left = remaining(await this.ready, this.config.caps, Date.now(), this.config.timeZone)
        if (adds.includes('like') && left.like < 1) return `today's like budget (${this.config.caps.like}) is used up, and the triple would add a like`
        if (adds.includes('favorite') && left.favorite < 1) return `today's favorite budget (${this.config.caps.favorite}) is used up, and the triple would add a favorite`
        return adds.includes('coin') ? balanceRefusal((await navInfo(this.client)).coins ?? 0, most) : undefined
      },
      preRead: () => Promise.resolve(adds.length === 0 ? 'this account already liked, coined, and saved this video' : undefined),
      perform: async () => {
        const result = await tripleLike(this.client, target.aid, bvid)
        if (result.coin && result.coins > 0) coins = result.coins
        // Only what Bilibili applied counts; a part it skipped stays undone.
        adds = adds.filter(part => result[part])
        return undefined
      },
      sentDetail: () => tripleDetail(adds, done, coins),
    })
  }

  /** Report a watch of a video whose subtitles the account read, as far as it read; once a day. */
  private async reportWatchOf(video: VideoDetail, cid: number, reached: number): Promise<void> {
    const mid = this.account()?.mid
    if (mid === undefined) return
    const seconds = Math.max(1, Math.min(reached, video.seconds ?? reached))
    const outcome = await this.write({
      action: 'watch', target: video.bvid,
      perform: async () => {
        await reportWatch(this.client, { aid: video.aid, bvid: video.bvid, cid, mid, duration: video.seconds ?? seconds }, seconds)
        return undefined
      },
    })
    if (outcome.outcome === 'uncertain') this.ctx.logger.warn(`bili: the watch report of ${video.bvid} has an unknown outcome; not sent again`)
  }

  /** Report a share for each video link the host delivered to the owner; once per video. */
  private async reportSharesIn(text: string): Promise<void> {
    const ids = [...new Set(text.match(/BV[0-9A-Za-z]{10}/g) ?? [])].slice(0, 3)
    for (const bvid of ids) {
      if (this.precheck('share', bvid) !== undefined) continue
      await this.write({ action: 'share', target: bvid, perform: async () => { await reportShare(this.client, bvid); return undefined } })
    }
  }

  /**
   * Follow an account.
   * @param mid - its user id.
   * @returns the write guard's outcome.
   */
  async follow(mid: number): Promise<WriteOutcome> {
    if (!Number.isSafeInteger(mid) || mid <= 0) return { outcome: 'refused', detail: 'mid must be a positive user id' }
    if (mid === this.account()?.mid) return { outcome: 'refused', detail: 'this is the account itself' }
    return this.write({
      action: 'follow', target: `mid:${mid}`,
      preRead: async () => ([2, 6].includes(await relationTo(this.client, mid)) ? 'already following' : undefined),
      perform: async () => { await modifyRelation(this.client, mid, 1); return undefined },
    })
  }

  /**
   * Unfollow an account; the owner's account stays followed.
   * @param mid - its user id.
   * @returns the write guard's outcome.
   */
  async unfollow(mid: number): Promise<WriteOutcome> {
    if (!Number.isSafeInteger(mid) || mid <= 0) return { outcome: 'refused', detail: 'mid must be a positive user id' }
    if (mid === this.ownerMid()) return { outcome: 'refused', detail: 'the owner\'s account stays followed' }
    return this.write({
      action: 'unfollow', target: `mid:${mid}`,
      preRead: async () => ([2, 6].includes(await relationTo(this.client, mid)) ? undefined : 'not following'),
      perform: async () => { await modifyRelation(this.client, mid, 2); return undefined },
    })
  }

  /**
   * Add a video to a favorite folder (the default one unless named), or remove it.
   * @param bvid - BV id.
   * @param options - `remove`, and a folder id from `me()`.
   * @returns the write guard's outcome.
   */
  async favorite(bvid: string, options: { remove?: boolean; folderId?: number } = {}): Promise<WriteOutcome> {
    const early = this.precheck('favorite', bvid)
    if (early !== undefined) return early
    const video = await this.aidOf(bvid)
    if ('refusal' in video) return { outcome: 'refused', detail: video.refusal }
    let folder: Folder | undefined
    return this.write({
      action: 'favorite', target: bvid,
      check: async () => {
        const mid = this.account()?.mid
        if (mid === undefined) return 'no Bilibili account is signed in'
        const list = await folders(this.client, mid, video.aid)
        folder = options.folderId === undefined
          ? list.find(entry => entry.isDefault) ?? list[0]
          : list.find(entry => entry.id === options.folderId)
        return folder === undefined ? `no favorite folder ${options.folderId === undefined ? 'exists' : `with id ${options.folderId}`}` : undefined
      },
      preRead: () => Promise.resolve(options.remove === true
        ? folder?.contains === true ? undefined : `not in folder ${folder?.title ?? ''}`
        : folder?.contains === true ? `already in folder ${folder.title}` : undefined),
      perform: async () => {
        const ids = folder === undefined ? [] : [folder.id]
        await dealFavorite(this.client, video.aid, options.remove === true ? { add: [], remove: ids } : { add: ids, remove: [] }, bvid)
        return undefined
      },
    })
  }

  /**
   * Like a video.
   * @param bvid - BV id.
   * @returns the write guard's outcome.
   */
  async like(bvid: string): Promise<WriteOutcome> {
    const early = this.precheck('like', bvid)
    if (early !== undefined) return early
    const video = await this.aidOf(bvid)
    if ('refusal' in video) return { outcome: 'refused', detail: video.refusal }
    return this.write({
      action: 'like', target: bvid,
      preRead: async () => ((await hasLiked(this.client, bvid)) ? 'already liked' : undefined),
      perform: async () => { await likeVideo(this.client, video.aid, bvid); return undefined },
    })
  }

  /**
   * Add a video to watch later, or remove it.
   * @param bvid - BV id.
   * @param remove - remove instead of add.
   * @returns the write guard's outcome.
   */
  async watchLater(bvid: string, remove: boolean = false): Promise<WriteOutcome> {
    const early = this.precheck('watchlater', bvid)
    if (early !== undefined) return early
    const video = await this.aidOf(bvid)
    if ('refusal' in video) return { outcome: 'refused', detail: video.refusal }
    return this.write({
      action: 'watchlater', target: bvid,
      preRead: async () => {
        const listed = (await watchLaterAids(this.client)).has(video.aid)
        if (remove) return listed ? undefined : 'not on watch later'
        return listed ? 'already on watch later' : undefined
      },
      perform: async () => {
        await (remove ? removeWatchLater(this.client, video.aid) : addWatchLater(this.client, video.aid))
        return undefined
      },
    })
  }

  /**
   * Post one top-level comment on a video; one per video ever.
   * @param bvid - BV id.
   * @param text - at most 500 characters.
   * @returns the write guard's outcome; a sent comment carries its id as `receipt`.
   */
  async comment(bvid: string, text: string): Promise<WriteOutcome> {
    const early = this.precheck('comment', bvid, text)
    if (early !== undefined) return early
    const video = await this.aidOf(bvid)
    if ('refusal' in video) return { outcome: 'refused', detail: video.refusal }
    return this.write({
      action: 'comment', target: bvid, text, area: { type: VIDEO_AREA, oid: video.aid }, visibility: true,
      perform: () => addReply(this.client, { type: VIDEO_AREA, oid: video.aid }, text.trim(), bvid),
    })
  }

  /**
   * Reply to a comment that replied to or mentioned this account (from its inbox); one reply per comment ever.
   * @param rpid - the comment's id as the inbox shows it.
   * @param text - at most 500 characters.
   * @returns the write guard's outcome; a sent reply carries its id as `receipt`.
   */
  async reply(rpid: string, text: string): Promise<WriteOutcome> {
    const target = this.domain?.table('targets').get(rpid)
    if (target === undefined) return { outcome: 'refused', detail: `comment ${rpid} is not one that replied to or mentioned this account; read bili_inbox first` }
    const early = this.precheck('reply', rpid, text)
    if (early !== undefined) return early
    return this.write({
      action: 'reply', target: rpid, text, area: { type: target.type, oid: target.oid, root: target.root }, visibility: true,
      perform: () => addReply(this.client, { type: target.type, oid: target.oid, root: target.root, parent: rpid }, text.trim()),
    })
  }

  /**
   * Post a text-only dynamic.
   * @param text - at most 1000 characters.
   * @returns the write guard's outcome; a sent dynamic carries its id as `receipt`.
   */
  async dynamic(text: string): Promise<WriteOutcome> {
    return this.write({ action: 'dynamic', target: 'dynamic', text, perform: () => createDynamic(this.client, text.trim()) })
  }

  /**
   * Message the owner's main account; nobody else can be messaged.
   * @param text - at most 500 characters.
   * @returns the write guard's outcome; a sent message carries its key as `receipt`.
   */
  async dmOwner(text: string): Promise<WriteOutcome> {
    return this.messageOwner('dmOwner', text)
  }

  /** One message to the owner's main account through the write guard; the DM channel sends answers through it. */
  private async messageOwner(action: 'dmOwner' | 'dmReply', text: string, maxWaitMs?: number): Promise<WriteOutcome> {
    const ownerMid = this.ownerMid()
    if (ownerMid === undefined) return { outcome: 'refused', detail: 'no owner account is configured' }
    const outcome = await this.write({
      action, target: `mid:${ownerMid}`, text, ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
      check: async () => {
        const relation = await relationTo(this.client, ownerMid)
        if (relation === 6) return undefined
        return relation === 2
          ? 'the owner\'s account does not follow this account back; Bilibili delivers messages only between mutual followers, so ask the owner to follow it'
          : 'this account does not follow the owner\'s account and they are not mutual followers; Bilibili delivers messages only between mutual followers (bili_follow the owner, then the owner follows back)'
      },
      perform: async () => sendMessage(this.client, {
        sender: this.account()?.mid ?? 0, receiver: ownerMid, text: text.trim(), deviceId: await this.deviceId(),
      }),
    })
    if (outcome.outcome === 'sent') this.delivered(text)
    return outcome
  }

  /** A message reached the owner: each video it links is a find, and its share is reported. */
  private delivered(text: string): void {
    this.track(this.recordFinds(text))
    this.track(this.reportSharesIn(text))
  }

  /** Keep each video a message to the owner linked as a find, with its title when the account watched it. */
  private async recordFinds(text: string): Promise<void> {
    const ids = [...new Set(text.match(/BV[0-9A-Za-z]{10}/g) ?? [])].slice(0, 3)
    if (ids.length === 0) return
    const now = Date.now()
    await this.serialize(async () => {
      const domain = await this.ready
      const finds = domain.table('finds')
      for (const bvid of ids) {
        const title = this.titles.get(bvid)?.title ?? domain.table('seen').get(bvid)?.title
        await finds.put(bvid, { bvid, at: now, ...(title === undefined ? {} : { title }) })
      }
      const oldest = [...finds.entries()].sort(([, a], [, b]) => a.at - b.at).slice(0, Math.max(0, finds.size - MAX_FINDS))
      for (const [key] of oldest) await finds.delete(key)
    })
    this.ctx.logger.info(`bili: the owner got ${ids.length} find(s): ${ids.join(', ')}`)
  }

  /** Remember an opened video's title and uploader for finds and grades; the oldest are forgotten first. */
  private rememberTitle(bvid: string, title: string, author: string): void {
    this.titles.delete(bvid)
    this.titles.set(bvid, { title, author })
    for (const key of this.titles.keys()) {
      if (this.titles.size <= MAX_TITLES) break
      this.titles.delete(key)
    }
  }

  /** Add to a bounded set, forgetting the oldest. */
  private remember(set: Set<string>, value: string, max: number): void {
    set.delete(value)
    set.add(value)
    for (const key of set) {
      if (set.size <= max) break
      set.delete(key)
    }
  }

  /** The finds, newest first. */
  private recentFinds(): FindRecord[] {
    const rows = this.domain === undefined ? [] : [...this.domain.table('finds').entries()].map(([, row]) => row)
    return rows.sort((a, b) => b.at - a.at)
  }

  /** A stable device id for messages. */
  private async deviceId(): Promise<string> {
    return this.serialize(async () => {
      const domain = await this.ready
      const stored = domain.table('settings').get('device')
      if (stored !== undefined) return stored.text
      const device = randomUUID().toUpperCase()
      await domain.table('settings').put('device', { text: device, updatedAt: Date.now() })
      return device
    })
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  /**
   * The next batch of the home feed.
   * @returns about 12 bounded video cards.
   */
  async homeFeed(): Promise<VideoCard[]> {
    this.requireActive()
    this.feedIndex += 1
    return this.cards(await this.reading(() => homeFeed(this.client, this.feedIndex, this.config.timeZone)))
  }

  /**
   * The site leaderboard (排行榜) across all zones.
   * @returns up to 30 bounded video cards, top first.
   */
  async ranking(): Promise<VideoCard[]> {
    this.requireActive()
    return this.cards(await this.reading(() => ranking(this.client, this.config.timeZone)))
  }

  /**
   * A sample of a video's danmaku: the jokes and reactions of its own viewers.
   * @param bvid - BV id.
   * @param part - part number of a multi-part video.
   * @returns up to 40 lines across the video, each with its second.
   */
  async danmaku(bvid: string, part?: number): Promise<{ bvid: string; lines: DanmakuLine[] }> {
    this.requireActive()
    if (bvidOf(bvid) === undefined) throw new Error(`${JSON.stringify(bvid)} is not a BV id`)
    return this.reading(async () => {
      const video = await videoInfo(this.client, bvid, this.config.timeZone)
      const cid = video.parts.find(page => page.page === part)?.cid ?? video.cid
      return { bvid: video.bvid, lines: await danmaku(this.client, cid, DANMAKU_LINES) }
    })
  }

  /** Video cards without the owner's own uploads, each marked with the account's grade if it graded it. */
  private cards(items: VideoCard[]): VideoCard[] {
    const seen = this.domain?.table('seen')
    return this.notOwners(items).map((item) => {
      const grade = seen?.get(item.bvid)?.grade
      return grade === undefined ? item : { ...item, graded: grade }
    })
  }

  /**
   * What followed accounts posted, without the owner's own posts.
   * @param offset - `next` of the previous page.
   * @returns bounded posts, newest first, and the `next` offset when there are more.
   */
  async followingFeed(offset?: string): Promise<{ items: FeedPost[]; next?: string }> {
    this.requireActive()
    const page = await this.reading(() => followingFeed(this.client, offset, this.config.timeZone))
    return { ...page, items: this.notOwners(page.items) }
  }

  /**
   * Popular videos.
   * @param page - from 1.
   * @returns bounded video cards.
   */
  async popular(page: number = 1): Promise<VideoCard[]> {
    this.requireActive()
    return this.cards(await this.reading(() => popular(this.client, Math.max(1, Math.floor(page)), this.config.timeZone)))
  }

  /**
   * Search videos.
   * @param keyword - search words.
   * @param page - from 1.
   * @param order - `relevance` (default) or `newest` first.
   * @returns bounded video cards.
   */
  async search(keyword: string, page: number = 1, order: SearchOrder = 'relevance'): Promise<VideoCard[]> {
    this.requireActive()
    const words = keyword.trim().slice(0, 100)
    if (words === '') throw new Error('the keyword is empty')
    return this.cards(await this.reading(() => search(this.client, words, Math.max(1, Math.floor(page)), this.config.timeZone, order)))
  }

  /**
   * Feed entries without the owner's own uploads and posts: the owner has seen them, so they are never finds,
   * and the account's browsing goes to what the owner has not seen.
   */
  private notOwners<T extends { authorMid?: number | undefined }>(items: T[]): T[] {
    const owner = this.ownerMid()
    return owner === undefined ? items : items.filter(item => item.authorMid !== owner)
  }

  /**
   * A video: facts, one page of subtitles (with coverage notes), and top comments.
   * @param bvid - BV id.
   * @param options - subtitle page and part.
   * @returns the facts, one subtitle page or the reason there is none, and up to five top comments.
   */
  async video(
    bvid: string, options: { subtitlePage?: number; part?: number } = {},
  ): Promise<{ video: VideoDetail; subtitle: SubtitleView; topComments: CommentView[] }> {
    this.requireActive()
    if (bvidOf(bvid) === undefined) throw new Error(`${JSON.stringify(bvid)} is not a BV id`)
    return this.reading(async () => {
      const video = await videoInfo(this.client, bvid, this.config.timeZone)
      // Opened in a wake: it counts toward the wake's watch floor, and a find that links it gets its title.
      this.wakeRun?.watched.add(video.bvid)
      this.rememberTitle(video.bvid, video.title, video.author)
      const cid = video.parts.find(part => part.page === options.part)?.cid ?? video.cid
      const subtitle = await subtitles(this.client, bvid, cid, options.subtitlePage ?? 1)
      if (subtitle.reached !== undefined) this.remember(this.read, video.bvid, MAX_READ)
      const top = await comments(this.client, video.aid, { order: 'hot' }, this.config.timeZone)
      // It read what the video says: report a watch that far (in the background; never the owner's videos).
      if (subtitle.reached !== undefined) this.track(this.reportWatchOf(video, cid, subtitle.reached))
      return { video, subtitle: subtitle.view, topComments: top.comments.slice(0, 5) }
    })
  }

  /**
   * Comments of a video, or one thread when `root` is given.
   * @param bvid - BV id.
   * @param options - order, `next` offset, root comment id, and thread page.
   * @returns bounded comments and the `next` offset, or a thread with its root.
   */
  async comments(bvid: string, options: { order?: 'hot' | 'new'; offset?: string; root?: string; page?: number } = {}): Promise<{ comments: CommentView[]; next?: string; root?: CommentView }> {
    this.requireActive()
    if (bvidOf(bvid) === undefined) throw new Error(`${JSON.stringify(bvid)} is not a BV id`)
    return this.reading(async () => {
      const video = await videoInfo(this.client, bvid, this.config.timeZone)
      if (options.root !== undefined) {
        if (!/^\d+$/.test(options.root)) throw new Error('root must be a comment id')
        const page = Math.max(1, Math.floor(options.page ?? 1))
        const result = await thread(this.client, { type: VIDEO_AREA, oid: video.aid, root: options.root }, page, this.config.timeZone)
        return { comments: result.replies, ...(result.root === undefined ? {} : { root: result.root }) }
      }
      return comments(this.client, video.aid, { order: options.order ?? 'hot', ...(options.offset === undefined ? {} : { offset: options.offset }) }, this.config.timeZone)
    })
  }

  /**
   * Unread counts, the newest replies and mentions, and the owner's latest messages; what it shows counts as seen.
   * @returns unread counts, up to ten replies and mentions, and the owner's latest messages.
   */
  async inbox(): Promise<InboxView> {
    this.requireActive()
    return this.reading(async () => {
      const unread = await unreadCounts(this.client)
      const replies = await inboxItems(this.client, 'reply')
      const mentions = await inboxItems(this.client, 'at')
      const ownerMid = this.ownerMid()
      const owner = ownerMid === undefined ? [] : await ownerMessages(this.client, ownerMid)
      await this.markSeen('reply', replies)
      await this.markSeen('at', mentions)
      await this.markSeen('dm', owner)
      const strip = ({ type: _type, oid: _oid, root: _root, ...rest }: InboxItem): Omit<InboxItem, 'type' | 'oid' | 'root'> => rest
      return {
        unread, replies: replies.slice(0, 10).map(strip), mentions: mentions.slice(0, 10).map(strip), ownerMessages: owner.slice(-10),
      }
    })
  }

  /** Record items the model has read so no inbox wake repeats them. */
  private async markSeen(kind: PendingRecord['kind'], items: readonly (InboxItem | OwnerMessage)[]): Promise<void> {
    await this.serialize(async () => {
      const domain = await this.ready
      const seen = new Set(domain.table('inbox').get(kind)?.seen ?? [])
      for (const item of items) {
        if ('rpid' in item) await this.rememberTarget(item)
        seen.add(item.id)
        await domain.table('pending').delete(`${kind}:${item.id}`)
      }
      await domain.table('inbox').put(kind, { seen: [...seen].slice(-MAX_SEEN) })
    })
  }

  /**
   * The account, its folders, and today's budget.
   * @returns the account facts, or `signedIn: false`, with today's budget and any pause.
   */
  async me(): Promise<MeView> {
    const domain = await this.ready
    const now = Date.now()
    const budget = remaining(domain, this.config.caps, now, this.config.timeZone)
    const pause = domain.table('pause').get('writes')
    const backoff = domain.table('backoff').get('reads')
    const base = {
      budget,
      ...(pause === undefined ? {} : { pause: `${pause.scope === 'all' ? 'all writes' : 'public speech'} paused (${pause.reason}) until the owner resumes them` }),
      ...(backoff === undefined || backoff.until <= now ? {} : { readsResumeAt: new Date(backoff.until).toISOString() }),
    }
    const account = this.account()
    if (account?.state !== 'active') return { signedIn: false, ...base }
    // While reads back off, the card comes from storage alone.
    if (backoff !== undefined && backoff.until > now) {
      return { signedIn: true, mid: account.mid, uname: account.uname, level: account.level, ...base }
    }
    return this.reading(async () => {
      const nav = await navInfo(this.client)
      const stat = await relationStat(this.client, account.mid)
      const list = await folders(this.client, account.mid)
      const rewards = await dailyRewards(this.client)
      await this.storeProgress(nav, rewards)
      return {
        signedIn: true, mid: account.mid, uname: nav.uname ?? account.uname, level: nav.level ?? account.level,
        ...(nav.exp === undefined ? {} : { exp: nav.exp }), ...(nav.coins === undefined ? {} : { coins: nav.coins }), rewards,
        ...stat, folders: list, ...base,
      }
    })
  }

  /** Read level, EXP, coins, and today's rewards again (after a report or a coin, and with each cookie check). */
  private async refreshProgress(): Promise<void> {
    if (this.account()?.state !== 'active') return
    try {
      await this.storeProgress(await navInfo(this.client), await dailyRewards(this.client))
    } catch (error: unknown) {
      this.ctx.logger.debug(`bili: could not read level and daily rewards: ${errorText(error)}`)
    }
  }

  /** Keep the latest level, EXP, coins, and rewards for Settings; log a level-up. */
  private async storeProgress(nav: Awaited<ReturnType<typeof navInfo>>, rewards: DailyRewards): Promise<void> {
    const exp = nav.exp
    if (!nav.isLogin || exp === undefined) return
    const now = Date.now()
    const level = nav.level ?? 0
    const before = this.account()?.level
    await this.serialize(async () => {
      const domain = await this.ready
      await domain.table('progress').put('current', {
        level, exp: exp.current, min: exp.min, next: exp.next, coins: nav.coins ?? 0,
        rewards: { day: dayKey(now, this.config.timeZone), ...rewards }, checkedAt: now,
      })
    })
    if (before !== undefined && level !== before) {
      await this.updateAccount({ level })
      this.ctx.logger.info(`bili: the account is now LV${level} (${exp.current} EXP)`)
    }
  }

  /** The stored progress, for Settings. */
  private progressView(): ProgressView | null {
    const row = this.domain?.table('progress').get('current')
    return row === undefined ? null : { ...row }
  }

  // ── Journal ────────────────────────────────────────────────────────────

  /**
   * Keep one dated journal entry.
   * @param text - at most 600 characters; at most 8 entries a day.
   * @returns the stored entry's number and what is left today, or why it was refused.
   */
  async journalWrite(text: string): Promise<{ saved: true; seq: number; leftToday: number } | { refused: string }> {
    const entry = text.trim()
    if (entry === '') return { refused: 'the entry is empty' }
    if (codePoints(entry) > JOURNAL_LIMITS.chars) return { refused: `the entry is ${codePoints(entry)} characters; the limit is ${JOURNAL_LIMITS.chars}` }
    return this.serialize(async () => {
      const domain = await this.ready
      const now = Date.now()
      const day = dayKey(now, this.config.timeZone)
      const rows = [...domain.table('journal').entries()].map(([, row]) => row)
      const today = rows.filter(row => row.day === day).length
      if (today >= JOURNAL_LIMITS.perDay) return { refused: `today already has ${JOURNAL_LIMITS.perDay} entries` }
      const seq = Math.max(0, ...rows.map(row => row.seq)) + 1
      await domain.table('journal').put(seqKey(seq), { seq, day, at: now, text: entry })
      this.ctx.logger.info(`bili: journal entry ${seq} (${codePoints(entry)} chars)`)
      return { saved: true as const, seq, leftToday: JOURNAL_LIMITS.perDay - today - 1 }
    })
  }

  /**
   * Recent journal entries, newest first.
   * @param page - from 1.
   * @returns up to ten entries and the page count.
   */
  async journalRead(page: number = 1): Promise<{ entries: { seq: number; day: string; text: string }[]; page: number; pages: number }> {
    const domain = await this.ready
    const rows = [...domain.table('journal').entries()].map(([, row]) => row).sort((a, b) => b.seq - a.seq)
    const pages = Math.max(1, Math.ceil(rows.length / JOURNAL_LIMITS.pageSize))
    const index = Math.min(Math.max(1, Math.floor(page)), pages)
    const entries = rows
      .slice((index - 1) * JOURNAL_LIMITS.pageSize, index * JOURNAL_LIMITS.pageSize)
      .map(({ seq, day, text }) => ({ seq, day, text }))
    return { entries, page: index, pages }
  }

  // ── Main agent ─────────────────────────────────────────────────────────

  /**
   * Send one message to the owner's main agent (`bili_tell_main_agent`): the WeChat channel queues it
   * in the owner's chat Session as untrusted data, and that Session's answer goes to the owner on
   * WeChat. Bounded per day by `mainAgentPerDay`; only messages that were queued count.
   * @param text - at most {@link MAIN_AGENT_MAX_CHARS} characters.
   * @returns `sent` with what is left today, or `refused` with the reason.
   */
  async tellMainAgent(text: string): Promise<WriteOutcome> {
    const message = text.trim()
    if (message === '') return { outcome: 'refused', detail: 'the message is empty' }
    const chars = codePoints(message)
    if (chars > MAIN_AGENT_MAX_CHARS) return { outcome: 'refused', detail: `the message is ${chars} characters; the limit is ${MAIN_AGENT_MAX_CHARS}` }
    return this.serialize(async (): Promise<WriteOutcome> => {
      const domain = await this.ready
      const now = Date.now()
      const day = dayKey(now, this.config.timeZone)
      const rows = [...domain.table('told').entries()].map(([, row]) => row)
      // Only today's messages count, so earlier days' rows go.
      for (const row of rows.filter(row => row.day !== day)) await domain.table('told').delete(seqKey(row.seq))
      const kept = rows.filter(row => row.day === day)
      const today = kept.length
      const perDay = this.config.mainAgentPerDay
      if (today >= perDay) return { outcome: 'refused', detail: `today's ${perDay} message(s) to the main agent are used up` }
      const notifier = this.ctx.get('lsyNotifier')
      if (notifier?.tellMainAgent === undefined) return { outcome: 'refused', detail: 'the owner\'s WeChat channel is not running, so the main agent cannot be reached' }
      let sessionId: string
      try {
        sessionId = await notifier.tellMainAgent({ text: message, from: BILI_AGENT_ORIGIN })
      } catch (error: unknown) {
        this.ctx.logger.warn(`bili: the message to the main agent did not go out: ${errorText(error)}`)
        return { outcome: 'refused', detail: `the main agent could not take it: ${errorText(error)}` }
      }
      const seq = Math.max(0, ...kept.map(row => row.seq)) + 1
      await domain.table('told').put(seqKey(seq), { seq, day, at: now, chars, sessionId })
      this.ctx.logger.info(`bili: told the main agent ${chars} chars in chat Session ${sessionId} (${today + 1}/${perDay} today)`)
      const left = perDay - today - 1
      return { outcome: 'sent', detail: `the main agent got it and takes it up in a turn of its own; its answer goes to the owner on WeChat, not to you. ${left} left today.` }
    })
  }

  // ── Taste ──────────────────────────────────────────────────────────────

  /** The notes on the owner's taste, oldest first; every wake prompt lists them. */
  private tasteNotes(): TasteRecord[] {
    const rows = this.domain === undefined ? [] : [...this.domain.table('taste').entries()].map(([, row]) => row)
    return rows.sort((a, b) => a.seq - b.seq)
  }

  /**
   * Keep one note about the owner's taste (`bili_taste_write`): what a reaction to a find taught,
   * or what the owner said they want more or less of.
   * @param text - at most 200 characters, one line.
   * @param replaces - number of one of the Session's own notes to rewrite instead of adding one.
   * @returns the note's number and how many notes there are, or why it was refused.
   */
  async tasteWrite(text: string, replaces?: number): Promise<{ saved: true; seq: number; notes: number } | { refused: string }> {
    return this.keepTaste(text, 'cat', replaces)
  }

  /**
   * Add or rewrite a note. When the notes are full, the oldest of the Session's own makes room;
   * the owner's stay until the owner deletes them, and the Session cannot rewrite them.
   */
  private async keepTaste(text: string, from: TasteRecord['from'], replaces?: number): Promise<{ saved: true; seq: number; notes: number } | { refused: string }> {
    const note = clean(text, 10_000)
    if (note === '') return { refused: 'the note is empty' }
    if (codePoints(note) > TASTE_LIMITS.chars) return { refused: `the note is ${codePoints(note)} characters; the limit is ${TASTE_LIMITS.chars}` }
    return this.serialize(async () => {
      const domain = await this.ready
      const table = domain.table('taste')
      const rows = [...table.entries()].map(([, row]) => row).sort((a, b) => a.seq - b.seq)
      const now = Date.now()
      if (replaces !== undefined) {
        const old = rows.find(row => row.seq === replaces)
        if (old === undefined) return { refused: `there is no note ${replaces}` }
        if (old.from === 'owner' && from === 'cat') return { refused: `note ${replaces} is the owner's own; add a new note instead` }
        await table.put(seqKey(old.seq), { seq: old.seq, at: now, text: note, from })
        this.ctx.logger.info(`bili: taste note ${old.seq} rewritten by the ${from === 'owner' ? 'owner' : 'Session'} (${codePoints(note)} chars)`)
        return { saved: true as const, seq: old.seq, notes: rows.length }
      }
      let count = rows.length
      if (count >= TASTE_LIMITS.notes) {
        const victim = rows.find(row => row.from === 'cat')
        if (victim === undefined) return { refused: `all ${TASTE_LIMITS.notes} notes are the owner's own` }
        await table.delete(seqKey(victim.seq))
        count -= 1
        this.ctx.logger.info(`bili: taste note ${victim.seq} dropped to make room`)
      }
      const seq = Math.max(0, ...rows.map(row => row.seq)) + 1
      await table.put(seqKey(seq), { seq, at: now, text: note, from })
      this.ctx.logger.info(`bili: taste note ${seq} by the ${from === 'owner' ? 'owner' : 'Session'} (${codePoints(note)} chars)`)
      return { saved: true as const, seq, notes: count + 1 }
    })
  }

  // ── Grades ─────────────────────────────────────────────────────────────

  /**
   * Grade a watched video (`bili_verdict`): `must` 值得看, `ok` 可以看, or `skip` 不值当, and why.
   * `must` needs evidence: the account read the video's subtitles with `video()` first; a grade from
   * the title alone is at most `ok`. Grading again replaces the grade.
   * @param bvid - BV id.
   * @param grade - the grade.
   * @param reason - why, at most 120 characters.
   * @returns the grade kept, or why it was refused.
   */
  async verdict(bvid: string, grade: Grade, reason: string): Promise<{ saved: true; grade: Grade } | { refused: string }> {
    const id = bvidOf(bvid)
    if (id === undefined) return { refused: `${JSON.stringify(bvid)} is not a BV id` }
    if (!(GRADES as readonly string[]).includes(grade)) return { refused: 'grade must be must, ok, or skip' }
    const why = clean(reason, 10_000)
    if (why === '') return { refused: 'say why' }
    if (codePoints(why) > VERDICT_CHARS) return { refused: `the reason is ${codePoints(why)} characters; the limit is ${VERDICT_CHARS}` }
    const read = this.read.has(id)
    if (grade === 'must' && !read) return { refused: `you have not read the subtitles of ${id} (bili_video); without them it is at most ok` }
    const known = this.titles.get(id)
    await this.serialize(async () => {
      const domain = await this.ready
      const table = domain.table('seen')
      const facts = known === undefined ? {} : { title: known.title, author: known.author }
      await table.put(id, { bvid: id, at: Date.now(), ...facts, grade, reason: why, read })
      const oldest = [...table.entries()].sort(([, a], [, b]) => a.at - b.at).slice(0, Math.max(0, table.size - MAX_SEEN_VIDEOS))
      for (const [key] of oldest) await table.delete(key)
    })
    this.ctx.logger.info(`bili: graded ${id} ${grade}${read ? '' : ' (subtitles not read)'}`)
    return { saved: true as const, grade }
  }

  /**
   * The seen list: what the account graded, newest first, or one video's grade.
   * @param bvid - one video to look up.
   * @param limit - entries, at most 50.
   * @returns the grades.
   */
  async seen(bvid?: string, limit: number = 30): Promise<{ entries: Omit<SeenRecord, 'at'>[] }> {
    const domain = await this.ready
    const rows = [...domain.table('seen').entries()].map(([, row]) => row).sort((a, b) => b.at - a.at)
    const picked = bvid === undefined ? rows.slice(0, Math.max(1, Math.min(50, Math.floor(limit)))) : rows.filter(row => row.bvid === bvid)
    return { entries: picked.map(({ at: _at, ...row }) => row) }
  }

  /** Links of a held answer that are not graded must. */
  private unjudged(text: string | undefined): string[] {
    const seen = this.domain?.table('seen')
    const ids = [...new Set(text?.match(/BV[0-9A-Za-z]{10}/g) ?? [])]
    return ids.filter(id => seen?.get(id)?.grade !== 'must')
  }

  /** Picks sent today: finds delivered since local midnight. */
  private picksToday(now: number): number {
    const day = dayKey(now, this.config.timeZone)
    return this.recentFinds().filter(find => dayKey(find.at, this.config.timeZone) === day).length
  }

  /** The owner's keywords: the Settings edit, else the configured ones. */
  private keywords(): { list: string[]; text: string; updatedAt: number | null } {
    const row = this.domain?.table('settings').get('keywords')
    const text = row === undefined ? this.config.keywords.join('\n') : row.text
    const list = text.split('\n').map(line => line.trim()).filter(line => line !== '').slice(0, MAX_KEYWORDS)
    return { list, text, updatedAt: row?.updatedAt ?? null }
  }

  // ── Trends ─────────────────────────────────────────────────────────────

  /**
   * The hot-search list (热搜): what the whole site searches for right now.
   * @returns up to 30 keywords, each with the label the search box shows when it differs.
   */
  async hotSearches(): Promise<HotSearch[]> {
    this.requireActive()
    return this.reading(() => hotSearches(this.client, HOT_SEARCHES))
  }

  /** The trend notebook, newest first; `fresh` keeps only what a wake still lists. */
  private trendNotes(fresh = false): TrendRecord[] {
    const rows = this.domain === undefined ? [] : [...this.domain.table('trends').entries()].map(([, row]) => row)
    const since = Date.now() - TREND_LIMITS.freshDays * 86_400_000
    return rows.filter(row => !fresh || row.at >= since).sort((a, b) => b.at - a.at || b.seq - a.seq)
  }

  /**
   * Note one meme, event, or phrase the account met (`bili_trend_write`): what it is, where it
   * comes from, and which community it lives in, so later wakes understand it and can tell the owner.
   * A term already noted is rewritten in place.
   * @param term - the meme itself, at most 30 characters.
   * @param note - at most 200 characters.
   * @param replaces - number of an entry to rewrite instead.
   * @returns the entry's number, or why it was refused.
   */
  async trendWrite(term: string, note: string, replaces?: number): Promise<{ saved: true; seq: number } | { refused: string }> {
    const name = clean(term, 10_000)
    const text = clean(note, 10_000)
    if (name === '' || text === '') return { refused: 'the term and its note must both be filled' }
    if (codePoints(name) > TREND_LIMITS.term) return { refused: `the term is ${codePoints(name)} characters; the limit is ${TREND_LIMITS.term}` }
    if (codePoints(text) > TREND_LIMITS.chars) return { refused: `the note is ${codePoints(text)} characters; the limit is ${TREND_LIMITS.chars}` }
    return this.serialize(async () => {
      const domain = await this.ready
      const table = domain.table('trends')
      const rows = [...table.entries()].map(([, row]) => row)
      const old = replaces === undefined ? rows.find(row => row.term === name) : rows.find(row => row.seq === replaces)
      if (replaces !== undefined && old === undefined) return { refused: `there is no entry ${replaces}` }
      const seq = old?.seq ?? Math.max(0, ...rows.map(row => row.seq)) + 1
      await table.put(seqKey(seq), { seq, at: Date.now(), term: name, note: text })
      const oldest = [...table.entries()].sort(([, a], [, b]) => a.at - b.at).slice(0, Math.max(0, table.size - TREND_LIMITS.entries))
      for (const [key] of oldest) await table.delete(key)
      this.ctx.logger.info(`bili: trend ${seq} ${old === undefined ? 'noted' : 'rewritten'} (${codePoints(name)}+${codePoints(text)} chars)`)
      return { saved: true as const, seq }
    })
  }

  // ── Settings route ─────────────────────────────────────────────────────

  /**
   * What the Settings section shows. Built from storage only, so no cookie or token can reach it.
   * @returns the view.
   */
  async view(): Promise<BiliView> {
    const domain = await this.ready
    const now = Date.now()
    const account = domain.table('account').get('current')
    const pause = domain.table('pause').get('writes')
    const backoff = domain.table('backoff').get('reads')
    const day = dayKey(now, this.config.timeZone)
    const used = usage(domain, day)
    const plans = await this.currentPlans(now)
    const recent = ledgerRows(domain).slice(-10).reverse()
    const lastWake = this.lastWake()
    return {
      account: account === undefined ? { state: 'signed-out' } : accountView(account),
      login: this.login.view,
      pause: pause === undefined ? null : { scope: pause.scope, reason: pause.reason, since: pause.since },
      readsResumeAt: backoff === undefined || backoff.until <= now ? null : backoff.until,
      usage: { day, actions: CAPPED_ACTIONS.map(action => ({ action, used: used[action], cap: this.config.caps[action] })) },
      interests: this.interests(),
      clock: {
        timeZone: this.config.timeZone,
        today: plans.today.wakes.map(wake => ({
          window: `${this.config.wakes[wake.window]?.start ?? '?'}–${this.config.wakes[wake.window]?.end ?? '?'}`,
          at: wake.at ?? null,
          state: wake.state,
          ...(wake.adjusted === undefined ? {} : { adjusted: wake.adjusted }),
        })),
        nextWakeAt: this.nextWake(plans) ?? null,
        lastWake: lastWake ?? null,
        route: this.routeView(now),
      },
      recent: recent.map(row => ({
        at: row.reservedAt, action: row.action, target: row.target, state: row.state,
        ...(row.detail === undefined ? {} : { detail: row.detail }),
        ...(row.visibility === undefined ? {} : { visibility: row.visibility }),
      })),
      ownerMid: this.ownerMid() ?? 0,
      ownerUpdatedAt: domain.table('owner').get('main')?.updatedAt ?? null,
      manualWake: this.manual ?? null,
      progress: this.progressView(),
      verification: VERIFY_KINDS.flatMap((kind) => {
        const row = domain.table('verify').get(kind)
        return row === undefined ? [] : [{ kind, message: row.message, since: row.since }]
      }),
      taste: this.tasteNotes().map(({ seq, at, text, from }) => ({ seq, at, text, from })),
      finds: this.recentFinds().slice(0, FINDS_IN_VIEW).map(({ bvid, at, title, reaction }) => ({
        bvid, at, ...(title === undefined ? {} : { title }), ...(reaction === undefined ? {} : { reaction }),
      })),
      trends: this.trendNotes().map(({ seq, at, term, note }) => ({ seq, at, term, note })),
      keywords: { text: this.keywords().text, updatedAt: this.keywords().updatedAt },
      today: this.todayView(domain, now),
      seen: this.seenView(domain),
    }
  }

  /** Today's report: grades given today, and picks sent against the quota. */
  private todayView(domain: Domain<typeof biliDomain>, now: number): BiliView['today'] {
    const day = dayKey(now, this.config.timeZone)
    const graded: Record<Grade, number> = { must: 0, ok: 0, skip: 0 }
    for (const [, row] of domain.table('seen').entries()) if (dayKey(row.at, this.config.timeZone) === day) graded[row.grade] += 1
    return { day, graded, picks: this.picksToday(now), perDay: this.config.picksPerDay }
  }

  /** The graded videos, newest first, marked when they went to the owner. */
  private seenView(domain: Domain<typeof biliDomain>): SeenView[] {
    const finds = domain.table('finds')
    return [...domain.table('seen').entries()].map(([, row]) => row).sort((a, b) => b.at - a.at).slice(0, SEEN_IN_VIEW)
      .map(({ bvid, at, title, author, grade, reason, read }) => ({
        bvid, at, ...(title === undefined ? {} : { title }), ...(author === undefined ? {} : { author }),
        grade, reason, read, sent: finds.get(bvid) !== undefined,
      }))
  }

  /** The route of the last check, with when off-peak starts while it is in a peak. */
  private routeView(now: number): RouteView | null {
    const route = this.lastRoute
    if (route === undefined) return null
    const offPeakAt = route.rule === undefined || peakAt(route.rule, now) === undefined ? null : nextOffPeak(route.rule, now) ?? null
    return { provider: route.provider, model: route.model, source: route.source, priced: route.rule !== undefined, offPeakAt }
  }

  /** `GET` answers the view; `POST` takes one owner action and answers the new view. */
  private async route(request: Request): Promise<Response> {
    const headers = { 'cache-control': 'no-store' }
    if (request.method === 'POST') {
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return Response.json({ error: 'expected application/json' }, { status: 415, headers })
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'body is not JSON' }, { status: 400, headers })
      }
      const action = (body as { action?: unknown } | null)?.action
      if (action === 'login') {
        await this.startLogin()
      } else if (action === 'resume') {
        await this.resume()
      } else if (action === 'wake') {
        this.manual = await this.manualWake()
      } else if (action === 'interests') {
        const text = (body as { text?: unknown }).text
        if (typeof text !== 'string' || codePoints(text) > MAX_INTERESTS_CHARS) return Response.json({ error: `text must be a string of at most ${MAX_INTERESTS_CHARS} characters` }, { status: 400, headers })
        await this.serialize(async () => {
          const domain = await this.ready
          await domain.table('settings').put('interests', { text: text.trim(), updatedAt: Date.now() })
        })
        this.ctx.logger.info(`bili: the owner updated the interests text (${codePoints(text.trim())} chars)`)
      } else if (action === 'owner') {
        const mid = (body as { mid?: unknown }).mid
        if (typeof mid !== 'number' || !Number.isSafeInteger(mid) || mid <= 0) return Response.json({ error: 'mid must be a positive integer UID' }, { status: 400, headers })
        if (mid === this.account()?.mid) return Response.json({ error: 'mid is this account itself, not the owner\'s main account' }, { status: 400, headers })
        await this.setOwner(mid)
      } else if (action === 'taste-add') {
        const text = (body as { text?: unknown }).text
        const kept = typeof text === 'string' ? await this.keepTaste(text, 'owner') : { refused: 'text must be a string' }
        if ('refused' in kept) return Response.json({ error: kept.refused }, { status: 400, headers })
      } else if (action === 'taste-delete') {
        const seq = (body as { seq?: unknown }).seq
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return Response.json({ error: 'seq must be a note number' }, { status: 400, headers })
        const deleted = await this.serialize(async () => (await this.ready).table('taste').delete(seqKey(seq)))
        if (deleted) this.ctx.logger.info(`bili: the owner deleted taste note ${seq}`)
      } else if (action === 'keywords') {
        const text = (body as { text?: unknown }).text
        if (typeof text !== 'string' || codePoints(text) > MAX_KEYWORDS_CHARS) return Response.json({ error: `text must be a string of at most ${MAX_KEYWORDS_CHARS} characters` }, { status: 400, headers })
        const kept = text.split('\n').map(line => line.trim()).filter(line => line !== '').join('\n')
        await this.serialize(async () => { await (await this.ready).table('settings').put('keywords', { text: kept, updatedAt: Date.now() }) })
        this.ctx.logger.info(`bili: the owner updated the keywords (${kept === '' ? 0 : kept.split('\n').length})`)
      } else if (action === 'trend-delete') {
        const seq = (body as { seq?: unknown }).seq
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return Response.json({ error: 'seq must be an entry number' }, { status: 400, headers })
        const deleted = await this.serialize(async () => (await this.ready).table('trends').delete(seqKey(seq)))
        if (deleted) this.ctx.logger.info(`bili: the owner deleted trend ${seq}`)
      } else {
        return Response.json({ error: 'unknown action' }, { status: 400, headers })
      }
    }
    return Response.json(await this.view(), { headers })
  }

  /**
   * Store the owner's main account. A different UID drops the owner-message baseline, so the next
   * inbox check records the new conversation's history instead of waking on it.
   */
  private async setOwner(mid: number): Promise<void> {
    const changed = await this.serialize(async () => {
      const domain = await this.ready
      const before = this.ownerMid()
      await domain.table('owner').put('main', { mid, updatedAt: Date.now() })
      if (before !== mid) await domain.table('inbox').delete('dm')
      return before !== mid
    })
    this.ctx.logger.info(`bili: the owner ${changed ? 'set a new' : 'saved the same'} main account UID`)
  }

  /** The owner's Resume: lift the write pause and the read back-off. */
  private async resume(): Promise<void> {
    const lifted = await this.serialize(async () => {
      const domain = await this.ready
      const paused = await domain.table('pause').delete('writes')
      const backedOff = await domain.table('backoff').delete('reads')
      return paused || backedOff
    })
    if (lifted) this.ctx.logger.info('bili: the owner resumed writes and reads from Settings')
  }
}

export default BiliAccount
