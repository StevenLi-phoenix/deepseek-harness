/**
 * The Bilibili account store, its loader, and its poller: one request at a
 * time shared by every caller, the last view kept through failures, owner
 * actions posted to the same route, and a faster refresh while a QR code is
 * live.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { BiliAction, BiliView } from '../view.ts'

export type { BiliAction, BiliView } from '../view.ts'

/** How often the open section refreshes. */
export const POLL_INTERVAL_MS = 5000
/** How often it refreshes while a QR code waits for its scan. */
export const LOGIN_POLL_MS = 2000

/** What the section renders. */
export interface BiliState {
  /** The last view the Host answered; a failed refresh keeps it. */
  view: BiliView | null
  /** Time of the last settled request, answered or not. */
  checkedAt: number | null
  /** The last request failed, so `view` (if any) is older than `checkedAt`. */
  stale: boolean
  /** The owner action in flight. */
  busy: BiliAction['action'] | null
  /** Why the last owner action failed. */
  error: string | null
}

/** @returns a store holding the not-yet-loaded state. */
export function createBiliStore(): SnapshotStore<BiliState> {
  return createSnapshotStore<BiliState>({ view: null, checkedAt: null, stale: false, busy: null, error: null })
}

/**
 * Check a route answer's outer shape. The Host half of this package wrote the
 * body, so its fields are this package's own contract.
 * @param body - the parsed JSON body.
 * @returns the view.
 */
export function parseView(body: unknown): BiliView {
  const fields = typeof body === 'object' && body !== null ? body as Partial<Record<keyof BiliView, unknown>> : {}
  if (typeof fields.account !== 'object' || typeof fields.login !== 'object' || typeof fields.usage !== 'object' || typeof fields.clock !== 'object' || !Array.isArray(fields.recent)) {
    throw new Error('unexpected Bilibili account answer')
  }
  return body as BiliView
}

/** Reads the view into a store, one request at a time, and posts owner actions. */
export class BiliLoader {
  private inFlight: Promise<void> | undefined

  /**
   * @param store - the store the section renders.
   * @param read - one GET of the route; rejects on transport failure.
   * @param post - one owner action; resolves with the new view.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<BiliState>,
    private readonly read: () => Promise<BiliView>,
    private readonly post: (action: BiliAction) => Promise<BiliView>,
    private readonly now: () => number = Date.now,
  ) {}

  /** @returns settlement after the answer is published; concurrent callers share the request in flight. */
  refresh(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    const request = this.query().finally(() => { this.inFlight = undefined })
    this.inFlight = request
    return request
  }

  /**
   * Post one owner action and publish the view it answers.
   * @param action - login, resume, or an interests edit.
   */
  async act(action: BiliAction): Promise<void> {
    this.store.update((draft) => {
      draft.busy = action.action
      draft.error = null
    })
    try {
      const view = await this.post(action)
      const at = this.now()
      this.store.update((draft) => {
        draft.view = view
        draft.checkedAt = at
        draft.stale = false
      })
    } catch (error: unknown) {
      this.store.update((draft) => { draft.error = error instanceof Error ? error.message : String(error) })
    } finally {
      this.store.update((draft) => { draft.busy = null })
    }
  }

  private async query(): Promise<void> {
    let view: BiliView | undefined
    try {
      view = await this.read()
    } catch {
      // Warn when the view goes stale, not on every poll after that.
      if (!this.store.getSnapshot().stale) console.warn('[bili] account status read failed')
    }
    const at = this.now()
    this.store.update((draft) => {
      draft.checkedAt = at
      draft.stale = view === undefined
      if (view !== undefined) draft.view = view
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
 * Refresh now and every `intervalMs` while the page is visible; a hidden page
 * stops the timer and showing it again refreshes at once.
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
