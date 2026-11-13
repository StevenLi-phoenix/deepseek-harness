/**
 * HTTP with a deadline and retries for the voice services: network errors, timeouts, 429, and 5xx
 * are retried with a growing pause; any other 4xx fails at once. Failure text never carries a URL
 * query, a header, or a response body beyond a short clip.
 */

/** A voice-service call that failed. */
export class VoiceError extends Error {
  /** @param message - reason fit for the agent and the log. */
  constructor(message: string) {
    super(message)
    this.name = 'VoiceError'
  }
}

/** Retry and deadline settings of one call. */
export interface CallOptions {
  /** Deadline of one attempt, in milliseconds. */
  timeoutMs: number
  /** Extra attempts after the first. */
  retries: number
  /** First pause before a retry; doubles each time. */
  retryDelayMs: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal | undefined
  /** Called before each retry, for the log. */
  onRetry?: (attempt: number, reason: string) => void
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** A response body clipped for an error message. */
async function clip(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  } catch {
    return ''
  }
}

/**
 * Call a service until it answers with a 2xx.
 * @param label - what the call is, for error text (for example `feiyu POST /v1/speech`).
 * @param url - absolute URL.
 * @param init - request init; `body` must be reusable across attempts (string, Buffer, or FormData).
 * @param options - deadline, retries, and test seams.
 * @returns the successful response, body unread.
 * @throws VoiceError after the last attempt or on a non-retryable status.
 */
export async function callService(label: string, url: string, init: RequestInit, options: CallOptions): Promise<Response> {
  const attempts = options.retries + 1
  const cancelled = (): boolean => options.signal?.aborted === true
  let pause = options.retryDelayMs
  let reason = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (cancelled()) throw new VoiceError(`${label} was cancelled`)
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    let retryable = true
    try {
      const response = await (options.fetch ?? fetch)(url, { ...init, signal })
      if (response.ok) return response
      const detail = await clip(response)
      reason = `${label} answered HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`
      retryable = response.status === 429 || response.status >= 500
    } catch (error: unknown) {
      if (cancelled()) throw new VoiceError(`${label} was cancelled`)
      const code = error instanceof Error && error.cause instanceof Error ? (error.cause as NodeJS.ErrnoException).code : undefined
      reason = timeout.aborted ? `${label} timed out after ${options.timeoutMs} ms` : `${label} failed${code === undefined ? '' : ` (${code})`}: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!retryable || attempt === attempts) throw new VoiceError(attempt > 1 ? `${reason} (after ${attempt} attempts)` : reason)
    options.onRetry?.(attempt, reason)
    await (options.sleep ?? defaultSleep)(pause)
    pause *= 2
  }
  throw new VoiceError(reason)
}
