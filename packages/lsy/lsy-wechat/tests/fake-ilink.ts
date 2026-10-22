/** In-memory iLink double: QR login, long-poll updates, and sends, behind a `fetch` replacement. */

/** iLink endpoints the client calls. */
export type Endpoint = 'ilink/bot/get_bot_qrcode' | 'ilink/bot/get_qrcode_status' | 'ilink/bot/getupdates' | 'ilink/bot/sendmessage' | 'cdn/download'

/** One canned answer: a JSON body, a raw body, a status, or a thrown network error. */
export type Reply = { status?: number; body?: unknown; raw?: string } | Error

/** One request the double received. */
export interface RecordedRequest {
  method: string
  origin: string
  endpoint: string
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

/** One accepted text send. */
export interface SentText {
  to: string
  text: string
  contextToken: string
}

/** Long-polling endpoints hold the request until an answer is queued or the client aborts. */
const LONG_POLL: ReadonlySet<Endpoint> = new Set(['ilink/bot/get_qrcode_status', 'ilink/bot/getupdates'])

/** Serves `fetch` calls for any origin; each endpoint answers from its own queue. */
export class FakeIlink {
  readonly requests: RecordedRequest[] = []
  readonly sent: SentText[] = []
  /** CDN downloads by `encrypted_query_param`: encrypted bytes, or an HTTP status to fail with. */
  readonly cdn = new Map<string, Uint8Array | number>()
  private readonly queues = new Map<Endpoint, Reply[]>()
  private readonly waiters = new Map<Endpoint, Array<(reply: Reply) => void>>()
  private qrCount = 0
  private bufCount = 0

  /**
   * Queue answers for one endpoint; a request already waiting on it receives the first at once.
   * @param endpoint - endpoint path.
   * @param replies - answers in order.
   */
  reply(endpoint: Endpoint, ...replies: Reply[]): void {
    for (const reply of replies) {
      const waiter = this.waiters.get(endpoint)?.shift()
      if (waiter === undefined) {
        const queue = this.queues.get(endpoint) ?? []
        queue.push(reply)
        this.queues.set(endpoint, queue)
      } else {
        waiter(reply)
      }
    }
  }

  /**
   * Queue one successful getupdates answer.
   * @param msgs - raw messages.
   * @param extra - extra response fields.
   */
  updates(msgs: unknown[], extra: Record<string, unknown> = {}): void {
    this.bufCount += 1
    this.reply('ilink/bot/getupdates', { body: { ret: 0, msgs, get_updates_buf: `buf-${this.bufCount}`, ...extra } })
  }

  /**
   * Queue QR status answers.
   * @param bodies - status bodies in order.
   */
  statuses(...bodies: Array<Record<string, unknown>>): void {
    this.reply('ilink/bot/get_qrcode_status', ...bodies.map(body => ({ body })))
  }

  /** Requests made to one endpoint, oldest first. */
  requestsTo(endpoint: Endpoint): RecordedRequest[] {
    return this.requests.filter(request => request.endpoint === endpoint)
  }

  /** Long-polls currently held open. */
  waiting(endpoint: Endpoint): number {
    return this.waiters.get(endpoint)?.length ?? 0
  }

  /** `fetch` replacement bound to this double. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith('/download')) {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      this.requests.push({ method: init?.method ?? 'GET', origin: url.origin, endpoint: 'cdn/download', query: Object.fromEntries(url.searchParams), headers, body: undefined })
      const entry = this.cdn.get(url.searchParams.get('encrypted_query_param') ?? '')
      return typeof entry === 'object' ? new Response(new Uint8Array(entry)) : new Response('missing', { status: entry ?? 404 })
    }
    const endpoint = url.pathname.slice(1) as Endpoint
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    this.requests.push({ method: init?.method ?? 'GET', origin: url.origin, endpoint, query: Object.fromEntries(url.searchParams), headers, body })
    const signal = init?.signal ?? undefined
    signal?.throwIfAborted()
    const reply = this.queues.get(endpoint)?.shift() ?? await this.fallback(endpoint, signal)
    if (reply instanceof Error) throw reply
    const status = reply.status ?? 200
    if (endpoint === 'ilink/bot/sendmessage' && status === 200 && reply.raw === undefined && ((reply.body as { ret?: number } | undefined)?.ret ?? 0) === 0) {
      const msg = (body as { msg: { to_user_id: string; item_list: Array<{ text_item: { text: string } }>; context_token: string } }).msg
      this.sent.push({ to: msg.to_user_id, text: msg.item_list[0]!.text_item.text, contextToken: msg.context_token })
    }
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status, headers: { 'content-type': 'application/json' } })
  }

  /** Default answer when nothing is queued: a fresh QR code, a successful send, or a held long-poll. */
  private fallback(endpoint: Endpoint, signal: AbortSignal | undefined): Promise<Reply> {
    if (endpoint === 'ilink/bot/get_bot_qrcode') {
      this.qrCount += 1
      const qrcode = `qr-${this.qrCount}`
      return Promise.resolve({ body: { ret: 0, qrcode, qrcode_img_content: `https://liteapp.weixin.qq.com/q/${this.qrCount}?qrcode=${qrcode}&bot_type=3` } })
    }
    if (!LONG_POLL.has(endpoint)) return Promise.resolve({ body: { ret: 0 } })
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(endpoint) ?? []
      this.waiters.set(endpoint, waiters)
      const onAbort = (): void => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reject(new DOMException('This operation was aborted', 'AbortError'))
      }
      const waiter = (reply: Reply): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(reply)
      }
      waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** An inbound text message from `from`. */
export function textMessage(from: string, text: string, contextToken = `ctx-${text}`, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { from_user_id: from, message_type: 1, context_token: contextToken, item_list: [{ type: 1, text_item: { text } }], ...extra }
}

/** An inbound message with one image item, keyed for the double's CDN. */
export function imageMessage(from: string, param: string, aeskeyHex: string, contextToken = `ctx-${param}`): Record<string, unknown> {
  const item = { type: 2, image_item: { aeskey: aeskeyHex, media: { encrypt_query_param: param } } }
  return { from_user_id: from, message_type: 1, context_token: contextToken, item_list: [item] }
}
