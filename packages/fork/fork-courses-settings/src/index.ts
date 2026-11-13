/**
 * Settings → 课程 DDL, node half: `GET /api/fork.courses` answers the deadline poller's rules, last poll, the course
 * sync's health, the next reminders, and the latest messages from `ctx.forkCourses`; `POST /api/fork.courses.poll`
 * (JSON only) runs one poll now (it sends what is due, like a timer poll) and answers the new status. Both sit under `/api`, so
 * the connection's sign-in check guards them. The configuration is edited through the All settings card.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CoursesStatus, ForkCourses } from '@deepseek-ai/dsh-fork-courses'
import { COURSES_PATH, COURSES_POLL_PATH, type CoursesView } from './view.ts'

export * from './view.ts'

/** Required Host services. */
export const inject = ['connection', 'forkCourses']

/** The slice of the connection service this plugin uses. */
interface CoursesConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * The status as the page reads it.
 * @param status - from `ctx.forkCourses.status()`.
 * @returns the wire view.
 */
export function toView(status: CoursesStatus): CoursesView {
  const poll = status.lastPoll
  return {
    enabled: status.enabled,
    timeZone: status.timeZone,
    beforeHours: status.rules.beforeHours,
    lateBeforeHours: status.rules.lateBeforeHours,
    urgentWithinHours: status.rules.urgentWithinHours,
    quietHours: status.quietHours,
    quietNow: status.quietNow,
    lastPoll: poll === null
      ? null
      : {
        at: poll.at, trigger: poll.trigger, durationMs: poll.durationMs, ok: poll.ok, error: poll.error ?? null,
        openTasks: poll.openTasks ?? null, reminders: poll.reminders ?? null, outcome: poll.outcome ?? null,
      },
    nextPollAt: status.nextPollAt,
    polling: status.polling,
    sync: status.sync === null
      ? null
      : {
        status: status.sync.status, latestRunAt: status.sync.latestRunAt, lastSyncedAt: status.sync.lastSyncedAt,
        failedSinceSynced: status.sync.failedSinceSynced, reason: status.sync.reason, alerting: status.sync.alerting,
      },
    outage: status.outage,
    upcoming: status.upcoming.map(row => ({
      id: row.task.id, course: row.task.course, title: row.task.parentTitle === null ? row.task.title : `${row.task.parentTitle} › ${row.task.title}`,
      phase: row.phase, deadline: row.deadline, nextAt: row.nextAt,
    })),
    notes: status.notes.map(note => ({
      at: note.at, title: note.title, body: note.body, outcome: note.outcome, error: note.error ?? null,
    })),
  }
}

/**
 * Register the status and poll routes.
 * @param ctx - Host context with the connection service and the courses service.
 */
export function apply(ctx: Context): void {
  const connection = Reflect.get(ctx, 'connection') as CoursesConnection
  const courses = (): ForkCourses => ctx.forkCourses
  const answer = (): Response => Response.json(toView(courses().status()), { headers: { 'cache-control': 'no-store' } })
  ctx.effect(() => connection.fetch.register({
    path: COURSES_PATH, methods: ['GET'], requestBody: 'buffered', fetch: () => Promise.resolve(answer()),
  }), `fork-courses-settings: ${COURSES_PATH}`)
  ctx.effect(() => connection.fetch.register({
    path: COURSES_POLL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      // A cross-site form cannot send JSON, so only a same-origin page script can start a poll.
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return Response.json({ error: 'send application/json' }, { status: 415 })
      ctx.logger.info('fork-courses-settings: poll requested from Settings')
      await courses().poll('manual')
      return answer()
    },
  }), `fork-courses-settings: ${COURSES_POLL_PATH}`)
}
