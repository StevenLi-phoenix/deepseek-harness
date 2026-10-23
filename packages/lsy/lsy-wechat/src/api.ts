/** Minimal iLink bot HTTP client: QR login, long-poll updates, and text sends. */
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'

/** API origin of every login; a bound account then uses the `baseurl` the login returned. */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** Channel version reported in `base_info` and encoded into `iLink-App-ClientVersion`. */
export const ILINK_CHANNEL_VERSION = '0.2.1'
/** Self-declared client identity in `base_info`, like an HTTP User-Agent. */
export const ILINK_BOT_AGENT = `dsh-lsy-wechat/${ILINK_CHANNEL_VERSION}`
/** `ret` or `errcode` of a bot token the server no longer accepts; only a new login helps. */
export const ILINK_STALE_TOKEN = -14
/** `ret` of a rejected send: expired context token, used-up reply quota, or text too long. */
export const ILINK_SEND_REJECTED = -2
/** `message_type` of a message a WeChat user wrote. */
export const MESSAGE_TYPE_USER = 1
/** `message_type` of a message a bot sent. */
export const MESSAGE_TYPE_BOT = 2

/** `type` values of message items. */
export const ItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

/** Deadline of ordinary requests when the caller sets none. */
const DEFAULT_TIMEOUT_MS = 15_000
/** `bot_type` this channel logs in as. */
const BOT_TYPE = '3'

/** Encrypted CDN reference of one media item (see media.ts). */
const cdnMediaSchema = z.object({
  encrypt_query_param: z.string().nullish(),
  /** base64 of the raw key (images) or of its hex spelling (files, voice, video). */
  aes_key: z.string().nullish(),
  /** Complete download URL, when the server provides one. */
  full_url: z.string().nullish(),
})

const itemSchema = z.object({
  type: z.number().nullish(),
  text_item: z.object({ text: z.string().nullish() }).nullish(),
  voice_item: z.object({ text: z.string().nullish() }).nullish(),
  /** `aeskey` is the image key as 32 hex characters, preferred over `media.aes_key`. */
  image_item: z.object({ media: cdnMediaSchema.nullish(), aeskey: z.string().nullish() }).nullish(),
  file_item: z.object({ file_name: z.string().nullish(), media: cdnMediaSchema.nullish() }).nullish(),
  video_item: z.object({ media: cdnMediaSchema.nullish() }).nullish(),
})

const messageItemSchema = itemSchema.extend({
  /** Quoted message: a summary `title` and/or the quoted item itself. */
  ref_msg: z.object({ title: z.string().nullish(), message_item: itemSchema.nullish() }).nullish(),
})

// uint64 ids (message_id, msg_id, ...) are not declared, so precision lost by JSON.parse never matters.
const messageSchema = z.object({
  from_user_id: z.string().nullish(),
  message_type: z.number().nullish(),
  context_token: z.string().nullish(),
  item_list: z.array(messageItemSchema).nullish(),
})

const updatesSchema = z.object({
  ret: z.number().nullish(),
  errcode: z.number().nullish(),
  errmsg: z.string().nullish(),
  msgs: z.array(z.unknown()).nullish(),
  get_updates_buf: z.string().nullish(),
  longpolling_timeout_ms: z.number().nullish(),
})

const qrcodeSchema = z.object({
  ret: z.number().nullish(),
  errmsg: z.string().nullish(),
  qrcode: z.string().nullish(),
  qrcode_img_content: z.string().nullish(),
})

const qrStatusSchema = z.object({
  status: z.string(),
  bot_token: z.string().nullish(),
  ilink_bot_id: z.string().nullish(),
  baseurl: z.string().nullish(),
  ilink_user_id: z.string().nullish(),
  redirect_host: z.string().nullish(),
})

const uploadUrlSchema = z.object({
  ret: z.number().nullish(),
  errmsg: z.string().nullish(),
  /** CDN upload parameter; the URL is `<cdn>/upload?encrypted_query_param=…&filekey=…`. */
  upload_param: z.string().nullish(),
  /** Complete upload URL, preferred when present. */
  upload_full_url: z.string().nullish(),
})

const sendReplySchema = z.object({
  ret: z.number().nullish(),
  errmsg: z.string().nullish(),
})

const configSchema = z.object({
  ret: z.number().nullish(),
  errmsg: z.string().nullish(),
  /** Opaque ticket `ilink/bot/sendtyping` requires for this user. */
  typing_ticket: z.string().nullish(),
})

/** `status` of `ilink/bot/sendtyping`. */
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const
/** One of {@link TypingStatus}. */
export type TypingStatusValue = (typeof TypingStatus)[keyof typeof TypingStatus]

/** One message item as received; every field is optional on the wire. */
export type WeixinItem = z.infer<typeof itemSchema>
/** Encrypted CDN reference of one media item. */
export type CdnMediaRef = z.infer<typeof cdnMediaSchema>

/** `media_type` of an upload. */
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3 } as const

/** Body of `ilink/bot/getuploadurl`, minus the fields the client adds. */
export interface UploadUrlRequest {
  /** Random 32-hex-character key naming the upload. */
  filekey: string
  media_type: (typeof UploadMediaType)[keyof typeof UploadMediaType]
  to_user_id: string
  /** Plaintext size in bytes. */
  rawsize: number
  /** Plaintext MD5, hex. */
  rawfilemd5: string
  /** Ciphertext size in bytes (AES-128-ECB with PKCS#7 padding). */
  filesize: number
  /** AES-128 key, 32 hex characters. */
  aeskey: string
}
/** One message item with its optional quote. */
export type WeixinMessageItem = z.infer<typeof messageItemSchema>
/** One inbound message as received. */
export type WeixinMessage = z.infer<typeof messageSchema>

/** A fresh login QR code. */
export interface BotQrcode {
  /** Opaque handle polled with {@link IlinkClient.getQrcodeStatus}. */
  qrcode: string
  /** URL the QR code shown to the user encodes. */
  url: string
}

/** One answer of the QR status long-poll; credential fields are set once `status` is `confirmed`. */
export interface QrStatus {
  /** `wait`, `scaned`, `scaned_but_redirect`, `need_verifycode`, `verify_code_blocked`, `expired`, `binded_redirect`, or `confirmed`. */
  status: string
  botToken: string | undefined
  botId: string | undefined
  baseUrl: string | undefined
  /** WeChat user who scanned the code: the owner of the bound bot. */
  ownerUserId: string | undefined
  /** Host to poll instead, for `scaned_but_redirect`. */
  redirectHost: string | undefined
}

/** One long-poll answer. */
export interface UpdatesResult {
  /** Well-formed messages, in server order. */
  messages: WeixinMessage[]
  /** Messages dropped because their shape was unexpected. */
  malformed: number
  /** Cursor to persist and send next time; undefined when the server sent none. */
  buf: string | undefined
  /** Server-suggested deadline of the next long-poll. */
  nextTimeoutMs: number | undefined
  /** True when the client deadline expired first; a normal empty answer. */
  timedOut: boolean
}

/** Transport-level failure: network error, HTTP status, or a body that is not the expected JSON. */
export class IlinkError extends Error {
  /** @param message - diagnostic; never contains the bot token. */
  constructor(message: string) {
    super(message)
    this.name = 'IlinkError'
  }
}

/** The server answered with a non-zero `ret` or `errcode`. */
export class IlinkApiError extends IlinkError {
  /**
   * @param endpoint - API path, e.g. `ilink/bot/sendmessage`.
   * @param ret - `ret` field, 0 when absent.
   * @param errcode - `errcode` field, 0 when absent.
   * @param errmsg - server text, when present.
   */
  constructor(readonly endpoint: string, readonly ret: number, readonly errcode: number, errmsg: string | undefined) {
    super(`iLink ${endpoint} failed: ret ${ret}, errcode ${errcode}${errmsg ? ` (${errmsg})` : ''}`)
    this.name = 'IlinkApiError'
  }

  /** Whether the bot token is no longer accepted and a new login is needed. */
  get stale(): boolean {
    return this.ret === ILINK_STALE_TOKEN || this.errcode === ILINK_STALE_TOKEN
  }
}

/**
 * Whether an error says the bot token is stale.
 * @param error - caught value.
 * @returns true for an {@link IlinkApiError} carrying `-14`.
 */
export function isStaleTokenError(error: unknown): boolean {
  return error instanceof IlinkApiError && error.stale
}

/**
 * Encode `major.minor.patch` as the uint32 `0x00MMNNPP` iLink expects.
 * @param version - semver-like version; a pre-release suffix is ignored.
 * @returns the encoded number.
 */
export function clientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(part => Number.parseInt(part, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

/** `X-WECHAT-UIN`: base64 of the decimal text of a random uint32. */
function randomUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Request body metadata the server uses for observability. */
function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: ILINK_CHANNEL_VERSION, bot_agent: ILINK_BOT_AGENT }
}

/** `undefined` for null, absent, or empty strings. */
function present(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value
}

/** Marks a request whose client deadline expired before an answer arrived. */
const TIMED_OUT: unique symbol = Symbol('timed out')

/** One request of {@link IlinkClient}. */
interface CallSpec {
  method: 'GET' | 'POST'
  /** Path relative to the base URL, without query. */
  path: string
  query?: Record<string, string>
  body?: unknown
  timeoutMs: number
  signal: AbortSignal | undefined
}

/** Client construction options. */
export interface IlinkClientOptions {
  /** API origin; the account's `baseUrl` after login. Defaults to {@link ILINK_BASE_URL}. */
  baseUrl?: string
  /** Bot token; omitted for the login endpoints. */
  token?: string
  /** `fetch` replacement; defaults to the global `fetch` at call time. */
  fetch?: typeof fetch
  /** Deadline of ordinary requests in milliseconds. */
  timeoutMs?: number
}

/**
 * Minimal iLink bot client. Every request has its own deadline and honors an
 * optional external AbortSignal; error messages never contain the bot token.
 */
export class IlinkClient {
  /** API origin requests go to. */
  readonly baseUrl: string
  private readonly token: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  /** @param options - origin, token, fetch, and default deadline. */
  constructor(options: IlinkClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ILINK_BASE_URL
    this.token = options.token
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Request a new login QR code.
   * @param signal - external cancellation.
   * @returns the handle to poll and the URL to render as a QR code.
   * @throws {IlinkError} on transport failures, a non-zero `ret`, or a timeout.
   */
  async getBotQrcode(signal?: AbortSignal): Promise<BotQrcode> {
    const path = 'ilink/bot/get_bot_qrcode'
    const raw = await this.call({ method: 'POST', path, query: { bot_type: BOT_TYPE }, body: { local_token_list: [] }, timeoutMs: this.timeoutMs, signal })
    if (raw === TIMED_OUT) throw new IlinkError(`iLink ${path}: timed out after ${this.timeoutMs}ms`)
    const reply = parseBody(path, qrcodeSchema, raw)
    const ret = reply.ret ?? 0
    if (ret !== 0) throw new IlinkApiError(path, ret, 0, present(reply.errmsg))
    const qrcode = present(reply.qrcode)
    const url = present(reply.qrcode_img_content)
    if (qrcode === undefined || url === undefined) throw new IlinkError(`iLink ${path}: no QR code in the answer`)
    return { qrcode, url }
  }

  /**
   * Long-poll the state of a login QR code.
   * @param qrcode - handle from {@link getBotQrcode}.
   * @param verifyCode - number the user read from WeChat, when the server asked for one.
   * @param timeoutMs - client deadline; expiry reads as `wait`.
   * @param signal - external cancellation.
   * @returns the current status.
   * @throws {IlinkError} on transport failures.
   */
  async getQrcodeStatus(qrcode: string, verifyCode: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<QrStatus> {
    const path = 'ilink/bot/get_qrcode_status'
    const query: Record<string, string> = verifyCode === undefined ? { qrcode } : { qrcode, verify_code: verifyCode }
    const raw = await this.call({ method: 'GET', path, query, timeoutMs, signal })
    if (raw === TIMED_OUT) {
      return { status: 'wait', botToken: undefined, botId: undefined, baseUrl: undefined, ownerUserId: undefined, redirectHost: undefined }
    }
    const reply = parseBody(path, qrStatusSchema, raw)
    return {
      status: reply.status,
      botToken: present(reply.bot_token),
      botId: present(reply.ilink_bot_id),
      baseUrl: present(reply.baseurl),
      ownerUserId: present(reply.ilink_user_id),
      redirectHost: present(reply.redirect_host),
    }
  }

  /**
   * Long-poll new messages.
   * @param buf - cursor from the previous answer; empty on the first call.
   * @param timeoutMs - client deadline; expiry reads as an empty answer.
   * @param signal - external cancellation; aborting rejects with its reason.
   * @returns messages and the next cursor.
   * @throws {IlinkApiError} on a non-zero `ret`/`errcode` (see {@link IlinkApiError.stale}).
   * @throws {IlinkError} on transport failures.
   */
  async getUpdates(buf: string, timeoutMs: number, signal?: AbortSignal): Promise<UpdatesResult> {
    const path = 'ilink/bot/getupdates'
    const raw = await this.call({ method: 'POST', path, body: { get_updates_buf: buf, base_info: baseInfo() }, timeoutMs, signal })
    if (raw === TIMED_OUT) return { messages: [], malformed: 0, buf: undefined, nextTimeoutMs: undefined, timedOut: true }
    const reply = parseBody(path, updatesSchema, raw)
    const ret = reply.ret ?? 0
    const errcode = reply.errcode ?? 0
    if (ret !== 0 || errcode !== 0) throw new IlinkApiError(path, ret, errcode, present(reply.errmsg))
    const messages: WeixinMessage[] = []
    let malformed = 0
    for (const candidate of reply.msgs ?? []) {
      const parsed = messageSchema.safeParse(candidate)
      if (parsed.success) messages.push(parsed.data)
      else malformed += 1
    }
    const next = reply.longpolling_timeout_ms
    return {
      messages,
      malformed,
      buf: present(reply.get_updates_buf),
      nextTimeoutMs: typeof next === 'number' && next > 0 ? next : undefined,
      timedOut: false,
    }
  }

  /**
   * Send one text message.
   * @param to - recipient user id.
   * @param text - plain text; the caller keeps it within the size limits.
   * @param contextToken - `context_token` of a recent message from that user.
   * @param signal - external cancellation.
   * @throws {IlinkApiError} on a non-zero `ret` (`-2` rejected, `-14` stale token).
   * @throws {IlinkError} on transport failures or a timeout.
   */
  sendText(to: string, text: string, contextToken: string, signal?: AbortSignal): Promise<void> {
    return this.sendItem(to, { type: ItemType.TEXT, text_item: { text } }, contextToken, signal)
  }

  /**
   * Ask where to upload one encrypted attachment for a recipient.
   * @param request - file key, media type, recipient, plaintext size and MD5, ciphertext size, and the hex AES key.
   * @param signal - external cancellation.
   * @returns the complete upload URL or the upload parameter, whichever the server gave.
   * @throws {IlinkApiError} on a non-zero `ret`.
   * @throws {IlinkError} on transport failures, a timeout, or an answer with neither.
   */
  async getUploadUrl(request: UploadUrlRequest, signal?: AbortSignal): Promise<{ uploadFullUrl?: string; uploadParam?: string }> {
    const path = 'ilink/bot/getuploadurl'
    const raw = await this.call({ method: 'POST', path, body: { ...request, no_need_thumb: true, base_info: baseInfo() }, timeoutMs: this.timeoutMs, signal })
    if (raw === TIMED_OUT) throw new IlinkError(`iLink ${path}: timed out after ${this.timeoutMs}ms`)
    const reply = parseBody(path, uploadUrlSchema, raw)
    const ret = reply.ret ?? 0
    if (ret !== 0) throw new IlinkApiError(path, ret, 0, present(reply.errmsg))
    const uploadFullUrl = present(reply.upload_full_url?.trim())
    const uploadParam = present(reply.upload_param)
    if (uploadFullUrl === undefined && uploadParam === undefined) throw new IlinkError(`iLink ${path}: no upload URL in the answer`)
    return { ...uploadFullUrl === undefined ? {} : { uploadFullUrl }, ...uploadParam === undefined ? {} : { uploadParam } }
  }

  /**
   * Send one finished message holding a single item: text, or an uploaded image, video, or file.
   * @param to - recipient user id.
   * @param item - the message item.
   * @param contextToken - `context_token` of a recent message from that user.
   * @param signal - external cancellation.
   * @throws {IlinkApiError} on a non-zero `ret` (`-2` rejected, `-14` stale token).
   * @throws {IlinkError} on transport failures or a timeout.
   */
  async sendItem(to: string, item: Record<string, unknown>, contextToken: string, signal?: AbortSignal): Promise<void> {
    const path = 'ilink/bot/sendmessage'
    const msg = {
      from_user_id: '',
      to_user_id: to,
      client_id: `dsh-lsy-wechat-${randomUUID()}`,
      message_type: MESSAGE_TYPE_BOT,
      message_state: 2,
      item_list: [item],
      context_token: contextToken,
    }
    const raw = await this.call({ method: 'POST', path, body: { msg, base_info: baseInfo() }, timeoutMs: this.timeoutMs, signal })
    if (raw === TIMED_OUT) throw new IlinkError(`iLink ${path}: timed out after ${this.timeoutMs}ms`)
    const reply = parseBody(path, sendReplySchema, raw)
    const ret = reply.ret ?? 0
    if (ret !== 0) throw new IlinkApiError(path, ret, 0, present(reply.errmsg))
  }

  /**
   * Read the bot's per-user configuration; today only the typing ticket.
   * @param userId - the user the bot talks to.
   * @param contextToken - `context_token` of a recent message from that user, when there is one.
   * @param signal - external cancellation.
   * @returns the typing ticket, absent when the server gave none.
   * @throws {IlinkApiError} on a non-zero `ret`.
   * @throws {IlinkError} on transport failures or a timeout.
   */
  async getConfig(userId: string, contextToken: string | undefined, signal?: AbortSignal): Promise<{ typingTicket?: string }> {
    const path = 'ilink/bot/getconfig'
    const body = { ilink_user_id: userId, ...contextToken === undefined ? {} : { context_token: contextToken }, base_info: baseInfo() }
    const reply = parseBody(path, configSchema, await this.post(path, body, signal))
    const ret = reply.ret ?? 0
    if (ret !== 0) throw new IlinkApiError(path, ret, 0, present(reply.errmsg))
    const typingTicket = present(reply.typing_ticket)
    return typingTicket === undefined ? {} : { typingTicket }
  }

  /**
   * Show or clear the "typing" line in the user's chat. The server drops it after a few
   * seconds, so a long task sends {@link TypingStatus.TYPING} again periodically.
   * @param userId - the user the bot talks to.
   * @param typingTicket - ticket from {@link getConfig}.
   * @param status - typing or cancel.
   * @param signal - external cancellation.
   * @throws {IlinkApiError} on a non-zero `ret`.
   * @throws {IlinkError} on transport failures or a timeout.
   */
  async sendTyping(userId: string, typingTicket: string, status: TypingStatusValue, signal?: AbortSignal): Promise<void> {
    await this.expectOk('ilink/bot/sendtyping', { ilink_user_id: userId, typing_ticket: typingTicket, status, base_info: baseInfo() }, signal)
  }

  /**
   * Tell the server the channel client started, so it can reconcile the bot's online state.
   * @param signal - external cancellation.
   * @throws {IlinkError} on any failure.
   */
  async notifyStart(signal?: AbortSignal): Promise<void> {
    await this.expectOk('ilink/bot/msg/notifystart', { base_info: baseInfo() }, signal)
  }

  /**
   * Tell the server the channel client is stopping.
   * @param signal - external cancellation.
   * @throws {IlinkError} on any failure.
   */
  async notifyStop(signal?: AbortSignal): Promise<void> {
    await this.expectOk('ilink/bot/msg/notifystop', { base_info: baseInfo() }, signal)
  }

  /** POST one body with the ordinary deadline; a timeout becomes an {@link IlinkError}. */
  private async post(path: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const raw = await this.call({ method: 'POST', path, body, timeoutMs: this.timeoutMs, signal })
    if (raw === TIMED_OUT) throw new IlinkError(`iLink ${path}: timed out after ${this.timeoutMs}ms`)
    return raw
  }

  /** POST one body whose answer carries only `ret` and `errmsg`. */
  private async expectOk(path: string, body: unknown, signal: AbortSignal | undefined): Promise<void> {
    const reply = parseBody(path, sendReplySchema, await this.post(path, body, signal))
    const ret = reply.ret ?? 0
    if (ret !== 0) throw new IlinkApiError(path, ret, 0, present(reply.errmsg))
  }

  /** Perform one request; resolves to {@link TIMED_OUT} when the client deadline expires first. */
  private async call(spec: CallSpec): Promise<unknown> {
    const url = new URL(spec.path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value)
    const common = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(clientVersion(ILINK_CHANNEL_VERSION)),
    }
    // The QR status GET carries only the app identity, like the reference client.
    const post = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': randomUin(),
      ...common,
      ...(this.token === undefined ? {} : { Authorization: `Bearer ${this.token}` }),
    }
    const headers: Record<string, string> = spec.method === 'GET' ? common : post
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new IlinkError(`iLink ${spec.path}: timed out`)) }, spec.timeoutMs)
    const signal = spec.signal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, spec.signal])
    let status: number
    let text: string
    try {
      const response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        redirect: 'error',
        signal,
      })
      status = response.status
      text = await response.text()
    } catch (error: unknown) {
      spec.signal?.throwIfAborted()
      if (deadline.signal.aborted) return TIMED_OUT
      throw new IlinkError(`iLink ${spec.path}: request failed: ${errorText(error)}`)
    } finally {
      clearTimeout(timer)
    }
    if (status < 200 || status > 299) throw new IlinkError(`iLink ${spec.path}: HTTP ${status}`)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new IlinkError(`iLink ${spec.path}: response is not JSON`)
    }
  }
}

/** Validate one response body against its schema. */
function parseBody<T>(path: string, schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new IlinkError(`iLink ${path}: unexpected response shape`)
  return parsed.data
}
