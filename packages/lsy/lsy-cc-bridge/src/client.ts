/**
 * Client of the dsh-cc-bridge relay (`lsy/cc-bridge/relay.py`): one long-lived unix-socket
 * connection of JSON lines. Requests carry an id and get one response with the same id; the relay
 * also pushes `message` events (what a Claude Code session sent) and `status` events. The client
 * reconnects with backoff, acknowledges each message once the caller took it, and retries messages
 * the caller could not take yet.
 */

import { createConnection, type Socket } from 'node:net'

/** What the relay knows about one Claude Code session; it carries no socket path or token. */
export interface SessionView {
  name: string
  pid: number
  sessionId?: string
  cwd?: string
  kind?: string
  status?: string
  entrypoint?: string
  version?: string
  startedAt?: number
  updatedAt?: number
  tmux?: string
}

/** A message a Claude Code session sent; `from` is identified by the relay from the process table. */
export interface InboundMessage {
  event: 'message'
  id: string
  at: number
  from: SessionView
  text: string
  /** The name the message itself claims, kept apart because the sender wrote it. */
  claimedName?: string | null
}

/** A delivery receipt Claude Code sent back (held for approval, dropped). */
export interface StatusEvent {
  event: 'status'
  at: number
  pid?: number | null
  action?: string | null
  status?: string | null
  reason?: string | null
}

/** One response of the relay. */
export interface RelayResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

/** Logger surface the client needs. */
export interface ClientLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
}

export interface ClientOptions {
  path: string
  requestTimeoutMs: number
  logger: ClientLogger
  /** Take one inbound message; false means "not now", and it is offered again later. */
  onMessage(message: InboundMessage): Promise<boolean>
  onStatus?(status: StatusEvent): void
  /** Backoff bounds between connection attempts. */
  reconnectMinMs?: number
  reconnectMaxMs?: number
  /** Pause before a message the caller could not take is offered again, and how many offers it gets. */
  retryMs?: number
  maxAttempts?: number
}

interface Waiting {
  resolve: (response: RelayResponse) => void
  timer: NodeJS.Timeout
}

const HANDLED_KEEP = 500

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class RelayClient {
  private socket: Socket | undefined
  private buffer = ''
  private nextId = 1
  private stopped = true
  private ready = false
  private reconnectTimer: NodeJS.Timeout | undefined
  private backoff: number
  private readonly waiting = new Map<number, Waiting>()
  private readonly handled = new Set<string>()
  private readonly attempts = new Map<string, number>()
  private readonly retryTimers = new Set<NodeJS.Timeout>()
  private lastError = ''

  constructor(private readonly options: ClientOptions) {
    this.backoff = options.reconnectMinMs ?? 1000
  }

  /** Whether the relay answered the hello of the current connection. */
  get connected(): boolean {
    return this.ready
  }

  /** Why the last connection attempt failed, for tool errors. */
  get problem(): string {
    return this.lastError
  }

  /** Start connecting; safe to call once. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  /** Close the connection and stop reconnecting. */
  stop(): void {
    this.stopped = true
    this.ready = false
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    this.socket?.destroy()
    this.socket = undefined
    this.failWaiting('the bridge client stopped')
  }

  /**
   * Send one request and wait for its response.
   * @returns the response; `{ ok: false }` with a reason when the relay is unreachable or too slow.
   */
  request(op: string, fields: Record<string, unknown> = {}): Promise<RelayResponse> {
    const socket = this.socket
    if (socket === undefined || !this.ready) {
      return Promise.resolve({ ok: false, error: this.lastError === '' ? 'the Claude Code bridge is not connected' : `the Claude Code bridge is not connected (${this.lastError})` })
    }
    return this.send(socket, op, fields)
  }

  private send(socket: Socket, op: string, fields: Record<string, unknown>): Promise<RelayResponse> {
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve({ ok: false, error: `the Claude Code bridge did not answer ${op} within ${String(this.options.requestTimeoutMs)} ms` })
      }, this.options.requestTimeoutMs)
      timer.unref()
      this.waiting.set(id, { resolve, timer })
      socket.write(`${JSON.stringify({ id, op, ...fields })}\n`, (error) => {
        if (error === undefined || error === null) return
        const waiter = this.waiting.get(id)
        if (waiter === undefined) return
        clearTimeout(waiter.timer)
        this.waiting.delete(id)
        resolve({ ok: false, error: `could not write to the bridge: ${errorText(error)}` })
      })
    })
  }

  private connect(): void {
    if (this.stopped) return
    const socket = createConnection({ path: this.options.path })
    this.socket = socket
    this.buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      void this.send(socket, 'hello', {}).then((response) => {
        if (this.socket !== socket) return
        if (!response.ok) {
          this.lastError = response.error ?? 'hello refused'
          this.options.logger.warn(`cc-bridge: the relay refused hello: ${this.lastError}`)
          socket.destroy()
          return
        }
        this.ready = true
        this.lastError = ''
        this.backoff = this.options.reconnectMinMs ?? 1000
        this.options.logger.info(`cc-bridge: connected to the relay at ${this.options.path} (version ${String(response['version'])}, ${String(response['pending'])} message(s) waiting)`)
      })
    })
    socket.on('data', (chunk: string) => { this.onData(chunk) })
    socket.on('error', (error) => {
      const message = (error as NodeJS.ErrnoException).code ?? errorText(error)
      if (message !== this.lastError) this.options.logger.info(`cc-bridge: relay unreachable at ${this.options.path}: ${message}`)
      this.lastError = message
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      const wasReady = this.ready
      this.ready = false
      this.failWaiting('the bridge connection closed')
      if (wasReady) this.options.logger.warn('cc-bridge: the relay connection closed; reconnecting')
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, this.options.reconnectMaxMs ?? 30_000)
    this.reconnectTimer = setTimeout(() => { this.connect() }, delay)
    this.reconnectTimer.unref()
  }

  private failWaiting(reason: string): void {
    for (const [id, waiter] of this.waiting) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, error: reason })
      this.waiting.delete(id)
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim() !== '') this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.options.logger.warn('cc-bridge: the relay sent a line that is not JSON')
      return
    }
    if (typeof value['id'] === 'number') {
      const waiter = this.waiting.get(value['id'])
      if (waiter !== undefined) {
        clearTimeout(waiter.timer)
        this.waiting.delete(value['id'])
        waiter.resolve(value as unknown as RelayResponse)
      }
      return
    }
    if (value['event'] === 'message') void this.onMessage(value as unknown as InboundMessage)
    else if (value['event'] === 'status') this.options.onStatus?.(value as unknown as StatusEvent)
  }

  private async onMessage(message: InboundMessage): Promise<void> {
    if (this.handled.has(message.id)) {
      this.acknowledge(message.id)
      return
    }
    let taken = false
    try {
      taken = await this.options.onMessage(message)
    } catch (error: unknown) {
      this.options.logger.warn(`cc-bridge: taking message ${message.id.slice(0, 8)} failed: ${errorText(error)}`)
    }
    if (taken) {
      this.settle(message.id)
      return
    }
    const tries = (this.attempts.get(message.id) ?? 0) + 1
    this.attempts.set(message.id, tries)
    if (tries >= (this.options.maxAttempts ?? 5)) {
      this.options.logger.warn(`cc-bridge: gave up on message ${message.id.slice(0, 8)} from ${message.from.name} after ${String(tries)} attempts`)
      this.settle(message.id)
      return
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer)
      void this.onMessage(message)
    }, this.options.retryMs ?? 30_000)
    timer.unref()
    this.retryTimers.add(timer)
  }

  private settle(id: string): void {
    this.attempts.delete(id)
    this.handled.add(id)
    if (this.handled.size > HANDLED_KEEP) this.handled.delete(this.handled.values().next().value as string)
    this.acknowledge(id)
  }

  private acknowledge(id: string): void {
    // Replayed messages arrive before the hello response, so readiness is not required.
    if (this.socket === undefined) return
    void this.send(this.socket, 'ack', { ids: [id] })
  }
}
