/**
 * The parts of the courses service's answers this package reads, parsed at the wire: report and query task
 * summaries, the report's sync health, and a sync run's coverage. Unknown fields are ignored so the service can
 * add fields; a missing required one fails the whole answer, because a reminder computed from half a record could
 * be wrong in either direction.
 */
import { z } from 'zod'

const instant = z.string().nullish().transform(value => (value === null || value === undefined ? null : Date.parse(value)))
  .refine(value => value === null || Number.isFinite(value), 'not a date')

const taskSchema = z.object({
  id: z.string().min(1),
  kind: z.string(),
  version: z.number().int().nonnegative(),
  title: z.string(),
  course_id: z.string().nullish(),
  course_name: z.string().nullish(),
  parent_task_id: z.string().nullish(),
  parent_title: z.string().nullish(),
  parts_done: z.number().nullish(),
  parts_total: z.number().nullish(),
  due_at: instant,
  late_at: instant,
  closes_at: instant,
  deadline_certainty: z.string().nullish(),
  progress_status: z.string().nullish(),
  percent: z.number().nullish(),
  submission_status: z.string().nullish(),
  submission_verified: z.boolean().nullish(),
  remaining_work: z.string().nullish(),
  last_checked_at: instant,
  updated_at: instant,
  source_links: z.array(z.object({ label: z.string(), url: z.string(), kind: z.string().optional() })).nullish(),
})

/** One task summary, with times in Unix epoch milliseconds. */
export interface TaskSummary {
  readonly id: string
  readonly version: number
  readonly title: string
  readonly courseId: string | null
  readonly course: string
  readonly parentId: string | null
  readonly parentTitle: string | null
  readonly partsDone: number | null
  readonly partsTotal: number | null
  readonly dueAt: number | null
  readonly lateAt: number | null
  readonly closesAt: number | null
  readonly certainty: string
  readonly progress: string
  readonly percent: number | null
  readonly submission: string
  readonly submissionVerified: boolean
  readonly remainingWork: string | null
  /** `last_checked_at`, else `updated_at`: what the service calls "Last update at". */
  readonly checkedAt: number | null
  readonly links: ReadonlyArray<{ readonly label: string; readonly url: string }>
}

/**
 * A course name without its catalogue suffix (`Introduction to X — CS-UY 1234 A` → `Introduction to X`).
 * @param name - `course_name`.
 * @returns the short name, or the whole name when it has no suffix.
 */
export function shortCourse(name: string | null | undefined): string {
  /* v8 ignore next -- split() always yields a first element; ?? only satisfies noUncheckedIndexedAccess. */
  const head = (name ?? '').split(' — ')[0]?.trim() ?? ''
  return head === '' ? (name ?? '').trim() : head
}

/**
 * Parse task summaries; rows of other kinds (memos, reminders) are skipped.
 * @param items - `report.items`, `report.undated.items`, or `query.records`.
 * @returns the tasks.
 * @throws {z.ZodError} when a task row lacks a field this package needs.
 */
export function parseTasks(items: readonly unknown[]): TaskSummary[] {
  const tasks: TaskSummary[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null || (item as { kind?: unknown }).kind !== 'task') continue
    const row = taskSchema.parse(item)
    tasks.push({
      id: row.id,
      version: row.version,
      title: row.title,
      courseId: row.course_id ?? null,
      course: shortCourse(row.course_name),
      parentId: row.parent_task_id ?? null,
      parentTitle: row.parent_title ?? null,
      partsDone: row.parts_done ?? null,
      partsTotal: row.parts_total ?? null,
      dueAt: row.due_at,
      lateAt: row.late_at,
      closesAt: row.closes_at,
      certainty: row.deadline_certainty ?? 'unknown',
      progress: row.progress_status ?? 'not_started',
      percent: row.percent ?? null,
      submission: row.submission_status ?? 'unknown',
      submissionVerified: row.submission_verified ?? false,
      remainingWork: row.remaining_work ?? null,
      checkedAt: row.last_checked_at ?? row.updated_at,
      links: (row.source_links ?? []).map(link => ({ label: link.label, url: link.url })),
    })
  }
  return tasks
}

const healthSchema = z.object({
  status: z.string(),
  latest_run_at: instant,
  last_clean_run_at: instant,
  failed_runs_since_clean: z.number().int().nonnegative().nullish(),
})

/** Whether the sync collectors work, from `report.coverage.health`. */
export interface SyncHealth {
  /** `ok`, `degraded`, `failing`, or `missing`; other values are passed through. */
  readonly status: string
  readonly latestRunAt: number | null
  readonly lastCleanAt: number | null
  readonly failedRuns: number
  /** Id of the newest sync run (`report.coverage.items[0].id`), whose coverage names the failure. */
  readonly latestRunId: string | null
}

/**
 * Parse the report's coverage.
 * @param coverage - `report.coverage`.
 * @returns the health; `missing` when the report carries none.
 */
export function parseHealth(coverage: unknown): SyncHealth {
  const record = typeof coverage === 'object' && coverage !== null ? coverage as { health?: unknown; items?: unknown } : {}
  if (record.health === undefined || record.health === null) return { status: 'missing', latestRunAt: null, lastCleanAt: null, failedRuns: 0, latestRunId: null }
  const health = healthSchema.parse(record.health)
  const first = Array.isArray(record.items) ? record.items[0] as { id?: unknown } | undefined : undefined
  return {
    status: health.status,
    latestRunAt: health.latest_run_at,
    lastCleanAt: health.last_clean_run_at,
    failedRuns: health.failed_runs_since_clean ?? 0,
    latestRunId: typeof first?.id === 'string' ? first.id : null,
  }
}

const coverageSchema = z.array(z.object({ area: z.string().optional(), status: z.string(), detail: z.string().nullish() }))

/** Longest failure reason kept. */
export const MAX_REASON_CHARS = 160

/**
 * The reason a sync run gives for what it could not check: the first `failed` entry's detail, else the first
 * `not_checked` one, without a leading `<course id>: `, cut to {@link MAX_REASON_CHARS}.
 * @param record - `get` of a sync run with `detail: full` (`data.coverage`).
 * @returns the reason, or null when the run names none.
 */
export function failureReason(record: unknown): string | null {
  const data = typeof record === 'object' && record !== null ? (record as { data?: { coverage?: unknown } }).data : undefined
  const parsed = coverageSchema.safeParse(data?.coverage ?? [])
  if (!parsed.success) return null
  const pick = parsed.data.find(row => row.status === 'failed' && (row.detail ?? '') !== '')
    ?? parsed.data.find(row => row.status === 'not_checked' && (row.detail ?? '') !== '')
  if (pick === undefined) return null
  /* v8 ignore next -- pick was chosen for a non-empty detail; ?? only satisfies the optional type. */
  const text = (pick.detail ?? '').replace(/^[\w-]+:\s+/u, '').replace(/\s+/gu, ' ').trim()
  return Array.from(text).length > MAX_REASON_CHARS ? `${Array.from(text).slice(0, MAX_REASON_CHARS - 1).join('')}…` : text
}
