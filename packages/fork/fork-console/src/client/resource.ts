/**
 * One polled Host resource: a snapshot store, a loader that runs one request at a time and keeps the last answer through
 * failures, and a poller that works only while the section is mounted and the page is visible. Actions run through the same
 * loader: the click shows its effect at once (an optimistic patch, or a busy mark), the Host's answer replaces it, and a
 * refusal puts the previous data back and says why.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ActionError, ActionErrorCode } from '../views.ts'

/** How often an open section refreshes. */
export const POLL_INTERVAL_MS = 10_000

/** What the owner is told about the last action. */
export interface Notice {
  readonly kind: 'error'
  readonly code: ActionErrorCode | 'network'
  readonly detail?: string | undefined
}

/** What a section renders. */
export interface ResourceState<T> {
  /** The last answer; a failed refresh keeps it. */
  data: T | null
  /** Time of the last settled read, answered or not. */
  checkedAt: number | null
  /** The last read failed, so `data` (if any) is older than `checkedAt`. */
  stale: boolean
  refreshing: boolean
  /** Actions in flight by key, for example `pause:octo-tags`; the row shows them as busy. */
  busy: Record<string, true>
  /** The last refused or failed action. */
  notice: Notice | null
}

/**
 * Create the store a resource view reads from.
 * @returns a store holding the not-yet-loaded state.
 */
export function createResourceStore<T>(): SnapshotStore<ResourceState<T>> {
  return createSnapshotStore<ResourceState<T>>({ data: null, checkedAt: null, stale: false, refreshing: false, busy: {}, notice: null })
}

/** A copy of the busy marks without one key. */
function without(busy: Record<string, true>, key: string): Record<string, true> {
  return Object.fromEntries(Object.entries(busy).filter(([name]) => name !== key))
}

/** A refusal or transport failure of a POST, with the Host's code when it sent one. */
export class ActionFailure extends Error {
  override readonly name = 'ActionFailure'

  /**
   * @param code - the Host's code, or `network`.
   * @param detail - the Host's short reason.
   */
  constructor(readonly code: ActionErrorCode | 'network', readonly detail?: string) {
    super(code)
  }
}

/**
 * Read a failed response into an {@link ActionFailure}.
 * @param response - a non-2xx response.
 * @returns the failure.
 */
export async function failureOf(response: Response): Promise<ActionFailure> {
  const body = await response.json().catch(() => ({})) as Partial<ActionError>
  return new ActionFailure(typeof body.error === 'string' ? body.error : 'internal_error', typeof body.detail === 'string' ? body.detail : undefined)
}

/** Reads one Host resource into a store, one request at a time. */
export class ResourceLoader<T> {
  private inFlight: Promise<void> | undefined

  /**
   * @param label - log label, for example `subscriptions`.
   * @param store - the store the section renders.
   * @param read - one GET; rejects on transport failure.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly label: string,
    private readonly store: SnapshotStore<ResourceState<T>>,
    private readonly read: () => Promise<T>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Reload the resource and publish the answer.
   * @returns settlement after the answer is published; concurrent callers share the request in flight. */
  refresh(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    this.store.update((draft) => { draft.refreshing = true })
    const request = this.query().finally(() => { this.inFlight = undefined })
    this.inFlight = request
    return request
  }

  private async query(): Promise<void> {
    let data: T | undefined
    try {
      data = await this.read()
    } catch {
      // Warn when the reading goes stale, not on every poll after that.
      if (!this.store.getSnapshot().stale) console.warn(`[fork-console] ${this.label} read failed`)
    }
    const at = this.now()
    this.store.update((draft) => {
      draft.refreshing = false
      draft.checkedAt = at
      draft.stale = data === undefined
      if (data !== undefined) draft.data = data
    })
  }

  /**
   * Run one action: mark it busy and apply `optimistic` at once, then take the Host's answer or put the old data back.
   * @param key - what is acted on, for the busy mark.
   * @param send - the POST; resolves to the fresh resource, rejects with an {@link ActionFailure} or a transport error.
   * @param optimistic - patch applied to the data before the answer arrives.
   * @returns true when the Host accepted the action.
   */
  async act(key: string, send: () => Promise<T>, optimistic?: (data: T) => T): Promise<boolean> {
    const before = this.store.getSnapshot().data
    const started = this.now()
    this.store.update((draft) => {
      draft.busy[key] = true
      draft.notice = null
      if (optimistic !== undefined && draft.data !== null) draft.data = optimistic(draft.data)
    })
    try {
      const fresh = await send()
      this.store.update((draft) => {
        draft.busy = without(draft.busy, key)
        draft.data = fresh
        draft.checkedAt = this.now()
        draft.stale = false
      })
      console.info(`[fork-console] ${this.label} ${key} ok (${this.now() - started} ms)`)
      return true
    } catch (error: unknown) {
      const failure = error instanceof ActionFailure ? error : new ActionFailure('network')
      console.warn(`[fork-console] ${this.label} ${key} ${failure.code} (${this.now() - started} ms)`)
      this.store.update((draft) => {
        draft.busy = without(draft.busy, key)
        draft.data = before
        draft.notice = { kind: 'error', code: failure.code, detail: failure.detail }
      })
      return false
    }
  }

  /** Clear the notice. */
  dismiss(): void {
    this.store.update((draft) => { draft.notice = null })
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
 * Refresh now and every `intervalMs` while the page is visible; a hidden page stops the timer and showing it again refreshes at once.
 * @param refresh - one refresh; the loader shares a request in flight.
 * @param intervalMs - polling period.
 * @param page - visibility source; null polls without one.
 * @returns a stop function.
 */
export function startPolling(
  refresh: () => void, intervalMs: number = POLL_INTERVAL_MS, page: VisibilitySource | null = currentPage(),
): () => void {
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

/**
 * GET or POST a Host route with the sign-in cookie.
 * @param route - document-relative route.
 * @param init - request options; a body is sent as JSON.
 * @returns the parsed JSON body.
 * @throws {ActionFailure} for a refusal, or on a transport failure (`network`).
 */
export async function requestJson<R>(route: string, init: { body?: unknown } = {}): Promise<R> {
  let response: Response
  try {
    response = await fetch(route, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init.body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) },
    })
  } catch {
    throw new ActionFailure('network')
  }
  if (!response.ok) throw await failureOf(response)
  return await response.json() as R
}
