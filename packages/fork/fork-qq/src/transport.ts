/**
 * The seam between the channel and the QQ Open Platform. The channel talks only to {@link QqTransport};
 * the default implementation wraps Tencent's official Node.js SDK (`@tencent-connect/qqbot-nodejs`), which
 * holds the app token, the gateway WebSocket (heartbeat, resume, reconnect), and the message API with its
 * `msg_seq` bookkeeping. The connection is outbound only: the channel opens no listening port.
 */

/** One text message QQ delivered to the bot, normalized across the two scopes the channel serves. */
export interface QqInbound {
  /** `c2c` is a private chat with one user; `group` is a group message that @-mentions the bot. */
  scope: 'c2c' | 'group'
  /** The sender's openid: `user_openid` in a private chat, `member_openid` in a group. Not a QQ number. */
  senderId: string
  /** `group_openid`, present when `scope` is `group`. */
  groupId?: string | undefined
  /** QQ's id of this message; replies quote it. */
  messageId: string
  /** The text, trimmed. */
  text: string
  /** When QQ stamped the message, in Unix epoch milliseconds (arrival time when QQ's stamp is unreadable). */
  at: number
  /** Attachments the message carried; the channel does not download them. */
  attachments: number
}

/** Where a reply goes. */
export interface QqTarget {
  scope: 'c2c' | 'group'
  /** `user_openid` or `group_openid`. */
  id: string
  /** The inbound message this answers; omitted for a proactive message. */
  msgId?: string | undefined
}

/** What the transport reports while it runs. */
export interface QqHandlers {
  message(message: QqInbound): void
  /** The gateway accepted the bot (a new session or a resume). */
  ready(): void
  disconnected(reason: string): void
}

/** A connection to QQ. */
export interface QqTransport {
  /**
   * Connect and deliver events until `signal` aborts.
   * @returns when stopped; rejects when the connection cannot be kept (bad credentials, fatal close).
   */
  run(handlers: QqHandlers, signal: AbortSignal): Promise<void>
  /**
   * Send one text message.
   * @throws when QQ refuses it (expired reply window, quota, content rules) or the request fails.
   */
  send(target: QqTarget, text: string): Promise<void>
}

/** The fields of the SDK's inbound message this module reads. */
interface SdkInbound {
  kind?: string
  senderId?: string
  groupOpenid?: string
  messageId?: string
  content?: string
  timestamp?: string
  attachments?: unknown[]
}

/**
 * Normalize the SDK's inbound message. Guild and guild-DM messages (the SDK's default intents include
 * them) and malformed events yield `undefined`: the channel serves private chats and group @ mentions only.
 */
export function toInbound(message: unknown, now: number = Date.now()): QqInbound | undefined {
  const m = message as SdkInbound | null
  if (m === null || typeof m !== 'object') return undefined
  if (m.kind !== 'c2c' && m.kind !== 'group') return undefined
  if (typeof m.senderId !== 'string' || m.senderId === '' || typeof m.messageId !== 'string' || m.messageId === '') return undefined
  if (m.kind === 'group' && (typeof m.groupOpenid !== 'string' || m.groupOpenid === '')) return undefined
  const stamp = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : Number.NaN
  return {
    scope: m.kind,
    senderId: m.senderId,
    ...(m.kind === 'group' ? { groupId: m.groupOpenid } : {}),
    messageId: m.messageId,
    text: typeof m.content === 'string' ? m.content.trim() : '',
    at: Number.isFinite(stamp) ? stamp : now,
    attachments: Array.isArray(m.attachments) ? m.attachments.length : 0,
  }
}

/** Log sink for the SDK; the channel maps these onto its own logger. */
export interface SdkLog {
  debug(message: string): void
  warn(message: string): void
}

/** What the default transport needs. */
export interface SdkTransportOptions {
  appId: string
  appSecret: string
  log: SdkLog
  /** Open Platform API base URL; tests point it at a local double. */
  baseUrl?: string
  /** Token endpoint base URL; tests point it at a local double. */
  tokenBaseUrl?: string
}

/**
 * Gateway intents the channel asks for: group and private messages only. The SDK's default adds guild
 * intents a personal bot may not hold, and QQ closes the connection with 4914/4915 when asked for one it lacks.
 */
export const GROUP_AND_C2C_INTENT = 1 << 25

/** Strip the app secret and anything shaped like a bearer token from SDK log text. */
export function scrub(text: string, secret: string): string {
  const withoutSecret = secret === '' ? text : text.split(secret).join('***')
  return withoutSecret.replace(/(QQBot\s+|access_token["':=\s]+)[A-Za-z0-9._~+/=-]{12,}/g, '$1***')
}

/**
 * The default transport, over Tencent's official SDK. The SDK loads on first use, so a build that never
 * configures QQ never touches it.
 */
export function createSdkTransport(options: SdkTransportOptions): QqTransport {
  type Bot = InstanceType<typeof import('@tencent-connect/qqbot-nodejs').QQBot>
  let bot: Bot | undefined
  const line = (text: unknown): string => scrub(typeof text === 'string' ? text : String(text), options.appSecret)
  const load = async (): Promise<Bot> => {
    if (bot !== undefined) return bot
    const { QQBot } = await import('@tencent-connect/qqbot-nodejs')
    // The SDK logs gateway chatter at info; the channel keeps it at debug so the service log stays readable.
    bot = new QQBot({
      appId: options.appId,
      appSecret: options.appSecret,
      intents: GROUP_AND_C2C_INTENT,
      ...options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl },
      ...options.tokenBaseUrl === undefined ? {} : { tokenBaseUrl: options.tokenBaseUrl },
      logger: {
        info: (text) => { options.log.debug(line(text)) },
        debug: (text) => { options.log.debug(line(text)) },
        warn: (text) => { options.log.warn(line(text)) },
        error: (text) => { options.log.warn(line(text)) },
      },
    })
    return bot
  }
  return {
    async run(handlers, signal) {
      const client = await load()
      client.on('message', (_ctx, message) => {
        const inbound = toInbound(message)
        if (inbound !== undefined) handlers.message(inbound)
      })
      client.on('ready', () => { handlers.ready() })
      client.on('resumed', () => { handlers.ready() })
      client.on('disconnected', (event) => { handlers.disconnected(line(JSON.stringify(event))) })
      client.on('error', (error) => { options.log.warn(`sdk error: ${line(error.message)}`) })
      try {
        await client.start(signal)
      } catch (error: unknown) {
        throw new Error(line(error instanceof Error ? error.message : String(error)), { cause: error })
      }
    },
    async send(target, text) {
      const client = await load()
      const replyTarget = { scope: target.scope, targetId: target.id, ...target.msgId === undefined ? {} : { msgId: target.msgId } }
      await client.sendText(replyTarget, text)
    },
  }
}
