/** Refreshing a Settings section while the page is visible. */

/** The part of `document` the poller watches. */
export interface PageVisibility {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** @returns the browser document, or null outside a browser. */
function currentPage(): PageVisibility | null {
  return 'document' in globalThis ? globalThis.document : null
}

/**
 * Refresh now and again after each period while the page is visible; a hidden page stops the timer, and showing it
 * again refreshes at once.
 * @param refresh - one refresh; the loader shares a request in flight.
 * @param interval - the period in milliseconds, or a function asked for the next period after each refresh.
 * @param page - visibility source; null polls without one. The browser document by default.
 * @returns a stop function.
 */
export function startPolling(
  refresh: () => void,
  interval: number | (() => number),
  page: PageVisibility | null = currentPage(),
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  const tick = (): void => {
    refresh()
    timer = setTimeout(tick, typeof interval === 'number' ? interval : interval())
  }
  const run = (): void => {
    if (running) return
    running = true
    tick()
  }
  const pause = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    running = false
  }
  const onVisibility = (): void => {
    if (page?.visibilityState === 'hidden') pause()
    else run()
  }
  page?.addEventListener('visibilitychange', onVisibility)
  onVisibility()
  return () => {
    page?.removeEventListener('visibilitychange', onVisibility)
    pause()
  }
}
