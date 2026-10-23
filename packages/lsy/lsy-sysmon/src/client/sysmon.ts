/**
 * The system status store and its loader: one request at a time, shared by
 * every caller, keeping the last snapshot through failures; and the poller
 * that refreshes while the section is mounted and the page is visible.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SysmonSnapshot } from '../snapshot.ts'

export type { SysmonSnapshot } from '../snapshot.ts'

/** How often the open section refreshes. */
export const POLL_INTERVAL_MS = 5000

/** What the section renders. */
export interface SysmonState {
  /** The last snapshot the Host answered; a failed refresh keeps it. */
  snapshot: SysmonSnapshot | null
  /** Time of the last settled request, answered or not. */
  checkedAt: number | null
  /** The last request failed, so `snapshot` (if any) is older than `checkedAt`. */
  stale: boolean
  refreshing: boolean
}

/** @returns a store holding the not-yet-loaded state. */
export function createSysmonStore(): SnapshotStore<SysmonState> {
  return createSnapshotStore<SysmonState>({ snapshot: null, checkedAt: null, stale: false, refreshing: false })
}

/**
 * Check a route answer's outer shape. The Host half of this package wrote the
 * body, so its fields are this package's own contract.
 * @param body - the parsed JSON body.
 * @returns the snapshot.
 */
export function parseSnapshot(body: unknown): SysmonSnapshot {
  const fields = typeof body === 'object' && body !== null ? body as Partial<Record<keyof SysmonSnapshot, unknown>> : {}
  if (typeof fields.sampledAt !== 'number' || typeof fields.cpu !== 'object' || typeof fields.memory !== 'object' || !Array.isArray(fields.disks)) {
    throw new Error('unexpected system status answer')
  }
  return body as SysmonSnapshot
}

/** Reads the system status into a store, one request at a time. */
export class SysmonLoader {
  private inFlight: Promise<void> | undefined

  /**
   * @param store - the store the section renders.
   * @param read - one Host route query; rejects on transport failure.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<SysmonState>,
    private readonly read: () => Promise<SysmonSnapshot>,
    private readonly now: () => number = Date.now,
  ) {}

  /** @returns settlement after the answer is published; concurrent callers share the request in flight. */
  refresh(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    this.store.update((draft) => { draft.refreshing = true })
    const request = this.query().finally(() => { this.inFlight = undefined })
    this.inFlight = request
    return request
  }

  private async query(): Promise<void> {
    let snapshot: SysmonSnapshot | undefined
    try {
      snapshot = await this.read()
    } catch {
      // Warn when the reading goes stale, not on every poll after that.
      if (!this.store.getSnapshot().stale) console.warn('[lsy-sysmon] system status read failed')
    }
    const at = this.now()
    this.store.update((draft) => {
      draft.refreshing = false
      draft.checkedAt = at
      draft.stale = snapshot === undefined
      if (snapshot !== undefined) draft.snapshot = snapshot
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
