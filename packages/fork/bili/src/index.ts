/**
 * The agent's own Bilibili account (`ctx.bili`), as a client of bili-svc. bili-svc on the same Mac
 * holds and refreshes the account's session and is the only place that writes to Bilibili: its
 * door (`POST /v1/bili/call`) serves the reads and the non-speech actions (like, coin, triple,
 * follow, unfollow, favorite, watch later, the watch heartbeat), each action under bili-svc's
 * ledger, daily caps, and risk brake, and its Reply Gate (`POST /v1/reply/dm`) carries the answers
 * to the owner's own messages. DSH thinks and drafts: the account's long-lived Session answers the
 * owner's Bilibili messages through `ctx.ownerRelay` and the DM channel (`src/dm.ts`), and its
 * tools read and act through the door. Once a day the daily share (`src/share.ts`) prompts the
 * Session to message the owner first (a video it watched and a recent 热梗) through bili-svc's
 * `POST /v1/share/owner`; that is the only message it starts, and only to the owner. The account
 * never comments, replies, posts, or shares in public.
 *
 * This entry holds the configuration, the lifecycle, and the wiring; each public method delegates to its topic's module.
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
// Type-only: the connection service's Context merge (ctx.connection).
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/cordis-plugin-timer'
// Type-only: the credential store's reference brand; this package takes no runtime export from it.
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: the ctx.ownerNotifier service the WeChat channel provides.
import type {} from '@deepseek-ai/dsh-event-bus'
// Type-only: ctx.ownerRelay, which relays the account's turns through its DM channel.
import type {} from '@deepseek-ai/dsh-owner-relay'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { BackgroundWork } from '@deepseek-ai/dsh-service-kit'
import { AccountSession, type SessionConfig } from './account-session.ts'
import type { CommentView, DanmakuLine, FeedPost, HotSearch, SearchOrder, SubtitleView, VideoCard, VideoDetail } from './api.ts'
import { DEFAULT_SERVICE_URL, RemoteBiliClient, TOKEN_CREDENTIAL, errorText } from './client.ts'
import { BILI_RELAY_CHANNEL, DmChannel, replyOwner, shareOwner, type DmOutcome, type OwnerSendHost } from './dm.ts'
import { HotStore, type BiliHot } from './hot.ts'
import { Journal } from './journal.ts'
import { tellMainAgent, type MainAgentHost } from './main-agent.ts'
import { DEFAULT_MANAGE_CREDENTIAL, LEDGER_ROWS, ManageClient } from './manage.ts'
import { OwnerInbox } from './owner-inbox.ts'
import { BiliReads, type InboxView, type MeView } from './reads.ts'
import { ManageSettings } from './settings.ts'
import { SettingsRoute } from './settings-route.ts'
import { SettingsView } from './settings-view.ts'
import { assertShareConfig, DailyShare, type ShareConfig } from './share.ts'
import { AccountStatus } from './status.ts'
import { biliDomain } from './storage.ts'
import { isTimeZone } from './time.ts'
import { BILI_PATH, type ActionResult, type BiliView } from './view.ts'
import { BiliWrites, type WriteOutcome } from './writes.ts'

export { BiliApiError, BiliOutcomeError, BiliRefused, BiliRiskError, BiliSessionError, BiliTransportError, BiliVerifyError, type BiliCaller, type CallOptions, type CallResult, type ServiceStatus } from './client.ts'
export type { BiliHot, BiliHotComment } from './hot.ts'
export type { Endpoint, EndpointName } from './endpoints.ts'
export type { CommentView, FeedPost, Folder, HotSearch, InboxItem, OwnerMessage, SearchOrder, SubtitleView, VideoCard, VideoDetail } from './api.ts'
export type * from './view.ts'
export type { SessionConfig } from './account-session.ts'
export type { InboxView, MeView } from './reads.ts'
export type { WriteOutcome } from './writes.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The agent's own Bilibili account. */
    bili: BiliAccount
    /** Hot comments and hot-search words the account's public reads showed, for the meme miner. */
    biliHot: BiliHot
  }
}

/** The daily share is checked this often; a check costs no model tokens. */
const SHARE_TICK_MS = 60_000

/** The slice of `ctx.presence` the daily share reads, when the presence plugin is mounted. */
interface PresenceReader {
  isAsleep(): boolean
}

/** The credential store's reference grammar: a POSIX shell identifier. */
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A credential's value, read per call; undefined when it is unset or empty. Never logged. */
function credentialReader(ctx: Context, ref: CredentialRef): () => Promise<string | undefined> {
  return async () => {
    const resolved = await ctx.credentials.resolve(ref)
    return resolved?.value === undefined || resolved.value === '' ? undefined : resolved.value
  }
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
  /**
   * Credential holding the bili-svc token of scope `manage`. Only the Settings route uses it: the
   * sign-in, session, gate, and brake controls. Unset, Settings stays read-only and names this credential.
   */
  manageTokenEnv: string
  /** IANA time zone of the journal, the main-agent limit, and prompt times. */
  timeZone: string
  /** Messages the account's Session may send the owner's main agent per day (`bili_tell_main_agent`); 0 turns them off. */
  mainAgentPerDay: number
  /** The account's Session. */
  session: SessionConfig
  /** Owner-message check period, in milliseconds; checks cost no model tokens. */
  inboxPollMs: number
  /** The daily share: once a day the account messages the owner first, at a random time in the window. */
  share: ShareConfig
}

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (!isAbsolute(config.session.workspacePath)) throw new Error('bili: session.workspacePath must be an absolute path')
  if (config.session.title.trim() === '') throw new Error('bili: session.title must be non-empty')
  if (!isTimeZone(config.timeZone)) throw new Error(`bili: timeZone "${config.timeZone}" is not a valid IANA time zone`)
  if (!/^[a-z0-9_-]{1,64}$/.test(config.account)) throw new Error(`bili: account "${config.account}" is not a bili-svc account id`)
  if (!CREDENTIAL_NAME.test(config.manageTokenEnv)) throw new Error(`bili: manageTokenEnv "${config.manageTokenEnv}" is not a credential name (a shell identifier)`)
  assertShareConfig(config.share)
}

/**
 * The agent's own Bilibili account, through bili-svc: reads, actions, the owner-message check,
 * the DM channel of the owner relay, the journal, messages to the main agent, and the Settings route.
 */
export class BiliAccount extends Service {
  static inject = ['timer', 'storageDomain', 'credentials', 'sessionController', 'permissionPresets', 'sessionTitle']
  /** Configuration schema. */
  static Config: z<Config> = z.object({
    ownerMid: z.natural().description("The owner's main account (UID), the only one whose messages the Session answers; the UID set in Settings wins. Unset, nothing is answered."),
    account: z.string().default('maomao').description("bili-svc's id of the agent's account: the account of every call."),
    manageTokenEnv: z.string().role('credential-ref').default(DEFAULT_MANAGE_CREDENTIAL).description('Name of the credential holding the bili-svc management token; only the name is configured here.'),
    timeZone: z.string().default('America/New_York').description('IANA time zone of the journal, the main-agent limit, and prompt times.'),
    mainAgentPerDay: z.natural().max(20).default(5).description("Messages the account's Session may send the owner's main agent per day (bili_tell_main_agent); 0 turns them off."),
    session: z.object({
      workspacePath: z.string().default('/Users/dsh-runtime/bili').description('Absolute working directory of the account Session.'),
      agentPreset: z.string().default('bili').description('Agent preset of the account Session.'),
      permissionPreset: z.string().default('danger-full-access').description('Permission preset set on the account Session.'),
      title: z.string().default('B站').description('Title of the account Session.'),
    }),
    inboxPollMs: z.natural().min(120_000).default(600_000).description('Owner-message check period, in milliseconds; checks cost no model tokens.'),
    share: z.object({
      enabled: z.boolean().default(true).description('Whether the account messages the owner once a day with a video it watched and a recent 热梗; the switch in Settings wins.'),
      start: z.string().default('19:00').description('Start of the daily share window, HH:MM in timeZone.'),
      end: z.string().default('22:30').description('End of the daily share window, HH:MM in timeZone (same day, after start).'),
    }),
  })

  private readonly ready: Promise<Domain<typeof biliDomain>>
  private readonly client: RemoteBiliClient
  private readonly abort = new AbortController()
  private readonly background = new BackgroundWork((error: unknown) => { this.ctx.logger.warn(`bili: background work failed: ${errorText(error)}`) })
  private readonly timers = new Set<() => void>()
  private domain: Domain<typeof biliDomain> | undefined
  private stopping = false
  /** bili-svc's status and the agent's account in it. */
  private readonly status: AccountStatus
  /** The account's channel of `ctx.ownerRelay`: answers to the owner's messages, through bili-svc's Reply Gate. */
  private readonly dm: DmChannel
  /** What the sends of the DM channel's answers to the owner need. */
  private readonly sends: OwnerSendHost
  /** The account's long-lived Session. */
  private readonly session: AccountSession
  /** The owner-message check and queue. */
  private readonly ownerInbox: OwnerInbox
  /** The daily share to the owner. */
  private readonly share: DailyShare
  private readonly reads: BiliReads
  private readonly writes: BiliWrites
  private readonly journal: Journal
  /** What `tellMainAgent` needs: storage, the daily limit, and the notifier. */
  private readonly mainAgent: MainAgentHost
  /** What the Settings section shows. */
  private readonly settingsView: SettingsView
  /** The Settings route, which answers the view. */
  private readonly route: SettingsRoute

  /**
   * @param ctx - Host services owning timers, storage, credentials, and Sessions.
   * @param config - owner account, bili-svc account, limits, and Session settings.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'bili')
    assertConfig(config)
    const baseUrl = (process.env['BILI_SVC_URL'] ?? DEFAULT_SERVICE_URL).replace(/\/+$/, '')
    const logger = { info: (message: string) => { ctx.logger.info(message) }, warn: (message: string) => { ctx.logger.warn(message) } }
    const serialize = <T>(work: () => Promise<T>): Promise<T> => this.background.serialize(work)
    const track = (work: Promise<void>): void => { this.background.track(work) }
    const ownerMid = (): number | undefined => this.ownerMid()
    this.client = new RemoteBiliClient({
      baseUrl,
      account: config.account,
      // A fixed shell identifier, so it is a valid reference without the runtime `credentialRef()` check.
      token: credentialReader(ctx, TOKEN_CREDENTIAL as CredentialRef),
      debug: (message) => { ctx.logger.debug(message) },
      info: (message) => { ctx.logger.info(message) },
    })
    const settings = new ManageSettings({
      manage: new ManageClient({
        baseUrl,
        // Checked by `assertConfig` against the store's reference grammar, so it needs no runtime `credentialRef()`.
        token: credentialReader(ctx, config.manageTokenEnv as CredentialRef),
        debug: (message) => { ctx.logger.debug(message) },
      }),
      info: logger.info,
      warn: logger.warn,
      now: () => Date.now(),
    })
    this.ready = ctx.storageDomain.open(biliDomain)
    const ready = this.ready
    const hot = new HotStore({ ready, now: () => Date.now(), logger: ctx.logger })
    ctx.provide('biliHot', hot)
    this.status = new AccountStatus({
      client: this.client,
      account: config.account,
      signal: this.abort.signal,
      debug: (message) => { ctx.logger.debug(message) },
    })
    this.sends = { client: this.client, ownerMid, signal: this.abort.signal, logger }
    this.share = new DailyShare({
      ready,
      serialize,
      ownerMid,
      holdReason: (now, domain) => this.ownerInbox.holdReason(now, domain),
      prompt: text => this.session.prompt(text, 'share'),
      timeZone: config.timeZone,
      now: () => Date.now(),
      random: () => Math.random(),
      logger,
    }, config.share)
    this.dm = new DmChannel({
      replyOwner: text => this.replyOwner(text),
      shareOwner: text => this.shareOwner(text),
      shareCurrent: sessionId => this.share.isShareTurn(sessionId),
      shareSettled: (sessionId, outcome, detail, text) => this.share.settled(sessionId, outcome, detail, text),
      hold: work => this.background.hold(work),
      notifier: () => this.ctx.get('ownerNotifier'),
      logger,
    })
    this.session = new AccountSession({
      ctx,
      ready,
      serialize,
      session: config.session,
      timeZone: config.timeZone,
      signal: this.abort.signal,
      dm: this.dm,
    })
    this.ownerInbox = new OwnerInbox({
      ready,
      client: this.client,
      serialize,
      track,
      ownerMid,
      prompt: async text => (await this.session.prompt(text, 'reply')) !== undefined,
      timeout: (work, ms) => this.ctx.timeout(work, ms),
      stopping: () => this.stopping,
      ownerAsleep: () => ((this.ctx.get as (name: string) => unknown)('presence') as PresenceReader | undefined)?.isAsleep() === true,
      timeZone: config.timeZone,
      logger,
    })
    this.writes = new BiliWrites({ client: this.client, timeZone: config.timeZone, selfMid: () => this.status.selfMid(), ownerMid, logger })
    this.reads = new BiliReads({
      client: this.client,
      timeZone: config.timeZone,
      ownerMid,
      track,
      hot,
      reportWatch: (video, cid, reached) => this.writes.reportWatch(video, cid, reached),
      markSeen: items => this.ownerInbox.markSeen(items),
      accountView: () => this.status.accountView(),
    })
    this.journal = new Journal({ ready, serialize, timeZone: config.timeZone, info: logger.info })
    this.mainAgent = { ready, serialize, timeZone: config.timeZone, perDay: config.mainAgentPerDay, notifier: () => this.ctx.get('ownerNotifier'), logger }
    this.settingsView = new SettingsView({
      ready,
      settings,
      status: this.status,
      share: this.share,
      ownerMid,
      account: config.account,
      manageTokenEnv: config.manageTokenEnv,
      timeZone: config.timeZone,
      signal: this.abort.signal,
      warn: logger.warn,
    })
    this.route = new SettingsRoute({
      view: (result, ledgerRows) => this.view(result, ledgerRows),
      settings,
      status: this.status,
      share: this.share,
      setOwner: mid => this.ownerInbox.setOwner(mid),
      manageTokenEnv: config.manageTokenEnv,
    })

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const cleanup = ctx.effect(() => async () => {
        this.stopping = true
        this.abort.abort(new Error('bili is stopping'))
        this.ownerInbox.stop()
        for (const dispose of this.timers) dispose()
        await this.background.drain()
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
        const connection = child.connection
        child.effect(() => connection.fetch.register({
          path: BILI_PATH,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: request => this.route.handle(request),
        }), 'bili: /api/bili')
      },
    })
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Drop queued items of the retired reply and mention wakes, and start the owner-message check and the daily share. */
  private async restore(domain: Domain<typeof biliDomain>): Promise<void> {
    await this.ownerInbox.dropRetired(domain)
    this.ctx.logger.info(`bili: bili-svc at ${this.client.baseUrl}, account ${this.config.account}; ${this.ownerMid() === undefined ? 'no owner account set, so no messages are answered' : 'answering the owner\'s messages'}`)
    this.every(this.config.inboxPollMs, () => this.ownerInbox.poll())
    this.every(SHARE_TICK_MS, () => this.share.tick())
    const enabled = await this.share.enabled()
    this.ctx.logger.info(`bili: the daily share is ${enabled ? `on, once a day at a random time in ${this.config.share.start}–${this.config.share.end} ${this.config.timeZone}` : 'off'}`)
  }

  /** Run `work` every `ms`, never two at once. */
  private every(ms: number, work: () => Promise<void>): void {
    let running = false
    const dispose = this.ctx.interval(() => {
      if (running || this.stopping) return
      running = true
      this.background.track(work().finally(() => { running = false }))
    }, ms)
    this.timers.add(dispose)
  }

  /** The owner's main account: the UID set in Settings, else the configured one. */
  private ownerMid(): number | undefined {
    return this.domain?.table('owner').get('main')?.mid ?? this.config.ownerMid
  }

  // ── The DM channel ─────────────────────────────────────────────────────

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

  /** One reply to the owner through bili-svc's Reply Gate ({@link replyOwner}). */
  private replyOwner(text: string): Promise<DmOutcome> {
    return replyOwner(this.sends, text)
  }

  /** One part of the daily share to the owner through bili-svc ({@link shareOwner}). */
  private shareOwner(text: string): Promise<DmOutcome> {
    return shareOwner(this.sends, text)
  }

  /**
   * Whether this plugin created a Session; each one is claimed by the DM channel.
   * @param sessionId - Session to check.
   * @returns true for every Session this plugin created.
   */
  ownsSession(sessionId: string): boolean {
    return this.domain?.table('sessions').get(sessionId) !== undefined
  }

  // ── Actions (src/writes.ts) ────────────────────────────────────────────

  /**
   * Give a video coins, never with a like. Bilibili takes at most 2 coins per video from one
   * account for an original and 1 otherwise; `count` defaults to that most. bili-svc allows one
   * coin write per video ever; the balance limits the rest.
   * @param bvid - BV id.
   * @param count - 1 or 2; default the most the video takes.
   * @returns the outcome.
   */
  async coin(bvid: string, count?: number): Promise<WriteOutcome> {
    return this.writes.coin(bvid, count)
  }

  /**
   * 一键三连: like, coins (2 for an original, 1 otherwise), and a favorite in the default folder,
   * in one request. Parts already done are reported; all three done answers `already` without a
   * call. bili-svc allows one triple per video ever and counts it against its caps.
   * @param bvid - BV id.
   * @returns the outcome.
   */
  async triple(bvid: string): Promise<WriteOutcome> {
    return this.writes.triple(bvid)
  }

  /**
   * Follow an account.
   * @param mid - its user id.
   * @returns the outcome.
   */
  async follow(mid: number): Promise<WriteOutcome> {
    return this.writes.follow(mid)
  }

  /**
   * Unfollow an account; the owner's account stays followed.
   * @param mid - its user id.
   * @returns the outcome.
   */
  async unfollow(mid: number): Promise<WriteOutcome> {
    return this.writes.unfollow(mid)
  }

  /**
   * Add a video to a favorite folder (the default one unless named), or remove it.
   * @param bvid - BV id.
   * @param options - `remove`, and a folder id from `me()`.
   * @returns the outcome.
   */
  async favorite(bvid: string, options: { remove?: boolean; folderId?: number } = {}): Promise<WriteOutcome> {
    return this.writes.favorite(bvid, options)
  }

  /**
   * Like a video.
   * @param bvid - BV id.
   * @returns the outcome.
   */
  async like(bvid: string): Promise<WriteOutcome> {
    return this.writes.like(bvid)
  }

  /**
   * Add a video to watch later, or remove it.
   * @param bvid - BV id.
   * @param remove - remove instead of add.
   * @returns the outcome.
   */
  async watchLater(bvid: string, remove: boolean = false): Promise<WriteOutcome> {
    return this.writes.watchLater(bvid, remove)
  }

  // ── Reads (src/reads.ts) ───────────────────────────────────────────────

  /**
   * The next batch of the home feed.
   * @returns about 12 bounded video cards.
   */
  async homeFeed(): Promise<VideoCard[]> {
    return this.reads.homeFeed()
  }

  /**
   * The site leaderboard (排行榜) across all zones.
   * @returns up to 30 bounded video cards, top first.
   */
  async ranking(): Promise<VideoCard[]> {
    return this.reads.ranking()
  }

  /**
   * A sample of a video's danmaku: the jokes and reactions of its own viewers.
   * @param bvid - BV id.
   * @param part - part number of a multi-part video.
   * @returns up to 40 lines across the video, each with its second.
   */
  async danmaku(bvid: string, part?: number): Promise<{ bvid: string; lines: DanmakuLine[] }> {
    return this.reads.danmaku(bvid, part)
  }

  /**
   * What followed accounts posted, without the owner's own posts.
   * @param offset - `next` of the previous page.
   * @returns bounded posts, newest first, and the `next` offset when there are more.
   */
  async followingFeed(offset?: string): Promise<{ items: FeedPost[]; next?: string }> {
    return this.reads.followingFeed(offset)
  }

  /**
   * Popular videos.
   * @param page - from 1.
   * @returns bounded video cards.
   */
  async popular(page: number = 1): Promise<VideoCard[]> {
    return this.reads.popular(page)
  }

  /**
   * Search videos.
   * @param keyword - search words.
   * @param page - from 1.
   * @param order - `relevance` (default) or `newest` first.
   * @returns bounded video cards.
   */
  async search(keyword: string, page: number = 1, order: SearchOrder = 'relevance'): Promise<VideoCard[]> {
    return this.reads.search(keyword, page, order)
  }

  /**
   * The hot-search list (热搜): what the whole site searches for right now.
   * @returns up to 30 keywords, each with the label the search box shows when it differs.
   */
  async hotSearches(): Promise<HotSearch[]> {
    return this.reads.hotSearches()
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
    return this.reads.video(bvid, options)
  }

  /**
   * Comments of a video, or one thread when `root` is given.
   * @param bvid - BV id.
   * @param options - order, `next` offset, root comment id, and thread page.
   * @returns bounded comments and the `next` offset, or a thread with its root.
   */
  async comments(bvid: string, options: { order?: 'hot' | 'new'; offset?: string; root?: string; page?: number } = {}): Promise<{ comments: CommentView[]; next?: string; root?: CommentView }> {
    return this.reads.comments(bvid, options)
  }

  /**
   * Unread counts, the newest replies and mentions, and the owner's latest messages; the owner's
   * messages it shows count as handed over.
   * @returns unread counts, up to ten replies and mentions, and the owner's latest messages.
   */
  async inbox(): Promise<InboxView> {
    return this.reads.inbox()
  }

  /**
   * The account, its folders, its level and coins, and whether bili-svc holds actions.
   * @returns the account facts, or `signedIn: false`.
   */
  async me(): Promise<MeView> {
    return this.reads.me()
  }

  // ── Journal (src/journal.ts) ───────────────────────────────────────────

  /**
   * Keep one dated journal entry.
   * @param text - at most 600 characters; at most 8 entries a day.
   * @returns the stored entry's number and what is left today, or why it was refused.
   */
  async journalWrite(text: string): Promise<{ saved: true; seq: number; leftToday: number } | { refused: string }> {
    return this.journal.write(text)
  }

  /**
   * Recent journal entries, newest first.
   * @param page - from 1.
   * @returns up to ten entries and the page count.
   */
  async journalRead(page: number = 1): Promise<{ entries: { seq: number; day: string; text: string }[]; page: number; pages: number }> {
    return this.journal.read(page)
  }

  // ── Main agent (src/main-agent.ts) ─────────────────────────────────────

  /**
   * Send one message to the owner's main agent (`bili_tell_main_agent`): the WeChat channel queues it
   * in the owner's chat Session as untrusted data, and that Session's answer goes to the owner on
   * WeChat. Bounded per day by `mainAgentPerDay`; only messages that were queued count.
   * @param text - at most {@link MAIN_AGENT_MAX_CHARS} characters.
   * @returns `sent` with what is left today, or `refused` with the reason.
   */
  async tellMainAgent(text: string): Promise<WriteOutcome> {
    return tellMainAgent(this.mainAgent, text)
  }

  // ── Settings view (src/settings-view.ts) ──────────────────────────────

  /**
   * What the Settings section shows: every account bili-svc lists, its gate, brake, and ledger, QR
   * sign-ins in progress, and the owner's main account. With the manage token the status comes from
   * the management read; without it, from the agent's own token, read-only. bili-svc's answers carry
   * no cookie or token, and the QR keys stay on the Host.
   * @param result - what the action that led to this view did; null for a plain read.
   * @param ledgerRows - ledger rows to read.
   * @returns the view.
   */
  async view(result: ActionResult | null = null, ledgerRows: number = LEDGER_ROWS): Promise<BiliView> {
    return this.settingsView.read(result, ledgerRows)
  }
}

export default BiliAccount
