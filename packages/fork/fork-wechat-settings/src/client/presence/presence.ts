/**
 * The quiet-hours store, its loader, and its poller: one status request at a time shared by every
 * caller, the last view kept through failures, and the buttons posted to the same route.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PresenceAction, PresenceAnswer, PresenceView } from '../../presence-view.ts'

export type { PresenceAction, PresenceAnswer, PresenceView } from '../../presence-view.ts'

/** How often the open section refreshes. */
export const POLL_INTERVAL_MS = 5000

/** What the section renders. */
export interface PresenceState {
  /** The last view the Host answered; a failed refresh keeps it. */
  view: PresenceView | null
  /** Time of the last settled status request, answered or not. */
  checkedAt: number | null
  /** The last status request failed, so `view` (if any) is older than `checkedAt`. */
  stale: boolean
  /** The button in flight. */
  busy: PresenceAction['action'] | null
  /** Why the last button failed. */
  error: string | null
  /** How many messages the last "send now" sent. */
  flushed: number | null
}

/**
 * A store for the section.
 * @returns a store holding the not-yet-loaded state.
 */
export function createPresenceStore(): SnapshotStore<PresenceState> {
  return createSnapshotStore<PresenceState>({ view: null, checkedAt: null, stale: false, busy: null, error: null, flushed: null })
}

/**
 * Check a route answer's outer fields. The Host half of this package wrote the body, so its fields
 * are this package's own contract.
 * @param body - the parsed JSON body.
 * @returns the answer.
 */
export function parseAnswer(body: unknown): PresenceAnswer {
  const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const view = fields['view']
  if (typeof view !== 'object' || view === null) throw new Error('unexpected quiet-hours answer')
  const { window, shortcut, timeZone, asleep } = view as Record<string, unknown>
  if (typeof asleep !== 'boolean' || typeof timeZone !== 'string' || typeof window !== 'object' || window === null || typeof shortcut !== 'object' || shortcut === null) {
    throw new Error('unexpected quiet-hours answer')
  }
  return body as PresenceAnswer
}

/** Reads the view into a store, one request at a time, and posts the buttons. */
export class PresenceLoader {
  private inFlight: Promise<void> | undefined

  /**
   * @param store - the store the section renders.
   * @param read - one GET of the route; rejects on transport failure.
   * @param post - one button; resolves with the answer, rejects with the route's error text.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<PresenceState>,
    private readonly read: () => Promise<PresenceAnswer>,
    private readonly post: (action: PresenceAction) => Promise<PresenceAnswer>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read the status once.
   * @returns settlement after the answer is published; concurrent callers share the request in flight.
   */
  refresh(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    const request = this.query().finally(() => { this.inFlight = undefined })
    this.inFlight = request
    return request
  }

  /**
   * Press one button: busy at once, then its answer or its error.
   * @param action - the button.
   */
  async act(action: PresenceAction): Promise<void> {
    this.store.update((draft) => {
      draft.busy = action.action
      draft.error = null
      if (action.action === 'flush') draft.flushed = null
    })
    try {
      const answer = await this.post(action)
      const at = this.now()
      this.store.update((draft) => {
        draft.view = answer.view
        draft.checkedAt = at
        draft.stale = false
        if (action.action === 'flush') draft.flushed = answer.flushed
      })
    } catch (error: unknown) {
      this.store.update((draft) => { draft.error = error instanceof Error ? error.message : String(error) })
    } finally {
      this.store.update((draft) => { draft.busy = null })
    }
  }

  private async query(): Promise<void> {
    let answer: PresenceAnswer | undefined
    try {
      answer = await this.read()
    } catch {
      // Warn when the view goes stale, not on every poll after that.
      if (!this.store.getSnapshot().stale) console.warn('[fork-presence] status read failed')
    }
    const at = this.now()
    this.store.update((draft) => {
      draft.checkedAt = at
      draft.stale = answer === undefined
      if (answer !== undefined) draft.view = answer.view
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
