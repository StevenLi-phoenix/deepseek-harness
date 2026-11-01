/** Wire types and paths of Settings → 课程 DDL: what `GET /api/fork.courses` and `POST /api/fork.courses.poll` answer. */

/** Host route path of the status. */
export const COURSES_PATH = '/api/fork.courses'
/** Host route path that polls now and answers the new status. */
export const COURSES_POLL_PATH = '/api/fork.courses.poll'
/** Document-relative route of the status, for the browser. */
export const COURSES_ROUTE = 'api/fork.courses'
/** Document-relative route of a poll now, for the browser. */
export const COURSES_POLL_ROUTE = 'api/fork.courses.poll'

/** The latest poll. */
export interface PollView {
  readonly at: number
  readonly trigger: 'timer' | 'manual'
  readonly durationMs: number
  readonly ok: boolean
  readonly error: string | null
  readonly openTasks: number | null
  readonly reminders: number | null
  /** What happened to the reminders it found. */
  readonly outcome: 'none' | 'sent' | 'held' | 'failed' | 'disabled' | null
}

/** The course sync collectors, from the service's report. */
export interface SyncView {
  /** `ok`, `degraded`, `failing`, `missing`, or another status the service reports. */
  readonly status: string
  readonly latestRunAt: number | null
  readonly lastCleanAt: number | null
  readonly failedRuns: number
  /** What the newest run says it could not check. */
  readonly reason: string | null
  /** An alert went out and no recovery since. */
  readonly alerting: boolean
}

/** One open deadline and when it is reminded next. */
export interface UpcomingView {
  readonly id: string
  readonly course: string
  readonly title: string
  readonly phase: 'due' | 'late'
  readonly deadline: number
  readonly nextAt: number | null
}

/** One message sent or failed. */
export interface NoteView {
  readonly at: number
  readonly title: string
  readonly body: string
  readonly outcome: 'sent' | 'failed'
  readonly error: string | null
}

/** Body of `GET /api/fork.courses`. */
export interface CoursesView {
  readonly enabled: boolean
  readonly timeZone: string
  readonly beforeHours: readonly number[]
  readonly lateBeforeHours: readonly number[]
  readonly urgentWithinHours: number
  readonly quietHours: { readonly followPresence: boolean; readonly enabled: boolean; readonly start: string; readonly end: string }
  readonly quietNow: boolean
  readonly lastPoll: PollView | null
  readonly nextPollAt: number | null
  readonly polling: boolean
  readonly sync: SyncView | null
  readonly outage: { readonly failures: number; readonly since: number | null; readonly alerted: boolean }
  readonly upcoming: readonly UpcomingView[]
  readonly notes: readonly NoteView[]
}
