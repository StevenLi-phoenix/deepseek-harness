/**
 * The agent's own Bilibili account (`ctx.bili`), as a client of bili-svc. bili-svc on the same Mac
 * holds and refreshes the account's session and is the only place that writes to Bilibili: its
 * door (`POST /v1/bili/call`) serves the reads and the non-speech actions (like, coin, triple,
 * follow, unfollow, favorite, watch later, the watch heartbeat), each action under bili-svc's
 * ledger, daily caps, and risk brake, and its Reply Gate (`POST /v1/reply/dm`) carries the answers
 * to the owner's own messages. DSH thinks and drafts: the account's long-lived Session answers the
 * owner's Bilibili messages through `ctx.ownerRelay` and the DM channel (`src/dm.ts`), and its
 * tools read and act through the door. The account never comments, replies, posts, shares, or
 * messages the owner on its own.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: the ctx.lsyNotifier service the WeChat channel provides.
import type {} from '@deepseek-ai/dsh-lsy-event-bus'
// Type-only: ctx.ownerRelay, which relays the account's turns through its DM channel.
import type {} from '@deepseek-ai/dsh-owner-relay'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import {
  addWatchLater, bvidOf, coinsGiven, comments, dailyRewards, dealFavorite, folders, followingFeed,
  danmaku, giveCoin, hasLiked, homeFeed, hotSearches, inboxItems, likeVideo, ranking, modifyRelation, navInfo, ownerMessages, popular,
  relationStat, relationTo, removeWatchLater, reportWatch, search, subtitles, thread, tripleLike, unreadCounts, unreadMessages, videoInfo,
  VIDEO_AREA, watchLaterAids,
  type CommentView, type DailyRewards, type DanmakuLine, type FeedPost, type Folder, type HotSearch, type InboxItem, type OwnerMessage,
  type SearchOrder, type SubtitleView, type VideoCard, type VideoDetail,
} from './api.ts'
import {
  BiliApiError, BiliOutcomeError, BiliRefused, BiliRiskError, BiliSessionError, BiliTransportError, BiliVerifyError,
  DEFAULT_SERVICE_URL, RemoteBiliClient, TOKEN_CREDENTIAL, type ServiceAccount, type ServiceStatus,
} from './client.ts'
import { BILI_AGENT_ORIGIN, BILI_RELAY_CHANNEL, DmChannel, type DmOutcome } from './dm.ts'
import { biliDomain, seqKey } from './storage.ts'
import { clean, codePoints, ownerPrompt } from './text.ts'
import { dayKey, formatStamp, isTimeZone } from './time.ts'
import { BILI_PATH, SESSION_STATES, type AccountView, type BiliView, type SessionState } from './view.ts'

export {
  ACTION_TIMEOUT_MS, BiliApiError, BiliOutcomeError, BiliRefused, BiliRiskError, BiliSessionError, BiliTransportError, BiliVerifyError,
  DEFAULT_SERVICE_URL, READ_TIMEOUT_MS, RemoteBiliClient, TOKEN_CREDENTIAL, allowedEndpoint, parseJson,
  type BiliCaller, type CallOptions, type CallResult, type ServiceStatus,
} from './client.ts'
export { ENDPOINTS, isEndpointName, type Endpoint, type EndpointName } from './endpoints.ts'
export { COVERAGE, LIMITS, type CommentView, type FeedPost, type Folder, type HotSearch, type InboxItem, type OwnerMessage, type SearchOrder, type SubtitleView, type VideoCard, type VideoDetail } from './api.ts'
export { REPLY_CHARS, UNTRUSTED_NOTE, UNTRUSTED_TAG, clean, untrusted } from './text.ts'
export * from './view.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The agent's own Bilibili account. */
    bili: BiliAccount
  }
}

/** How the account's Session is created. */
export interface SessionConfig {
  /** Absolute directory the Session works in; created before every prompt. */
  workspacePath: string
  /** Agent preset of the Session; the bundle defines `bili` with only the Bilibili tools. */
  agentPreset: string
  /** Permission preset set on a new Session; the `bili` preset mounts no shell or file tools, and nobody approves calls. */
  permissionPreset: string
  /** Session title. */
  title: string
}

/** Plugin configuration. */
export interface Config {
  /**
   * The owner's main account (UID): the only account whose messages the Session answers. The UID
   * set in Settings wins, so a deployment can keep it out of committed files. Unset, nothing is answered.
   */
  ownerMid?: number
  /** bili-svc's id of the agent's account: the `account` of every call. */
  account: string
  /** IANA time zone of the journal, the main-agent limit, and prompt times. */
  timeZone: string
  /** Messages the account's Session may send the owner's main agent per day (`bili_tell_main_agent`); 0 turns them off. */
  mainAgentPerDay: number
  /** The account's Session. */
  session: SessionConfig
  /** Owner-message check period, in milliseconds; checks cost no model tokens. */
  inboxPollMs: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  ownerMid: z.natural(),
  account: z.string().default('maomao'),
  timeZone: z.string().default('America/New_York'),
  mainAgentPerDay: z.natural().max(20).default(5),
  session: z.object({
    workspacePath: z.string().default('/Users/dsh-runtime/bili'),
    agentPreset: z.string().default('bili'),
    permissionPreset: z.string().default('danger-full-access'),
    title: z.string().default('B站'),
  }),
  inboxPollMs: z.natural().min(120_000).default(600_000),
})

/** Resolve failures that keep the stored Session: it exists and is only unavailable right now. */
const TRANSIENT_RESOLVE_CODES: ReadonlySet<string> = new Set(['session/agent-busy', 'session/writer-held'])
/** Owner-message ids remembered. */
const MAX_SEEN = 500
/** Owner messages waiting for a turn; the oldest are dropped first. */
const MAX_PENDING = 100
/** Owner messages handed over per turn. */
const MAX_TURN_ITEMS = 20
/** After a message from the owner, messages are checked this often ... */
const FAST_POLL_MS = 60_000
/** ... for this long after the latest one. */
const CONVERSATION_MS = 900_000
/** A bili-svc status answer is reused for this long. */
const STATUS_TTL_MS = 10_000
/** Journal limits. */
export const JOURNAL_LIMITS = { chars: 600, perDay: 8, pageSize: 10 } as const
/** Code points of one message to the owner's main agent. */
export const MAIN_AGENT_MAX_CHARS = 2000
/** Hot-search keywords read at once. */
const HOT_SEARCHES = 30
/** Danmaku lines one read returns. */
const DANMAKU_LINES = 40

/** What a write tool learns. */
export type WriteOutcome =
  | { readonly outcome: 'sent'; readonly detail: string; readonly receipt?: string }
  | { readonly outcome: 'already'; readonly detail: string }
  /** `verification` carries Bilibili's words when it refused for want of a verified phone number. */
  | { readonly outcome: 'refused'; readonly detail: string; readonly verification?: string }
  | { readonly outcome: 'uncertain'; readonly detail: string }

/** The account card the `bili_me` tool shows. */
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
  /** Who keeps the limits: bili-svc, which caps, spaces, and ledgers every action. */
  limits: string
  /** Present while bili-svc holds every action (read-only mode or its brake). */
  pause?: string
}

/** The inbox the `bili_inbox` tool shows. */
export interface InboxView {
  unread: { replies: number; mentions: number; messages: number }
  replies: Omit<InboxItem, 'type' | 'oid' | 'root'>[]
  mentions: Omit<InboxItem, 'type' | 'oid' | 'root'>[]
  ownerMessages: OwnerMessage[]
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
  if (!/^[a-z0-9_-]{1,64}$/.test(config.account)) throw new Error(`bili: account "${config.account}" is not a bili-svc account id`)
}

/** `1 coin`, `2 coins`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Why the balance cannot cover a coin write, or nothing. */
function balanceRefusal(balance: number, needed: number): string | undefined {
  return balance < needed ? `the account has ${plural(balance, 'coin')}; this needs ${needed} (about one comes each day from signing in)` : undefined
}

/** Bilibili's coin refusals, explained. */
const COIN_CODES: Readonly<Record<number, string>> = {
  [-104]: 'not enough coins',
  34002: 'an account cannot coin its own video',
  34003: 'that coin count is not allowed for this video',
  34004: 'coins were given too quickly',
  34005: 'this video already has the most coins this account may give',
}

/** Parts of a triple (一键三连). */
const TRIPLE_PARTS = ['like', 'coin', 'favorite'] as const
/** One of {@link TRIPLE_PARTS}. */
type TriplePart = typeof TRIPLE_PARTS[number]

/** What a triple did: the parts it added, and those done before. */
function tripleDetail(added: readonly TriplePart[], before: readonly TriplePart[], coins: number): string {
  const words: Record<TriplePart, string> = { like: 'liked', coin: `gave ${plural(coins, 'coin')}`, favorite: 'saved to the default folder' }
  const head = added.length === 0 ? 'Bilibili applied none of the missing parts' : added.map(part => words[part]).join(', ')
  return before.length === 0 ? head : `${head}; already done before: ${before.join(', ')}`
}

/** The account bili-svc answers for: the configured id, else the first with a working session. */
function pickAccount(status: ServiceStatus, id: string): ServiceAccount | undefined {
  return status.accounts.find(account => account.id === id) ?? status.accounts.find(account => account.session === 'ok')
}

/** One action: what it is about, and the call that does it. */
interface ActSpec {
  action: string
  target: string
  /** Whether it is already done; read before the call, so an idempotent action costs nothing. */
  preRead?: () => Promise<string | undefined>
  /** The one call through bili-svc's door. */
  perform: () => Promise<void>
  /** The `sent` detail; `<action> sent` by default. */
  sentDetail?: () => string
}

/**
 * The agent's own Bilibili account, through bili-svc: reads, actions, the owner-message check,
 * the DM channel of the owner relay, the journal, messages to the main agent, and the Settings route.
 */
export class BiliAccount extends Service {
  static inject = ['timer', 'storageDomain', 'credentials', 'sessionController', 'permissionPresets', 'sessionTitle']
  static Config = Config

  private readonly ready: Promise<Domain<typeof biliDomain>>
  private readonly client: RemoteBiliClient
  private readonly abort = new AbortController()
  private readonly inflight = new Set<Promise<void>>()
  private readonly timers = new Set<() => void>()
  private domain: Domain<typeof biliDomain> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false
  private feedIndex = 0
  /** The last status answer of bili-svc, reused for {@link STATUS_TTL_MS}. */
  private statusCache: { at: number; value: Promise<ServiceStatus> } | undefined
  /** The account's channel of `ctx.ownerRelay`: answers to the owner's messages, through bili-svc's Reply Gate. */
  private readonly dm: DmChannel
  /** The owner's conversation keeps the fast message check until then. */
  private conversationUntil = 0
  /** The next fast message check, while the owner is messaging. */
  private fastPoll: (() => void) | undefined
  /** A message check is running; another one waits for the next tick. */
  private polling = false

  /**
   * @param ctx - Host services owning timers, storage, credentials, and Sessions.
   * @param config - owner account, bili-svc account, limits, and Session settings.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'bili')
    assertConfig(config)
    this.client = new RemoteBiliClient({
      baseUrl: (process.env['BILI_SVC_URL'] ?? DEFAULT_SERVICE_URL).replace(/\/+$/, ''),
      account: config.account,
      token: () => this.token(),
      debug: (message) => { ctx.logger.debug(message) },
      info: (message) => { ctx.logger.info(message) },
    })
    this.ready = ctx.storageDomain.open(biliDomain)
    this.dm = new DmChannel({
      replyOwner: text => this.replyOwner(text),
      hold: work => this.hold(work),
      notifier: () => this.ctx.get('lsyNotifier'),
      logger: { info: (message) => { ctx.logger.info(message) }, warn: (message) => { ctx.logger.warn(message) } },
    })

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const cleanup = ctx.effect(() => async () => {
        this.stopping = true
        this.abort.abort(new Error('bili is stopping'))
        this.fastPoll?.()
        for (const dispose of this.timers) dispose()
        await Promise.allSettled([...this.inflight])
        await this.chain
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

  /** Drop queued items of the retired reply and mention wakes, and start the owner-message check. */
  private async restore(domain: Domain<typeof biliDomain>): Promise<void> {
    const dropped = await this.serialize(async () => {
      let count = 0
      for (const [key, row] of [...domain.table('pending').entries()]) {
        if (row.kind === 'dm') continue
        await domain.table('pending').delete(key)
        count += 1
      }
      await domain.table('inbox').delete('reply')
      await domain.table('inbox').delete('at')
      return count
    })
    if (dropped > 0) this.ctx.logger.info(`bili: dropped ${dropped} queued reply or mention item(s): replies to strangers are bili-svc's (the up preset) now`)
    this.ctx.logger.info(`bili: bili-svc at ${this.client.baseUrl}, account ${this.config.account}; ${this.ownerMid() === undefined ? 'no owner account set, so no messages are answered' : 'answering the owner\'s messages'}`)
    this.every(this.config.inboxPollMs, () => this.pollOwner())
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

  // ── bili-svc ───────────────────────────────────────────────────────────

  /** The bearer token, read per call; never logged. */
  private async token(): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(TOKEN_CREDENTIAL))
    return resolved?.value === undefined || resolved.value === '' ? undefined : resolved.value
  }

  /** bili-svc's status, shared by callers within {@link STATUS_TTL_MS}. */
  private status(): Promise<ServiceStatus> {
    const now = Date.now()
    if (this.statusCache !== undefined && now - this.statusCache.at < STATUS_TTL_MS) return this.statusCache.value
    const value = this.client.status(this.abort.signal)
    this.statusCache = { at: now, value }
    // A failed answer is not reused.
    value.catch(() => { if (this.statusCache?.value === value) this.statusCache = undefined })
    return value
  }

  /** The agent's account as bili-svc lists it, or why it cannot be read. */
  private async accountView(): Promise<{ view: AccountView; gate: ServiceStatus['gate'] }> {
    const checkedAt = Date.now()
    const id = this.config.account
    let status: ServiceStatus
    try {
      status = await this.status()
    } catch (error: unknown) {
      return { view: { account: id, session: 'unreachable', error: errorText(error), checkedAt }, gate: undefined }
    }
    const account = pickAccount(status, id)
    if (account === undefined) return { view: { account: id, session: 'unreachable', error: `bili-svc lists no account ${id}`, checkedAt }, gate: status.gate }
    const session: SessionState = (SESSION_STATES as readonly string[]).includes(account.session) ? account.session as SessionState : 'missing'
    return {
      view: {
        account: account.id, session, checkedAt,
        ...(account.mid > 0 ? { mid: account.mid } : {}),
        ...(account.display === '' ? {} : { uname: account.display }),
      },
      gate: status.gate,
    }
  }

  /** The account's own mid, which some reads and actions need; bili-svc lists it. */
  private async selfMid(): Promise<number> {
    const { view } = await this.accountView()
    if (view.session !== 'ok') throw new Error(view.session === 'unreachable' ? `bili-svc cannot be asked about the account: ${view.error ?? 'no answer'}` : `the Bilibili session in bili-svc is ${view.session}; bili-svc owns the login, and the owner renews it there`)
    if (view.mid !== undefined) return view.mid
    const nav = await navInfo(this.client)
    if (!nav.isLogin || nav.mid === undefined) throw new Error('Bilibili says the account is signed out; bili-svc owns the login, and the owner renews it there')
    return nav.mid
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
   * Prompt the account's Session with the owner's messages unless it is busy; its answer goes back
   * to the owner through the DM channel.
   * @returns whether the prompt went in.
   */
  private async promptSession(text: string): Promise<boolean> {
    mkdirSync(this.config.session.workspacePath, { recursive: true })
    const sessionId = await this.accountSession()
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const status = (resolved.agent as { status?: string }).status
    if (status !== undefined && status !== 'idle') {
      this.ctx.logger.info(`bili: Session ${sessionId} is ${status}; the owner's messages wait for the next check`)
      return false
    }
    // Known before the turn can end: its answer is the reply.
    this.dm.expectReply(sessionId)
    try {
      await this.ctx.sessionController.prompt({
        requestId: randomUUID() as SessionRequestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: this.config.timeZone,
      }, this.abort.signal)
    } catch (error: unknown) {
      this.dm.dropReply(sessionId)
      throw error
    }
    this.ctx.logger.info(`bili: the owner's messages prompted Session ${sessionId} (${text.length} chars)`)
    return true
  }

  /**
   * One reply to the owner through bili-svc's Reply Gate. Anything but `sent` goes to WeChat.
   * @param text - one message, at most 500 characters.
   */
  private async replyOwner(text: string): Promise<DmOutcome> {
    const ownerMid = this.ownerMid()
    if (ownerMid === undefined) return { status: 'failed', detail: 'no owner account is configured' }
    try {
      const answer = await this.client.replyDm(ownerMid, text.trim(), this.abort.signal)
      const id = answer.id === undefined ? '' : ` (${answer.id})`
      this.ctx.logger.info(`bili: bili-svc's Reply Gate answered ${answer.status}${id} to a ${codePoints(text.trim())}-char reply to the owner`)
      return { status: answer.status, detail: answer.status === 'sent' ? 'sent' : `bili-svc's Reply Gate answered ${answer.status}${id}` }
    } catch (error: unknown) {
      const unknown = error instanceof BiliTransportError
      this.ctx.logger.warn(`bili: the reply to the owner ${unknown ? 'has an unknown outcome' : 'was refused'}: ${errorText(error)}`)
      return { status: 'failed', detail: unknown ? `the outcome at bili-svc is unknown (${errorText(error)})` : errorText(error) }
    }
  }

  // ── Owner messages ────────────────────────────────────────────────────

  /** The owner's main account: the UID set in Settings, else the configured one. */
  private ownerMid(): number | undefined {
    return this.domain?.table('owner').get('main')?.mid ?? this.config.ownerMid
  }

  /** Check the owner's messages (no model involved) and prompt the Session for new ones. */
  private async pollOwner(): Promise<void> {
    const ownerMid = this.ownerMid()
    if (ownerMid === undefined || this.polling) return
    this.polling = true
    try {
      try {
        await this.collectOwner(ownerMid)
      } catch (error: unknown) {
        this.ctx.logger.warn(`bili: the owner-message check failed: ${errorText(error)}`)
        return
      }
      await this.deliverOwner()
    } finally {
      this.polling = false
    }
  }

  /** Fetch what changed and queue new owner messages; the first look only records a baseline. */
  private async collectOwner(ownerMid: number): Promise<void> {
    const domain = await this.ready
    const baselined = domain.table('inbox').get('dm') !== undefined
    if (baselined && (await unreadMessages(this.client)) === 0) return
    await this.queueOwner(await ownerMessages(this.client, ownerMid))
  }

  /** Queue unseen owner messages. */
  private async queueOwner(items: readonly OwnerMessage[]): Promise<void> {
    await this.serialize(async () => {
      const domain = await this.ready
      const row = domain.table('inbox').get('dm')
      const seen = new Set(row?.seen ?? [])
      let queued = 0
      for (const item of items) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        if (row === undefined) continue
        await domain.table('pending').put(`dm:${item.id}`, { kind: 'dm', id: item.id, at: item.at, item: { kind: 'message from the owner\'s account', text: item.text } })
        queued += 1
      }
      await domain.table('inbox').put('dm', { seen: [...seen].slice(-MAX_SEEN) })
      const pending = domain.table('pending')
      const excess = [...pending.entries()].sort(([, a], [, b]) => a.at - b.at).slice(0, Math.max(0, pending.size - MAX_PENDING))
      for (const [key] of excess) await pending.delete(key)
      if (row === undefined) this.ctx.logger.info(`bili: owner-message baseline: ${items.length} message(s) already there`)
      else if (queued > 0) {
        this.ctx.logger.info(`bili: ${queued} new message(s) from the owner`)
        this.ownerSpoke(Date.now())
      }
    })
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
      this.ctx.logger.info('bili: the owner\'s conversation went quiet; back to the regular message check')
      return
    }
    this.fastPoll = this.ctx.timeout(() => {
      this.track(this.pollOwner().finally(() => { this.armFastPoll() }))
    }, FAST_POLL_MS)
  }

  /** Hand queued owner messages to the Session, oldest first. */
  private async deliverOwner(): Promise<void> {
    const domain = await this.ready
    const pending = [...domain.table('pending').entries()]
      .filter(([, row]) => row.kind === 'dm')
      .map(([key, row]) => ({ key, row }))
      .sort((a, b) => a.row.at - b.row.at)
    if (pending.length === 0) return
    const batch = pending.slice(0, MAX_TURN_ITEMS)
    const prompt = ownerPrompt({ now: Date.now(), timeZone: this.config.timeZone, items: batch.map(({ row }) => row.item) })
    let prompted = false
    try {
      prompted = await this.promptSession(prompt)
    } catch (error: unknown) {
      this.ctx.logger.warn(`bili: prompting the Session with the owner's messages failed: ${errorText(error)}`)
    }
    if (!prompted) return
    await this.serialize(async () => {
      for (const { key } of batch) await domain.table('pending').delete(key)
    })
  }

  // ── Actions ────────────────────────────────────────────────────────────

  /**
   * Run one action through bili-svc's door: an optional pre-read (so an idempotent action costs
   * nothing), then the one call, whose outcome bili-svc decided (caps, once-rules, brake, ledger).
   * Never retried.
   */
  private async act(spec: ActSpec): Promise<WriteOutcome> {
    const log = (outcome: WriteOutcome): WriteOutcome => {
      this.ctx.logger.info(`bili: ${spec.action} ${spec.target} ${outcome.outcome}${outcome.outcome === 'sent' ? '' : `: ${outcome.detail}`}`)
      return outcome
    }
    try {
      const already = await spec.preRead?.()
      if (already !== undefined) return log({ outcome: 'already', detail: already })
    } catch (error: unknown) {
      // A refusal of this package's own (the account itself, no such folder) is the answer; anything else is a failed check.
      return log({ outcome: 'refused', detail: error instanceof BiliRefused ? error.message : `could not check before writing: ${errorText(error)}` })
    }
    try {
      await spec.perform()
    } catch (error: unknown) {
      return log(this.outcomeOf(spec.action, error))
    }
    return log({ outcome: 'sent', detail: spec.sentDetail?.() ?? `${spec.action} sent` })
  }

  /** What an action's failure means for the model. */
  private outcomeOf(action: string, error: unknown): WriteOutcome {
    if (error instanceof BiliOutcomeError) {
      const why = error.reason === '' ? '' : ` (${error.reason})`
      switch (error.outcome) {
        case 'already':
          return { outcome: 'already', detail: `bili-svc says it is already done${why}` }
        case 'uncertain':
          return { outcome: 'uncertain', detail: `the outcome is unknown${why}; bili-svc counts it and never sends it again` }
        case 'held':
          return { outcome: 'refused', detail: `bili-svc held it${why}; actions wait until bili-svc lets them through again` }
        default:
          return { outcome: 'refused', detail: `bili-svc refused it${why}` }
      }
    }
    if (error instanceof BiliTransportError) {
      return { outcome: 'uncertain', detail: `the outcome is unknown (${error.message}); it is never sent again` }
    }
    if (error instanceof BiliVerifyError) {
      const words = error.detail === '' ? `code ${error.code}` : error.detail
      return { outcome: 'refused', detail: `Bilibili refused it until the account verifies a phone number: code ${error.code}${error.detail === '' ? '' : ` (${error.detail})`}`, verification: words }
    }
    if (error instanceof BiliRiskError) {
      return { outcome: 'refused', detail: `Bilibili's risk control stopped it (${error.reason}); bili-svc holds actions until the owner releases its brake` }
    }
    if (error instanceof BiliApiError) {
      const hint = action === 'coin' || action === 'triple' ? COIN_CODES[error.code] : undefined
      return { outcome: 'refused', detail: `Bilibili refused it: code ${error.code}${error.detail === '' ? '' : ` (${error.detail})`}${hint === undefined ? '' : `: ${hint}`}` }
    }
    return { outcome: 'refused', detail: errorText(error) }
  }

  /** A video to act on, or why not. */
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
   * Give a video coins, never with a like. Bilibili takes at most 2 coins per video from one
   * account for an original and 1 otherwise; `count` defaults to that most. bili-svc allows one
   * coin write per video ever; the balance limits the rest.
   * @param bvid - BV id.
   * @param count - 1 or 2; default the most the video takes.
   * @returns the outcome.
   */
  async coin(bvid: string, count?: number): Promise<WriteOutcome> {
    if (count !== undefined && count !== 1 && count !== 2) return { outcome: 'refused', detail: 'count must be 1 or 2' }
    const target = await this.aidOf(bvid)
    if ('refusal' in target) return { outcome: 'refused', detail: target.refusal }
    const most = target.video.original ? 2 : 1
    const coins: 1 | 2 = count === undefined ? most : count
    if (coins > most) return { outcome: 'refused', detail: `${bvid} is not marked original, so Bilibili takes at most 1 coin for it` }
    let short: string | undefined
    const outcome = await this.act({
      action: 'coin', target: bvid,
      preRead: async () => {
        const given = await coinsGiven(this.client, bvid)
        if (given > 0) return `this account already gave this video ${plural(given, 'coin')}; one coin write per video`
        short = balanceRefusal((await navInfo(this.client)).coins ?? 0, coins)
        return undefined
      },
      perform: async () => {
        if (short !== undefined) throw new BiliRefused(short)
        await giveCoin(this.client, target.aid, bvid, coins)
      },
      sentDetail: () => `gave ${plural(coins, 'coin')}`,
    })
    return outcome
  }

  /**
   * 一键三连: like, coins (2 for an original, 1 otherwise), and a favorite in the default folder,
   * in one request. Parts already done are reported; all three done answers `already` without a
   * call. bili-svc allows one triple per video ever and counts it against its caps.
   * @param bvid - BV id.
   * @returns the outcome.
   */
  async triple(bvid: string): Promise<WriteOutcome> {
    const target = await this.aidOf(bvid)
    if ('refusal' in target) return { outcome: 'refused', detail: target.refusal }
    const most = target.video.original ? 2 : 1
    let adds: TriplePart[] = []
    let done: TriplePart[] = []
    let coins = most
    let short: string | undefined
    return this.act({
      action: 'triple', target: bvid,
      preRead: async () => {
        const mid = await this.selfMid()
        const liked = await hasLiked(this.client, bvid)
        const given = await coinsGiven(this.client, bvid)
        const saved = (await folders(this.client, mid, target.aid)).some(folder => folder.contains)
        const state: Record<TriplePart, boolean> = { like: liked, coin: given > 0, favorite: saved }
        done = TRIPLE_PARTS.filter(part => state[part])
        adds = TRIPLE_PARTS.filter(part => !state[part])
        if (adds.length === 0) return 'this account already liked, coined, and saved this video'
        if (adds.includes('coin')) short = balanceRefusal((await navInfo(this.client)).coins ?? 0, most)
        return undefined
      },
      perform: async () => {
        if (short !== undefined) throw new BiliRefused(short)
        const result = await tripleLike(this.client, target.aid, bvid)
        if (result.coin && result.coins > 0) coins = result.coins
        // Only what Bilibili applied counts; a part it skipped stays undone.
        adds = adds.filter(part => result[part])
      },
      sentDetail: () => tripleDetail(adds, done, coins),
    })
  }

  /** Report a watch of a video whose subtitles the account read, as far as it read; bili-svc keeps it to once a day. */
  private async reportWatchOf(video: VideoDetail, cid: number, reached: number): Promise<void> {
    let mid: number
    try {
      mid = await this.selfMid()
    } catch (error: unknown) {
      this.ctx.logger.info(`bili: no watch report for ${video.bvid}: ${errorText(error)}`)
      return
    }
    const seconds = Math.max(1, Math.min(reached, video.seconds ?? reached))
    const outcome = await this.act({
      action: 'watch', target: video.bvid,
      perform: () => reportWatch(this.client, { aid: video.aid, bvid: video.bvid, cid, mid, duration: video.seconds ?? seconds }, seconds),
    })
    if (outcome.outcome === 'uncertain') this.ctx.logger.warn(`bili: the watch report of ${video.bvid} has an unknown outcome; not sent again`)
  }

  /**
   * Follow an account.
   * @param mid - its user id.
   * @returns the outcome.
   */
  async follow(mid: number): Promise<WriteOutcome> {
    if (!Number.isSafeInteger(mid) || mid <= 0) return { outcome: 'refused', detail: 'mid must be a positive user id' }
    return this.act({
      action: 'follow', target: `mid:${mid}`,
      preRead: async () => {
        if (mid === await this.selfMid()) throw new BiliRefused('this is the account itself')
        return [2, 6].includes(await relationTo(this.client, mid)) ? 'already following' : undefined
      },
      perform: () => modifyRelation(this.client, mid, 1),
    })
  }

  /**
   * Unfollow an account; the owner's account stays followed.
   * @param mid - its user id.
   * @returns the outcome.
   */
  async unfollow(mid: number): Promise<WriteOutcome> {
    if (!Number.isSafeInteger(mid) || mid <= 0) return { outcome: 'refused', detail: 'mid must be a positive user id' }
    if (mid === this.ownerMid()) return { outcome: 'refused', detail: 'the owner\'s account stays followed' }
    return this.act({
      action: 'unfollow', target: `mid:${mid}`,
      preRead: async () => ([2, 6].includes(await relationTo(this.client, mid)) ? undefined : 'not following'),
      perform: () => modifyRelation(this.client, mid, 2),
    })
  }

  /**
   * Add a video to a favorite folder (the default one unless named), or remove it.
   * @param bvid - BV id.
   * @param options - `remove`, and a folder id from `me()`.
   * @returns the outcome.
   */
  async favorite(bvid: string, options: { remove?: boolean; folderId?: number } = {}): Promise<WriteOutcome> {
    const video = await this.aidOf(bvid)
    if ('refusal' in video) return { outcome: 'refused', detail: video.refusal }
    let folder: Folder | undefined
    return this.act({
      action: 'favorite', target: bvid,
      preRead: async () => {
        const list = await folders(this.client, await this.selfMid(), video.aid)
        folder = options.folderId === undefined
          ? list.find(entry => entry.isDefault) ?? list[0]
          : list.find(entry => entry.id === options.folderId)
        if (folder === undefined) throw new BiliRefused(`no favorite folder ${options.folderId === undefined ? 'exists' : `with id ${options.folderId}`}`)
        if (options.remove === true) return folder.contains === true ? undefined : `not in folder ${folder.title}`
        return folder.contains === true ? `already in folder ${folder.title}` : undefined
      },
      perform: async () => {
        const ids = folder === undefined ? [] : [folder.id]
        await dealFavorite(this.client, video.aid, options.remove === true ? { add: [], remove: ids } : { add: ids, remove: [] }, bvid)
      },
    })
  }

  /**
   * Like a video.
   * @param bvid - BV id.
   * @returns the outcome.
   */
  async like(bvid: string): Promise<WriteOutcome> {
    const video = await this.aidOf(bvid)
    if ('refusal' in video) return { outcome: 'refused', detail: video.refusal }
    return this.act({
      action: 'like', target: bvid,
      preRead: async () => ((await hasLiked(this.client, bvid)) ? 'already liked' : undefined),
      perform: () => likeVideo(this.client, video.aid, bvid),
    })
  }

  /**
   * Add a video to watch later, or remove it.
   * @param bvid - BV id.
   * @param remove - remove instead of add.
   * @returns the outcome.
   */
  async watchLater(bvid: string, remove: boolean = false): Promise<WriteOutcome> {
    const video = await this.aidOf(bvid)
    if ('refusal' in video) return { outcome: 'refused', detail: video.refusal }
    return this.act({
      action: 'watchlater', target: bvid,
      preRead: async () => {
        const listed = (await watchLaterAids(this.client)).has(video.aid)
        if (remove) return listed ? undefined : 'not on watch later'
        return listed ? 'already on watch later' : undefined
      },
      perform: () => (remove ? removeWatchLater(this.client, video.aid) : addWatchLater(this.client, video.aid)),
    })
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  /**
   * A read through bili-svc, with a model-readable error when the session or the service is not usable.
   * @param work - the read.
   */
  private async reading<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error: unknown) {
      if (error instanceof BiliSessionError) throw new Error(error.message)
      if (error instanceof BiliApiError && error.code === -101) throw new Error('Bilibili says the account is signed out; bili-svc owns the login, and the owner renews it there')
      throw error
    }
  }

  /**
   * The next batch of the home feed.
   * @returns about 12 bounded video cards.
   */
  async homeFeed(): Promise<VideoCard[]> {
    this.feedIndex += 1
    return this.notOwners(await this.reading(() => homeFeed(this.client, this.feedIndex, this.config.timeZone)))
  }

  /**
   * The site leaderboard (排行榜) across all zones.
   * @returns up to 30 bounded video cards, top first.
   */
  async ranking(): Promise<VideoCard[]> {
    return this.notOwners(await this.reading(() => ranking(this.client, this.config.timeZone)))
  }

  /**
   * A sample of a video's danmaku: the jokes and reactions of its own viewers.
   * @param bvid - BV id.
   * @param part - part number of a multi-part video.
   * @returns up to 40 lines across the video, each with its second.
   */
  async danmaku(bvid: string, part?: number): Promise<{ bvid: string; lines: DanmakuLine[] }> {
    if (bvidOf(bvid) === undefined) throw new Error(`${JSON.stringify(bvid)} is not a BV id`)
    return this.reading(async () => {
      const video = await videoInfo(this.client, bvid, this.config.timeZone)
      const cid = video.parts.find(page => page.page === part)?.cid ?? video.cid
      return { bvid: video.bvid, lines: await danmaku(this.client, cid, DANMAKU_LINES) }
    })
  }

  /**
   * What followed accounts posted, without the owner's own posts.
   * @param offset - `next` of the previous page.
   * @returns bounded posts, newest first, and the `next` offset when there are more.
   */
  async followingFeed(offset?: string): Promise<{ items: FeedPost[]; next?: string }> {
    const page = await this.reading(() => followingFeed(this.client, offset, this.config.timeZone))
    return { ...page, items: this.notOwners(page.items) }
  }

  /**
   * Popular videos.
   * @param page - from 1.
   * @returns bounded video cards.
   */
  async popular(page: number = 1): Promise<VideoCard[]> {
    return this.notOwners(await this.reading(() => popular(this.client, Math.max(1, Math.floor(page)), this.config.timeZone)))
  }

  /**
   * Search videos.
   * @param keyword - search words.
   * @param page - from 1.
   * @param order - `relevance` (default) or `newest` first.
   * @returns bounded video cards.
   */
  async search(keyword: string, page: number = 1, order: SearchOrder = 'relevance'): Promise<VideoCard[]> {
    const words = keyword.trim().slice(0, 100)
    if (words === '') throw new Error('the keyword is empty')
    return this.notOwners(await this.reading(() => search(this.client, words, Math.max(1, Math.floor(page)), this.config.timeZone, order)))
  }

  /**
   * The hot-search list (热搜): what the whole site searches for right now.
   * @returns up to 30 keywords, each with the label the search box shows when it differs.
   */
  async hotSearches(): Promise<HotSearch[]> {
    return this.reading(() => hotSearches(this.client, HOT_SEARCHES))
  }

  /** Feed entries without the owner's own uploads and posts: the owner has seen them. */
  private notOwners<T extends { authorMid?: number | undefined }>(items: T[]): T[] {
    const owner = this.ownerMid()
    return owner === undefined ? items : items.filter(item => item.authorMid !== owner)
  }

  /**
   * A video: facts, one page of subtitles (with coverage notes), and top comments. A video whose
   * subtitles were read is reported as watched that far (bili-svc keeps it to once a day).
   * @param bvid - BV id.
   * @param options - subtitle page and part.
   * @returns the facts, one subtitle page or the reason there is none, and up to five top comments.
   */
  async video(
    bvid: string, options: { subtitlePage?: number; part?: number } = {},
  ): Promise<{ video: VideoDetail; subtitle: SubtitleView; topComments: CommentView[] }> {
    if (bvidOf(bvid) === undefined) throw new Error(`${JSON.stringify(bvid)} is not a BV id`)
    return this.reading(async () => {
      const video = await videoInfo(this.client, bvid, this.config.timeZone)
      const cid = video.parts.find(part => part.page === options.part)?.cid ?? video.cid
      const subtitle = await subtitles(this.client, bvid, cid, options.subtitlePage ?? 1)
      const top = await comments(this.client, video.aid, { order: 'hot' }, this.config.timeZone)
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
   * Unread counts, the newest replies and mentions, and the owner's latest messages; the owner's
   * messages it shows count as handed over.
   * @returns unread counts, up to ten replies and mentions, and the owner's latest messages.
   */
  async inbox(): Promise<InboxView> {
    return this.reading(async () => {
      const unread = await unreadCounts(this.client)
      const replies = await inboxItems(this.client, 'reply')
      const mentions = await inboxItems(this.client, 'at')
      const ownerMid = this.ownerMid()
      const owner = ownerMid === undefined ? [] : await ownerMessages(this.client, ownerMid)
      await this.markSeen(owner)
      const strip = ({ type: _type, oid: _oid, root: _root, ...rest }: InboxItem): Omit<InboxItem, 'type' | 'oid' | 'root'> => rest
      return {
        unread, replies: replies.slice(0, 10).map(strip), mentions: mentions.slice(0, 10).map(strip), ownerMessages: owner.slice(-10),
      }
    })
  }

  /** Record owner messages the model has read so no turn repeats them. */
  private async markSeen(items: readonly OwnerMessage[]): Promise<void> {
    await this.serialize(async () => {
      const domain = await this.ready
      const seen = new Set(domain.table('inbox').get('dm')?.seen ?? [])
      for (const item of items) {
        seen.add(item.id)
        await domain.table('pending').delete(`dm:${item.id}`)
      }
      await domain.table('inbox').put('dm', { seen: [...seen].slice(-MAX_SEEN) })
    })
  }

  /**
   * The account, its folders, its level and coins, and whether bili-svc holds actions.
   * @returns the account facts, or `signedIn: false`.
   */
  async me(): Promise<MeView> {
    const { view, gate } = await this.accountView()
    const base: Pick<MeView, 'limits' | 'pause'> = {
      limits: 'bili-svc enforces daily caps, spacing, and once-rules on every action; it answers refused when one is used up',
      ...(gate?.readonly === true ? { pause: `bili-svc holds every action (gate mode ${gate.mode === '' ? 'unknown' : gate.mode}) until the owner lets them through again` } : {}),
    }
    if (view.session !== 'ok') return { signedIn: false, ...view.uname === undefined ? {} : { uname: view.uname }, ...base }
    return this.reading(async () => {
      const nav = await navInfo(this.client)
      if (!nav.isLogin) return { signedIn: false, ...base }
      const mid = nav.mid ?? view.mid ?? 0
      const stat = await relationStat(this.client, mid)
      const list = await folders(this.client, mid)
      const rewards = await dailyRewards(this.client)
      return {
        signedIn: true, mid,
        ...(nav.uname ?? view.uname) === undefined ? {} : { uname: nav.uname ?? view.uname },
        ...(nav.level === undefined ? {} : { level: nav.level }),
        ...(nav.exp === undefined ? {} : { exp: nav.exp }), ...(nav.coins === undefined ? {} : { coins: nav.coins }), rewards,
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
        sessionId = await notifier.tellMainAgent({ text: message, from: BILI_AGENT_ORIGIN, origin: 'bili' })
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

  // ── Settings route ─────────────────────────────────────────────────────

  /**
   * What the Settings section shows: the account as bili-svc lists it, read-only, and the owner's
   * main account. bili-svc's status names accounts and session states only, so no cookie or token
   * can reach it.
   * @returns the view.
   */
  async view(): Promise<BiliView> {
    const domain = await this.ready
    const { view, gate } = await this.accountView()
    return {
      account: view,
      gate: gate === undefined ? null : { mode: clean(gate.mode, 40), readonly: gate.readonly },
      ownerMid: this.ownerMid() ?? 0,
      ownerUpdatedAt: domain.table('owner').get('main')?.updatedAt ?? null,
      timeZone: this.config.timeZone,
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
      if (action === 'owner') {
        const mid = (body as { mid?: unknown }).mid
        if (typeof mid !== 'number' || !Number.isSafeInteger(mid) || mid <= 0) return Response.json({ error: 'mid must be a positive integer UID' }, { status: 400, headers })
        const { view } = await this.accountView()
        if (mid === view.mid) return Response.json({ error: 'mid is this account itself, not the owner\'s main account' }, { status: 400, headers })
        await this.setOwner(mid)
      } else {
        return Response.json({ error: 'unknown action' }, { status: 400, headers })
      }
    }
    return Response.json(await this.view(), { headers })
  }

  /**
   * Store the owner's main account. A different UID drops the owner-message baseline, so the next
   * check records the new conversation's history instead of answering it.
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
}

export default BiliAccount
