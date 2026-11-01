/**
 * The Memory settings store and its loader: the list is read one request at a time (a changed query starts a
 * new read and drops the old one's answer), waiting writes leave the page at once when the owner answers them
 * and come back if the Host refuses, and the two destructive flows (rollback, erase) always show the Host's
 * preview before they apply it with the preview's token.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  PAGE_SIZE,
  type ActionResult, type DetailView, type MemoryAction, type MemoryQuery, type MemoryView,
} from '../view.ts'

export type { ActionResult, DetailView, MemoryAction, MemoryQuery, MemoryView } from '../view.ts'

/** How often the open section refreshes. */
export const POLL_INTERVAL_MS = 10_000

/** A rollback preview, as the Host answers it. */
export type RollbackPreview = Extract<ActionResult, { action: 'rollback'; stage: 'preview' }>
/** An erase preview, as the Host answers it. */
export type PurgePreview = Extract<ActionResult, { action: 'forget'; stage: 'preview' }>

/** The Session and/or time a rollback goes back to. */
export interface RollbackTarget {
  session?: string
  since?: string
}

/** Where a rollback is: asking for the preview, showing it, applying it, or finished. */
export interface RollbackFlow {
  readonly target: RollbackTarget
  readonly stage: 'previewing' | 'ready' | 'applying' | 'done'
  readonly preview?: RollbackPreview
  readonly restored?: number
  readonly removed?: number
}

/** Where an erase is. */
export interface PurgeFlow {
  readonly ids: readonly string[]
  readonly stage: 'previewing' | 'ready' | 'applying'
  readonly preview?: PurgePreview
}

/** One entry's detail: loading, in hand, or unreadable. */
export type DetailState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly detail: DetailView } | { readonly status: 'error' }

/** Why the last action failed. */
export interface ActionError {
  readonly code: string | null
  readonly message: string
}

/** What the section renders. */
export interface MemoryState {
  /** The last view the Host answered; a failed refresh keeps it. */
  view: MemoryView | null
  /** The list's filter and page, which every read carries. */
  query: MemoryQuery
  /** Time of the last settled read, answered or not. */
  checkedAt: number | null
  /** The last read failed, so `view` (if any) is older than `checkedAt`. */
  stale: boolean
  /** Waiting writes the owner answered, hidden until the Host confirms or refuses. */
  hiding: string[]
  /** Ids with an action in flight. */
  busy: string[]
  details: Record<string, DetailState>
  rollback: RollbackFlow | null
  purge: PurgeFlow | null
  error: ActionError | null
}

/** @returns a store holding the not-yet-loaded state. */
export function createMemoryStore(): SnapshotStore<MemoryState> {
  return createSnapshotStore<MemoryState>({
    view: null,
    query: { q: '', category: 'all', offset: 0, limit: PAGE_SIZE },
    checkedAt: null,
    stale: false,
    hiding: [],
    busy: [],
    details: {},
    rollback: null,
    purge: null,
    error: null,
  })
}

/**
 * Check a read answer's outer shape. The Host half of this package wrote the body, so its fields are this
 * package's own contract.
 * @param body - the parsed JSON body.
 * @returns the view.
 */
export function parseView(body: unknown): MemoryView {
  const fields = typeof body === 'object' && body !== null ? body as Partial<Record<keyof MemoryView, unknown>> : {}
  if (!Array.isArray(fields.pending) || typeof fields.entries !== 'object' || fields.entries === null || typeof fields.counts !== 'object') {
    throw new Error('unexpected memory answer')
  }
  return body as MemoryView
}

/** A Host refusal, with its code when it gave one. */
export class MemoryRequestError extends Error {
  constructor(message: string, readonly code: string | null = null) {
    super(message)
  }
}

/** The three calls the loader makes. */
export interface MemoryApi {
  read(query: MemoryQuery): Promise<MemoryView>
  detail(id: string): Promise<DetailView>
  post(action: MemoryAction): Promise<ActionResult>
}

const asError = (error: unknown): ActionError => {
  if (error instanceof MemoryRequestError) return { code: error.code, message: error.message }
  return { code: null, message: error instanceof Error ? error.message : String(error) }
}

const without = (list: readonly string[], ids: readonly string[]): string[] => list.filter(id => !ids.includes(id))

/** The actions the section calls; every one answers at once and settles when the Host has. */
export interface MemoryActions {
  refresh(): Promise<void>
  setQuery(patch: Partial<MemoryQuery>): Promise<void>
  review(op: 'approve' | 'discard' | 'revert', ids: readonly string[]): Promise<void>
  loadDetail(id: string): Promise<void>
  rollbackPreview(target: RollbackTarget): Promise<void>
  rollbackApply(): Promise<void>
  rollbackCancel(): void
  purgePreview(ids: readonly string[]): Promise<void>
  purgeApply(): Promise<void>
  purgeCancel(): void
  feedbackAdd(input: Extract<MemoryAction, { action: 'feedback.add' }>): Promise<boolean>
  feedbackForget(id: string): Promise<void>
  dismissError(): void
}

/** Reads the memory view into a store and carries the owner's actions to the Host. */
export class MemoryLoader implements MemoryActions {
  private inFlight: Promise<void> | undefined
  private generation = 0

  /**
   * @param store - the store the section renders.
   * @param api - the Host calls.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<MemoryState>,
    private readonly api: MemoryApi,
    private readonly now: () => number = Date.now,
  ) {}

  /** @returns settlement after the answer is published; concurrent callers share the read in flight. */
  refresh(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    const request: Promise<void> = this.query().finally(() => { if (this.inFlight === request) this.inFlight = undefined })
    this.inFlight = request
    return request
  }

  /**
   * Change the list's filter or page and read again; a filter change goes back to the first page.
   * @param patch - fields to change.
   */
  setQuery(patch: Partial<MemoryQuery>): Promise<void> {
    this.store.update((draft) => {
      const moved = patch.offset !== undefined
      draft.query = { ...draft.query, ...moved ? {} : { offset: 0 }, ...patch }
    })
    // The answer to the old query is dropped when it lands.
    return this.reload()
  }

  /**
   * Answer waiting writes, or undo entries' latest change. Waiting writes leave the page at once.
   * @param op - `approve` keeps, `discard` drops, `revert` undoes.
   * @param ids - waiting-write or entry ids.
   */
  async review(op: 'approve' | 'discard' | 'revert', ids: readonly string[]): Promise<void> {
    const optimistic = op !== 'revert'
    this.store.update((draft) => {
      draft.busy = [...new Set([...draft.busy, ...ids])]
      if (optimistic) draft.hiding = [...new Set([...draft.hiding, ...ids])]
      draft.error = null
    })
    try {
      const result = await this.api.post({ action: op, ids: [...ids] })
      if (result.action === 'approve' || result.action === 'discard' || result.action === 'revert') {
        const failed = result.results.filter(item => !item.ok)
        if (failed.length > 0) {
          this.store.update((draft) => {
            draft.hiding = without(draft.hiding, failed.map(item => item.id))
            draft.error = { code: failed[0]?.failure?.code ?? null, message: failed.map(item => item.failure?.message ?? item.id).join(' ') }
          })
        }
      }
    } catch (error: unknown) {
      this.store.update((draft) => {
        draft.hiding = without(draft.hiding, ids)
        draft.error = asError(error)
      })
    }
    this.forgetDetails(ids)
    await this.reload()
    this.store.update((draft) => {
      draft.busy = without(draft.busy, ids)
      draft.hiding = without(draft.hiding, ids)
    })
  }

  /**
   * Fetch one entry in full with its history.
   * @param id - entry or waiting-write id.
   */
  async loadDetail(id: string): Promise<void> {
    if (this.store.getSnapshot().details[id]?.status === 'ready') return
    this.store.update((draft) => { draft.details[id] = { status: 'loading' } })
    try {
      const detail = await this.api.detail(id)
      this.store.update((draft) => { draft.details[id] = { status: 'ready', detail } })
    } catch {
      this.store.update((draft) => { draft.details[id] = { status: 'error' } })
    }
  }

  /**
   * Ask the Host what a rollback would do. Nothing changes until {@link rollbackApply}.
   * @param target - the Session and/or time to go back to.
   */
  async rollbackPreview(target: RollbackTarget): Promise<void> {
    this.store.update((draft) => {
      draft.rollback = { target, stage: 'previewing' }
      draft.error = null
    })
    try {
      const preview = await this.api.post({ action: 'rollback', ...target })
      if (preview.action !== 'rollback' || preview.stage !== 'preview') throw new Error('unexpected rollback answer')
      this.store.update((draft) => { draft.rollback = { target, stage: 'ready', preview } })
    } catch (error: unknown) {
      this.store.update((draft) => {
        draft.rollback = null
        draft.error = asError(error)
      })
    }
  }

  /** Apply the rollback exactly as previewed; the Host refuses if memory changed since. */
  async rollbackApply(): Promise<void> {
    const flow = this.store.getSnapshot().rollback
    if (flow?.stage !== 'ready' || flow.preview === undefined) return
    const { target, preview } = flow
    this.store.update((draft) => { draft.rollback = { target, stage: 'applying', preview } })
    try {
      const done = await this.api.post({ action: 'rollback', ...target, confirm: preview.token })
      if (done.action !== 'rollback' || done.stage !== 'done') throw new Error('unexpected rollback answer')
      this.store.update((draft) => { draft.rollback = { target, stage: 'done', restored: done.restored, removed: done.removed } })
      this.store.update((draft) => { draft.details = {} })
    } catch (error: unknown) {
      this.store.update((draft) => {
        draft.rollback = null
        draft.error = asError(error)
      })
    }
    await this.reload()
  }

  /** Close the rollback preview or its result. */
  rollbackCancel(): void {
    this.store.update((draft) => { draft.rollback = null })
  }

  /**
   * Ask the Host what erasing entries would remove. Nothing changes until {@link purgeApply}.
   * @param ids - entry ids.
   */
  async purgePreview(ids: readonly string[]): Promise<void> {
    this.store.update((draft) => {
      draft.purge = { ids, stage: 'previewing' }
      draft.error = null
    })
    try {
      const preview = await this.api.post({ action: 'forget', ids: [...ids] })
      if (preview.action !== 'forget' || preview.stage !== 'preview') throw new Error('unexpected erase answer')
      this.store.update((draft) => { draft.purge = { ids, stage: 'ready', preview } })
    } catch (error: unknown) {
      this.store.update((draft) => {
        draft.purge = null
        draft.error = asError(error)
      })
    }
  }

  /** Erase exactly what was previewed; the Host refuses if it changed since. */
  async purgeApply(): Promise<void> {
    const flow = this.store.getSnapshot().purge
    if (flow?.stage !== 'ready' || flow.preview === undefined) return
    const { ids, preview } = flow
    this.store.update((draft) => { draft.purge = { ids, stage: 'applying', preview } })
    try {
      await this.api.post({ action: 'forget', ids: [...ids], confirm: preview.token })
      this.store.update((draft) => { draft.purge = null })
    } catch (error: unknown) {
      this.store.update((draft) => {
        draft.purge = null
        draft.error = asError(error)
      })
    }
    this.forgetDetails(ids)
    await this.reload()
  }

  /** Close the erase confirmation. */
  purgeCancel(): void {
    this.store.update((draft) => { draft.purge = null })
  }

  /**
   * Record a verdict on a persona reply.
   * @param input - the verdict.
   * @returns whether the Host took it.
   */
  async feedbackAdd(input: Extract<MemoryAction, { action: 'feedback.add' }>): Promise<boolean> {
    this.store.update((draft) => { draft.error = null })
    try {
      await this.api.post(input)
    } catch (error: unknown) {
      this.store.update((draft) => { draft.error = asError(error) })
      return false
    }
    await this.reload()
    return true
  }

  /**
   * Remove a recorded verdict.
   * @param id - verdict id.
   */
  async feedbackForget(id: string): Promise<void> {
    this.store.update((draft) => {
      draft.busy = [...draft.busy, id]
      draft.error = null
    })
    try {
      await this.api.post({ action: 'feedback.forget', id })
    } catch (error: unknown) {
      this.store.update((draft) => { draft.error = asError(error) })
    }
    await this.reload()
    this.store.update((draft) => { draft.busy = without(draft.busy, [id]) })
  }

  /** Clear the last action's error. */
  dismissError(): void {
    this.store.update((draft) => { draft.error = null })
  }

  /** Read again after a change, dropping any read that started before it. */
  private reload(): Promise<void> {
    this.generation += 1
    this.inFlight = undefined
    return this.refresh()
  }

  private forgetDetails(ids: readonly string[]): void {
    this.store.update((draft) => { for (const id of ids) Reflect.deleteProperty(draft.details, id) })
  }

  private async query(): Promise<void> {
    const generation = this.generation
    const asked = this.store.getSnapshot().query
    let view: MemoryView | undefined
    try {
      view = await this.api.read(asked)
    } catch {
      // Warn when the reading goes stale, not on every poll after that.
      if (!this.store.getSnapshot().stale) console.warn('[lsy-memory-admin] memory read failed')
    }
    if (generation !== this.generation) return
    const at = this.now()
    this.store.update((draft) => {
      draft.checkedAt = at
      draft.stale = view === undefined
      if (view !== undefined) draft.view = view
    })
    // A page past the end (entries were removed) goes back to the last page that has any.
    if (view !== undefined && view.entries.items.length === 0 && view.entries.matched > 0) {
      const last = Math.floor((view.entries.matched - 1) / asked.limit) * asked.limit
      if (last < asked.offset) await this.setQuery({ offset: last })
    }
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
