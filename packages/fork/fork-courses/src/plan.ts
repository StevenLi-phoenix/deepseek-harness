/**
 * Which reminders are due and how they read. Everything here is a pure function of the task summaries, the clock,
 * the rules, and the set of keys already sent, so whether a reminder goes out never depends on a model.
 *
 * - **Before the deadline** (`due`): the checkpoints are hours before `due_at`. A poll sends the smallest
 *   checkpoint already crossed, once; crossing several at once (first start, a long outage) sends one message.
 * - **Late window** (`late`): once `due_at` has passed and `late_at` or `closes_at` is still ahead, the task is
 *   reported once as missed (`open`), then at the late checkpoints before that end.
 * - A task whose submission is `submitted` or whose progress is `completed` is never reminded.
 * - The key is phase, task, deadline, and checkpoint, so a moved deadline starts its checkpoints again.
 * - A message lists what it reminds of first, then an outlook: the other unfinished tasks due within
 *   {@link OUTLOOK_HOURS} (late windows included), soonest first, so the owner always sees what is most urgent.
 *   The outlook is context; it never marks anything as reminded.
 */
import type { SyncHealth, TaskSummary } from './records.ts'
import { hours, span, stamp } from './time.ts'

/** When reminders fire. */
export interface ReminderRules {
  /** Hours before the on-time deadline. */
  readonly beforeHours: readonly number[]
  /** Hours before the late window ends. */
  readonly lateBeforeHours: readonly number[]
}

/** Before the on-time deadline, or inside the late window after it. */
export type ReminderPhase = 'due' | 'late'

/** One reminder a poll decided to send. */
export interface PlannedReminder {
  readonly key: string
  readonly phase: ReminderPhase
  /** Hours before `deadline`, or `open` for the first notice of a missed on-time deadline. */
  readonly checkpoint: number | 'open'
  /** The deadline the reminder counts down to: `due_at`, or the end of the late window. */
  readonly deadline: number
  readonly task: TaskSummary
}

/**
 * Whether the owner is done with a task as far as reminders go.
 * @param task - the summary.
 * @returns true when submitted or completed.
 */
export function isDone(task: TaskSummary): boolean {
  return task.submission === 'submitted' || task.progress === 'completed'
}

/**
 * The end of a task's late window that is still ahead: the earlier of `late_at` and `closes_at` after `now`.
 * @param task - the summary.
 * @param now - Unix epoch milliseconds.
 * @returns the end, or null when no window is open.
 */
export function lateWindowEnd(task: TaskSummary, now: number): number | null {
  const ends = [task.lateAt, task.closesAt].filter((at): at is number => at !== null && at > now)
  return ends.length === 0 ? null : Math.min(...ends)
}

/**
 * The reminder key: phase, task, deadline, checkpoint.
 * @param phase - before the deadline or in the late window.
 * @param taskId - the task.
 * @param deadline - Unix epoch milliseconds.
 * @param checkpoint - hours before it, or `open`.
 * @returns the key.
 */
export function reminderKey(phase: ReminderPhase, taskId: string, deadline: number, checkpoint: number | 'open'): string {
  return `${phase}|${taskId}|${new Date(deadline).toISOString()}|${String(checkpoint)}`
}

/** The smallest checkpoint already crossed before `deadline`, or undefined. */
function crossed(checkpoints: readonly number[], deadline: number, now: number): number | undefined {
  const passed = checkpoints.filter(h => now >= deadline - hours(h))
  return passed.length === 0 ? undefined : Math.min(...passed)
}

/**
 * The phase, deadline, and checkpoint a task is at now, whether or not it was sent.
 * @param task - the summary.
 * @param now - Unix epoch milliseconds.
 * @param rules - the checkpoints.
 * @returns the step, or undefined when nothing is due for this task now.
 */
export function currentStep(task: TaskSummary, now: number, rules: ReminderRules): Omit<PlannedReminder, 'task'> | undefined {
  if (isDone(task) || task.dueAt === null) return undefined
  if (now < task.dueAt) {
    const checkpoint = crossed(rules.beforeHours, task.dueAt, now)
    return checkpoint === undefined ? undefined : { key: reminderKey('due', task.id, task.dueAt, checkpoint), phase: 'due', checkpoint, deadline: task.dueAt }
  }
  const end = lateWindowEnd(task, now)
  if (end === null) return undefined
  const checkpoint = crossed(rules.lateBeforeHours, end, now) ?? 'open'
  return { key: reminderKey('late', task.id, end, checkpoint), phase: 'late', checkpoint, deadline: end }
}

/**
 * The reminders this poll sends.
 * @param tasks - open task summaries.
 * @param now - Unix epoch milliseconds.
 * @param rules - the checkpoints.
 * @param wasSent - whether a key went out before.
 * @returns the reminders, late ones first, then by deadline.
 */
export function planReminders(
  tasks: readonly TaskSummary[], now: number, rules: ReminderRules, wasSent: (key: string) => boolean,
): PlannedReminder[] {
  const planned: PlannedReminder[] = []
  for (const task of tasks) {
    const step = currentStep(task, now, rules)
    if (step !== undefined && !wasSent(step.key)) planned.push({ ...step, task })
  }
  return planned.sort((a, b) => (a.phase === b.phase ? a.deadline - b.deadline : a.phase === 'late' ? -1 : 1))
}

/** The next time a task's reminder fires, for Settings. */
export interface UpcomingReminder {
  readonly task: TaskSummary
  readonly phase: ReminderPhase
  readonly deadline: number
  /** When the next checkpoint is crossed; null when every checkpoint of this deadline is behind. */
  readonly nextAt: number | null
}

/**
 * Open tasks with a deadline or late window ahead, soonest first, and when each one is reminded next.
 * @param tasks - open task summaries.
 * @param now - Unix epoch milliseconds.
 * @param rules - the checkpoints.
 * @param limit - rows at most.
 * @returns the rows.
 */
export function upcoming(tasks: readonly TaskSummary[], now: number, rules: ReminderRules, limit: number): UpcomingReminder[] {
  const rows: UpcomingReminder[] = []
  for (const task of tasks) {
    if (isDone(task) || task.dueAt === null) continue
    const late = now >= task.dueAt
    const deadline = late ? lateWindowEnd(task, now) : task.dueAt
    if (deadline === null) continue
    const next = (late ? rules.lateBeforeHours : rules.beforeHours).map(h => deadline - hours(h)).filter(at => at > now)
    rows.push({ task, phase: late ? 'late' : 'due', deadline, nextAt: next.length === 0 ? null : Math.min(...next) })
  }
  return rows.sort((a, b) => a.deadline - b.deadline).slice(0, limit)
}

const PROGRESS_LABEL: Readonly<Record<string, string>> = {
  in_progress: '进行中',
  partial: '做了一部分',
  reopened: '重新打开',
}

/** The outlook lists tasks due within this many hours. */
export const OUTLOOK_HOURS = 72
/** The outlook lists at most this many tasks; the rest are counted. */
export const OUTLOOK_ROWS = 6

/** One task's line: course, title, open parts, progress, and the deadline with the time left. */
function line(reminder: PlannedReminder, parts: readonly TaskSummary[], now: number, timeZone: string, bullet = '•'): string {
  const { task } = reminder
  const name = task.parentTitle !== null && parts.length === 0 ? `${task.parentTitle} · ${task.title}` : task.title
  const head = task.course === '' ? name : `${task.course} · ${name}`
  const open = parts.length === 0 ? '' : `（还没交的部分：${parts.map(part => part.title).join('、')}）`
  const label = PROGRESS_LABEL[task.progress]
  const progress = label === undefined ? '' : `，进度：${label}${task.percent === null ? '' : ` ${task.percent}%`}`
  const tentative = task.certainty === 'confirmed' ? '' : '（日期待确认）'
  const left = span(reminder.deadline - now)
  const when = reminder.phase === 'late'
    ? `准时截止 ${stamp(task.dueAt ?? reminder.deadline, timeZone)} 已过，迟交截止 ${stamp(reminder.deadline, timeZone)}，还剩 ${left}`
    : `${stamp(reminder.deadline, timeZone)} 截止${tentative}，还剩 ${left}`
  return `${bullet} ${head}${open} — ${when}${progress}`
}

/** A message for the owner's channel. */
export interface CoursesNote {
  readonly title: string
  readonly body: string
  /** Event kinds the message reports, for channels that hold messages while the owner sleeps. */
  readonly kinds: readonly string[]
  /** A deadline in the message is within the urgent span. */
  readonly urgent: boolean
}

/** What a reminder message needs besides the reminders. */
export interface RenderContext {
  readonly now: number
  readonly timeZone: string
  /** A deadline this close (hours) marks the message urgent; 0 never does. */
  readonly urgentWithinHours: number
  /** Sync health; records last synced `staleHours` or more ago add a line saying how old they may be. */
  readonly health: SyncHealth | null
  /** Hours since the last sync after which the records count as old. */
  readonly staleHours: number
  /** Every open task, for the outlook after the reminders; without it the message has no outlook. */
  readonly tasks?: readonly TaskSummary[]
}

/**
 * The tasks to list after a message's own reminders: unfinished, due (or, in a late window, closing) within
 * {@link OUTLOOK_HOURS}, not among the reminded ones, soonest first. A part whose parent is listed at the same
 * deadline is folded into the parent.
 * @param tasks - every open task.
 * @param reminded - the tasks the message reminds of, parts included.
 * @param now - Unix epoch milliseconds.
 * @returns the rows in deadline order, each as a reminder-shaped step (never sent, so never keyed).
 */
export function outlook(tasks: readonly TaskSummary[], reminded: ReadonlySet<string>, now: number): PlannedReminder[] {
  const rows: PlannedReminder[] = []
  for (const task of tasks) {
    if (isDone(task) || task.dueAt === null || reminded.has(task.id)) continue
    const late = now >= task.dueAt
    const deadline = late ? lateWindowEnd(task, now) : task.dueAt
    if (deadline === null || deadline > now + hours(OUTLOOK_HOURS)) continue
    const phase: ReminderPhase = late ? 'late' : 'due'
    rows.push({ key: reminderKey(phase, task.id, deadline, 'open'), phase, checkpoint: 'open', deadline, task })
  }
  const listed = new Set(rows.map(row => `${row.task.id}|${row.deadline}`))
  return rows.filter(row => row.task.parentId === null || !listed.has(`${row.task.parentId}|${row.deadline}`)).sort((a, b) => a.deadline - b.deadline)
}

/** The outlook section: a header, at most {@link OUTLOOK_ROWS} lines (⚠️ for a missed on-time deadline), and the count of the rest. */
function outlookSection(rows: readonly PlannedReminder[], now: number, timeZone: string): string | undefined {
  if (rows.length === 0) return undefined
  return [
    `接下来 ${OUTLOOK_HOURS} 小时内还有（按截止时间）：`,
    ...rows.slice(0, OUTLOOK_ROWS).map(row => line(row, [], now, timeZone, row.phase === 'late' ? '⚠️' : '•')),
    ...rows.length > OUTLOOK_ROWS ? [`另有 ${rows.length - OUTLOOK_ROWS} 项`] : [],
  ].join('\n')
}

/**
 * One message for every reminder of a poll. A part whose parent is reminded at the same deadline is folded into
 * the parent's line.
 * @param planned - the poll's reminders.
 * @param context - clock, zone, urgency, and sync health.
 * @returns the message.
 */
export function renderReminders(planned: readonly PlannedReminder[], context: RenderContext): CoursesNote {
  const { now, timeZone } = context
  const parents = new Map(planned.map(reminder => [`${reminder.task.id}|${reminder.phase}|${reminder.deadline}`, reminder]))
  const folded = new Map<PlannedReminder, TaskSummary[]>()
  const shown: PlannedReminder[] = []
  for (const reminder of planned) {
    const parent = reminder.task.parentId === null ? undefined : parents.get(`${reminder.task.parentId}|${reminder.phase}|${reminder.deadline}`)
    if (parent === undefined) {
      shown.push(reminder)
      continue
    }
    folded.set(parent, [...folded.get(parent) ?? [], reminder.task])
  }
  const late = shown.filter(reminder => reminder.phase === 'late')
  const due = shown.filter(reminder => reminder.phase === 'due')
  const sections: string[] = []
  if (late.length > 0) sections.push(['⚠️ 准时截止已过，迟交还来得及：', ...late.map(reminder => line(reminder, folded.get(reminder) ?? [], now, timeZone))].join('\n'))
  if (due.length > 0) sections.push(['⏰ 快到截止：', ...due.map(reminder => line(reminder, folded.get(reminder) ?? [], now, timeZone))].join('\n'))
  if (context.tasks !== undefined) {
    const section = outlookSection(outlook(context.tasks, new Set(planned.map(reminder => reminder.task.id)), now), now, timeZone)
    if (section !== undefined) sections.push(section)
  }
  const health = context.health
  if (health !== null && isStale(health, now, context.staleHours)) sections.push(freshnessLine(health, timeZone))
  sections.push('做完了在 app 里打勾就行，不用回我。')
  const urgent = context.urgentWithinHours > 0 && shown.some(reminder => reminder.deadline - now <= hours(context.urgentWithinHours))
  const title = late.length > 0
    ? `⚠️ 课程 DDL：${late.length} 项已过准时截止，迟交窗口还开着${due.length > 0 ? `；另有 ${due.length} 项快到截止` : ''}`
    : `⏰ 课程 DDL 提醒：${due.length} 项快到截止`
  const kinds = [...late.length > 0 ? ['courses.deadline.late'] : [], ...due.length > 0 ? ['courses.deadline.due'] : []]
  return { title, body: sections.join('\n\n'), kinds, urgent }
}

/**
 * Whether the records are old: no run ever checked anything, or the last one that did is `staleHours` or more ago. A
 * degraded run (some areas failed) counts as a sync; judging by the last clean run told the owner "6 days without a
 * sync" hours after a run that read 40 of 48 areas.
 * @param health - from the report.
 * @param now - Unix epoch milliseconds.
 * @param staleHours - hours after which the records count as old.
 * @returns true when the records are old.
 */
export function isStale(health: SyncHealth, now: number, staleHours: number): boolean {
  return health.lastSyncedAt === null || now - health.lastSyncedAt >= hours(staleHours)
}

/** How old the records may be, when they are stale. */
function freshnessLine(health: SyncHealth, timeZone: string): string {
  const synced = health.lastSyncedAt === null ? '还没有过成功的同步' : `最近一次同步在 ${stamp(health.lastSyncedAt, timeZone)}`
  return `（课程记录可能过时：${synced}${health.failedSinceSynced > 0 ? `，之后 ${health.failedSinceSynced} 次同步失败` : ''}；新作业和提交状态可能没更新。）`
}

/** The sync alert held in storage. */
export interface SyncAlertState {
  /** An alert went out and no recovery since. */
  readonly active: boolean
  /** When the last alert went out. */
  readonly alertedAt: number | null
  /** `lastSyncedAt` when the alert went out (stored as `cleanAt`); a newer sync ends the alert. */
  readonly cleanAt: number | null
}

/** When the sync counts as broken. */
export interface SyncAlertRules {
  /** Health statuses that count as broken. */
  readonly statuses: readonly string[]
  /** Hours since the last sync before the first alert. */
  readonly staleHours: number
  /** Hours between alerts while it stays broken. */
  readonly repeatHours: number
}

/**
 * Whether the sync health calls for a message: the first alert once the status is broken and the last sync is
 * `staleHours` old, then at most one every `repeatHours`, and one recovery when a newer sync follows. A sync is a run
 * that checked something, a degraded one included; the status alone ends nothing, so a degraded run between two
 * failing ones is one recovery with its real time, not a recovery naming the old sync.
 * @param health - from the report.
 * @param now - Unix epoch milliseconds.
 * @param state - the stored alert.
 * @param rules - statuses and spans.
 * @returns `failing`, `recovered`, or null.
 */
export function planSyncNotice(health: SyncHealth, now: number, state: SyncAlertState, rules: SyncAlertRules): 'failing' | 'recovered' | null {
  if (state.active && (health.lastSyncedAt ?? 0) > (state.cleanAt ?? 0)) return 'recovered'
  if (!rules.statuses.includes(health.status) || !isStale(health, now, rules.staleHours)) return null
  if (!state.active) return 'failing'
  return state.alertedAt === null || now - state.alertedAt >= hours(rules.repeatHours) ? 'failing' : null
}

/**
 * The sync alert.
 * @param health - from the report.
 * @param reason - what the newest run says it could not check, if anything.
 * @param now - Unix epoch milliseconds.
 * @param timeZone - IANA zone.
 * @returns the message.
 */
export function renderSyncFailing(health: SyncHealth, reason: string | null, now: number, timeZone: string): CoursesNote {
  const since = health.lastSyncedAt === null ? '还没有成功过' : `已经 ${span(now - health.lastSyncedAt)}没成功了`
  const lines = [
    health.lastSyncedAt === null ? '最近一次成功同步：没有记录。' : `最近一次成功同步：${stamp(health.lastSyncedAt, timeZone)}。`,
    `之后失败 ${health.failedSinceSynced} 次${health.latestRunAt === null ? '' : `，最近一次在 ${stamp(health.latestRunAt, timeZone)}`}。`,
    ...reason === null ? [] : [`原因：${reason}`],
    'DDL 提醒照旧按现有记录发，但新作业和提交状态可能没更新。',
  ]
  return { title: `⚠️ 课程同步${since}`, body: lines.join('\n'), kinds: ['courses.sync.failing'], urgent: false }
}

/**
 * The recovery message.
 * @param health - from the report.
 * @param timeZone - IANA zone.
 * @returns the message.
 */
export function renderSyncRecovered(health: SyncHealth, timeZone: string): CoursesNote {
  const at = health.lastSyncedAt ?? health.latestRunAt
  return { title: '✅ 课程同步恢复了', body: at === null ? '课程记录又能更新了。' : `${stamp(at, timeZone)} 同步成功，课程记录又能更新了。`, kinds: ['courses.sync.recovered'], urgent: false }
}
