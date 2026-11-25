/**
 * The quiet-hours store, its loader, and its poller: one status request at a time shared by every
 * caller, the last view kept through failures, and the buttons posted to the same route.
 */

import { shareInFlight } from '@deepseek-ai/dsh-settings-kit/client'
import { runAction } from '../action.ts'
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
  const { window, signalSilent, timeZone, asleep } = view as Record<string, unknown>
  if (typeof asleep !== 'boolean' || typeof timeZone !== 'string' || typeof window !== 'object' || window === null || typeof signalSilent !== 'boolean') {
    throw new Error('unexpected quiet-hours answer')
  }
  return body as PresenceAnswer
}

/** Reads the view into a store, one request at a time, and posts the buttons. */
export class PresenceLoader {
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
  readonly refresh: () => Promise<void> = shareInFlight(() => this.query())

  /**
   * Press one button: busy at once, then its answer or its error.
   * @param action - the button.
   */
  async act(action: PresenceAction): Promise<void> {
    await runAction(this.store, action.action, async () => {
      const answer = await this.post(action)
      const at = this.now()
      this.store.update((draft) => {
        draft.view = answer.view
        draft.checkedAt = at
        draft.stale = false
        if (action.action === 'flush') draft.flushed = answer.flushed
      })
    }, (draft) => { if (action.action === 'flush') draft.flushed = null })
  }

  private async query(): Promise<void> {
    let answer: PresenceAnswer | undefined
    try {
      answer = await this.read()
    } catch {
      // Warn when the view goes stale, not on every poll after that.
      if (!this.store.getSnapshot().stale) console.warn('[presence] status read failed')
    }
    const at = this.now()
    this.store.update((draft) => {
      draft.checkedAt = at
      draft.stale = answer === undefined
      if (answer !== undefined) draft.view = answer.view
    })
  }
}
