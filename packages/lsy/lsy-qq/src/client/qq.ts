/**
 * The QQ section's store and loader: one status request at a time, shared by every caller, keeping the last answer
 * through failures; the "fresh code" action; and the poller that refreshes while the section is mounted and the
 * page is visible.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { QqPanel, QqRefreshAnswer } from '../panel-view.ts'

export type { QqPanel, QqRefreshAnswer } from '../panel-view.ts'

/** How often the open section refreshes: short, because a scan should show up within seconds. */
export const POLL_INTERVAL_MS = 3000

/** What the section renders. */
export interface QqState {
  /** The last answer of the Host; a failed refresh keeps it. */
  panel: QqPanel | null
  /** Time of the last settled request, answered or not. */
  checkedAt: number | null
  /** The last request failed, so `panel` (if any) is older than `checkedAt`. */
  stale: boolean
  /** A fresh QR code was asked for and the answer is pending. */
  codeRequested: boolean
  /** The last request for a fresh code was declined; cleared by the next request. */
  codeDeclined: boolean
}

/** @returns a store holding the not-yet-loaded state. */
export function createQqStore(): SnapshotStore<QqState> {
  return createSnapshotStore<QqState>({ panel: null, checkedAt: null, stale: false, codeRequested: false, codeDeclined: false })
}

/**
 * Check a route answer's outer shape. The Host half of this package wrote the body, so its fields are this
 * package's own contract.
 * @param body - the parsed JSON body.
 * @returns the panel.
 */
export function parsePanel(body: unknown): QqPanel {
  const fields = typeof body === 'object' && body !== null ? body as Partial<Record<keyof QqPanel, unknown>> : {}
  if (typeof fields.at !== 'number' || typeof fields.connection !== 'object' || fields.connection === null
    || typeof fields.login !== 'object' || fields.login === null) {
    throw new Error('unexpected QQ answer')
  }
  return body as QqPanel
}

/** Reads the QQ panel into a store, one request at a time. */
export class QqLoader {
  private inFlight: Promise<void> | undefined

  /**
   * @param store - the store the section renders.
   * @param read - one status query; rejects on transport failure.
   * @param renew - one fresh-code request; rejects on transport failure.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<QqState>,
    private readonly read: () => Promise<QqPanel>,
    private readonly renew: () => Promise<QqRefreshAnswer>,
    private readonly now: () => number = Date.now,
  ) {}

  /** @returns settlement after the answer is published; concurrent callers share the request in flight. */
  refresh(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    const request = this.query().finally(() => { this.inFlight = undefined })
    this.inFlight = request
    return request
  }

  /** Ask NapCat for a fresh login code; the answer carries the panel after the request. */
  async renewCode(): Promise<void> {
    if (this.store.getSnapshot().codeRequested) return
    this.store.update((draft) => { draft.codeRequested = true; draft.codeDeclined = false })
    let answer: QqRefreshAnswer | undefined
    try {
      answer = await this.renew()
    } catch {
      console.warn('[lsy-qq] fresh login code request failed')
    }
    const at = this.now()
    this.store.update((draft) => {
      draft.codeRequested = false
      draft.checkedAt = at
      if (answer === undefined) {
        draft.codeDeclined = true
        return
      }
      draft.codeDeclined = !answer.refreshed
      draft.stale = false
      draft.panel = answer
    })
  }

  private async query(): Promise<void> {
    let panel: QqPanel | undefined
    try {
      panel = await this.read()
    } catch {
      // Warn when the reading goes stale, not on every poll after that.
      if (!this.store.getSnapshot().stale) console.warn('[lsy-qq] QQ status read failed')
    }
    const at = this.now()
    this.store.update((draft) => {
      draft.checkedAt = at
      draft.stale = panel === undefined
      if (panel !== undefined) draft.panel = panel
    })
  }
}

/** The part of `document` the poller watches. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** @returns the browser document, or null outside a browser. */
function currentPage(): VisibilitySource | null {
  return 'document' in globalThis ? globalThis.document : null
}

/**
 * Refresh now and every `intervalMs` while the page is visible; a hidden page stops the timer and showing it
 * again refreshes at once.
 * @param refresh - one refresh; the loader shares a request in flight.
 * @param intervalMs - polling period.
 * @param page - visibility source; null polls without one.
 * @returns a stop function.
 */
export function startPolling(refresh: () => void, intervalMs: number, page: VisibilitySource | null = currentPage()): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  const run = (): void => {
    if (timer !== undefined) return
    refresh()
    timer = setInterval(refresh, intervalMs)
  }
  const pause = (): void => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
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
