/**
 * OneBot v11 over a forward WebSocket: this process connects out to the protocol end (NapCat) and reads its
 * events. Only the connection and the request/response correlation live here; what an event means is up to the
 * collector. The client never sends anything on its own.
 */
import WebSocket from 'ws'

/** One message segment: `{ type: 'text', data: { text } }`, `{ type: 'image', data: { url, file } }`, and so on. */
export interface OneBotSegment {
  type: string
  data: Record<string, unknown>
}

/** Sender block of a message event. */
export interface OneBotSender {
  user_id?: number | string
  nickname?: string
  card?: string
  role?: string
}

/** The fields of an event this package reads; the platform sends more. */
export interface OneBotEvent {
  post_type: string
  time?: number
  self_id?: number | string
  message_type?: string
  sub_type?: string
  message_id?: number | string
  message_seq?: number | string
  group_id?: number | string
  user_id?: number | string
  operator_id?: number | string
  message?: OneBotSegment[] | string
  raw_message?: string
  sender?: OneBotSender
  notice_type?: string
  meta_event_type?: string
  file?: { id?: string; name?: string; size?: number; busid?: number }
  [key: string]: unknown
}

/** A reply to an API call. */
export interface OneBotResponse {
  status?: string
  retcode?: number
  data?: unknown
  message?: string
  wording?: string
  echo?: string
}

/** What the connection reports while it runs. */
export interface OneBotHandlers {
  event(event: OneBotEvent): void
  /** The socket is open and authenticated. */
  open(): void
  /** The socket closed; the reason never contains the token. */
  close(reason: string): void
}

/** Options of {@link OneBotClient}. */
export interface OneBotOptions {
  /** `ws://host:port` of the protocol end's WebSocket server. */
  url: string
  /** Access token, sent as a Bearer header; empty sends none. */
  token: string
  /** Deadline of one API call, in milliseconds. */
  requestTimeoutMs?: number
  /** The socket is dropped when nothing arrives for this long (the protocol end sends a heartbeat every 30 s). */
  idleTimeoutMs?: number
  /** Opens the socket; tests substitute a double. */
  connect?: (url: string, headers: Record<string, string>) => WebSocket
}

/** An API call that failed: a transport problem, a timeout, or a non-zero `retcode`. */
export class OneBotError extends Error {
  constructor(message: string, readonly retcode?: number) {
    super(message)
  }
}

/** Strip a token from text that may quote the URL or a header. */
export function scrubToken(text: string, token: string): string {
  return token === '' ? text : text.split(token).join('***')
}

/** Whether the URL points at this machine or the tailnet, the only places the protocol end may live. */
export function isPrivateUrl(raw: string): boolean {
  const url = URL.parse(raw)
  if (url === null || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1') return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return host.endsWith('.ts.net')
  const [first = 0, second = 0] = parts
  return first === 127 || (first === 100 && second >= 64 && second <= 127)
}

/** A client of the protocol end. */
export class OneBotClient {
  private socket: WebSocket | undefined
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private counter = 0

  constructor(private readonly options: OneBotOptions) {}

  /** Whether the socket is open. */
  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /**
   * Connect and deliver events until `signal` aborts or the socket closes.
   * @returns when the socket closed or the signal aborted; rejects when the connection could not be made.
   */
  run(handlers: OneBotHandlers, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = this.options.token === '' ? {} : { authorization: `Bearer ${this.options.token}` }
      let socket: WebSocket
      try {
        const open = this.options.connect ?? ((url, h) => new WebSocket(url, { headers: h, handshakeTimeout: 15_000 }))
        socket = open(this.options.url, headers)
      } catch (error: unknown) {
        reject(new OneBotError(scrubToken(error instanceof Error ? error.message : String(error), this.options.token)))
        return
      }
      this.socket = socket
      let opened = false
      let idle: NodeJS.Timeout | undefined
      const idleMs = this.options.idleTimeoutMs ?? 120_000
      const touch = (): void => {
        clearTimeout(idle)
        idle = setTimeout(() => { socket.terminate() }, idleMs)
        idle.unref()
      }
      const onAbort = (): void => {
        socket.close()
        setTimeout(() => { socket.terminate() }, 2000).unref()
      }
      const finish = (reason: string, error?: Error): void => {
        clearTimeout(idle)
        signal.removeEventListener('abort', onAbort)
        if (this.socket === socket) this.socket = undefined
        for (const [echo, call] of this.pending) {
          clearTimeout(call.timer)
          call.reject(new OneBotError('the connection closed'))
          this.pending.delete(echo)
        }
        if (opened) handlers.close(reason)
        if (error !== undefined && !opened) reject(error)
        else resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      socket.on('open', () => {
        opened = true
        touch()
        handlers.open()
      })
      socket.on('message', (raw: WebSocket.RawData) => {
        touch()
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(String(raw)) as Record<string, unknown>
        } catch {
          return
        }
        const echo = payload['echo']
        const call = typeof echo === 'string' ? this.pending.get(echo) : undefined
        if (call !== undefined && typeof echo === 'string') {
          this.pending.delete(echo)
          clearTimeout(call.timer)
          call.resolve(payload)
          return
        }
        if (typeof payload['post_type'] === 'string') handlers.event(payload as OneBotEvent)
      })
      socket.on('error', (error: Error) => {
        // The `ws` error text can quote the URL; the token is a header, but scrub anyway.
        const wrapped = new OneBotError(scrubToken(error.message, this.options.token))
        if (!opened) finish(wrapped.message, wrapped)
      })
      socket.on('close', (code: number) => { finish(`closed with code ${code}`) })
    })
  }

  /**
   * Call one API action.
   * @returns the action's `data`.
   * @throws {@link OneBotError} when the socket is down, the call times out, or the protocol end answers a failure.
   */
  async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) throw new OneBotError('not connected to the protocol end')
    this.counter += 1
    const echo = `lsy-qq-${this.counter}`
    const response = await new Promise<OneBotResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new OneBotError(`${action} timed out`))
      }, this.options.requestTimeoutMs ?? 20_000)
      this.pending.set(echo, { resolve: (value) => { resolve(value as OneBotResponse) }, reject, timer })
      socket.send(JSON.stringify({ action, params, echo }), (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          clearTimeout(timer)
          this.pending.delete(echo)
          reject(new OneBotError(scrubToken(error.message, this.options.token)))
        }
      })
    })
    if (response.status !== 'ok' && response.retcode !== 0) {
      throw new OneBotError(`${action} failed: ${response.wording ?? response.message ?? 'unknown error'}`, response.retcode)
    }
    return response.data as T
  }
}
