/**
 * The API platform's message bus over its typed RPC, `POST <apiBase>/v2/call/messageservice/post`. A post at or
 * above the bus's notify threshold goes on to the notification service, which pushes it to the owner's phone;
 * `digest: true` waits for the daily email digest instead. The RPC keeps `idempotency_key`, which the bus's REST
 * adapter drops: the bus scopes the key to the caller, answers an identical repeat with the first message's id and
 * no second push, and answers the same key with other content with 409 `idempotency_conflict`. The token never
 * reaches a log line or an error.
 *
 * @module @deepseek-ai/dsh-tool-push/bus
 */

/** Why a post failed. */
export type BusFailure = 'not-configured' | 'auth' | 'duplicate' | 'invalid' | 'http' | 'network' | 'timeout'

/** A failed post; `message` is safe to log and to show to the model. */
export class BusError extends Error {
  /**
   * @param failure - the failure class.
   * @param message - what went wrong.
   * @param status - the HTTP status, when the bus answered.
   */
  constructor(readonly failure: BusFailure, message: string, readonly status?: number) {
    super(message)
    this.name = 'BusError'
  }
}

/** What the client needs. */
export interface BusOptions {
  /** Platform base, e.g. `https://api.lishuyu.app`, without a trailing slash. */
  readonly apiBase: string
  /** Per-call timeout in milliseconds. */
  readonly timeoutMs: number
  /** The PAT, or undefined when it is not configured; read on every call so a rotated token needs no restart. */
  readonly token: () => Promise<string | undefined>
  /** Fetch implementation; tests replace it. */
  readonly fetch?: typeof fetch
}

/** One message, in the bus's `post` input. */
export interface BusPost {
  /** Who posts, 1-24 characters. */
  readonly source: string
  /** The message, 1-500 characters. */
  readonly text: string
  /** Bus channel the message is kept in. */
  readonly channel: string
  /** 0-9; at or above the bus's notify threshold the message is pushed. */
  readonly priority: number
  /** Queue for the daily email digest instead of pushing now. */
  readonly digest?: true
  /** Digest lines with the same key collapse into one with a count. */
  readonly digest_key?: string
  /** Caller-scoped key: a repeat posts nothing new. */
  readonly idempotency_key: string
}

/** Longest bus error text carried into a message. */
const MAX_ERROR_CHARS = 200

/**
 * The bus's error code from an answer body.
 * @param body - the parsed body, or nothing.
 * @returns the `error` field, cut short, or nothing.
 */
function errorOf(body: unknown): string | undefined {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  return typeof error === 'string' ? error.slice(0, MAX_ERROR_CHARS) : undefined
}

/** The message bus. */
export class MessageBus {
  private readonly fetchImpl: typeof fetch

  /** @param options - base URL, timeout, and token source. */
  constructor(private readonly options: BusOptions) {
    this.fetchImpl = options.fetch ?? (async (...args) => await fetch(...args))
  }

  /**
   * Post one message.
   * @param input - the message.
   * @param signal - caller abort.
   * @returns the message id; an identical repeat returns the first one's.
   * @throws {BusError} on a missing token, a transport failure, or an answer that is not a message id.
   */
  async post(input: BusPost, signal?: AbortSignal): Promise<{ readonly id: number }> {
    const token = await this.options.token()
    if (token === undefined || token === '') throw new BusError('not-configured', 'the message bus token is not set')
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.apiBase}/v2/call/messageservice/post`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    } catch (error: unknown) {
      if (timeout.aborted) throw new BusError('timeout', `the message bus did not answer within ${String(this.options.timeoutMs)} ms`)
      throw new BusError('network', `the message bus could not be reached (${error instanceof Error ? error.message : String(error)})`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    const code = errorOf(body)
    if (!response.ok) {
      const said = `HTTP ${String(response.status)}${code === undefined ? '' : ` ${code}`}`
      if (response.status === 401 || response.status === 403) throw new BusError('auth', `the message bus refused the token (${said})`, response.status)
      if (response.status === 409 && code === 'idempotency_conflict') {
        throw new BusError('duplicate', 'this key was already posted with other content', response.status)
      }
      if (response.status === 400 || response.status === 422) throw new BusError('invalid', `the message bus rejected the message (${said})`, response.status)
      throw new BusError('http', `the message bus answered ${said}`, response.status)
    }
    const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new BusError('invalid', 'the message bus answered without a message id', response.status)
    return { id }
  }
}
