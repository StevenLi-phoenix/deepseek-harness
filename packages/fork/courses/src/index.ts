/**
 * The owner's course records in DSH, as `ctx.courses`: a client of the courses service (REST with a
 * `courses`-audience PAT), and a poller that reminds the owner of deadlines on WeChat. Whether a reminder goes out
 * is decided here, by fixed rules over the service's `report` (checkpoints before the deadline, the late window,
 * submitted and completed tasks skipped, quiet hours, one message per task and checkpoint across restarts); the
 * agent only answers the owner's replies. The service's own sync collectors are watched through
 * `report.coverage.health`: a broken sync is told once, then at most daily, and its recovery once. DSH never syncs
 * course records itself.
 *
 * @module @deepseek-ai/dsh-courses
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: ctx.credentials.
import type {} from '@deepseek-ai/dsh-credentials'
import type { OwnerNote } from '@deepseek-ai/dsh-event-bus'
// Type-only: ctx.presence.
import type {} from '@deepseek-ai/dsh-presence'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { CoursesApi, CoursesApiError } from './api.ts'
import {
  planReminders, planSyncNotice, renderReminders, renderSyncFailing, renderSyncRecovered, upcoming,
  type CoursesNote, type ReminderRules, type UpcomingReminder,
} from './plan.ts'
import { failureReason, parseHealth, parseTasks, type SyncHealth, type TaskSummary } from './records.ts'
import { coursesDomain, type NoteRecord, type OutageRecord, type PollRecord, type SyncRecord } from './storage.ts'
import { hours, inWindow, stamp } from './time.ts'

export * from './api.ts'
export * from './plan.ts'
export * from './records.ts'
export * from './time.ts'
export type * from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    courses: Courses
  }
}

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/u

/** Plugin configuration. */
export interface Config {
  /** Send deadline and sync reminders; off keeps the client and the tools working and stops the poller. */
  enabled: boolean
  /** Courses API base, without a trailing slash. */
  baseUrl: string
  /** Name of the PAT (audience `courses`) in the credential store or `$DSH_HOME/.env`. */
  tokenEnv: string
  /** `X-Courses-Agent` value: how the service's history names writes from DSH. */
  agentName: string
  /** IANA zone deadlines are shown and quiet hours are read in. */
  timeZone: string
  /** Minutes between polls. */
  pollMinutes: number
  /** Seconds after start before the first poll. */
  firstPollSeconds: number
  /** Timeout of one call to the service, in milliseconds. */
  requestTimeoutMs: number
  /** Days ahead the poll reads; must cover the largest checkpoint. */
  lookaheadDays: number
  /** Hours before an on-time deadline at which the owner is reminded. */
  beforeHours: number[]
  /** Hours before the end of a late window at which the owner is reminded (the first notice of a missed deadline comes at once). */
  lateBeforeHours: number[]
  /** A reminder whose deadline is this many hours away goes out during quiet hours and while the owner sleeps; 0 never. */
  urgentWithinHours: number
  /** When reminders wait; the next poll after them sends what is still due. */
  quietHours: {
    /** Wait while `ctx.presence` says the owner sleeps (Settings → 勿扰). */
    followPresence: boolean
    /** Also wait in the daily window below. */
    enabled: boolean
    /** Window start, `HH:MM`. */
    start: string
    /** Window end, `HH:MM`; earlier than `start` wraps midnight. */
    end: string
  }
  /** Telling the owner that the course sync collectors are broken. */
  sync: {
    /** Send the alert and the recovery at all. */
    alert: boolean
    /** `report.coverage.health.status` values that count as broken. */
    statuses: string[]
    /** Hours since the last sync before the first alert and the stale line in reminders. */
    staleHours: number
    /** Hours between alerts while it stays broken. */
    repeatHours: number
  }
  /** Consecutive failed polls before the owner is told that reminders are paused. */
  outageAlertAfter: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('Send deadline and sync reminders; off stops the poller (the tools keep working).'),
  baseUrl: z.string().default('https://api.lishuyu.app/courses').description('Courses API base, without a trailing slash.'),
  tokenEnv: z.string().default('COURSES_PAT').description('Name of the PAT (audience courses) in the credential store or $DSH_HOME/.env.'),
  agentName: z.string().default('DSH (courses)').description('X-Courses-Agent value: how the service history names writes from DSH.'),
  timeZone: z.string().default('America/New_York').description('IANA zone deadlines are shown and quiet hours are read in.'),
  pollMinutes: z.natural().min(1).default(15).description('Minutes between polls.'),
  firstPollSeconds: z.natural().default(60).description('Seconds after start before the first poll.'),
  requestTimeoutMs: z.natural().min(1000).default(20_000).description('Timeout of one call to the courses service, in milliseconds.'),
  lookaheadDays: z.natural().min(1).default(7).description('Days ahead the poll reads; must cover the largest checkpoint.'),
  beforeHours: z.array(z.number().min(0.25)).default([48, 24, 3]).description('Hours before an on-time deadline at which the owner is reminded.'),
  lateBeforeHours: z.array(z.number().min(0.25)).default([12, 3]).description('Hours before a late window ends at which the owner is reminded; a missed deadline is told at once.'),
  urgentWithinHours: z.number().min(0).default(3).description('A deadline this close (hours) is sent during quiet hours and sleep; 0 never.'),
  quietHours: z.object({
    followPresence: z.boolean().default(true).description('Wait while the owner sleeps (Settings → 勿扰).'),
    enabled: z.boolean().default(false).description('Also wait in the daily window below.'),
    start: z.string().pattern(CLOCK).default('01:00').description('Window start, HH:MM.'),
    end: z.string().pattern(CLOCK).default('09:00').description('Window end, HH:MM.'),
  }),
  sync: z.object({
    alert: z.boolean().default(true).description('Tell the owner when the course sync collectors are broken, and when they recover.'),
    statuses: z.array(z.string()).default(['failing', 'missing']).description('Sync health statuses that count as broken.'),
    staleHours: z.natural().min(1).default(24).description('Hours since the last sync (a run that checked something) before the first alert and the stale line in reminders.'),
    repeatHours: z.natural().min(1).default(24).description('Hours between alerts while the sync stays broken.'),
  }),
  outageAlertAfter: z.natural().min(1).default(4).description('Consecutive failed polls before the owner is told that reminders are paused.'),
})

/** Who the copy of a reminder in the owner's chat Session comes from; never shown to the owner. */
const NOTE_ORIGIN = 'the course deadline check (courses: fixed rules over the owner\'s course records, not a model); when the owner answers that something was submitted or finished, update the record with the courses tools'

/** Messages kept for Settings. */
const NOTES_KEPT = 20
/** Days a sent reminder key is kept after its deadline. */
const SENT_RETAIN_DAYS = 30
/** Report pages read per poll; each is cut at 40 KB by the service. */
const MAX_REPORT_PAGES = 5
/** Rows of the upcoming list in Settings. */
const UPCOMING_ROWS = 12

/** Everything Settings shows. */
export interface CoursesStatus {
  readonly enabled: boolean
  readonly timeZone: string
  readonly rules: ReminderRules & { readonly urgentWithinHours: number }
  readonly quietHours: Config['quietHours']
  /** Quiet right now (window or sleep), as the next poll would judge it. */
  readonly quietNow: boolean
  readonly lastPoll: PollRecord | null
  readonly nextPollAt: number | null
  readonly polling: boolean
  readonly sync: (SyncHealth & { readonly reason: string | null; readonly alerting: boolean }) | null
  readonly outage: OutageRecord
  readonly upcoming: readonly UpcomingReminder[]
  readonly notes: readonly NoteRecord[]
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch {
    throw new Error(`courses: timeZone "${config.timeZone}" is not a valid IANA time zone`)
  }
  if (!/^https?:\/\/[^\s]+[^/]$/u.test(config.baseUrl)) throw new Error('courses: baseUrl must be an http(s) URL without a trailing slash')
  if (config.beforeHours.length === 0) throw new Error('courses: beforeHours needs at least one checkpoint')
  const largest = Math.max(...config.beforeHours, ...config.lateBeforeHours)
  if (largest > config.lookaheadDays * 24) throw new Error(`courses: lookaheadDays (${config.lookaheadDays}) must cover the largest checkpoint (${largest} h)`)
  if (config.quietHours.start === config.quietHours.end) throw new Error('courses: quietHours start and end must differ')
}

/**
 * The courses client and the deadline poller.
 */
export class Courses extends Service {
  static inject = ['storageDomain', 'credentials']
  static Config = Config

  /** The courses service; the tools call it too. */
  readonly api: CoursesApi
  private readonly ready: Promise<Domain<typeof coursesDomain>>
  private domain: Domain<typeof coursesDomain> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private nextPollAt: number | null = null
  private polling = false
  private tasks: readonly TaskSummary[] = []
  private health: SyncHealth | null = null
  private reason: string | null = null
  private reasonRunId: string | null = null

  /**
   * @param ctx - Host with storage and credentials.
   * @param config - service, rules, quiet hours, and alerts.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'courses')
    assertConfig(config)
    const ref = credentialRef(config.tokenEnv)
    this.api = new CoursesApi({
      baseUrl: config.baseUrl,
      agent: config.agentName,
      timeoutMs: config.requestTimeoutMs,
      token: async () => (await ctx.credentials.resolve(ref))?.value,
    })
    this.ready = ctx.storageDomain.open(coursesDomain)
    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      const last = domain.table('poll').get('latest')
      this.ctx.logger.info(`courses: ${config.enabled ? `reminders on, every ${config.pollMinutes} min, checkpoints ${config.beforeHours.join('/')} h, late ${config.lateBeforeHours.join('/')} h, zone ${config.timeZone}` : 'reminders off'}; ${Array.from(domain.table('sent').keys()).length} reminder keys stored${last === undefined ? '' : `, last poll ${new Date(last.at).toISOString()} ${last.ok ? 'ok' : 'failed'}`}`)
      if (config.enabled) this.arm(config.firstPollSeconds * 1000)
      return async () => {
        // A poll under way re-arms when it ends, which is after this.
        this.stopped = true
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = undefined
        this.nextPollAt = null
        await this.chain
        await domain.close()
      }
    }, 'courses.init()')
  }

  /** The rules the planner runs on. */
  get rules(): ReminderRules {
    return { beforeHours: this.config.beforeHours, lateBeforeHours: this.config.lateBeforeHours }
  }

  /** The zone the owner reads times in. */
  get timeZone(): string {
    return this.config.timeZone
  }

  private arm(delayMs: number): void {
    if (this.stopped) return
    this.nextPollAt = Date.now() + delayMs
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.poll('timer')
        .catch((error: unknown) => { this.ctx.logger.warn(`courses: poll failed: ${errorText(error)}`) })
        .finally(() => { this.arm(this.config.pollMinutes * 60_000) })
    }, delayMs)
    this.timer.unref()
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work)
    this.chain = result.catch(() => undefined)
    return result
  }

  /**
   * Whether reminders wait right now: the daily window, or the owner asleep when `followPresence` is on.
   * @param now - Unix epoch milliseconds.
   * @returns true while quiet.
   */
  isQuiet(now: number = Date.now()): boolean {
    const quiet = this.config.quietHours
    if (quiet.enabled && inWindow(now, quiet, this.config.timeZone)) return true
    return quiet.followPresence && (this.ctx.get('presence')?.isAsleep() ?? false)
  }

  /**
   * Read the report once, send what is due, and record the outcome. Polls run one at a time; a manual poll while
   * one runs waits for it and then runs.
   * @param trigger - the timer or the Settings button.
   * @returns the poll's record.
   */
  poll(trigger: 'timer' | 'manual'): Promise<PollRecord> {
    return this.serialize(async () => {
      this.polling = true
      try {
        return await this.runPoll(trigger)
      } finally {
        this.polling = false
      }
    })
  }

  private async runPoll(trigger: 'timer' | 'manual'): Promise<PollRecord> {
    const domain = await this.ready
    const started = Date.now()
    let tasks: TaskSummary[]
    let health: SyncHealth
    try {
      ({ tasks, health } = await this.readReport(started))
    } catch (error: unknown) {
      const record: PollRecord = { at: started, trigger, durationMs: Date.now() - started, ok: false, error: errorText(error) }
      await domain.table('poll').put('latest', record)
      // A token that was never set is a setup step, shown in Settings and the log, not an outage to message about.
      await this.recordOutage(domain, record, !(error instanceof CoursesApiError && error.failure === 'not-configured'))
      return record
    }
    this.tasks = tasks
    this.health = health
    await this.endOutage(domain)
    let outcome: NonNullable<PollRecord['outcome']> = 'disabled'
    let reminders = 0
    if (this.config.enabled) {
      const sent = domain.table('sent')
      const planned = planReminders(tasks, started, this.rules, key => sent.get(key) !== undefined)
      reminders = planned.length
      outcome = 'none'
      if (planned.length > 0) {
        const note = renderReminders(planned, {
          now: started, timeZone: this.config.timeZone, urgentWithinHours: this.config.urgentWithinHours, health, tasks,
          staleHours: this.config.sync.staleHours,
        })
        if (this.isQuiet(started) && !note.urgent) {
          outcome = 'held'
          this.ctx.logger.info(`courses: held ${planned.length} reminder(s) for quiet hours (${planned.map(reminder => reminder.key).join(', ')})`)
        } else if (await this.deliver(domain, note)) {
          outcome = 'sent'
          for (const reminder of planned) {
            await sent.put(reminder.key, {
              at: started, taskId: reminder.task.id, title: reminder.task.title,
              phase: reminder.phase, checkpoint: reminder.checkpoint, deadline: reminder.deadline,
            })
          }
          this.ctx.logger.info(`courses: sent ${planned.length} reminder(s)${note.urgent ? ' (urgent)' : ''}: ${planned.map(reminder => reminder.key).join(', ')}`)
        } else {
          outcome = 'failed'
        }
      }
      await this.checkSync(domain, health, started)
      await this.prune(domain, started)
    }
    const record: PollRecord = {
      at: started, trigger, durationMs: Date.now() - started, ok: true,
      openTasks: tasks.length, reminders, outcome, syncStatus: health.status,
    }
    await domain.table('poll').put('latest', record)
    this.ctx.logger.info(`courses: poll (${trigger}) ok in ${record.durationMs} ms: ${tasks.length} open task(s), ${reminders} reminder(s) ${outcome}, sync ${health.status}${health.lastSyncedAt === null ? '' : ` (last synced ${new Date(health.lastSyncedAt).toISOString()}, ${health.failedSinceSynced} failed since; last clean ${health.lastCleanAt === null ? 'none' : new Date(health.lastCleanAt).toISOString()})`}`)
    return record
  }

  /** The open tasks up to the lookahead (overdue ones included, for late windows) and the sync health. */
  private async readReport(now: number): Promise<{ tasks: TaskSummary[]; health: SyncHealth }> {
    const to = new Date(now + hours(this.config.lookaheadDays * 24)).toISOString()
    const tasks: TaskSummary[] = []
    let health: SyncHealth | undefined
    let offset: number | null = 0
    for (let page = 0; page < MAX_REPORT_PAGES && offset !== null; page++) {
      const result = await this.api.call('report', { view: 'deadlines', to, overdue: 'include', include_undated: 'exclude', coverage_limit: 1, limit: 100, offset })
      const body = typeof result === 'object' && result !== null ? result as { items?: unknown; coverage?: unknown; next_offset?: unknown } : {}
      if (!Array.isArray(body.items)) throw new CoursesApiError('invalid', 'the courses report has no items list')
      tasks.push(...parseTasks(body.items))
      health ??= parseHealth(body.coverage)
      offset = typeof body.next_offset === 'number' ? body.next_offset : null
    }
    /* v8 ignore next -- the page loop runs at least once and sets health; ?? only satisfies the type. */
    return { tasks, health: health ?? parseHealth(undefined) }
  }

  /** Send one message to the owner's channel; false (and a warning) when it could not be handed over. */
  private async deliver(domain: Domain<typeof coursesDomain>, note: CoursesNote): Promise<boolean> {
    const notifier = this.ctx.get('ownerNotifier')
    const notes = domain.table('notes')
    const seq = Math.max(0, ...Array.from(notes.entries(), ([, row]) => row.seq)) + 1
    let error: string | undefined
    if (notifier === undefined) {
      error = 'no ownerNotifier service is mounted'
    } else {
      const message: OwnerNote = {
        title: note.title, body: note.body, kinds: note.kinds, origin: NOTE_ORIGIN, ...note.urgent ? { urgent: true as const } : {},
      }
      try {
        await notifier.send(message)
      } catch (caught: unknown) {
        error = errorText(caught)
      }
    }
    if (error !== undefined) this.ctx.logger.warn(`courses: could not send "${note.title}": ${error}; the next poll retries`)
    await notes.put(String(seq).padStart(8, '0'), { seq, at: Date.now(), title: note.title, body: note.body, kinds: [...note.kinds], outcome: error === undefined ? 'sent' : 'failed', ...error === undefined ? {} : { error } })
    const stale = Array.from(notes.entries()).sort(([, a], [, b]) => b.seq - a.seq).slice(NOTES_KEPT).map(([key]) => key)
    if (stale.length > 0) await notes.deleteMany(stale)
    return error === undefined
  }

  /** Alert on a broken sync, at most once per `repeatHours`, and tell its recovery once. */
  private async checkSync(domain: Domain<typeof coursesDomain>, health: SyncHealth, now: number): Promise<void> {
    const table = domain.table('sync')
    const state: SyncRecord = table.get('latest') ?? { active: false, alertedAt: null, cleanAt: null }
    if (health.status === 'ok' || health.latestRunId === null) {
      this.reason = null
      this.reasonRunId = null
    } else if (health.latestRunId !== this.reasonRunId) {
      this.reason = await this.readReason(health.latestRunId)
      this.reasonRunId = health.latestRunId
    }
    if (!this.config.sync.alert) return
    const decision = planSyncNotice(health, now, state, this.config.sync)
    if (decision === null) return
    if (decision === 'failing' && this.isQuiet(now)) {
      this.ctx.logger.info('courses: the sync alert waits for quiet hours to end')
      return
    }
    const note = decision === 'failing' ? renderSyncFailing(health, this.reason, now, this.config.timeZone) : renderSyncRecovered(health, this.config.timeZone)
    if (!await this.deliver(domain, note)) return
    await table.put('latest', decision === 'failing' ? { active: true, alertedAt: now, cleanAt: health.lastSyncedAt } : { active: false, alertedAt: state.alertedAt, cleanAt: health.lastSyncedAt })
    this.ctx.logger.info(`courses: sync ${decision === 'failing' ? `alert sent (status ${health.status}, ${health.failedSinceSynced} failed runs since the last sync)` : `recovery sent (${note.body})`}`)
  }

  /** What the newest sync run says it could not check; null (logged) when it cannot be read. */
  private async readReason(runId: string): Promise<string | null> {
    try {
      return failureReason(await this.api.call('get', { id: runId, detail: 'full' }))
    } catch (error: unknown) {
      this.ctx.logger.info(`courses: could not read sync run ${runId}: ${errorText(error)}`)
      return null
    }
  }

  /** Count a failed poll; at `outageAlertAfter` in a row, tell the owner once. */
  private async recordOutage(domain: Domain<typeof coursesDomain>, record: PollRecord, tell: boolean): Promise<void> {
    const table = domain.table('outage')
    const held = table.get('latest') ?? { failures: 0, since: null, alerted: false }
    const next: OutageRecord = { failures: held.failures + 1, since: held.since ?? record.at, alerted: held.alerted }
    /* v8 ignore next -- failed-poll records always carry an error; ?? only satisfies the optional type. */
    this.ctx.logger.warn(`courses: poll (${record.trigger}) failed (${next.failures} in a row): ${record.error ?? ''}`)
    if (tell && this.config.enabled && !next.alerted && next.failures >= this.config.outageAlertAfter) {
      next.alerted = await this.deliver(domain, {
        title: '⚠️ 连不上课程记录服务，DDL 提醒暂停了',
        /* v8 ignore next -- failed-poll records carry an error and a stored since; ?? only satisfies the types. */
        body: `从 ${stamp(next.since ?? record.at, this.config.timeZone)} 起连续 ${next.failures} 次读取失败：${record.error ?? ''}\n恢复后我会再说一声。`,
        kinds: ['courses.service.down'],
        urgent: false,
      })
    }
    await table.put('latest', next)
  }

  /** A poll succeeded: clear the outage and tell the owner if they were told about it. */
  private async endOutage(domain: Domain<typeof coursesDomain>): Promise<void> {
    const table = domain.table('outage')
    const held = table.get('latest')
    if (held === undefined || held.failures === 0) return
    if (held.alerted && this.config.enabled) {
      await this.deliver(domain, { title: '✅ 课程记录服务恢复了', body: 'DDL 提醒继续。', kinds: ['courses.service.recovered'], urgent: false })
    }
    this.ctx.logger.info(`courses: the courses service answers again after ${held.failures} failed poll(s)`)
    await table.put('latest', { failures: 0, since: null, alerted: false })
  }

  /** Drop reminder keys whose deadline is long past. */
  private async prune(domain: Domain<typeof coursesDomain>, now: number): Promise<void> {
    const sent = domain.table('sent')
    const old = Array.from(sent.entries()).filter(([, row]) => now - row.deadline > hours(SENT_RETAIN_DAYS * 24)).map(([key]) => key)
    if (old.length > 0) await sent.deleteMany(old)
  }

  /**
   * Everything Settings shows: the rules, the last poll, the sync health with the newest run's reason, the
   * outage counter, the next reminders, and the latest messages (newest first).
   * @returns a snapshot.
   */
  status(): CoursesStatus {
    const domain = this.domain
    const now = Date.now()
    const sync = domain?.table('sync').get('latest')
    return {
      enabled: this.config.enabled,
      timeZone: this.config.timeZone,
      rules: { ...this.rules, urgentWithinHours: this.config.urgentWithinHours },
      quietHours: this.config.quietHours,
      quietNow: this.isQuiet(now),
      lastPoll: domain?.table('poll').get('latest') ?? null,
      nextPollAt: this.nextPollAt,
      polling: this.polling,
      sync: this.health === null ? null : { ...this.health, reason: this.reason, alerting: sync?.active ?? false },
      outage: domain?.table('outage').get('latest') ?? { failures: 0, since: null, alerted: false },
      upcoming: upcoming(this.tasks, now, this.rules, UPCOMING_ROWS),
      notes: domain === undefined ? [] : Array.from(domain.table('notes').entries(), ([, row]) => row).sort((a, b) => b.seq - a.seq),
    }
  }
}

export default Courses
