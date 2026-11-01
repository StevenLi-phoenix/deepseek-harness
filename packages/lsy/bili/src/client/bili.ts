/**
 * The Bilibili account store, its loader, and its poller: one request at a
 * time shared by every caller, the last view kept through failures, and owner
 * actions posted to the same route.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ActionResult, BiliAction, BiliView } from '../view.ts'

export type { BiliAction, BiliView } from '../view.ts'

/** How often the open section refreshes. */
export const POLL_INTERVAL_MS = 5000
/** How often a QR sign-in waiting for a scan is asked. */
export const LOGIN_POLL_MS = 2000
/** Ledger rows shown at first. */
export const LEDGER_PAGE = 20
/** Most ledger rows Settings asks for. */
export const LEDGER_MAX = 100

/** What the section renders. */
export interface BiliState {
  /** The last view the Host answered; a failed refresh keeps it. */
  view: BiliView | null
  /** Time of the last settled request, answered or not. */
  checkedAt: number | null
  /** The last request failed, so `view` (if any) is older than `checkedAt`. */
  stale: boolean
  /** The owner action in flight, with the account it is about. */
  busy: { action: BiliAction['action']; account: string | null } | null
  /** Why the last owner action failed. */
  error: string | null
  /** bili-svc's or the Host's code for the failure (`mode_refused`, `not_owner`, …), when it gave one. */
  errorCode: string | null
  /** What the last action did, and when. */
  result: { value: ActionResult; at: number } | null
  /** Ledger rows asked for. */
  ledgerLimit: number
}

/** @returns a store holding the not-yet-loaded state. */
export function createBiliStore(): SnapshotStore<BiliState> {
  return createSnapshotStore<BiliState>({
    view: null, checkedAt: null, stale: false, busy: null, error: null, errorCode: null, result: null, ledgerLimit: LEDGER_PAGE,
  })
}

/**
 * Check a route answer's outer shape. The Host half of this package wrote the
 * body, so its fields are this package's own contract.
 * @param body - the parsed JSON body.
 * @returns the view.
 */
export function parseView(body: unknown): BiliView {
  const fields = typeof body === 'object' && body !== null ? body as Partial<Record<keyof BiliView, unknown>> : {}
  if (
    typeof fields.account !== 'object' || fields.account === null || typeof fields.ownerMid !== 'number' || typeof fields.timeZone !== 'string'
    || !Array.isArray(fields.accounts) || !Array.isArray(fields.logins) || typeof fields.manage !== 'boolean'
  ) {
    throw new Error('unexpected Bilibili account answer')
  }
  return body as BiliView
}

/** A route failure with the code the Host gave it. */
export class RouteError extends Error {
  /**
   * @param message - the Host's words.
   * @param code - the Host's error code, or null.
   */
  constructor(message: string, readonly code: string | null) {
    super(message)
    this.name = 'RouteError'
  }
}

/** What an action changes in the view before the Host answers: only stopping is shown ahead, since bili-svc may refuse automatic. */
function optimistic(view: BiliView, action: BiliAction): BiliView {
  if (action.action !== 'gate.mode' || action.mode !== 'readonly' || view.gate === null) return view
  return { ...view, gate: { ...view.gate, mode: action.mode, readonly: true } }
}

/** Reads the view into a store, one request at a time, and posts owner actions. */
export class BiliLoader {
  private inFlight: Promise<void> | undefined
  private quietInFlight = false

  /**
   * @param store - the store the section renders.
   * @param read - one GET of the route with the ledger rows wanted; rejects on transport failure.
   * @param post - one owner action; resolves with the new view.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<BiliState>,
    private readonly read: (ledgerLimit: number) => Promise<BiliView>,
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
   * Post one owner action and publish the view it answers. Switching the gate to read-only shows at
   * once and goes back if the Host refuses.
   * @param action - the action.
   */
  async act(action: BiliAction): Promise<void> {
    const before = this.store.getSnapshot().view
    this.store.update((draft) => {
      draft.busy = { action: action.action, account: 'account' in action ? action.account : null }
      draft.error = null
      draft.errorCode = null
      draft.result = null
      if (before !== null) draft.view = optimistic(before, action)
    })
    try {
      const view = await this.post(action)
      const at = this.now()
      this.store.update((draft) => {
        draft.view = view
        draft.checkedAt = at
        draft.stale = false
        if (view.result !== null) draft.result = { value: view.result, at }
        if (action.action === 'ledger') draft.ledgerLimit = action.limit
      })
    } catch (error: unknown) {
      this.store.update((draft) => {
        draft.error = error instanceof Error ? error.message : String(error)
        draft.errorCode = error instanceof RouteError ? error.code : null
        draft.view = before
      })
    } finally {
      this.store.update((draft) => { draft.busy = null })
    }
  }

  /**
   * Post a background action (a QR sign-in's poll): no busy state and no error banner, and never two at once.
   * @param action - the action.
   */
  async quiet(action: BiliAction): Promise<void> {
    if (this.quietInFlight || this.store.getSnapshot().busy !== null) return
    this.quietInFlight = true
    try {
      const view = await this.post(action)
      const at = this.now()
      this.store.update((draft) => {
        draft.view = view
        draft.checkedAt = at
        draft.stale = false
        if (view.result?.outcome === 'done') draft.result = { value: view.result, at }
      })
    } catch {
      // The next poll or the 5 s refresh shows the state; a banner per failed poll would only flicker.
      console.warn('[bili] background action failed')
    } finally {
      this.quietInFlight = false
    }
  }

  private async query(): Promise<void> {
    let view: BiliView | undefined
    try {
      view = await this.read(this.store.getSnapshot().ledgerLimit)
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
