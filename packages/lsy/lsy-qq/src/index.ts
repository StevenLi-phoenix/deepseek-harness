/** QQ channel over the official QQ Open Platform Bot API: allowlisted peers, one chat Session each, and the `qq` relay channel. */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type { LsyNotifier } from '@deepseek-ai/dsh-lsy-event-bus'
// Type-only: ctx.ownerRelay, which relays each chat Session's final answers through this channel.
import type { RelayAnswer, RelayChannel, RelayDelivery } from '@deepseek-ai/dsh-owner-relay'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { qqDomain } from './storage.ts'
import { ATTACHMENT_NOTE, FORWARD_FAILED_PREFIX, frameInbound, HELP_REPLY, NEW_CHAT_REPLY, shortId, splitText } from './text.ts'
import { createSdkTransport, type QqInbound, type QqTarget, type QqTransport } from './transport.ts'

export * from './text.ts'
export * from './transport.ts'
export type * from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The QQ channel. */
    lsyQq: QqChannel
  }
}

/** Who may talk to the bot: openids QQ assigned, listed here. Both lists start empty, so nobody gets an answer. */
export interface AllowConfig {
  /** `user_openid`s whose private messages are answered. */
  users: string[]
  /** `group_openid`s whose @ messages are answered, from any member. */
  groups: string[]
}

/** How a peer's chat Session is created. */
export interface SessionConfig {
  /** Absolute directory the chat Sessions work in; created before every forwarded message. */
  workspacePath: string
  /** Agent preset of the chat Sessions; the bundle defines `qq` with a persona and no shell, file, or web tools. */
  agentPreset: string
  /** Permission preset applied when a chat Session is created. */
  permissionPreset: string
  /** Session title prefix; the peer's short id follows. */
  titlePrefix: string
  /** IANA time zone sent with every prompt. */
  timeZone: string
}

/** Channel configuration. */
export interface Config {
  /** Name of the credential (`$DSH_HOME/.env` variable or stored credential) holding the bot's AppID. */
  appIdEnv: string
  /** Name of the credential holding the bot's AppSecret. */
  appSecretEnv: string
  /** Who is answered. */
  allow: AllowConfig
  /** Chat Session settings. */
  session: SessionConfig
  /** Code points per QQ message; longer answers are split. */
  maxMessageChars: number
  /** Messages one answer may be split into (QQ allows five replies to one inbound message). */
  maxReplyParts: number
  /** Messages one peer may send per minute before the rest are dropped. */
  perPeerPerMinute: number
  /** How long a private message keeps its reply window open, in milliseconds. */
  c2cReplyWindowMs: number
  /** How long a group message keeps its reply window open, in milliseconds. */
  groupReplyWindowMs: number
  /** Tell the owner (through `ctx.lsyNotifier`) when a sender outside the allowlist writes, so its openid can be added. */
  notifyUnknown: boolean
  /** Credential re-check period while the AppID or AppSecret is missing, in milliseconds. */
  credentialPollMs: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  appIdEnv: z.string().role('credential-ref').default('LSY_QQ_APP_ID'),
  appSecretEnv: z.string().role('credential-ref').default('LSY_QQ_APP_SECRET'),
  allow: z.object({
    users: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
  }),
  session: z.object({
    workspacePath: z.string().default('/Users/dsh-runtime/qq'),
    agentPreset: z.string().default('qq'),
    permissionPreset: z.string().default('danger-full-access'),
    titlePrefix: z.string().default('QQ'),
    timeZone: z.string().default('America/New_York'),
  }),
  maxMessageChars: z.natural().min(100).max(4500).default(1500),
  maxReplyParts: z.natural().min(1).max(5).default(4),
  perPeerPerMinute: z.natural().min(1).default(10),
  c2cReplyWindowMs: z.natural().min(60_000).default(3_300_000),
  groupReplyWindowMs: z.natural().min(30_000).default(270_000),
  notifyUnknown: z.boolean().default(true),
  credentialPollMs: z.natural().min(1000).default(30_000),
})

/** Name of the channel through which `ctx.ownerRelay` relays the chat Sessions' answers. */
export const QQ_RELAY_CHANNEL = 'qq'

/** QQ accepts five passive replies to one inbound message id. */
const MAX_PASSIVE_REPLIES = 5
/** First retry delay after a failed connection; doubles up to {@link MAX_RETRY_MS}. */
const FIRST_RETRY_MS = 2000
const MAX_RETRY_MS = 120_000
/** A connection that stayed ready this long resets the retry delay. */
const STABLE_MS = 60_000
/** Chat Sessions remembered for {@link QqChannel.ownsSession}; the oldest are forgotten first. */
const MAX_REMEMBERED_SESSIONS = 200
/** The owner hears of a given unknown sender at most this often, and of all of them at most {@link UNKNOWN_PER_HOUR} times an hour. */
const UNKNOWN_RENOTIFY_MS = 24 * 60 * 60_000
const UNKNOWN_PER_HOUR = 3
/** Resolve failures that keep the stored chat Session: it exists and is only unavailable right now. */
const TRANSIENT_RESOLVE_CODES: ReadonlySet<string> = new Set(['session/agent-busy', 'session/writer-held'])
/** Longest unknown-sender message quoted to the owner, in code points. */
const UNKNOWN_PREVIEW_CHARS = 80

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (!isAbsolute(config.session.workspacePath)) throw new Error('lsy-qq: session.workspacePath must be an absolute path')
  if (config.session.titlePrefix.trim() === '') throw new Error('lsy-qq: session.titlePrefix must be non-empty')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.session.timeZone })
  } catch {
    throw new Error(`lsy-qq: session.timeZone "${config.session.timeZone}" is not a valid IANA time zone`)
  }
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Peer key of an inbound message: the user in a private chat, the group in a group chat. */
export function peerKeyOf(message: Pick<QqInbound, 'scope' | 'senderId' | 'groupId'>): string {
  return message.scope === 'group' ? `group:${message.groupId ?? ''}` : `c2c:${message.senderId}`
}

/** Messages per rolling minute, per key. */
class RateWindow {
  private readonly hits = new Map<string, number[]>()
  constructor(private readonly limit: number) {}

  /** @returns whether this hit fits within the limit; a refused hit is not counted. */
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter(at => now - at < 60_000)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }
}

/**
 * QQ channel. Connects the official bot to the QQ Open Platform, answers only the openids in `allow`,
 * gives each private chat and each group its own chat Session, and delivers each turn's final answer
 * that `ctx.ownerRelay` hands its `qq` channel. QQ lets a bot reply to a message within a window
 * (about an hour in private chats, minutes in groups) and at most five times; later answers go out
 * as proactive messages, and an answer QQ refuses falls back to `ctx.lsyNotifier` through the relay.
 */
export class QqChannel extends Service {
  static inject = ['storageDomain', 'sessionController', 'permissionPresets', 'sessionTitle', 'credentials']
  static Config = Config

  private readonly ready: Promise<Domain<typeof qqDomain>>
  private readonly abort = new AbortController()
  private readonly inflight = new Set<Promise<void>>()
  private readonly rate: RateWindow
  private domain: Domain<typeof qqDomain> | undefined
  private loop: Promise<void> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false
  private transport: QqTransport | undefined
  /** Last logged credential state, so each change is logged once. */
  private credentialState = ''
  /** When the owner was last told about unknown senders, newest last. */
  private readonly unknownTold: number[] = []

  /**
   * @param ctx - Host services owning storage, Sessions, presets, titles, and credentials.
   * @param config - Credentials, allowlist, chat Session settings, and delivery limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'lsyQq')
    assertConfig(config)
    this.rate = new RateWindow(config.perPeerPerMinute)
    this.ready = ctx.storageDomain.open(qqDomain)

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const cleanup = ctx.effect(() => async () => {
        this.stopping = true
        this.abort.abort(new Error('lsy-qq is stopping'))
        await this.loop
        await Promise.allSettled([...this.inflight])
        await this.chain // serialize() keeps the chain itself non-rejecting.
        await domain.close()
      }, 'lsyQq.lifecycle()')
      this.loop = this.run()
      return cleanup
    }, 'lsyQq.init()')

    // The relay delivers the chat Sessions' answers here whenever it is mounted; the channel works without it.
    ctx.plugin({
      name: 'lsy-qq-owner-relay',
      inject: ['ownerRelay'],
      apply: (child: Context) => {
        child.effect(() => this.joinRelay(child), 'lsyQq.ownerRelay()')
      },
    })
  }

  /**
   * Whether this channel created a Session: true for every chat Session it remembers, all of which
   * it claims with `ctx.ownerRelay`.
   * @param sessionId - Session to check.
   */
  ownsSession(sessionId: string): boolean {
    return this.domain?.table('sessions').get(sessionId) !== undefined
  }

  /** Register the `qq` channel and claim every stored chat Session once storage is open. */
  private joinRelay(child: Context): () => void {
    const relay = child.ownerRelay
    const channel: RelayChannel = {
      name: QQ_RELAY_CHANNEL,
      fallbackLabel: 'a QQ chat Session (its answer could not go out on QQ)',
      deliver: answer => this.hold(this.relayAnswer(answer)),
    }
    const unregister = relay.registerChannel(channel)
    let joined = true
    this.ready.then((domain) => {
      if (!joined) return
      const ids = [...domain.table('sessions').keys()]
      for (const id of ids) relay.claim(id, QQ_RELAY_CHANNEL)
      this.ctx.logger.info(`lsy-qq: the relay carries ${ids.length} chat Session(s) through channel ${QQ_RELAY_CHANNEL}`)
    }, (error: unknown) => {
      this.ctx.logger.warn(`lsy-qq: chat Sessions not claimed with the relay: ${errorText(error)}`)
    })
    return () => {
      joined = false
      unregister()
    }
  }

  /**
   * Deliver a chat Session's answer that the relay handed over.
   * @returns `sent` once QQ accepted every part, `kept` for a Session this channel no longer knows.
   * @throws when QQ refused a part; the relay then falls back to the notifier.
   */
  private async relayAnswer(answer: RelayAnswer): Promise<RelayDelivery> {
    const domain = await this.ready
    const peerKey = domain.table('sessions').get(answer.sessionId)?.peerKey
    const chat = peerKey === undefined ? undefined : domain.table('chats').get(peerKey)
    if (peerKey === undefined || chat === undefined || chat.sessionId !== answer.sessionId) {
      this.ctx.logger.info(`lsy-qq: Session ${answer.sessionId} is not a peer's current chat; its answer stays in the Session`)
      return 'kept'
    }
    await this.deliver(domain, peerKey, chat.scope, chat.targetId, answer.text)
    return 'sent'
  }

  /** Keep work another service awaits alive until teardown drains it; its outcome stays the caller's. */
  private hold<T>(work: Promise<T>): Promise<T> {
    const held = work.then(() => undefined, () => undefined).finally(() => this.inflight.delete(held))
    this.inflight.add(held)
    return work
  }

  /** Keep background work alive until teardown drains it. */
  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.ctx.logger.warn(`lsy-qq: background work failed: ${errorText(error)}`)
    }).finally(() => this.inflight.delete(tracked))
    this.inflight.add(tracked)
  }

  /** Run storage and send work one at a time; rejections reach the caller without breaking the chain. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work)
    this.chain = result.catch(() => undefined)
    return result
  }

  /** Resolve after `ms`, or as soon as the channel stops. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.abort.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.abort.signal.addEventListener('abort', done, { once: true })
    })
  }

  /** Read the bot's AppID and AppSecret; undefined while either is missing. Never logs a value. */
  private async credentials(): Promise<{ appId: string; appSecret: string } | undefined> {
    const [id, secret] = await Promise.all([
      this.ctx.credentials.resolve(credentialRef(this.config.appIdEnv)),
      this.ctx.credentials.resolve(credentialRef(this.config.appSecretEnv)),
    ])
    const appId = id?.value.trim() ?? ''
    const appSecret = secret?.value.trim() ?? ''
    const state = `${appId === '' ? 'no-id' : 'id'}:${appSecret === '' ? 'no-secret' : 'secret'}`
    if (state !== this.credentialState) {
      this.credentialState = state
      if (appId === '' || appSecret === '') {
        this.ctx.logger.info(`lsy-qq: ${this.config.appIdEnv} and ${this.config.appSecretEnv} are not both set (${state}); QQ stays offline and re-checks every ${this.config.credentialPollMs / 1000}s`)
      } else {
        this.ctx.logger.info(`lsy-qq: credentials found (bot app ${appId})`)
      }
    }
    return appId === '' || appSecret === '' ? undefined : { appId, appSecret }
  }

  /** The transport to QQ: a test double mounted as `lsyQqTransport`, otherwise the official SDK. */
  private makeTransport(credentials: { appId: string; appSecret: string }): QqTransport {
    const injected = (this.ctx.get as (name: string) => unknown)('lsyQqTransport') as QqTransport | undefined
    return injected ?? createSdkTransport({
      ...credentials,
      log: {
        debug: (message) => { this.ctx.logger.debug(`lsy-qq: sdk: ${message}`) },
        warn: (message) => { this.ctx.logger.warn(`lsy-qq: sdk: ${message}`) },
      },
    })
  }

  /** Stay connected while the plugin is active; waits for credentials, and backs off after a failed connection. */
  private async run(): Promise<void> {
    let failures = 0
    while (!this.stopping) {
      const credentials = await this.credentials()
      if (credentials === undefined) {
        await this.pause(this.config.credentialPollMs)
        continue
      }
      const transport = this.makeTransport(credentials)
      this.transport = transport
      let readyAt: number | undefined
      try {
        await transport.run({
          message: (message) => { this.track(this.handleMessage(message)) },
          ready: () => {
            readyAt = Date.now()
            this.ctx.logger.info('lsy-qq: connected to the QQ gateway')
          },
          disconnected: (reason) => { this.ctx.logger.warn(`lsy-qq: disconnected from the QQ gateway: ${reason}`) },
        }, this.abort.signal)
        if (this.stopping) return
        this.ctx.logger.warn('lsy-qq: the QQ connection ended without a stop; reconnecting')
      } catch (error: unknown) {
        if (this.stopping) return
        this.ctx.logger.warn(`lsy-qq: the QQ connection failed: ${errorText(error)}`)
      } finally {
        this.transport = undefined
      }
      failures = readyAt !== undefined && Date.now() - readyAt >= STABLE_MS ? 1 : failures + 1
      const wait = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
      this.ctx.logger.info(`lsy-qq: reconnecting in ${wait / 1000}s (attempt ${failures})`)
      await this.pause(wait)
    }
  }

  /** Whether this peer is on the allowlist. */
  private allowed(message: QqInbound): boolean {
    return message.scope === 'group'
      ? this.config.allow.groups.includes(message.groupId ?? '')
      : this.config.allow.users.includes(message.senderId)
  }

  /** Accept one inbound message: allowlist, rate limit, reply window, commands, then the peer's chat Session. */
  private async handleMessage(message: QqInbound): Promise<void> {
    const domain = await this.ready
    const peerKey = peerKeyOf(message)
    const targetId = message.scope === 'group' ? message.groupId ?? '' : message.senderId
    if (!this.allowed(message)) {
      this.ctx.logger.info(`lsy-qq: dropped a ${message.scope} message from ${message.scope === 'group' ? `member ${message.senderId} of group ${targetId}` : `user ${message.senderId}`}, not on allow.${message.scope === 'group' ? 'groups' : 'users'}`)
      if (this.config.notifyUnknown) await this.reportUnknown(domain, message, targetId)
      return
    }
    if (!this.rate.allow(peerKey, Date.now())) {
      this.ctx.logger.warn(`lsy-qq: dropped a message from ${peerKey}: more than ${this.config.perPeerPerMinute} a minute`)
      return
    }
    const text = message.text !== '' ? message.text : message.attachments > 0 ? ATTACHMENT_NOTE : ''
    if (text === '') {
      this.ctx.logger.debug(`lsy-qq: ignored an empty ${message.scope} message from ${peerKey}`)
      return
    }
    this.ctx.logger.info(`lsy-qq: ${message.scope} message from ${peerKey} (${text.length} chars${message.attachments > 0 ? `, ${message.attachments} attachment(s) not read` : ''})`)
    await this.serialize(async () => {
      await domain.table('windows').put(peerKey, { msgId: message.messageId, receivedAt: Date.now(), used: 0 })
    })
    const command = text.trim().toLowerCase()
    if (command === '/new') {
      await this.serialize(async () => {
        const chat = domain.table('chats').get(peerKey)
        if (chat === undefined) return
        await domain.table('chats').delete(peerKey)
        await domain.table('sessions').delete(chat.sessionId)
        this.ctx.get('ownerRelay')?.release(chat.sessionId)
        this.ctx.logger.info(`lsy-qq: ${peerKey} started a new chat`)
      })
      await this.reply(domain, peerKey, message.scope, targetId, NEW_CHAT_REPLY)
      return
    }
    if (command === '/help') {
      await this.reply(domain, peerKey, message.scope, targetId, HELP_REPLY)
      return
    }
    try {
      await this.forward(domain, peerKey, message, targetId, text)
    } catch (error: unknown) {
      if (this.stopping) return
      this.ctx.logger.warn(`lsy-qq: forwarding the ${peerKey} message failed: ${errorText(error)}`)
      await this.reply(domain, peerKey, message.scope, targetId, `${FORWARD_FAILED_PREFIX}${errorText(error).slice(0, 200)}`)
    }
  }

  /** Tell the owner, rarely, that a sender outside the allowlist wrote, with the openid to add. */
  private async reportUnknown(domain: Domain<typeof qqDomain>, message: QqInbound, targetId: string): Promise<void> {
    const notifier = this.ctx.get('lsyNotifier') as LsyNotifier | undefined
    if (notifier === undefined) return
    const now = Date.now()
    await this.serialize(async () => {
      const key = message.scope === 'group' ? `group:${targetId}` : `c2c:${message.senderId}`
      const seen = domain.table('unknown').get(key)
      if (seen !== undefined && now - seen.notifiedAt < UNKNOWN_RENOTIFY_MS) return
      const recent = this.unknownTold.filter(at => now - at < 3_600_000)
      this.unknownTold.splice(0, this.unknownTold.length, ...recent)
      if (this.unknownTold.length >= UNKNOWN_PER_HOUR) return
      this.unknownTold.push(now)
      await domain.table('unknown').put(key, { notifiedAt: now })
      const preview = Array.from(message.text).slice(0, UNKNOWN_PREVIEW_CHARS).join('')
      const list = message.scope === 'group' ? 'allow.groups' : 'allow.users'
      const id = message.scope === 'group' ? targetId : message.senderId
      try {
        await notifier.send({
          title: `QQ：${message.scope === 'group' ? '一个未放行的群' : '一个未放行的用户'}给机器人发了消息`,
          body: `没有回复。要放行就把这个 openid 加进 lsy-qq 的 ${list}：\n${id}${message.scope === 'group' ? `\n（发言成员 ${message.senderId}）` : ''}${preview === '' ? '' : `\n内容开头：${preview}`}`,
          origin: 'the QQ channel (an unlisted sender wrote; this is a notice, not the owner)',
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`lsy-qq: could not tell the owner about an unlisted sender: ${errorText(error)}`)
      }
    })
  }

  /** Prompt the peer's chat Session with the framed message. */
  private async forward(
    domain: Domain<typeof qqDomain>, peerKey: string, message: QqInbound, targetId: string, text: string,
  ): Promise<void> {
    const session = this.config.session
    mkdirSync(session.workspacePath, { recursive: true })
    const sessionId = await this.chatSession(domain, peerKey, message, targetId)
    await this.ctx.sessionController.prompt({
      requestId: randomUUID() as SessionRequestId,
      sessionId,
      // Steer, not queue: a message sent while the agent works joins the running turn at its next step.
      mode: 'steer',
      content: [{ type: 'text', text: frameInbound(message, text) }],
      clientTimeZone: session.timeZone,
    }, this.abort.signal)
    this.ctx.logger.info(`lsy-qq: forwarded ${text.length} chars from ${peerKey} to Session ${sessionId}`)
    // The answer comes back only through the relay; without it the peer would wait in silence.
    if (this.ctx.get('ownerRelay') === undefined) this.ctx.logger.warn('lsy-qq: no ownerRelay is mounted, so answers will not reach QQ')
  }

  /** The peer's chat Session: the stored one while it resolves, otherwise a new one. */
  private async chatSession(domain: Domain<typeof qqDomain>, peerKey: string, message: QqInbound, targetId: string): Promise<SessionId> {
    const stored = domain.table('chats').get(peerKey)
    if (stored !== undefined) {
      const sessionId = stored.sessionId as SessionId
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      if ('agent' in resolved) return sessionId
      if (TRANSIENT_RESOLVE_CODES.has(resolved.error.code)) throw resolved.error
      this.ctx.logger.info(`lsy-qq: chat Session ${sessionId} of ${peerKey} is unavailable (${resolved.error.code}); starting a new one`)
    }
    const session = this.config.session
    // Fails on an unknown preset before a Session exists.
    this.ctx.permissionPresets.resolve(session.permissionPreset)
    const created = await this.ctx.sessionController.create({ cwd: session.workspacePath, agentPreset: session.agentPreset })
    const resolved = await this.ctx.sessionController.resolveAgent(created.sessionId)
    if ('error' in resolved) throw resolved.error
    this.ctx.permissionPresets.set(resolved.agent.session, session.permissionPreset)
    this.ctx.sessionTitle.rename(resolved.agent.session, `${session.titlePrefix} ${message.scope === 'group' ? '群' : '私聊'} ${shortId(targetId)}`)
    const now = Date.now()
    const relay = this.ctx.get('ownerRelay')
    // Claimed before the first prompt, so the relay follows the Session's first turn.
    relay?.claim(created.sessionId, QQ_RELAY_CHANNEL)
    await this.serialize(async () => {
      const sessions = domain.table('sessions')
      await sessions.put(created.sessionId, { peerKey, createdAt: now })
      await domain.table('chats').put(peerKey, { sessionId: created.sessionId, scope: message.scope, targetId, createdAt: now })
      const excess = [...sessions.entries()]
        .sort(([, a], [, b]) => a.createdAt - b.createdAt)
        .slice(0, Math.max(0, sessions.size - MAX_REMEMBERED_SESSIONS))
      for (const [id] of excess) {
        await sessions.delete(id)
        relay?.release(id)
      }
    })
    this.ctx.logger.info(`lsy-qq: created chat Session ${created.sessionId} for ${peerKey} in ${session.workspacePath} (${session.agentPreset}, ${session.permissionPreset})`)
    return created.sessionId
  }

  /** Send a fixed reply; a failure is logged and never thrown. */
  private async reply(domain: Domain<typeof qqDomain>, peerKey: string, scope: 'c2c' | 'group', targetId: string, text: string): Promise<void> {
    try {
      await this.deliver(domain, peerKey, scope, targetId, text)
    } catch (error: unknown) {
      this.ctx.logger.warn(`lsy-qq: reply to ${peerKey} failed: ${errorText(error)}`)
    }
  }

  /**
   * Split an answer and send each part, quoting the peer's latest message while its reply window is
   * open and fewer than five passive replies went out; otherwise as proactive messages.
   * @throws when QQ refuses a part or no connection is up.
   */
  private deliver(domain: Domain<typeof qqDomain>, peerKey: string, scope: 'c2c' | 'group', targetId: string, raw: string): Promise<void> {
    return this.serialize(async () => {
      const transport = this.transport
      if (transport === undefined) throw new Error('QQ is not connected')
      const parts = splitText(raw, this.config.maxMessageChars, this.config.maxReplyParts)
      const windowMs = scope === 'group' ? this.config.groupReplyWindowMs : this.config.c2cReplyWindowMs
      for (const part of parts) {
        const window = domain.table('windows').get(peerKey)
        const passive = window !== undefined && Date.now() - window.receivedAt < windowMs && window.used < MAX_PASSIVE_REPLIES
        const target: QqTarget = { scope, id: targetId, ...(passive ? { msgId: window.msgId } : {}) }
        try {
          await transport.send(target, part)
        } catch (error: unknown) {
          this.ctx.logger.warn(`lsy-qq: sending ${part.length} chars to ${peerKey} as a ${passive ? 'reply' : 'proactive message'} failed: ${errorText(error)}`)
          throw error
        }
        if (passive) await domain.table('windows').put(peerKey, { ...window, used: window.used + 1 })
      }
      this.ctx.logger.info(`lsy-qq: sent ${parts.length} message(s) to ${peerKey}`)
    })
  }
}

export default QqChannel
