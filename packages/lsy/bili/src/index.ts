/**
 * The agent's own Bilibili account (`ctx.bili`). The owner signs it in once
 * by scanning a web QR code from Settings; the cookies and refresh token live
 * in one credential record and are refreshed daily. The account's long-lived
 * Session wakes on a body clock and when its inbox has something new, and
 * each turn's final answer goes to the owner's WeChat. Every write passes one
 * host-side guard (identity check, daily caps, one comment per video, a
 * random gap, a durable ledger), and risk-control answers pause writes until
 * the owner resumes them in Settings. Nothing here can be cleared by the model.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
// Type-only: the ctx.lsyNotifier service the WeChat channel provides.
import type {} from '@deepseek-ai/dsh-lsy-event-bus'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { encode } from 'uqr'
import {
  addReply, addWatchLater, bvidOf, commentRows, comments, createDynamic, dealFavorite, folders, followingFeed, hasLiked, homeFeed,
  inboxItems, likeVideo, modifyRelation, navInfo, ownerMessages, popular, relationStat, relationTo, removeWatchLater, search,
  sendMessage, subtitles, thread, threadRows, unreadCounts, videoInfo, VIDEO_AREA, watchLaterAids,
  type CommentView, type FeedPost, type Folder, type InboxItem, type OwnerMessage, type SubtitleView, type VideoCard, type VideoDetail,
} from './api.ts'
import { REFRESH_PUBLIC_KEY, confirmRefresh, deviceCookies, exchangeRefresh, parseGrant, pollQr, refreshNeeded, startQr, type BiliGrant, type QrPoll } from './auth.ts'
import { BiliApiError, BiliClient, BiliRefused, BiliRiskError, BiliTransportError } from './client.ts'
import { nextPlanned, rollPlan, settlePlan, windowProblem, type WakeWindow } from './clock.ts'
import type { CookieJar } from './cookies.ts'
import type { Endpoint, EndpointName } from './endpoints.ts'
import { DEFAULT_CAPS, HARD_CAPS, alreadyTaken, ledgerRows, nextSlot, pauseRefusal, remaining, reserve, settle, settleInterrupted, takeSlot, uncertainBefore, usage } from './guard.ts'
import { biliDomain, seqKey, type AccountRecord, type LedgerRecord, type PendingRecord, type PlanRecord, type WriteAction } from './storage.ts'
import { NOTICES, TEXT_LIMITS, codePoints, failureDetail, inboxPrompt, relayBody, wakePrompt } from './text.ts'
import { dayKey, formatGap, isTimeZone, nextDayStart } from './time.ts'
import { BILI_PATH, MAX_INTERESTS_CHARS, WRITE_ACTIONS, type BiliView, type LoginView } from './view.ts'

export { BiliApiError, BiliClient, BiliRefused, BiliRiskError, BiliTransportError, allowedEndpoint, parseJson, RISK_CODES, USER_AGENT } from './client.ts'
export { ENDPOINTS, type Endpoint, type EndpointName } from './endpoints.ts'
export { DEFAULT_CAPS, HARD_CAPS } from './guard.ts'
export { COVERAGE, LIMITS, type CommentView, type FeedPost, type Folder, type InboxItem, type OwnerMessage, type SubtitleView, type VideoCard, type VideoDetail } from './api.ts'
export { REFRESH_PUBLIC_KEY, correspondPath, refreshCsrf, type BiliGrant } from './auth.ts'
export { TEXT_LIMITS, UNTRUSTED_NOTE, UNTRUSTED_TAG, clean, untrusted } from './text.ts'
export { signQuery, mixinKey } from './wbi.ts'
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

/** Daily write caps; each is bounded by a hard maximum in code. */
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
  /** Messages to the owner's main account per day. */
  dmOwner: number
}

/** Plugin configuration. */
export interface Config {
  /** The owner's main account (UID); the only account this one may message. Unset, messaging is off. */
  ownerMid?: number
  /** IANA time zone of the body clock, day boundaries for caps, and prompt times. */
  timeZone: string
  /** Daily wake windows in `timeZone` (`HH:MM`, start inclusive, end exclusive, same day); one random wake in each. */
  wakes: WakeWindow[]
  /** Probability (0-1) that a window gets no wake on a given day. */
  skipChance: number
  /** What the owner is interested in, shown in every wake prompt until edited in Settings. */
  interests: string
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
}

const capsSchema = z.object(Object.fromEntries(WRITE_ACTIONS.map(action => [
  action, z.natural().max(HARD_CAPS[action]).default(DEFAULT_CAPS[action]),
]))) as unknown as z<CapsConfig>

/** Configuration schema. */
export const Config: z<Config> = z.object({
  ownerMid: z.natural(),
  timeZone: z.string().default('America/New_York'),
  wakes: z.array(z.object({ start: z.string(), end: z.string() })).default([{ start: '12:00', end: '14:00' }, { start: '19:30', end: '23:30' }]),
  skipChance: z.number().min(0).max(1).default(0.15),
  interests: z.string().default(''),
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
  requestGapMs: z.natural().min(1000).default(1200),
  requestJitterMs: z.natural().default(800),
  requestTimeoutMs: z.natural().min(1000).default(15_000),
  inboxPollMs: z.natural().min(120_000).default(600_000),
  inboxWakesPerHour: z.natural().max(6).default(2),
  readBackoffMs: z.natural().min(60_000).default(1_800_000),
  visibilityCheckMs: z.natural().min(30_000).default(300_000),
  refreshCheckMs: z.natural().min(3_600_000).default(86_400_000),
  refreshPublicKey: z.string().default(REFRESH_PUBLIC_KEY),
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
/** Plans kept, in days. */
const PLAN_DAYS = 14
/** Journal limits. */
export const JOURNAL_LIMITS = { chars: 600, perDay: 8, pageSize: 10 } as const

/** What a write tool learns. */
export type WriteOutcome =
  | { readonly outcome: 'sent'; readonly detail: string; readonly receipt?: string }
  | { readonly outcome: 'already'; readonly detail: string }
  | { readonly outcome: 'refused'; readonly detail: string }
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
  budget: Record<WriteAction, number>
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
  if (!config.refreshPublicKey.includes('BEGIN PUBLIC KEY')) throw new Error('bili: refreshPublicKey must be a PEM public key')
}

/** Ledger fields of a comment area. */
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
 * the body clock, the inbox poll, the final-answer relay, and the Settings route.
 */
export class BiliAccount extends Service {
  static inject = ['timer', 'storageDomain', 'credentials', 'sessionController', 'permissionPresets', 'sessionTitle']
  static Config = Config

  private readonly ready: Promise<Domain<typeof biliDomain>>
  private readonly client: BiliClient
  private readonly abort = new AbortController()
  private readonly inflight = new Set<Promise<void>>()
  private readonly replies = new Map<string, string>()
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
    }, { gapMs: config.requestGapMs, jitterMs: config.requestJitterMs, timeoutMs: config.requestTimeoutMs })
    this.ready = ctx.storageDomain.open(biliDomain)

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const cleanup = ctx.effect(() => async () => {
        this.stopping = true
        this.abort.abort(new Error('bili is stopping'))
        this.clockTimer?.()
        for (const dispose of [...this.timers, ...this.visibilityTimers.values()]) dispose()
        await Promise.allSettled([...this.inflight])
        await this.chain
        await this.writes
        await domain.close()
      }, 'bili.lifecycle()')
      await this.restore(domain)
      return cleanup
    }, 'bili.init()')

    ctx.on('session/event', (session, event) => { this.observeSession(session, event) })

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
    this.after(FIRST_SESSION_CHECK_MS, () => this.checkSession('start'))
    this.every(this.config.refreshCheckMs, () => this.checkSession('daily'))
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

  /** Tell the owner on WeChat; a missing or failing channel only costs the message. */
  private async notify(title: string): Promise<void> {
    const notifier = this.ctx.get('lsyNotifier')
    if (notifier === undefined) {
      this.ctx.logger.warn(`bili: no lsyNotifier to tell the owner: ${title}`)
      return
    }
    try {
      await notifier.send({ title })
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: notifying the owner failed: ${errorText(error)}`)
    }
  }

  /** Risk control answered: reads back off, writes pause until the owner resumes them, and the owner hears once per pause. */
  private async brake(name: EndpointName, reason: string): Promise<void> {
    const now = Date.now()
    const fresh = await this.serialize(async () => {
      const domain = await this.ready
      await domain.table('backoff').put('reads', { until: now + this.config.readBackoffMs, reason })
      if (domain.table('pause').get('writes')?.scope === 'all') return false
      await domain.table('pause').put('writes', { scope: 'all', reason, since: now })
      return true
    })
    this.ctx.logger.error(`bili: risk control on ${name} (${reason}); reads back off for ${formatGap(this.config.readBackoffMs)}, writes are paused until the owner resumes them in Settings`)
    if (fresh) await this.notify(NOTICES.riskPaused(reason))
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
      return this.loginNeeded(`the cookie refresh failed: ${errorText(error)}`)
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
      this.ctx.logger.warn(`bili: QR poll failed: ${errorText(error)}`)
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

  /** Store a confirmed login, add device cookies, and confirm the account through `nav`. */
  private async completeLogin(attempt: LoginAttempt, poll: Extract<QrPoll, { state: 'done' }>): Promise<void> {
    let device: CookieJar = {}
    try {
      device = await deviceCookies(this.client)
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: could not get device cookies (${errorText(error)}); search may refuse requests until the next login`)
    }
    const now = Date.now()
    const cookies = { ...poll.cookies, ...device }
    await this.storeGrant({ version: 1, mid: poll.mid, cookies, refreshToken: poll.refreshToken, loggedInAt: now, refreshedAt: now })
    this.client.resetWbi()
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

  // ── The account's Session and the relay ───────────────────────────────

  /**
   * Whether this plugin created a Session (and relays its turns).
   * @param sessionId - Session to check.
   * @returns true for every Session this plugin created.
   */
  ownsSession(sessionId: string): boolean {
    return this.domain?.table('sessions').get(sessionId) !== undefined
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
    await this.serialize(async () => {
      await domain.table('sessions').put(created.sessionId, { sessionId: created.sessionId, createdAt: now })
      await domain.table('current').put('session', { sessionId: created.sessionId, createdAt: now })
    })
    this.ctx.logger.info(`bili: created Session ${created.sessionId} in ${session.workspacePath} (${session.agentPreset}, ${session.permissionPreset})`)
    return created.sessionId
  }

  /**
   * Prompt the account's Session unless it is busy.
   * @returns whether the prompt went in.
   */
  private async promptSession(text: string, reason: 'clock' | 'inbox'): Promise<boolean> {
    mkdirSync(this.config.session.workspacePath, { recursive: true })
    const sessionId = await this.accountSession()
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const status = (resolved.agent as { status?: string }).status
    if (status !== undefined && status !== 'idle') {
      this.ctx.logger.info(`bili: Session ${sessionId} is ${status}; ${reason} wake skipped`)
      return false
    }
    await this.ctx.sessionController.prompt({
      requestId: randomUUID() as SessionRequestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: this.config.timeZone,
    }, this.abort.signal)
    const now = Date.now()
    await this.serialize(async () => {
      const domain = await this.ready
      const wakes = domain.table('wakes')
      await wakes.put(seqKey(now), { at: now, reason, sessionId })
      const excess = [...wakes.keys()].sort().slice(0, Math.max(0, wakes.size - MAX_WAKE_ROWS))
      for (const key of excess) await wakes.delete(key)
    })
    this.ctx.logger.info(`bili: ${reason} wake prompted Session ${sessionId} (${text.length} chars)`)
    return true
  }

  /** Remember each owned Session's latest assistant text and relay it to the owner when the turn ends. */
  private observeSession(session: Session, event: SessionEvent): void {
    if (!this.ownsSession(session.id)) return
    if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text).join('\n').trim()
      if (text !== '') this.replies.set(session.id, text)
      return
    }
    if (event.type !== 'turn/end') return
    const text = this.replies.get(session.id)
    this.replies.delete(session.id)
    const outcome = event.data.reason.kind
    const detail = failureDetail(event.data.reason)
    const body = relayBody(text, outcome, detail)
    this.ctx.logger.info(`bili: Session ${session.id} ended a turn (${detail === undefined ? outcome : `${outcome}: ${detail}`}); ${body === undefined ? 'nothing to relay' : `relaying ${body.length} chars`}`)
    if (body !== undefined) this.track(this.relay(body))
  }

  private async relay(body: string): Promise<void> {
    const notifier = this.ctx.get('lsyNotifier')
    if (notifier === undefined) {
      this.ctx.logger.warn('bili: no lsyNotifier is mounted; the final answer was not relayed')
      return
    }
    await notifier.send({ title: '📺 B站', body })
  }

  // ── Body clock ─────────────────────────────────────────────────────────

  /** Today's plan, rolled once and settled against the clock. */
  private async todayPlan(now: number): Promise<PlanRecord> {
    return this.serialize(async () => {
      const domain = await this.ready
      const day = dayKey(now, this.config.timeZone)
      const plans = domain.table('plans')
      const stored = plans.get(day)
      const { wakes, skipChance, timeZone } = this.config
      const plan = settlePlan(stored ?? rollPlan(day, wakes, skipChance, timeZone), wakes, now, timeZone)
      if (plan !== stored) await plans.put(day, plan)
      if (stored === undefined) {
        const planned = plan.wakes.filter(wake => wake.state === 'planned').length
        this.ctx.logger.info(`bili: body clock for ${day}: ${planned} wake(s), ${plan.wakes.length - planned} window(s) skipped`)
        for (const key of [...plans.keys()].sort().slice(0, Math.max(0, plans.size - PLAN_DAYS))) await plans.delete(key)
      }
      return plan
    })
  }

  /** Arm the timer for the next planned wake or the next local midnight. */
  private async armClock(): Promise<void> {
    if (this.stopping) return
    const now = Date.now()
    const plan = await this.todayPlan(now)
    const next = nextPlanned(plan)
    const at = Math.min(next?.at ?? Infinity, nextDayStart(now, this.config.timeZone))
    this.clockTimer?.()
    this.clockTimer = this.ctx.timeout(() => {
      this.clockTimer = undefined
      this.track(this.onClock())
    }, Math.max(0, at - now))
  }

  /** Fire the wakes that are due (at most one prompt), then re-arm. */
  private async onClock(): Promise<void> {
    try {
      const now = Date.now()
      const due = await this.serialize(async () => {
        const domain = await this.ready
        const day = dayKey(now, this.config.timeZone)
        const plan = domain.table('plans').get(day)
        if (plan === undefined) return 0
        let count = 0
        // At most once: a wake is marked done before its prompt, so a restart never repeats it.
        const wakes = plan.wakes.map((wake) => {
          if (wake.state !== 'planned' || wake.at === undefined || wake.at > now) return wake
          count += 1
          return { ...wake, state: 'done' as const }
        })
        if (count > 0) await domain.table('plans').put(day, { ...plan, wakes })
        return count
      })
      if (due > 0) await this.clockWake(now)
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
    const prompt = wakePrompt({
      now,
      timeZone: this.config.timeZone,
      lastWakeAt: this.lastWake()?.at,
      budget: remaining(domain, this.config.caps, now, this.config.timeZone),
      inbox,
      interests: this.interests().text,
      pause: domain.table('pause').get('writes'),
    })
    try {
      await this.promptSession(prompt, 'clock')
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: body-clock wake failed: ${errorText(error)}`)
    }
  }

  /** The latest wake, if any. */
  private lastWake(): { at: number; reason: 'clock' | 'inbox' } | undefined {
    const wakes = this.domain?.table('wakes')
    if (wakes === undefined) return undefined
    const last = [...wakes.keys()].sort().at(-1)
    const row = last === undefined ? undefined : wakes.get(last)
    return row === undefined ? undefined : { at: row.at, reason: row.reason }
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
    if (account?.state !== 'active' || (backoff !== undefined && backoff.until > Date.now())) return
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
    const ownerMid = this.config.ownerMid
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
    })
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

  /** Hand queued items to the Session, within the hourly wake cap. */
  private async deliverInbox(): Promise<void> {
    const domain = await this.ready
    const pending = [...domain.table('pending').entries()].map(([key, row]) => ({ key, row })).sort((a, b) => a.row.at - b.row.at)
    if (pending.length === 0) return
    const hourAgo = Date.now() - 3_600_000
    const recent = [...domain.table('wakes').entries()].filter(([, wake]) => wake.reason === 'inbox' && wake.at > hourAgo).length
    if (recent >= this.config.inboxWakesPerHour) {
      this.ctx.logger.info(`bili: ${pending.length} inbox item(s) wait: ${recent} inbox wake(s) in the last hour`)
      return
    }
    const batch = pending.slice(0, MAX_WAKE_ITEMS)
    const now = Date.now()
    const prompt = inboxPrompt({
      now,
      timeZone: this.config.timeZone,
      budget: remaining(domain, this.config.caps, now, this.config.timeZone),
      pause: domain.table('pause').get('writes'),
      items: batch.map(({ row }) => row.item),
    })
    let prompted = false
    try {
      prompted = await this.promptSession(prompt, 'inbox')
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
    if (used >= this.config.caps[spec.action]) return `today's ${spec.action} budget (${this.config.caps[spec.action]}) is used up`
    if (uncertainBefore(domain, spec.action, spec.target)) return `an earlier ${spec.action} of ${spec.target} has an unknown outcome; it is never sent again`
    if (alreadyTaken(domain, spec.action, spec.target)) {
      return spec.action === 'comment' ? `this account already commented on ${spec.target}; one comment per video` : `this account already replied to comment ${spec.target}`
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
    const wait = nextSlot(domain) - Date.now()
    if (wait > this.config.writeWaitMs) return refused(`the next write slot opens in ${formatGap(wait)}; try later`)
    if (wait > 0) {
      this.ctx.logger.info(`bili: ${spec.action} ${spec.target} waits ${Math.ceil(wait / 1000)} s for its slot`)
      await this.sleep(wait)
    }
    // A risk answer to another request can arrive while this write waits.
    const late = this.writeRefusal(spec)
    if (late !== undefined) return refused(late)
    const row = await this.serialize(() => reserve(domain, {
      action: spec.action,
      target: spec.target,
      ...(spec.text === undefined ? {} : { text: spec.text.trim() }),
      ...areaFields(spec.area),
    }, Date.now(), this.config.timeZone))
    let outcome: WriteOutcome
    try {
      const receipt = await spec.perform()
      const now = Date.now()
      await this.serialize(() => settle(domain, row.id, {
        state: 'accepted', settledAt: now,
        ...(receipt === undefined ? {} : { receipt }),
        ...(spec.visibility === true && receipt !== undefined ? { visibility: 'pending' as const, visibilityDueAt: now + this.config.visibilityCheckMs } : {}),
      }))
      outcome = { outcome: 'sent', detail: `${spec.action} sent`, ...(receipt === undefined ? {} : { receipt }) }
      const settled = domain.table('ledger').get(row.id)
      if (spec.visibility === true && receipt !== undefined && settled !== undefined) this.armVisibility(settled)
    } catch (error: unknown) {
      const now = Date.now()
      if (error instanceof BiliTransportError) {
        await this.serialize(() => settle(domain, row.id, { state: 'uncertain', settledAt: now, detail: error.message }))
        outcome = { outcome: 'uncertain', detail: `the outcome is unknown (${error.message}); it counts against today's budget and will not be sent again` }
      } else {
        const detail = error instanceof BiliRiskError
          ? `Bilibili's risk control stopped it (${error.reason}); writes are paused until the owner resumes them`
          : error instanceof BiliApiError ? `Bilibili refused it: code ${error.code}${error.detail === '' ? '' : ` (${error.detail})`}` : errorText(error)
        await this.serialize(() => settle(domain, row.id, { state: 'failed', settledAt: now, detail }))
        if (error instanceof BiliApiError && error.code === -101) this.track(this.checkSession(`code -101 from ${error.endpoint}`))
        outcome = { outcome: 'refused', detail }
      }
    }
    const gap = { minMs: this.config.writeGapMinMs, maxMs: this.config.writeGapMaxMs }
    await this.serialize(() => takeSlot(domain, Date.now(), gap, Math.random))
    const used = usage(domain, dayKey(Date.now(), this.config.timeZone))[spec.action]
    this.ctx.logger.info(`bili: ${spec.action} ${spec.target} ${outcome.outcome} (${used}/${this.config.caps[spec.action]} today)`)
    return outcome
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

  /** The aid of a video, or a refusal. */
  private async aidOf(bvid: string): Promise<{ aid: string } | { refusal: string }> {
    if (bvidOf(bvid) === undefined) return { refusal: `${JSON.stringify(bvid)} is not a BV id` }
    try {
      return { aid: (await videoInfo(this.client, bvid, this.config.timeZone)).aid }
    } catch (error: unknown) {
      return { refusal: `could not read ${bvid}: ${errorText(error)}` }
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
    if (mid === this.config.ownerMid) return { outcome: 'refused', detail: 'the owner\'s account stays followed' }
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
    const ownerMid = this.config.ownerMid
    if (ownerMid === undefined) return { outcome: 'refused', detail: 'no owner account is configured' }
    return this.write({
      action: 'dmOwner', target: `mid:${ownerMid}`, text,
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
    return this.reading(() => homeFeed(this.client, this.feedIndex, this.config.timeZone))
  }

  /**
   * What followed accounts posted.
   * @param offset - `next` of the previous page.
   * @returns bounded posts, newest first, and the `next` offset when there are more.
   */
  async followingFeed(offset?: string): Promise<{ items: FeedPost[]; next?: string }> {
    this.requireActive()
    return this.reading(() => followingFeed(this.client, offset, this.config.timeZone))
  }

  /**
   * Popular videos.
   * @param page - from 1.
   * @returns bounded video cards.
   */
  async popular(page: number = 1): Promise<VideoCard[]> {
    this.requireActive()
    return this.reading(() => popular(this.client, Math.max(1, Math.floor(page)), this.config.timeZone))
  }

  /**
   * Search videos.
   * @param keyword - search words.
   * @param page - from 1.
   * @returns bounded video cards.
   */
  async search(keyword: string, page: number = 1): Promise<VideoCard[]> {
    this.requireActive()
    const words = keyword.trim().slice(0, 100)
    if (words === '') throw new Error('the keyword is empty')
    return this.reading(() => search(this.client, words, Math.max(1, Math.floor(page)), this.config.timeZone))
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
      const cid = video.parts.find(part => part.page === options.part)?.cid ?? video.cid
      const subtitle = await subtitles(this.client, bvid, cid, options.subtitlePage ?? 1)
      const top = await comments(this.client, video.aid, { order: 'hot' }, this.config.timeZone)
      return { video, subtitle, topComments: top.comments.slice(0, 5) }
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
      const ownerMid = this.config.ownerMid
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
      if (nav.level !== undefined && nav.level !== account.level) await this.updateAccount({ level: nav.level })
      return {
        signedIn: true, mid: account.mid, uname: nav.uname ?? account.uname, level: nav.level ?? account.level,
        ...stat, folders: list, ...base,
      }
    })
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
    const plan = await this.todayPlan(now)
    const recent = ledgerRows(domain).slice(-10).reverse()
    const lastWake = this.lastWake()
    return {
      account: account === undefined ? { state: 'signed-out' } : accountView(account),
      login: this.login.view,
      pause: pause === undefined ? null : { scope: pause.scope, reason: pause.reason, since: pause.since },
      readsResumeAt: backoff === undefined || backoff.until <= now ? null : backoff.until,
      usage: { day, actions: WRITE_ACTIONS.map(action => ({ action, used: used[action], cap: this.config.caps[action] })) },
      interests: this.interests(),
      clock: {
        timeZone: this.config.timeZone,
        today: plan.wakes.map(wake => ({
          window: `${this.config.wakes[wake.window]?.start ?? '?'}–${this.config.wakes[wake.window]?.end ?? '?'}`,
          at: wake.at ?? null,
          state: wake.state,
        })),
        nextWakeAt: nextPlanned(plan)?.at ?? null,
        lastWake: lastWake ?? null,
      },
      recent: recent.map(row => ({
        at: row.reservedAt, action: row.action, target: row.target, state: row.state,
        ...(row.detail === undefined ? {} : { detail: row.detail }),
        ...(row.visibility === undefined ? {} : { visibility: row.visibility }),
      })),
      ownerMid: this.config.ownerMid ?? 0,
    }
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
      } else if (action === 'interests') {
        const text = (body as { text?: unknown }).text
        if (typeof text !== 'string' || codePoints(text) > MAX_INTERESTS_CHARS) return Response.json({ error: `text must be a string of at most ${MAX_INTERESTS_CHARS} characters` }, { status: 400, headers })
        await this.serialize(async () => {
          const domain = await this.ready
          await domain.table('settings').put('interests', { text: text.trim(), updatedAt: Date.now() })
        })
        this.ctx.logger.info(`bili: the owner updated the interests text (${codePoints(text.trim())} chars)`)
      } else {
        return Response.json({ error: 'unknown action' }, { status: 400, headers })
      }
    }
    return Response.json(await this.view(), { headers })
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
