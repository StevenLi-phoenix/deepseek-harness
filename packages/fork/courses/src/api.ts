/**
 * The REST client of the owner's courses service (`POST <baseUrl>/v1/ops/<operation>`, the hub's envelope
 * `{ ok, result }` or `{ ok: false, error }`). It authenticates with a platform PAT whose audience is `courses`,
 * resolved per call so a rotated token takes effect without a restart, and names itself in `X-Courses-Agent`
 * so the service's history says which writes came from DSH. The token never reaches a log line or an error.
 */

/** Why a call failed, as the poller and the tools report it. */
export type CoursesFailure = 'not-configured' | 'auth' | 'http' | 'network' | 'timeout' | 'invalid'

/** A failed call; `message` is safe to log and to show to the model (no token, no body beyond the service's error). */
export class CoursesApiError extends Error {
  /**
   * @param failure - the failure class.
   * @param message - what went wrong.
   * @param status - the HTTP status, when the service answered.
   */
  constructor(readonly failure: CoursesFailure, message: string, readonly status?: number) {
    super(message)
    this.name = 'CoursesApiError'
  }
}

/** What the client needs. */
export interface CoursesApiOptions {
  /** API base, e.g. `https://api.lishuyu.app/courses`, without a trailing slash. */
  readonly baseUrl: string
  /** `X-Courses-Agent` value. */
  readonly agent: string
  /** Per-call timeout in milliseconds. */
  readonly timeoutMs: number
  /** The PAT, or undefined when it is not configured. */
  readonly token: () => Promise<string | undefined>
  /** Fetch implementation; tests replace it. */
  readonly fetch?: typeof fetch
}

/** Longest service error text carried into a message. */
const MAX_ERROR_CHARS = 300

/** The courses service over HTTP. */
export class CoursesApi {
  private readonly fetchImpl: typeof fetch

  /** @param options - base URL, agent name, timeout, and token source. */
  constructor(private readonly options: CoursesApiOptions) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args))
  }

  /**
   * Run one operation.
   * @param operation - tool name, e.g. `report`.
   * @param args - its arguments.
   * @param signal - caller abort.
   * @returns the operation's `result`.
   * @throws {CoursesApiError} on a missing token, a transport failure, a non-2xx answer, or an answer without `ok: true`.
   */
  async call(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const token = await this.options.token()
    if (token === undefined || token === '') throw new CoursesApiError('not-configured', 'the courses token is not set')
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/v1/ops/${operation}`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json', 'x-courses-agent': this.options.agent },
        body: JSON.stringify(args),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    } catch (error: unknown) {
      if (timeout.aborted) throw new CoursesApiError('timeout', `the courses service did not answer within ${this.options.timeoutMs} ms`)
      throw new CoursesApiError('network', `the courses service could not be reached (${error instanceof Error ? error.message : String(error)})`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new CoursesApiError(response.ok ? 'invalid' : 'http', `the courses service answered HTTP ${response.status} without JSON`, response.status)
    }
    const envelope = typeof body === 'object' && body !== null ? body as { ok?: unknown; result?: unknown; error?: unknown } : {}
    if (!response.ok || envelope.ok !== true) {
      const detail = typeof envelope.error === 'string' ? `: ${envelope.error.slice(0, MAX_ERROR_CHARS)}` : ''
      const failure: CoursesFailure = response.status === 401 || response.status === 403 ? 'auth' : response.ok ? 'invalid' : 'http'
      throw new CoursesApiError(failure, `courses ${operation} failed with HTTP ${response.status}${detail}`, response.status)
    }
    return envelope.result
  }
}
