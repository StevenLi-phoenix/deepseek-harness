/** Bounded probes: every check has a deadline, and a failed one is an answer, never an exception. */

/** Answer of an HTTP probe: the status, or null when nothing answered within the deadline. */
export type ProbeResult = number | null

/**
 * GET a URL with a deadline. Nothing of the answer is read.
 * @param url - absolute URL.
 * @param timeoutMs - deadline of the whole request.
 * @param fetchImpl - replaceable in tests.
 * @returns the HTTP status, or null on a network error or timeout.
 */
export async function httpProbe(url: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: '*/*' } })
    // The body is never used; dropping it frees the socket.
    void response.body?.cancel().catch(() => undefined)
    return response.status
  } catch {
    return null
  }
}

/**
 * True for a 2xx answer.
 * @param status - the probe result.
 * @returns whether the status is 200-299.
 */
export function isHealthy(status: ProbeResult): boolean {
  return status !== null && status >= 200 && status < 300
}

/**
 * True for any answer below 500: something is listening and not failing, even when it has no page at this path.
 * @param status - the probe result.
 * @returns whether the status is below 500.
 */
export function isReachable(status: ProbeResult): boolean {
  return status !== null && status < 500
}

/** Marker for a check that did not finish within its deadline. */
export const TIMED_OUT: unique symbol = Symbol('timed-out')

/**
 * Wait for work at most `ms`.
 * @param work - the check; its late result and late rejection are dropped.
 * @param ms - deadline.
 * @returns the result, or {@link TIMED_OUT}.
 */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => { resolve(TIMED_OUT) }, ms) })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
    work.catch(() => undefined)
  }
}
