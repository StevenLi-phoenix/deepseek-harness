/** One read shared by every caller while it is in flight. */

/**
 * Share one run while it is in flight: a call before the last run settles returns that run, and the first call after
 * it settles starts a new one.
 * @param run - starts one run.
 * @returns the function that starts a run or joins the one in flight.
 */
export function shareInFlight(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | undefined
  return () => {
    if (inFlight !== undefined) return inFlight
    const request = run().finally(() => { inFlight = undefined })
    inFlight = request
    return request
  }
}
