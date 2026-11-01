import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { CoursesStatus } from '@deepseek-ai/dsh-lsy-courses'
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
  sync: { status: 'failing', latestRunAt: 5, lastCleanAt: 1, failedRuns: 14, latestRunId: 'run', reason: 'Browser is not available', alerting: true },
  outage: { failures: 0, since: null, alerted: false },
  upcoming: [{
    task: { id: 'p1', version: 2, title: 'Written', courseId: 'c', course: 'Example Course', parentId: 'hw', parentTitle: 'Homework 3', partsDone: null, partsTotal: null, dueAt: 1, lateAt: 2, closesAt: null, certainty: 'confirmed', progress: 'not_started', percent: null, submission: 'not_submitted', submissionVerified: true, remainingWork: null, checkedAt: 1, links: [] },
    phase: 'late', deadline: 2, nextAt: null,
  }],
  notes: [{ seq: 1, at: 9, title: 'T', body: 'B', kinds: ['courses.deadline.late'], outcome: 'sent' }],
}

async function mount() {
  const ctx = new Context()
  const routes: Route[] = []
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
  const poll = vi.fn(async () => STATUS.lastPoll)
  ctx.provide('lsyCourses', { status: () => STATUS, poll } as never)
  await ctx.plugin(plugin)
  const route = (path: string): Route => routes.find(entry => entry.path === path)!
  return { ctx, routes, route, poll }
}

describe('lsy-courses-settings Host routes', () => {
  it('registers GET /api/lsy.courses and POST /api/lsy.courses.poll under the /api sign-in, and drops them on disposal', async () => {
    const { ctx, routes } = await mount()
    expect(routes.map(route => [route.path, route.methods])).toEqual([['/api/lsy.courses', ['GET']], ['/api/lsy.courses.poll', ['POST']]])
    await ctx.fiber.dispose()
  })

  it('answers the status as the page reads it, without the poller\'s internal fields', async () => {
    const { route } = await mount()
    const response = await route('/api/lsy.courses').fetch(new Request('http://127.0.0.1/api/lsy.courses'))
    expect(response.headers.get('cache-control')).toBe('no-store')
    const view = await response.json() as CoursesView
    expect(view.upcoming).toEqual([{ id: 'p1', course: 'Example Course', title: 'Homework 3 › Written', phase: 'late', deadline: 2, nextAt: null }])
    expect(view.lastPoll).toEqual({ at: 10, trigger: 'timer', durationMs: 120, ok: true, error: null, openTasks: 8, reminders: 1, outcome: 'sent' })
    expect(view.sync).toEqual({ status: 'failing', latestRunAt: 5, lastCleanAt: 1, failedRuns: 14, reason: 'Browser is not available', alerting: true })
    expect(view.notes).toEqual([{ at: 9, title: 'T', body: 'B', outcome: 'sent', error: null }])
    expect(view.beforeHours).toEqual([72, 24, 6, 2])
  })

  it('polls on a JSON POST and refuses any other body, which a cross-site form could send', async () => {
    const { route, poll } = await mount()
    const refused = await route('/api/lsy.courses.poll').fetch(new Request('http://127.0.0.1/api/lsy.courses.poll', { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }))
    expect(refused.status).toBe(415)
    expect(poll).not.toHaveBeenCalled()
    const ok = await route('/api/lsy.courses.poll').fetch(new Request('http://127.0.0.1/api/lsy.courses.poll', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))
    expect(ok.status).toBe(200)
    expect(poll).toHaveBeenCalledWith('manual')
  })
})
