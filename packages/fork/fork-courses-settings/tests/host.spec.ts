import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { CoursesStatus } from '@deepseek-ai/dsh-fork-courses'
import * as plugin from '../src/index.ts'
import type { CoursesView } from '../src/view.ts'

interface Route {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

const STATUS: CoursesStatus = {
  enabled: true,
  timeZone: 'America/New_York',
  rules: { beforeHours: [72, 24, 6, 2], lateBeforeHours: [24, 6, 2], urgentWithinHours: 2 },
  quietHours: { followPresence: true, enabled: false, start: '01:00', end: '09:00' },
  quietNow: false,
  lastPoll: { at: 10, trigger: 'timer', durationMs: 120, ok: true, openTasks: 8, reminders: 1, outcome: 'sent', syncStatus: 'failing' },
  nextPollAt: 900_010,
  polling: false,
  sync: { status: 'failing', latestRunAt: 5, lastCleanAt: 0, failedRuns: 20, lastSyncedAt: 1, failedSinceSynced: 14, latestRunId: 'run', reason: 'Browser is not available', alerting: true },
  outage: { failures: 0, since: null, alerted: false },
  upcoming: [{
    task: { id: 'p1', version: 2, title: 'Written', courseId: 'c', course: 'Example Course', parentId: 'hw', parentTitle: 'Homework 3', partsDone: null, partsTotal: null, dueAt: 1, lateAt: 2, closesAt: null, certainty: 'confirmed', progress: 'not_started', percent: null, submission: 'not_submitted', submissionVerified: true, remainingWork: null, checkedAt: 1, links: [] },
    phase: 'late', deadline: 2, nextAt: null,
  }],
  notes: [{ seq: 1, at: 9, title: 'T', body: 'B', kinds: ['courses.deadline.late'], outcome: 'sent' }],
}

async function mount(status: CoursesStatus = STATUS) {
  const ctx = new Context()
  const routes: Route[] = []
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
  const poll = vi.fn(async () => STATUS.lastPoll)
  ctx.provide('forkCourses', { status: () => status, poll } as never)
  await ctx.plugin(plugin)
  const route = (path: string): Route => routes.find(entry => entry.path === path)!
  return { ctx, routes, route, poll }
}

describe('fork-courses-settings Host routes', () => {
  it('registers GET /api/fork.courses and POST /api/fork.courses.poll under the /api sign-in, and drops them on disposal', async () => {
    const { ctx, routes } = await mount()
    expect(routes.map(route => [route.path, route.methods])).toEqual([['/api/fork.courses', ['GET']], ['/api/fork.courses.poll', ['POST']]])
    await ctx.fiber.dispose()
  })

  it('answers the status as the page reads it, without the poller\'s internal fields', async () => {
    const { route } = await mount()
    const response = await route('/api/fork.courses').fetch(new Request('http://127.0.0.1/api/fork.courses'))
    expect(response.headers.get('cache-control')).toBe('no-store')
    const view = await response.json() as CoursesView
    expect(view.upcoming).toEqual([{ id: 'p1', course: 'Example Course', title: 'Homework 3 › Written', phase: 'late', deadline: 2, nextAt: null }])
    expect(view.lastPoll).toEqual({ at: 10, trigger: 'timer', durationMs: 120, ok: true, error: null, openTasks: 8, reminders: 1, outcome: 'sent' })
    expect(view.sync).toEqual({ status: 'failing', latestRunAt: 5, lastSyncedAt: 1, failedSinceSynced: 14, reason: 'Browser is not available', alerting: true })
    expect(view.notes).toEqual([{ at: 9, title: 'T', body: 'B', outcome: 'sent', error: null }])
    expect(view.beforeHours).toEqual([72, 24, 6, 2])
  })

  it('answers null for a status with no poll, no sync, no failure reason, and an untitled parent', async () => {
    const { route } = await mount({
      ...STATUS, lastPoll: null, sync: null,
      upcoming: [{ ...STATUS.upcoming[0]!, task: { ...STATUS.upcoming[0]!.task, parentTitle: null } }],
    })
    const view = await (await route('/api/fork.courses').fetch(new Request('http://127.0.0.1/api/fork.courses'))).json() as CoursesView
    expect(view.lastPoll).toBeNull()
    expect(view.sync).toBeNull()
    expect(view.upcoming[0]?.title).toBe('Written')
  })

  it('carries a failed poll\'s error and a failed note\'s error, and nulls the counts a failed poll lacks', async () => {
    const { route } = await mount({
      ...STATUS,
      lastPoll: { at: 10, trigger: 'manual', durationMs: 3, ok: false, error: 'HTTP 500', syncStatus: 'missing' },
      notes: [{ seq: 2, at: 11, title: 'N', body: 'B', kinds: [], outcome: 'failed', error: 'no channel' }],
    })
    const view = await (await route('/api/fork.courses').fetch(new Request('http://127.0.0.1/api/fork.courses'))).json() as CoursesView
    expect(view.lastPoll).toEqual({ at: 10, trigger: 'manual', durationMs: 3, ok: false, error: 'HTTP 500', openTasks: null, reminders: null, outcome: null })
    expect(view.notes).toEqual([{ at: 11, title: 'N', body: 'B', outcome: 'failed', error: 'no channel' }])
  })

  it('refuses a poll request that carries no content type', async () => {
    const { route, poll } = await mount()
    const refused = await route('/api/fork.courses.poll').fetch(new Request('http://127.0.0.1/api/fork.courses.poll', { method: 'POST' }))
    expect(refused.status).toBe(415)
    expect(await refused.json()).toEqual({ error: 'send application/json' })
    expect(poll).not.toHaveBeenCalled()
  })

  it('polls on a JSON POST and refuses any other body, which a cross-site form could send', async () => {
    const { route, poll } = await mount()
    const refused = await route('/api/fork.courses.poll').fetch(new Request('http://127.0.0.1/api/fork.courses.poll', { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }))
    expect(refused.status).toBe(415)
    expect(poll).not.toHaveBeenCalled()
    const ok = await route('/api/fork.courses.poll').fetch(new Request('http://127.0.0.1/api/fork.courses.poll', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))
    expect(ok.status).toBe(200)
    expect(poll).toHaveBeenCalledWith('manual')
  })
})
