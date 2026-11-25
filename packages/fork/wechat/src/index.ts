/** WeChat (iLink bot) channel: the owner's chat Session, its `wechat` relay channel, and `ctx.ownerNotifier`. */

import { isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
// Type-only: the connection service's Context merge (ctx.connection).
import type {} from '@deepseek-ai/dsh-client-connection'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
// Also ctx.eventBus, whose auto-archive sweep leaves the owner's current chat Session alone.
import type { MainAgentMessage, OwnerNote, OwnerNotifier } from '@deepseek-ai/dsh-event-bus'
// Type-only: ctx.ownerRelay, which relays each chat Session's final answers through this channel.
import type { RelayChannel } from '@deepseek-ai/dsh-owner-relay'
// Type-only: ctx.presence, which tells whether the owner sleeps, so non-urgent messages wait for the morning.
import type { DeferralHolder, Presence } from '@deepseek-ai/dsh-presence'
// Type-only: ctx.permissionPresets, which `inject` names for the chat Session's permission preset.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { BackgroundWork, joinRelay } from '@deepseek-ai/dsh-service-kit'
import type { ChannelStatus } from '@deepseek-ai/dsh-wechat-settings/wechat-view'
import { ChatSessions } from './chat.ts'
import { errorText } from './errors.ts'
import { InboundMessages } from './inbound.ts'
import { AccountLink } from './link.ts'
import { accountFilePath } from './login.ts'
import { OwnerNotes } from './notes.ts'
import { Outbox, type HoldResult } from './outbox.ts'
import { OutgoingFiles, type SendFileResult } from './outgoing.ts'
import { LongPoll } from './poll.ts'
import { ChatReplies, type SendTextResult } from './replies.ts'
import { WechatSettings } from './settings.ts'
import { wechatDomain, type OutboxRecord } from './storage.ts'
import { WECHAT_MAX_TEXT_BYTES, WECHAT_RELAY_CHANNEL } from './text.ts'
import { ChatTurns } from './turns.ts'
import { TypingIndicator } from './typing.ts'
import { ReplyWindow } from './window.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * WeChat messages from the owner and outbox notices.
     * @persistenceAttribution
     */
    'wechat': { kind: 'wechat' } & ContextFormed
  }
}

export type * from './api.ts'
export { IlinkApiError, IlinkError } from './api.ts'
export type * from './login.ts'
export { LoginError } from './login.ts'
export type * from './login-session.ts'
export type * from '@deepseek-ai/dsh-wechat-settings/wechat-view'
export type * from './text.ts'
export type * from './storage.ts'
// The results of the public methods, declared beside the code that produces them.
export type { DeliverReport, HoldResult } from './outbox.ts'
export type { SendFileResult } from './outgoing.ts'
export type { SendTextResult } from './replies.ts'

/** How the owner's chat Session is created. */
export interface ChatConfig {
  /**
   * Absolute directory the chat Session works in; created before every
   * forwarded message, so a removed directory never strands the stored
   * Session. Received attachments go to its `.wechat-inbox/`.
   */
  workspacePath: string
  /** Agent preset of the chat Session. */
  agentPreset: string
  /** Permission preset applied when the chat Session is created. */
  permissionPreset: string
  /** Session title. */
  title: string
  /** IANA time zone sent with every prompt and used for digest timestamps. */
  timeZone: string
  /**
   * What a message another Session passes the main agent does: `turn` queues it as a prompt that starts
   * a turn of its own (the turn is marked as not the owner's); `notify` only tells the owner and leaves
   * the message in the chat as a notice, so nothing happens until the owner replies.
   */
  agentMessage: 'turn' | 'notify'
  /**
   * What a note for the owner (`send()`) does: `turn` queues it in the chat Session as a prompt that starts a turn of its
   * own (marked as not the owner's), and the main agent tells the owner in its own words or answers NO_REPLY; `direct`
   * sends it as written. Safety notes, and notes the chat cannot take, always go as written.
   */
  notes: 'turn' | 'direct'
  /**
   * How the chat Session's words reach the owner. `hybrid`: the final answer of each turn is still sent as the reply, and
   * the Session also has `wechat_send` for messages in the middle of a turn (progress, a first answer before a long step,
   * a heads-up that cannot wait); a final answer that repeats a `wechat_send` text is not sent twice. `text`: only the final
   * answer is sent and `wechat_send` is not offered. Read when the tool plugin mounts and at every send, so a config
   * reload switches it.
   */
  delivery: 'text' | 'hybrid'
}

/** Channel configuration. */
export interface Config {
  /** Account file written by the login command; defaults to `<DSH_HOME>/wechat/account.json`. */
  accountFile?: string
  /** Chat Session settings. */
  chat: ChatConfig
  /** The operator's mute file for safety notices; defaults to `<DSH_HOME>/notices.muted`. */
  muteFile?: string
  /** Code points per WeChat message; longer texts are split. */
  maxMessageChars: number
  /** Messages one text may be split into; the last is cut beyond that. */
  maxReplyParts: number
  /** Messages the bot may send per owner message. */
  repliesPerToken: number
  /** How long an owner message keeps its reply window open, in milliseconds. */
  contextTtlMs: number
  /** Undelivered texts kept for the next window; the oldest are dropped first. */
  outboxLimit: number
  /** Account file re-check period while no usable account exists, in milliseconds. */
  accountPollMs: number
  /** Long-poll deadline until the server suggests another, in milliseconds. */
  longPollTimeoutMs: number
  /** Deadline of one send, in milliseconds. */
  requestTimeoutMs: number
  /** WeChat CDN base for media downloads; a server-provided `full_url` must share its origin. */
  cdnBaseUrl: string
  /** Largest attachment downloaded, in bytes. */
  maxMediaBytes: number
  /** Deadline of one attachment download, in milliseconds. */
  mediaTimeoutMs: number
  /**
   * Chat silence, in milliseconds, after which the owner's next message reaches the chat Session
   * with a note of when it was sent, how long the chat was quiet, and what the last message was.
   * Defaults to time-gap's 5 minutes, which leaves the owner's WeChat messages to this check
   * (its `deferChannels`). 0 turns the note off.
   */
  timeGapMs: number
  /**
   * How long after the owner's latest message nothing is held back for sleep, in milliseconds: the owner is
   * evidently awake, and what the chat Session answers in that time is a reply. 0 holds even replies.
   */
  awakeAfterMessageMs: number
  /** Messages one turn may send with `wechat_send`; the default is the whole reply window of one owner message (`repliesPerToken`). */
  maxSendsPerTurn: number
}

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (config.accountFile !== undefined && !isAbsolute(config.accountFile)) {
    throw new Error('wechat: accountFile must be an absolute path')
  }
  if (!isAbsolute(config.chat.workspacePath)) throw new Error('wechat: chat.workspacePath must be an absolute path')
  if (config.chat.title.trim() === '') throw new Error('wechat: chat.title must be non-empty')
  const cdn = URL.parse(config.cdnBaseUrl)
  const loopback = cdn !== null && ['127.0.0.1', 'localhost', '[::1]'].includes(cdn.hostname)
  if (cdn === null || !(cdn.protocol === 'https:' || (cdn.protocol === 'http:' && loopback))) {
    throw new Error('wechat: cdnBaseUrl must be an HTTPS URL (HTTP only on loopback)')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.chat.timeZone })
  } catch {
    throw new Error(`wechat: chat.timeZone "${config.chat.timeZone}" is not a valid IANA time zone`)
  }
}

/**
 * WeChat channel for one owner. Long-polls the bound bot, forwards the
 * owner's messages into one long-lived chat Session, delivers each turn's
 * final answer that `ctx.ownerRelay` hands its `wechat` channel, and delivers
 * bus notifications. iLink only lets a bot answer within a window opened by
 * the owner's latest message, so texts that find no open window wait in a
 * durable outbox and arrive as a digest when the owner writes again.
 */
export class WechatChannel extends Service implements OwnerNotifier {
  static inject = ['storageDomain', 'sessionController', 'permissionPresets', 'sessionTitle']
  /** Configuration schema. */
  static Config: z<Config> = z.object({
    accountFile: z.string(),
    muteFile: z.string(),
    chat: z.object({
      workspacePath: z.string().default('/Users/dsh-runtime/work'),
      agentPreset: z.string().default('unattended'),
      permissionPreset: z.string().default('danger-full-access'),
      title: z.string().default('微信'),
      timeZone: z.string().default('America/New_York'),
      agentMessage: z.union(['turn', 'notify'] as const).default('turn'),
      notes: z.union(['turn', 'direct'] as const).default('turn'),
      delivery: z.union(['text', 'hybrid'] as const).default('hybrid'),
    }),
    maxMessageChars: z.natural().min(200).max(WECHAT_MAX_TEXT_BYTES).default(3000),
    maxReplyParts: z.natural().min(1).default(3),
    repliesPerToken: z.natural().min(2).default(10),
    contextTtlMs: z.natural().min(60_000).default(84_600_000),
    outboxLimit: z.natural().min(1).default(50),
    accountPollMs: z.natural().min(1000).default(30_000),
    longPollTimeoutMs: z.natural().min(1000).default(35_000),
    requestTimeoutMs: z.natural().min(1000).default(15_000),
    cdnBaseUrl: z.string().default('https://novac2c.cdn.weixin.qq.com/c2c'),
    maxMediaBytes: z.natural().min(1024).default(25 * 1024 * 1024),
    mediaTimeoutMs: z.natural().min(1000).default(60_000),
    timeGapMs: z.natural().default(300_000),
    awakeAfterMessageMs: z.natural().default(1_800_000),
    maxSendsPerTurn: z.natural().min(1).default(10),
  })

  private readonly ready: Promise<Domain<typeof wechatDomain>>
  private readonly abort = new AbortController()
  private readonly background = new BackgroundWork((error: unknown) => { this.ctx.logger.warn(`wechat: background work failed: ${errorText(error)}`) })
  private domain: Domain<typeof wechatDomain> | undefined
  private loop: Promise<void> | undefined
  private stopping = false
  /** The owner's "typing" line while a chat Session works. */
  private readonly typing: TypingIndicator
  private readonly link: AccountLink
  private readonly window: ReplyWindow
  private readonly turns: ChatTurns
  private readonly queue: Outbox
  private readonly outgoing: OutgoingFiles
  private readonly chat: ChatSessions
  private readonly replies: ChatReplies
  private readonly notes: OwnerNotes
  private readonly poll: LongPoll

  /**
   * @param ctx - Host services owning storage, Sessions, presets, and titles.
   * @param config - Account file, chat Session settings, and delivery limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'ownerNotifier')
    assertConfig(config)
    const accountFile = config.accountFile ?? accountFilePath()
    const muteFile = config.muteFile ?? join(resolveDshHome(undefined, process.env), 'notices.muted')
    this.ready = ctx.storageDomain.open(wechatDomain)
    this.typing = new TypingIndicator({
      fetchTicket: async () => {
        const account = this.link.usableAccount()
        const window = this.window.stored()
        const { typingTicket } = await this.link.client(account).getConfig(account.ownerUserId, window?.token, this.abort.signal)
        if (typingTicket === undefined) throw new Error('the server gave no typing ticket')
        return typingTicket
      },
      // No channel signal: the cancel must still go out while the channel stops; the request deadline bounds it.
      send: async (ticket, status) => {
        const account = this.link.usableAccount()
        await this.link.client(account).sendTyping(account.ownerUserId, ticket, status)
      },
      warn: (message) => { this.ctx.logger.warn(`wechat: typing unavailable: ${message}; replies are unaffected`) },
      fetched: () => { this.ctx.logger.info('wechat: typing ticket fetched') },
    })

    const { ready, background, typing } = this
    const { logger } = ctx
    const signal = this.abort.signal
    const domain = (): Domain<typeof wechatDomain> | undefined => this.domain
    const stopping = (): boolean => this.stopping
    const link = new AccountLink({ accountFile, config, logger, signal, background, typing })
    const window = new ReplyWindow({ link, config, logger, signal, domain })
    const turns = new ChatTurns(typing)
    const outbox = new Outbox({ ready, link, window, background, config, logger, domain, presence: () => ctx.get('presence'), stopping })
    const outgoing = new OutgoingFiles({ ready, link, window, turns, background, config, logger, signal })
    const chat = new ChatSessions({ ctx, ready, link, outbox, background, config, domain })
    const inbound = new InboundMessages({ ctx, window, outbox, chat, turns, background, config, signal, stopping })
    this.link = link
    this.window = window
    this.turns = turns
    this.queue = outbox
    this.outgoing = outgoing
    this.chat = chat
    this.replies = new ChatReplies({ turns, outgoing, outbox, chat, window, config, logger })
    this.notes = new OwnerNotes({ ctx, muteFile, chat, outbox, turns, config, signal })
    this.poll = new LongPoll({ link, config, logger, signal, stopping, handleMessage: (...args) => inbound.handleMessage(...args) })

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      this.queue.armHold()
      const cleanup = ctx.effect(() => async () => {
        this.stopping = true
        this.turns.clearTypingGrace()
        this.queue.clearHold()
        // A running chat turn dies with the process; say so while the reply window is still usable.
        const running = this.turns.running()
        if (running.length > 0) await this.window.sendRestartNotice(running)
        await this.typing.stop()
        await this.link.notifyLifecycle('stop')
        this.abort.abort(new Error('wechat is stopping'))
        await this.loop
        await this.background.drain()
        await domain.close()
      }, 'wechat.lifecycle()')
      this.loop = this.poll.run(domain)
      return cleanup
    }, 'wechat.init()')

    // The relay delivers the chat Sessions' answers here whenever it is mounted; the channel works without it.
    ctx.plugin({
      name: 'wechat-owner-relay',
      inject: ['ownerRelay'],
      apply: (child: Context) => {
        child.effect(() => this.joinRelay(child), 'wechat.ownerRelay()')
      },
    })

    // The event bus's auto-archive sweep leaves the owner's current chat Session alone; the channel works without the bus.
    ctx.plugin({
      name: 'wechat-archive-protection',
      inject: ['eventBus'],
      apply: (child: Context) => {
        child.effect(
          () => child.eventBus.protectSessions('wechat', session => this.chat.isCurrentChat(session.id)),
          'wechat.archiveProtection()',
        )
      },
    })

    // Presence tells when the owner sleeps; the channel works without it and then holds nothing back.
    ctx.plugin({
      name: 'wechat-presence',
      inject: ['presence'],
      apply: (child: Context) => {
        child.effect(() => this.joinPresence(child.presence), 'wechat.presence()')
      },
    })

    // The Settings route mounts whenever the connection service is present; the channel works without it.
    ctx.plugin({
      name: 'wechat-settings-route',
      inject: ['connection'],
      apply: (child: Context) => {
        const settings = new WechatSettings({
          accountFile,
          timeZone: config.chat.timeZone,
          channel: this,
          logger: child.logger,
        })
        const connection = child.connection
        child.effect(() => connection.fetch.register(settings.route()), 'wechat.settings()')
        child.effect(() => () => { settings.dispose() }, 'wechat.settings.logins()')
      },
    })
  }

  /**
   * Register the `wechat` channel and claim every stored chat Session once storage is open.
   * @returns a disposer that unregisters the channel, which releases its claims.
   */
  private joinRelay(child: Context): () => void {
    const relay = child.ownerRelay
    const channel: RelayChannel = {
      name: WECHAT_RELAY_CHANNEL,
      deliver: answer => this.background.hold(this.replies.relayAnswer(answer)),
      onTurnStart: (sessionId) => { this.turns.start(sessionId) },
      onTurnEnd: (sessionId) => { this.turns.end(sessionId) },
      // Typing clears after the reply went out, so the chat never looks idle before the answer shows.
      onTurnSettled: () => { this.turns.settleTyping() },
    }
    return joinRelay(this.ctx, relay, channel, this.chat.remembered(), 'wechat')
  }

  /**
   * Hold the texts presence says to hold, and send them as one digest when the owner wakes.
   * @returns a disposer that stops listening and unregisters the holder.
   */
  private joinPresence(presence: Presence): () => void {
    const holder: DeferralHolder = {
      name: 'wechat',
      count: () => this.queue.heldCount(),
      flush: () => this.queue.releaseDeferred('flushed from Settings'),
    }
    const unregister = presence.registerHolder(holder)
    const stop = presence.onChange((state) => {
      if (state.asleep) return
      this.background.track(this.queue.releaseDeferred('the owner woke').then(() => undefined))
    })
    return () => {
      stop()
      unregister()
    }
  }

  /**
   * Deliver one notification for the owner. With `chat.notes: turn` it starts a turn of the chat Session, and the
   * main agent tells the owner in its own words or answers NO_REPLY; an urgent note (`presence.isUrgent()`) makes
   * that turn's answer pass the owner's sleep. A safety note, `chat.notes: direct`, or a chat that cannot take the
   * turn (no bound account, a refused prompt) sends the note as written, or keeps it for the next reply window.
   * @param note - title, optional body, optional link, and who sent it.
   * @returns resolves once the turn was queued, or the text was sent or durably queued.
   * @throws only when storage fails.
   */
  send(note: OwnerNote): Promise<void> {
    return this.notes.send(note)
  }

  /**
   * Pass a message from another of the agent's Sessions to the owner's current chat Session (the
   * main agent), creating one when there is none. It is queued, so a turn the owner started finishes
   * first; the turn it starts ends like any chat turn, and the relay sends its answer to the owner.
   * @param message - the text and who sent it, framed for the chat Session.
   * @returns the chat Session the message was queued in.
   * @throws when no account is bound (there is no chat), or the Session refused the prompt.
   */
  tellMainAgent(message: MainAgentMessage): Promise<SessionId> {
    return this.notes.tellMainAgent(message)
  }

  /**
   * Send one local file to the owner: a picture when its bytes are an image, a
   * video for `.mp4`/`.mov`/`.m4v`, a file otherwise. The recipient is always
   * the owner and the file goes only through the open reply window, never
   * queued; the window's last slot stays for the turn's text reply.
   * @param path - absolute path of a regular file within `maxMediaBytes`.
   * @param sessionId - the Session sending it, so a markdown image of the same file in this turn's answer is not sent twice.
   * @returns what was sent, or why it was not.
   */
  sendFile(path: string, sessionId?: string): Promise<SendFileResult> {
    return this.outgoing.sendFile(path, sessionId)
  }

  /**
   * How the chat Session's words reach the owner: `hybrid` registers `wechat_send` beside the final-answer reply.
   * @returns the configured delivery mode.
   */
  delivery(): 'text' | 'hybrid' {
    return this.config.chat.delivery
  }

  /**
   * Send a text the agent wrote for the owner in the middle of a turn (`wechat_send`). It goes through the same path as a
   * relayed answer: split, held while the owner sleeps (unless urgent), sent through the open reply window, or queued with
   * the reason. The window's last slot stays for the turn's final answer.
   * @param sessionId - the calling Session, for the per-turn cap and the repeat check; undefined outside a Session.
   * @param raw - the words for the owner.
   * @param options - `urgent` passes the owner's sleep.
   * @returns how many messages went out or wait and why, or why the text was refused.
   */
  sendText(sessionId: string | undefined, raw: string, options: { urgent?: boolean } = {}): Promise<SendTextResult> {
    return this.replies.sendText(sessionId, raw, options)
  }

  /**
   * Whether this channel created a Session: true for every chat Session it remembers, all of which
   * it claims with `ctx.ownerRelay`.
   * @param sessionId - Session to check.
   * @returns true for the current and earlier chat Sessions.
   */
  ownsSession(sessionId: string): boolean {
    return this.chat.ownsSession(sessionId)
  }

  /**
   * Hold a text the agent asked to defer. It goes to the owner inside a digest when `until` comes, or as soon as the owner wakes if that
   * is first; the owner's own messages do not release it earlier. Without `until` the owner has to be asleep now, since a text with no
   * time and no sleep to wait for would never be due.
   * @param raw - the text for the owner.
   * @param until - Unix epoch milliseconds, at most a week away.
   * @returns how many messages were queued, or why none were.
   */
  holdDelivery(raw: string, until?: number): Promise<HoldResult> {
    return this.queue.holdDelivery(raw, until)
  }

  /**
   * Texts waiting for the owner's next message, oldest first.
   * @returns snapshot of the outbox.
   */
  outbox(): OutboxRecord[] {
    return this.queue.rows()
  }

  /**
   * The channel's health for the Settings page: the long-poll, the owner chat's latest traffic, the
   * reply window, and the outbox. Counts, times, and codes only; no token, id, or message text.
   * @returns a snapshot.
   */
  status(): ChannelStatus {
    const activity = this.window.activity()
    const rows = this.queue.rows()
    return {
      channel: {
        ...this.link.status(),
        lastInboundAt: activity?.ownerAt ?? null,
        lastOutboundAt: activity?.sentAt ?? null,
        lastOutboundKind: activity?.sent ?? null,
      },
      window: this.window.status(),
      outbox: { count: rows.length, limit: this.config.outboxLimit, oldestAt: rows[0]?.queuedAt ?? null },
      delivery: { mode: this.config.chat.delivery, ...this.replies.stats() },
    }
  }

  /**
   * Read the account file again now instead of at the next check: ends the wait for a file, cuts the
   * running long-poll (which belongs to the old account), and skips a retry delay. Called after the
   * Settings page wrote or moved the file.
   * @param reason - what changed, for the log.
   */
  reloadAccount(reason: string): void {
    this.poll.reloadAccount(reason)
  }
}

export default WechatChannel
