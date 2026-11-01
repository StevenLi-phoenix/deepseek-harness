/**
 * The section's store and loader: one request at a time, shared by every caller, keeping the last answer through
 * failures; a poll now (POST) replaces the answer with the one it returns. Also the text of each card, decided
 * without a DOM.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CoursesView, PollView, SyncView, UpcomingView } from '../view.ts'
import type { CoursesKey } from './locales.ts'

/** How often the open section refreshes. */
export const POLL_INTERVAL_MS = 15_000

/** What the section renders. */
export interface CoursesState {
  view: CoursesView | null
  /** The last read failed, so `view` (if any) is older. */
  stale: boolean
  /** A poll now is running. */
  checking: boolean
}

/**
 * A store for the section.
 * @returns a store holding the not-yet-loaded state.
 */
export function createCoursesStore(): SnapshotStore<CoursesState> {
  return createSnapshotStore<CoursesState>({ view: null, stale: false, checking: false })
}

/**
 * Check a route answer's outer fields. The Host half of this package wrote the body.
 * @param body - the parsed JSON body.
 * @returns the view.
 */
export function parseView(body: unknown): CoursesView {
  const fields = typeof body === 'object' && body !== null ? body as Partial<Record<keyof CoursesView, unknown>> : {}
  if (typeof fields.enabled !== 'boolean' || !Array.isArray(fields.upcoming) || !Array.isArray(fields.notes) || typeof fields.timeZone !== 'string') {
    throw new Error('unexpected course deadline answer')
  }
  return body as CoursesView
}

/** Reads the status into the store, and runs a poll now. */
export class CoursesLoader {
  private inFlight: Promise<void> | undefined

  /**
   * @param store - the store the section renders.
   * @param read - `GET api/fork.courses`.
   * @param check - `POST api/fork.courses.poll`.
   */
  constructor(
    private readonly store: SnapshotStore<CoursesState>,
    private readonly read: () => Promise<CoursesView>,
    private readonly check: () => Promise<CoursesView>,
  ) {}

  /**
   * Read the status once.
   * @returns settlement after the answer is published; concurrent callers share the request in flight.
   */
  refresh(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    const request = this.apply(this.read).finally(() => { this.inFlight = undefined })
    this.inFlight = request
    return request
  }

  /**
   * Run one poll on the Host; a second call while one runs does nothing.
   * @returns settlement after the poll's answer is published.
   */
  async checkNow(): Promise<void> {
    if (this.store.getSnapshot().checking) return
    this.store.update((draft) => { draft.checking = true })
    try {
      await this.apply(this.check)
    } finally {
      this.store.update((draft) => { draft.checking = false })
    }
  }

  private async apply(source: () => Promise<CoursesView>): Promise<void> {
    let view: CoursesView | undefined
    try {
      view = await source()
    } catch {
      // Warn when the reading goes stale, not on every refresh after that.
      if (!this.store.getSnapshot().stale) console.warn('[fork-courses-settings] course deadline status read failed')
    }
    this.store.update((draft) => {
      draft.stale = view === undefined
      if (view !== undefined) draft.view = view
    })
  }
}

/** The section's `t`. */
export type Translate = (key: CoursesKey, params?: Record<string, string | number>) => string

/**
 * An instant in the view's zone, as `11/2 22:00`.
 * @param at - Unix epoch milliseconds.
 * @param timeZone - IANA zone.
 * @returns the label.
 */
export function clock(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).replace(',', '')
}

/**
 * The last poll as one line.
 * @param poll - the latest poll, or null.
 * @param timeZone - IANA zone.
 * @param t - the section's copy.
 * @returns the line.
 */
export function pollLine(poll: PollView | null, timeZone: string, t: Translate): string {
  if (poll === null) return t('poll.none')
  const time = clock(poll.at, timeZone)
  if (!poll.ok) return t('poll.failed', { time, error: poll.error ?? '' })
  const count = poll.reminders ?? 0
  const result = poll.outcome === 'sent' ? t('result.sent', { count })
    : poll.outcome === 'held' ? t('result.held', { count })
      : poll.outcome === 'failed' ? t('result.failed', { count })
        : poll.outcome === 'disabled' ? t('result.disabled')
          : t('result.none')
  return t('poll.ok', { time, tasks: poll.openTasks ?? 0, result })
}

/**
 * The sync card's tone and lines.
 * @param sync - the sync health, or null before the first poll.
 * @param timeZone - IANA zone.
 * @param t - the section's copy.
 * @returns the tone and the lines.
 */
export function syncLines(sync: SyncView | null, timeZone: string, t: Translate): { tone: 'ok' | 'warn' | 'idle'; lines: string[] } {
  if (sync === null) return { tone: 'idle', lines: [t('sync.unknown')] }
  if (sync.status === 'ok') return { tone: 'ok', lines: [t('sync.ok', { time: sync.latestRunAt === null ? '—' : clock(sync.latestRunAt, timeZone) })] }
  const known = ['degraded', 'failing', 'missing'].includes(sync.status)
  const status = known ? t(`sync.status.${sync.status}` as CoursesKey) : sync.status
  const lines = [t('sync.broken', { status, clean: sync.lastCleanAt === null ? t('sync.never') : clock(sync.lastCleanAt, timeZone), count: sync.failedRuns })]
  if (sync.reason !== null) lines.push(t('sync.reason', { reason: sync.reason }))
  if (sync.alerting) lines.push(t('sync.alerting'))
  return { tone: 'warn', lines }
}

/**
 * One upcoming row's deadline and next-reminder text.
 * @param row - the row.
 * @param timeZone - IANA zone.
 * @param t - the section's copy.
 * @returns both texts.
 */
export function upcomingText(row: UpcomingView, timeZone: string, t: Translate): { when: string; next: string } {
  const time = clock(row.deadline, timeZone)
  return {
    when: row.phase === 'late' ? t('upcoming.late', { time }) : t('upcoming.due', { time }),
    next: row.nextAt === null ? t('upcoming.noNext') : t('upcoming.next', { time: clock(row.nextAt, timeZone) }),
  }
}

/**
 * The rules as lines.
 * @param view - the status.
 * @param t - the section's copy.
 * @returns the lines.
 */
export function ruleLines(view: CoursesView, t: Translate): string[] {
  const lines = [
    t('rules.before', { hours: view.beforeHours.join(' / ') }),
    t('rules.late', { hours: view.lateBeforeHours.join(' / ') }),
  ]
  if (view.quietHours.followPresence) lines.push(t('rules.quietPresence'))
  if (view.quietHours.enabled) lines.push(t('rules.quietWindow', { start: view.quietHours.start, end: view.quietHours.end }))
  lines.push(view.urgentWithinHours > 0 ? t('rules.urgent', { hours: view.urgentWithinHours }) : t('rules.urgentOff'))
  lines.push(t('rules.zone', { zone: view.timeZone }))
  return lines
}
