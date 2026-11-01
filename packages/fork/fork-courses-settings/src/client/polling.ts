/** Refresh while the section is open and the page is visible. */

/** The part of `document` the poller watches. */
export interface PageVisibility {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * Refresh now and every `intervalMs` while the page is visible; showing a hidden page refreshes at once.
 * @param refresh - one refresh.
 * @param intervalMs - period.
 * @param page - visibility source; null polls without one.
 * @returns a stop function.
 */
export function startPolling(refresh: () => void, intervalMs: number, page: PageVisibility | null = 'document' in globalThis ? globalThis.document : null): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  const sync = (): void => {
    const visible = page?.visibilityState !== 'hidden'
    if (visible && timer === undefined) {
      refresh()
      timer = setInterval(refresh, intervalMs)
    } else if (!visible && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
  page?.addEventListener('visibilitychange', sync)
  sync()
  return () => {
    page?.removeEventListener('visibilitychange', sync)
    if (timer !== undefined) clearInterval(timer)
  }
}
