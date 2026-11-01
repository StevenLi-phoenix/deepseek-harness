/**
 * The 说话风格 section's store and its loader: one panel read at a time, kept through failures; the owner's edits
 * applied to the page at once (a deleted sample disappears before the Host answers) and then replaced by the Host's
 * panel, which also undoes an edit the Host refused; and a collection run started on demand.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { StyleEdit, StyleEditAnswer, StylePanel } from '../view.ts'

export type { StyleEdit, StyleEditAnswer, StylePanel } from '../view.ts'

/** How often the open section refreshes. */
export const POLL_INTERVAL_MS = 5000

/** What the section renders. */
export interface StyleState {
  /** The last panel; a failed read keeps it. */
  panel: StylePanel | null
  /** Time of the last settled read, answered or not. */
  checkedAt: number | null
  /** The last read failed. */
  stale: boolean
  /** An edit or a run request is on its way. */
  saving: boolean
  /** Why the last edit did not go through (`not_found`, `invalid_input`, `network`); cleared by the next one. */
  error: string | null
}

/** @returns a store holding the not-yet-loaded state. */
export function createStyleStore(): SnapshotStore<StyleState> {
  return createSnapshotStore<StyleState>({ panel: null, checkedAt: null, stale: false, saving: false, error: null })
}

/**
 * Check a panel's outer fields. The Host half of this package wrote the body.
 * @param body - the parsed JSON body.
 * @returns the panel.
 */
export function parsePanel(body: unknown): StylePanel {
  const fields = typeof body === 'object' && body !== null ? body as Partial<Record<keyof StylePanel, unknown>> : {}
  if (typeof fields.enabled !== 'boolean' || !Array.isArray(fields.samples) || !Array.isArray(fields.trend)) throw new Error('unexpected style answer')
  return body as StylePanel
}

/**
 * Check an edit answer.
 * @param body - the parsed JSON body.
 * @returns the answer.
 */
export function parseEditAnswer(body: unknown): StyleEditAnswer {
  const fields = typeof body === 'object' && body !== null ? body as { ok?: unknown; panel?: unknown; error?: unknown } : {}
  const panel = parsePanel(fields.panel)
  return fields.ok === true ? { ok: true, panel } : { ok: false, panel, error: typeof fields.error === 'string' ? fields.error : 'invalid_input' }
}

/** The page applied before the Host answers. */
function optimistic(panel: StylePanel, edit: StyleEdit): StylePanel {
  switch (edit.op) {
    case 'remove':
      return { ...panel, samples: panel.samples.filter(sample => sample.id !== edit.id) }
    case 'keep':
      return { ...panel, samples: panel.samples.map(sample => (sample.id === edit.id ? { ...sample, status: 'active' as const } : sample)) }
    case 'add':
      return panel
  }
}

/** Reads and edits the panel through the Host routes. */
export class StyleLoader {
  private inFlight: Promise<void> | undefined

  /**
   * @param store - the store the section renders.
   * @param transport - the three Host calls; each rejects on transport failure.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<StyleState>,
    private readonly transport: {
      readonly read: () => Promise<StylePanel>
      readonly edit: (edit: StyleEdit) => Promise<StyleEditAnswer>
      readonly collect: () => Promise<StylePanel>
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** @returns settlement after the panel is published; concurrent callers share the read in flight. */
  refresh(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    const request = this.query().finally(() => { this.inFlight = undefined })
    this.inFlight = request
    return request
  }

  private async query(): Promise<void> {
    let panel: StylePanel | undefined
    try {
      panel = await this.transport.read()
    } catch {
      if (!this.store.getSnapshot().stale) console.warn('[lsy-style] panel read failed')
    }
    const at = this.now()
    this.store.update((draft) => {
      draft.checkedAt = at
      draft.stale = panel === undefined
      // An edit on its way owns the page until the Host answers it.
      if (panel !== undefined && !draft.saving) draft.panel = panel
    })
  }

  /**
   * Apply one edit: on the page at once, then as the Host answers.
   * @param edit - remove, keep, or add.
   * @returns whether the Host accepted it.
   */
  async edit(edit: StyleEdit): Promise<boolean> {
    const before = this.store.getSnapshot().panel
    this.store.update((draft) => {
      draft.saving = true
      draft.error = null
      if (draft.panel !== null) draft.panel = optimistic(draft.panel, edit)
    })
    let answer: StyleEditAnswer | undefined
    try {
      answer = await this.transport.edit(edit)
    } catch {
      console.warn('[lsy-style] edit failed')
    }
    this.store.update((draft) => {
      draft.saving = false
      if (answer === undefined) {
        draft.panel = before
        draft.error = 'network'
        return
      }
      draft.panel = answer.panel
      draft.error = answer.ok ? null : answer.error
    })
    return answer?.ok === true
  }

  /** Start a collection run; the panel says `running` until it ends. */
  async collect(): Promise<void> {
    this.store.update((draft) => { draft.saving = true; draft.error = null })
    let panel: StylePanel | undefined
    try {
      panel = await this.transport.collect()
    } catch {
      console.warn('[lsy-style] collection request failed')
    }
    this.store.update((draft) => {
      draft.saving = false
      if (panel === undefined) draft.error = 'network'
      else draft.panel = panel
    })
  }
}

/** The part of `document` the poller watches. */
export interface PageVisibility {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * Refresh now and on a timer while the page is visible; showing a hidden page refreshes at once.
 * @param refresh - one refresh.
 * @param intervalMs - period.
 * @param page - the document; null outside a browser.
 * @returns a stop function.
 */
export function pollWhileVisible(refresh: () => void, intervalMs: number, page: PageVisibility | null = 'document' in globalThis ? globalThis.document : null): () => void {
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
