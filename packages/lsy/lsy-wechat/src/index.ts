/** WeChat (iLink bot) channel: the owner's chat Session, reply relay, and `ctx.lsyNotifier`. */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { failureDetail, type LsyNote, type LsyNotifier } from '@deepseek-ai/dsh-lsy-event-bus'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { IlinkApiError, IlinkClient, ILINK_SEND_REJECTED, isStaleTokenError, ItemType, MESSAGE_TYPE_USER, type WeixinMessage } from './api.ts'
import { accountFilePath, readAccountFile, type WechatAccount } from './login.ts'
import { attachmentNote, describeMedia, downloadMedia, isPromptImage, mediaSpec, saveInboxFile, uploadMedia, type OutboundKind, type ReceivedMedia } from './media.ts'
import { wechatDomain, type OutboxRecord, type WindowRecord } from './storage.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'lsy-wechat': { kind: 'lsy-wechat' } & ContextFormed
  }
}

import { buildDigest, contentText, fitText, inboundText, NEW_CHAT_REPLY, QUOTA_FOOTER, relayText, renderNote, splitText, WECHAT_MAX_TEXT_BYTES } from './text.ts'

export * from './api.ts'
export * from './login.ts'
export * from './text.ts'
export type * from './storage.ts'

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
}

/** Channel configuration. */
export interface Config {
  /** Account file written by the login command; defaults to `<DSH_HOME>/lsy-wechat/account.json`. */
  accountFile?: string
  /** Chat Session settings. */
  chat: ChatConfig
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
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  accountFile: z.string(),
  chat: z.object({
    workspacePath: z.string().default('/Users/dsh-runtime/work'),
    agentPreset: z.string().default('unattended'),
    permissionPreset: z.string().default('danger-full-access'),
    title: z.string().default('微信'),
    timeZone: z.string().default('America/New_York'),
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
})

/** Exact owner text that starts a fresh chat Session. */
const NEW_CHAT_COMMAND = '/new'
/** Frames a note another Session sent the owner, as the chat Session reads it. */
const SHARED_NOTE_INTRO = 'Another session (an event, reminder, monitor, or operator task) just sent the owner this message on WeChat. It is context, not the owner speaking: the owner may reply to it in this chat.'

/** Chat Sessions remembered for {@link WechatChannel.ownsSession}; the oldest are forgotten first. */
const MAX_REMEMBERED_SESSIONS = 200
/** First retry delay after a failed long-poll; doubles up to {@link MAX_RETRY_MS}. */
const FIRST_RETRY_MS = 2000
const MAX_RETRY_MS = 60_000
/** Resolve failures that keep the stored chat Session: it exists and is only unavailable right now. */
const TRANSIENT_RESOLVE_CODES: ReadonlySet<string> = new Set(['session/agent-busy', 'session/writer-held'])

/** Outcome of {@link WechatChannel.sendFile}: what went out, or why nothing did. */
export type SendFileResult =
  | { readonly sent: OutboundKind; readonly name: string; readonly bytes: number }
  | { readonly notSent: string }

/** A usable reply window and what sending through it needs. */
interface Target {
  account: WechatAccount
  key: string
  window: WindowRecord
}

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (config.accountFile !== undefined && !isAbsolute(config.accountFile)) {
    throw new Error('lsy-wechat: accountFile must be an absolute path')
  }
  if (!isAbsolute(config.chat.workspacePath)) throw new Error('lsy-wechat: chat.workspacePath must be an absolute path')
  if (config.chat.title.trim() === '') throw new Error('lsy-wechat: chat.title must be non-empty')
  const cdn = URL.parse(config.cdnBaseUrl)
  const loopback = cdn !== null && ['127.0.0.1', 'localhost', '[::1]'].includes(cdn.hostname)
  if (cdn === null || !(cdn.protocol === 'https:' || (cdn.protocol === 'http:' && loopback))) {
    throw new Error('lsy-wechat: cdnBaseUrl must be an HTTPS URL (HTTP only on loopback)')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.chat.timeZone })
  } catch {
    throw new Error(`lsy-wechat: chat.timeZone "${config.chat.timeZone}" is not a valid IANA time zone`)
  }
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Storage key of an outbox row; zero-padded so keys sort like `seq`. */
function outboxKey(seq: number): string {
  return String(seq).padStart(12, '0')
}

/**
 * WeChat channel for one owner. Long-polls the bound bot, forwards the
 * owner's messages into one long-lived chat Session, relays each turn's final
 * answer back, and delivers bus notifications. iLink only lets a bot answer
 * within a window opened by the owner's latest message, so texts that find no
 * open window wait in a durable outbox and arrive as a digest when the owner
 * writes again.
 */
export class WechatChannel extends Service implements LsyNotifier {
  static inject = ['storageDomain', 'sessionController', 'permissionPresets', 'sessionTitle']
  static Config = Config

  private readonly ready: Promise<Domain<typeof wechatDomain>>
  private readonly accountFile: string
  private readonly abort = new AbortController()
  private readonly inflight = new Set<Promise<void>>()
  /** Latest assistant text of the running turn, per owned Session. */
  private readonly replies = new Map<string, string>()
  private domain: Domain<typeof wechatDomain> | undefined
  private loop: Promise<void> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false
  /** Account loaded by the latest file check. */
  private account: WechatAccount | undefined
  /** Last logged account state, so each change is logged once. */
  private accountState = ''
  /** Bot token the server declared stale; the loop waits for a different one. */
  private staleToken: string | undefined

  /**
   * @param ctx - Host services owning storage, Sessions, presets, and titles.
   * @param config - Account file, chat Session settings, and delivery limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'lsyNotifier')
    assertConfig(config)
    this.accountFile = config.accountFile ?? accountFilePath()
    this.ready = ctx.storageDomain.open(wechatDomain)

    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const cleanup = ctx.effect(() => async () => {
        this.stopping = true
        this.abort.abort(new Error('lsy-wechat is stopping'))
        await this.loop
        await Promise.allSettled([...this.inflight])
        await this.chain // serialize() keeps the chain itself non-rejecting.
        await domain.close()
      }, 'lsyWechat.lifecycle()')
      this.loop = this.run(domain)
      return cleanup
    }, 'lsyWechat.init()')

    ctx.on('session/event', (session, event) => { this.observeSession(session, event) })
  }

  /**
   * Deliver one notification to the owner, or keep it for the next reply window.
   * @param note - title, optional body, and optional link, rendered as plain text.
   * @returns resolves once the text was sent or durably queued.
   * @throws only when storage fails.
   */
  async send(note: LsyNote): Promise<void> {
    const text = renderNote(note)
    await this.deliver(text)
    await this.shareWithChat(text)
  }

  /**
   * Leave a copy of a message another Session sent the owner in the owner's chat Session, so that
   * when the owner answers it on WeChat (where every reply reaches the chat Session) the agent knows
   * what was said. It waits for the chat Session's next turn and never starts one; with no chat
   * Session yet there is nobody to tell. A failure only costs the context, never the delivery.
   * @param text - the rendered note, as the owner received or will receive it.
   */
  private async shareWithChat(text: string): Promise<void> {
    let chatId: string | undefined
    try {
      const chats = this.domain === undefined ? [] : [...this.domain.table('chats').entries()].map(([, row]) => row)
      const chat = chats.sort((a, b) => b.createdAt - a.createdAt)[0]
      if (chat === undefined) return
      chatId = chat.sessionId
      const resolved = await this.ctx.sessionController.resolveAgent(chatId as SessionId)
      if (!('agent' in resolved)) return
      const agent = resolved.agent as { inject?: (message: UserMessage) => void }
      if (typeof agent.inject !== 'function') return
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: `${SHARED_NOTE_INTRO}\n${text}` }],
        source: { kind: 'lsy-wechat', form: 'notice', summary: 'another Session messaged the owner' },
      }))
      this.ctx.logger.info(`lsy-wechat: shared a ${text.length}-char note with chat Session ${chatId}`)
    } catch (error: unknown) {
      this.ctx.logger.warn(`lsy-wechat: could not share a note with chat Session ${chatId ?? '(unknown)'}: ${errorText(error)}`)
    }
  }

  /**
   * Send one local file to the owner: a picture when its bytes are an image, a
   * video for `.mp4`/`.mov`/`.m4v`, a file otherwise. The recipient is always
   * the owner and the file goes only through the open reply window, never
   * queued; the window's last slot stays for the turn's text reply.
   * @param path - absolute path of a regular file within `maxMediaBytes`.
   * @returns what was sent, or why it was not.
   */
  async sendFile(path: string): Promise<SendFileResult> {
    if (!isAbsolute(path)) return { notSent: 'path must be absolute' }
    let size: number
    try {
      const info = await stat(path)
      if (!info.isFile()) return { notSent: 'not a regular file' }
      size = info.size
    } catch (error: unknown) {
      return { notSent: `cannot read the file (${(error as NodeJS.ErrnoException).code ?? errorText(error)})` }
    }
    if (size === 0) return { notSent: 'the file is empty' }
    if (size > this.config.maxMediaBytes) return { notSent: `the file exceeds ${this.config.maxMediaBytes} bytes` }
    const data = await readFile(path)
    const name = basename(path)
    return this.serialize(async (): Promise<SendFileResult> => {
      const domain = await this.ready
      const target = this.target(domain)
      if (typeof target === 'string') return { notSent: target }
      if (target.window.used + 1 >= this.config.repliesPerToken) return { notSent: 'reply quota nearly used up; the last message is kept for the text reply' }
      const { baseUrl, botToken: token } = target.account
      const client = new IlinkClient({ baseUrl, token, timeoutMs: this.config.requestTimeoutMs })
      let uploaded: Awaited<ReturnType<typeof uploadMedia>>
      try {
        uploaded = await uploadMedia(client, target.account.ownerUserId, name, data, {
          cdnBaseUrl: this.config.cdnBaseUrl, timeoutMs: this.config.mediaTimeoutMs, signal: this.abort.signal,
        })
      } catch (error: unknown) {
        if (isStaleTokenError(error)) {
          this.markStale(target.account)
          return { notSent: 'bot token is stale' }
        }
        this.ctx.logger.warn(`lsy-wechat: uploading ${name} failed: ${errorText(error)}`)
        return { notSent: `upload failed: ${errorText(error)}` }
      }
      const outcome = await this.transmitItem(domain, target, uploaded.item, `${uploaded.kind} ${name} (${size} bytes) from ${path}`)
      return outcome === 'sent' ? { sent: uploaded.kind, name, bytes: size } : { notSent: outcome }
    })
  }

  /**
   * Whether this channel relays the turns of a Session: true for every chat Session it created.
   * @param sessionId - Session to check.
   * @returns true for the current and earlier chat Sessions.
   */
  ownsSession(sessionId: string): boolean {
    return this.domain?.table('sessions').get(sessionId) !== undefined
  }

  /**
   * Texts waiting for the owner's next message, oldest first.
   * @returns snapshot of the outbox.
   */
  outbox(): OutboxRecord[] {
    const table = this.domain?.table('outbox')
    return table === undefined ? [] : [...table.entries()].map(([, row]) => row).sort((a, b) => a.seq - b.seq)
  }

  /** Run storage and send work one at a time; rejections reach the caller without breaking the chain. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work)
    this.chain = result.catch(() => undefined)
    return result
  }

  /** Keep background work alive until teardown drains it. */
  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.ctx.logger.warn(`lsy-wechat: background work failed: ${errorText(error)}`)
    }).finally(() => this.inflight.delete(tracked))
    this.inflight.add(tracked)
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

  /** Long-poll while the plugin is active; waits for a usable account file between attempts. */
  private async run(domain: Domain<typeof wechatDomain>): Promise<void> {
    let failures = 0
    let timeoutMs = this.config.longPollTimeoutMs
    while (!this.stopping) {
      const account = this.loadAccount()
      if (account === undefined || account.botToken === this.staleToken) {
        await this.pause(this.config.accountPollMs)
        continue
      }
      try {
        const client = new IlinkClient({ baseUrl: account.baseUrl, token: account.botToken })
        const cursor = domain.table('cursors').get(account.botId)
        const updates = await client.getUpdates(cursor?.buf ?? '', timeoutMs, this.abort.signal)
        failures = 0
        timeoutMs = updates.nextTimeoutMs ?? this.config.longPollTimeoutMs
        if (updates.malformed > 0) this.ctx.logger.warn(`lsy-wechat: dropped ${updates.malformed} malformed message(s)`)
        // At-most-once: the cursor moves before handling, so a crash in between drops messages rather than repeating prompts.
        if (updates.buf !== undefined && updates.buf !== cursor?.buf) await domain.table('cursors').put(account.botId, { buf: updates.buf })
        for (const message of updates.messages) await this.handleMessage(domain, account, message)
      } catch (error: unknown) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- teardown sets it while getUpdates is awaited.
        if (this.stopping) return
        if (isStaleTokenError(error)) {
          this.markStale(account)
          continue
        }
        failures += 1
        const wait = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
        this.ctx.logger.warn(`lsy-wechat: long-poll failed (${failures} in a row): ${errorText(error)}; retrying in ${wait / 1000}s`)
        await this.pause(wait)
      }
    }
  }

  /** Re-read the account file and log each state change once. */
  private loadAccount(): WechatAccount | undefined {
    const read = readAccountFile(this.accountFile)
    const state = read.kind === 'ok' ? `ok:${read.account.botId}:${read.account.ownerUserId}:${read.account.boundAt}` : read.kind
    if (state !== this.accountState) {
      this.accountState = state
      if (read.kind === 'missing') {
        this.ctx.logger.info(`lsy-wechat: no account at ${this.accountFile}; run lsy/deploy/wechat-login.mjs to bind a bot (re-checking every ${this.config.accountPollMs / 1000}s)`)
      } else if (read.kind === 'invalid') {
        this.ctx.logger.warn(`lsy-wechat: account file ${this.accountFile} is unusable: ${read.reason}`)
      } else {
        this.ctx.logger.info(`lsy-wechat: bot ${read.account.botId} active for owner ${read.account.ownerUserId}`)
      }
    }
    this.account = read.kind === 'ok' ? read.account : undefined
    return this.account
  }

  /** Stop using a token the server rejected as stale until the account file carries another. */
  private markStale(account: WechatAccount): void {
    if (this.staleToken === account.botToken) return
    this.staleToken = account.botToken
    this.ctx.logger.error(`lsy-wechat: the token of bot ${account.botId} is stale (errcode -14); run lsy/deploy/wechat-login.mjs again. Re-checking ${this.accountFile} every ${this.config.accountPollMs / 1000}s`)
  }

  /** Accept one owner message: open a reply window, flush the outbox, then forward the text. */
  private async handleMessage(domain: Domain<typeof wechatDomain>, account: WechatAccount, message: WeixinMessage): Promise<void> {
    if (message.message_type !== MESSAGE_TYPE_USER) {
      this.ctx.logger.debug(`lsy-wechat: ignored a message of type ${message.message_type ?? 'unknown'}`)
      return
    }
    if (message.from_user_id !== account.ownerUserId) {
      this.ctx.logger.info(`lsy-wechat: dropped a message from ${message.from_user_id ?? 'an unknown user'}, who is not the owner`)
      return
    }
    const text = inboundText(message)
    this.ctx.logger.info(`lsy-wechat: owner message (${text.length} chars)`)
    const token = message.context_token ?? ''
    await this.serialize(async () => {
      if (token === '') {
        this.ctx.logger.warn('lsy-wechat: owner message carries no context_token; replies wait in the outbox')
      } else {
        await domain.table('windows').put(`${account.botId}/${account.ownerUserId}`, { token, receivedAt: Date.now(), used: 0, exhausted: false })
      }
      await this.flushOutbox(domain)
    })
    if (text === '') return
    if (text === NEW_CHAT_COMMAND) {
      await this.serialize(async () => {
        if (await domain.table('chats').delete(account.ownerUserId)) this.ctx.logger.info('lsy-wechat: owner started a new chat')
      })
      await this.deliver(NEW_CHAT_REPLY)
      return
    }
    try {
      await this.forward(domain, account, text, await this.receiveMedia(message))
    } catch (error: unknown) {
      if (this.stopping) return
      this.ctx.logger.warn(`lsy-wechat: forwarding the owner message failed: ${errorText(error)}`)
      await this.deliver(`⚠️ 消息没能交给 agent：${fitText(errorText(error), 300)}`)
    }
  }

  /** Download each image, file, and video of an owner message into the inbox; a failure becomes its reason. */
  private async receiveMedia(message: WeixinMessage): Promise<ReceivedMedia[]> {
    const received: ReceivedMedia[] = []
    for (const item of message.item_list ?? []) {
      const spec = mediaSpec(item)
      if (spec === undefined) continue
      try {
        const media = await downloadMedia(item, {
          cdnBaseUrl: this.config.cdnBaseUrl,
          maxBytes: this.config.maxMediaBytes,
          timeoutMs: this.config.mediaTimeoutMs,
          signal: this.abort.signal,
        })
        const path = await saveInboxFile(join(this.config.chat.workspacePath, '.wechat-inbox'), media)
        this.ctx.logger.info(`lsy-wechat: received ${describeMedia(media)} at ${path}`)
        received.push({ media, path })
      } catch (error: unknown) {
        if (this.stopping) throw error
        this.ctx.logger.warn(`lsy-wechat: could not receive ${spec.kind}: ${errorText(error)}`)
        received.push({ failed: spec.kind, name: spec.name, reason: errorText(error) })
      }
    }
    return received
  }

  /**
   * Prompt the owner's chat Session with one message: the text, a note on
   * each attachment, and the images as image parts. A Session that refuses
   * images (a text-only model) gets the note with the saved paths instead.
   */
  private async forward(
    domain: Domain<typeof wechatDomain>, account: WechatAccount, text: string, received: readonly ReceivedMedia[],
  ): Promise<void> {
    mkdirSync(this.config.chat.workspacePath, { recursive: true })
    const sessionId = await this.chatSession(domain, account)
    const images = received.filter(isPromptImage)
    const prompt = (attach: boolean): Promise<unknown> => {
      const note = attachmentNote(received, attach)
      return this.ctx.sessionController.prompt({
        requestId: randomUUID() as SessionRequestId,
        sessionId,
        // Steer, not queue: a message sent while the agent works (often a picture right after a
        // word) joins the running turn at its next step, so the model sees it natively there.
        mode: 'steer',
        content: [
          { type: 'text', text: note === '' ? text : `${text}\n\n${note}` },
          ...attach ? images.map(image => ({ type: 'image' as const, mediaType: image.media.mediaType, data: image.media.data.toString('base64'), name: image.media.name })) : [],
        ],
        clientTimeZone: this.config.chat.timeZone,
      }, this.abort.signal)
    }
    try {
      await prompt(images.length > 0)
    } catch (error: unknown) {
      if (images.length === 0 || (error as { code?: unknown }).code !== 'session/attachment-invalid') throw error
      this.ctx.logger.warn(`lsy-wechat: Session ${sessionId} refused the image parts (${errorText(error)}); forwarding the saved paths only`)
      await prompt(false)
    }
    this.ctx.logger.info(`lsy-wechat: forwarded ${text.length} chars${images.length > 0 ? ` and ${images.length} image(s)` : ''} to Session ${sessionId}`)
  }

  /** The owner's chat Session: the stored one while it resolves, otherwise a new one. */
  private async chatSession(domain: Domain<typeof wechatDomain>, account: WechatAccount): Promise<SessionId> {
    const stored = domain.table('chats').get(account.ownerUserId)
    if (stored !== undefined) {
      const sessionId = stored.sessionId as SessionId
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      if ('agent' in resolved) return sessionId
      if (TRANSIENT_RESOLVE_CODES.has(resolved.error.code)) throw resolved.error
      this.ctx.logger.info(`lsy-wechat: chat Session ${sessionId} is unavailable (${resolved.error.code}); starting a new one`)
    }
    return this.createChatSession(domain, account)
  }

  /** Create, resolve, configure, and remember a new chat Session. */
  private async createChatSession(domain: Domain<typeof wechatDomain>, account: WechatAccount): Promise<SessionId> {
    const chat = this.config.chat
    // Fails on an unknown preset before a Session exists.
    this.ctx.permissionPresets.resolve(chat.permissionPreset)
    const created = await this.ctx.sessionController.create({ cwd: chat.workspacePath, agentPreset: chat.agentPreset })
    const resolved = await this.ctx.sessionController.resolveAgent(created.sessionId)
    if ('error' in resolved) throw resolved.error
    this.ctx.permissionPresets.set(resolved.agent.session, chat.permissionPreset)
    this.ctx.sessionTitle.rename(resolved.agent.session, chat.title)
    const now = Date.now()
    await this.serialize(async () => {
      const sessions = domain.table('sessions')
      await sessions.put(created.sessionId, { ownerUserId: account.ownerUserId, createdAt: now })
      await domain.table('chats').put(account.ownerUserId, { sessionId: created.sessionId, createdAt: now })
      const excess = [...sessions.entries()]
        .sort(([, a], [, b]) => a.createdAt - b.createdAt)
        .slice(0, Math.max(0, sessions.size - MAX_REMEMBERED_SESSIONS))
      for (const [id] of excess) await sessions.delete(id)
    })
    this.ctx.logger.info(`lsy-wechat: created chat Session ${created.sessionId} in ${chat.workspacePath} (${chat.agentPreset}, ${chat.permissionPreset})`)
    return created.sessionId
  }

  /** Remember each owned Session's latest assistant text and relay it when the turn ends. */
  private observeSession(session: Session, event: SessionEvent): void {
    if (!this.ownsSession(session.id)) return
    if (event.type === 'assistant/message') {
      const text = contentText(event.data.message.content)
      if (text !== undefined) this.replies.set(session.id, text)
      return
    }
    if (event.type !== 'turn/end') return
    const text = this.replies.get(session.id)
    this.replies.delete(session.id)
    const outcome = event.data.reason.kind
    const detail = failureDetail(event.data.reason)
    const reply = relayText(text, outcome, detail)
    const ended = detail === undefined ? outcome : `${outcome}: ${detail}`
    this.ctx.logger.info(`lsy-wechat: Session ${session.id} ended a turn (${ended}); ${reply === undefined ? 'nothing to relay' : `relaying ${reply.length} chars`}`)
    if (reply !== undefined) this.track(this.deliver(reply))
  }

  /** Split one text into messages and send or queue each in order. */
  private deliver(text: string): Promise<void> {
    return this.serialize(async () => {
      const domain = await this.ready
      const chars = this.config.maxMessageChars - Array.from(QUOTA_FOOTER).length
      const bytes = WECHAT_MAX_TEXT_BYTES - Buffer.byteLength(QUOTA_FOOTER, 'utf8')
      for (const part of splitText(text, chars, this.config.maxReplyParts, bytes)) await this.deliverPart(domain, part)
    })
  }

  /** Send one message through the open window, or queue it with the reason it cannot go now. */
  private async deliverPart(domain: Domain<typeof wechatDomain>, text: string): Promise<void> {
    const target = this.target(domain)
    if (typeof target === 'string') {
      await this.enqueue(domain, text, target)
      return
    }
    const last = target.window.used + 1 >= this.config.repliesPerToken
    const outcome = await this.transmit(domain, target, last ? `${text}${QUOTA_FOOTER}` : text)
    if (outcome !== 'sent') await this.enqueue(domain, text, outcome)
  }

  /** The open reply window, or why there is none. */
  private target(domain: Domain<typeof wechatDomain>): Target | string {
    const account = this.account
    if (account === undefined) return 'no bound account'
    if (account.botToken === this.staleToken) return 'bot token is stale'
    const key = `${account.botId}/${account.ownerUserId}`
    const window = domain.table('windows').get(key)
    if (window === undefined) return 'the owner has not written yet'
    if (Date.now() - window.receivedAt > this.config.contextTtlMs) return 'reply window expired'
    if (window.exhausted || window.used >= this.config.repliesPerToken) return 'reply quota used up'
    return { account, key, window }
  }

  /** Send one text message and count it against the window; a failure returns why it was not sent. */
  private transmit(domain: Domain<typeof wechatDomain>, target: Target, text: string): Promise<string> {
    return this.transmitItem(domain, target, { type: ItemType.TEXT, text_item: { text } }, `${text.length} chars`)
  }

  /** Send one message item and count it against the window; a failure returns why it was not sent. */
  private async transmitItem(
    domain: Domain<typeof wechatDomain>, target: Target, item: Record<string, unknown>, label: string,
  ): Promise<string> {
    const { baseUrl, botToken: token } = target.account
    const client = new IlinkClient({ baseUrl, token, timeoutMs: this.config.requestTimeoutMs })
    try {
      await client.sendItem(target.account.ownerUserId, item, target.window.token, this.abort.signal)
    } catch (error: unknown) {
      if (error instanceof IlinkApiError && error.ret === ILINK_SEND_REJECTED) {
        await domain.table('windows').put(target.key, { ...target.window, exhausted: true })
        this.ctx.logger.info('lsy-wechat: WeChat rejected a send (ret -2); the reply window stays closed until the owner writes again')
        return 'rejected by WeChat (ret -2)'
      }
      if (isStaleTokenError(error)) {
        this.markStale(target.account)
        return 'bot token is stale'
      }
      this.ctx.logger.warn(`lsy-wechat: send failed: ${errorText(error)}`)
      return 'send failed'
    }
    const used = target.window.used + 1
    await domain.table('windows').put(target.key, { ...target.window, used })
    this.ctx.logger.info(`lsy-wechat: sent ${label} (${used}/${this.config.repliesPerToken} of this window)`)
    return 'sent'
  }

  /** Queue one text; a full outbox drops its oldest texts. */
  private async enqueue(domain: Domain<typeof wechatDomain>, text: string, reason: string): Promise<void> {
    const outbox = domain.table('outbox')
    const rows = this.outbox()
    const victims = rows.slice(0, Math.max(0, rows.length - this.config.outboxLimit + 1))
    for (const row of victims) await outbox.delete(outboxKey(row.seq))
    if (victims.length > 0) this.ctx.logger.warn(`lsy-wechat: outbox full; dropped the ${victims.length} oldest text(s)`)
    const seq = (rows.at(-1)?.seq ?? 0) + 1
    await outbox.put(outboxKey(seq), { seq, text, queuedAt: Date.now() })
    this.ctx.logger.info(`lsy-wechat: queued ${text.length} chars (${reason}); ${outbox.size} waiting`)
  }

  /** Send queued texts as digests while the window has more than one slot left; the last slot stays for the reply. */
  private async flushOutbox(domain: Domain<typeof wechatDomain>): Promise<void> {
    let rows = this.outbox()
    while (rows.length > 0) {
      const target = this.target(domain)
      if (typeof target === 'string' || target.window.used + 1 >= this.config.repliesPerToken) return
      const digest = buildDigest(rows, this.config.maxMessageChars, this.config.chat.timeZone)
      if (await this.transmit(domain, target, digest.text) !== 'sent') return
      for (const row of rows.slice(0, digest.count)) await domain.table('outbox').delete(outboxKey(row.seq))
      this.ctx.logger.info(`lsy-wechat: delivered ${digest.count} queued text(s) as one digest`)
      rows = rows.slice(digest.count)
    }
  }
}

export default WechatChannel
