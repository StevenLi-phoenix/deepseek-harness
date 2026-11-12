/** Refresh while the section is mounted and the page is visible. */

/** The part of `document` the poller watches. */
export interface PageVisibility {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** @returns the browser document, or null outside a browser. */
function documentPage(): PageVisibility | null {
  return 'document' in globalThis ? globalThis.document : null
}

/**
 * Refresh now and every `intervalMs` while the page is visible; hiding the page stops the timer, showing it again
 * refreshes at once.
 * @param refresh - one refresh; the loader shares a request in flight.
 * @param intervalMs - period.
 * @param page - visibility source; null polls without one.
 * @returns a stop function.
 */
export function startPolling(refresh: () => void, intervalMs: number, page: PageVisibility | null = documentPage()): () => void {
  let timer: ReturnType<typeof setInterval> | null = null
  const halt = (): void => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }
  const follow = (): void => {
    if (page?.visibilityState === 'hidden') {
      halt()
      return
    }
    if (timer !== null) return
    refresh()
    timer = setInterval(refresh, intervalMs)
  }
  page?.addEventListener('visibilitychange', follow)
  follow()
  return () => {
    page?.removeEventListener('visibilitychange', follow)
    halt()
  }
}
