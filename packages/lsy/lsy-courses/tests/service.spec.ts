import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { LsyNote } from '@deepseek-ai/dsh-lsy-event-bus'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import LsyCourses, { Config } from '../src/index.ts'

const H = 3_600_000
/** 2026-11-02 12:00 EST. */
const START = Date.parse('2026-11-02T12:00:00-05:00')
const TOKEN = 'pat_testtokenvalue0000000000000000000000'

interface FakeService {
  items: Record<string, unknown>[]
  health: Record<string, unknown> | null
  down: boolean
  calls: Array<{ op: string; body: Record<string, unknown>; headers: Headers }>
}

function iso(at: number): string {
  return new Date(at).toISOString()
}

function taskRow(id: string, dueAt: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'task', id, version: 1, title: `Task ${id}`, course_name: 'Example Course — CS-UY 0000 A', due_at: iso(dueAt), late_at: null, closes_at: null,
    deadline_certainty: 'confirmed', progress_status: 'not_started', submission_status: 'not_submitted', submission_verified: true, ...extra,
  }
}

const contexts: Context[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function fakeService(): FakeService {
  const service: FakeService = { items: [], health: { status: 'ok', latest_run_at: iso(START - H), last_clean_run_at: iso(START - H), failed_runs_since_clean: 0 }, down: false, calls: [] }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const op = url.slice(url.lastIndexOf('/') + 1)
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>
    service.calls.push({ op, body, headers: new Headers(init.headers) })
    if (service.down) return Response.json({ ok: false, error: 'Internal error' }, { status: 500 })
    if (op === 'report') return Response.json({ ok: true, result: { items: service.items, next_offset: null, coverage: { health: service.health, items: [{ id: 'run-7' }] } } })
    if (op === 'get') return Response.json({ ok: true, result: { id: body['id'], data: { coverage: [{ area: 'content', status: 'failed', detail: 'fall-x: Browser is not available: iab' }] } } })
    return Response.json({ ok: false, error: 'Unknown operation' }, { status: 404 })
  }))
  return service
}

interface MountOptions {
  pool?: MemoryMediaPool
  config?: Record<string, unknown>
  asleep?: boolean
  failSend?: () => boolean
}

async function mount(options: MountOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type} ${String(message.args[0])}`) } })
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  const pool = options.pool ?? new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  ctx.provide('credentials', { resolve: async (ref: string) => (ref === 'LSY_COURSES_PAT' ? { value: TOKEN, source: 'env' } : undefined) } as never)
  const sent: LsyNote[] = []
  ctx.provide('lsyNotifier', {
    send: async (note: LsyNote) => {
      if (options.failSend?.() === true) throw new Error('storage failed')
      sent.push(note)
    },
  } as never)
  const presence = { asleep: options.asleep ?? false }
  ctx.provide('lsyPresence', { isAsleep: () => presence.asleep } as never)
  await ctx.plugin(LsyCourses, Config(options.config as never ?? {}))
  await vi.advanceTimersByTimeAsync(0)
  return { ctx, courses: ctx.lsyCourses, sent, logs, pool, presence }
}

describe('configuration', () => {
  it('defaults to New York, a 15-minute poll, 72/24/6/2 h checkpoints, 24/6/2 h in the late window, and the PAT LSY_COURSES_PAT', () => {
    expect(Config({} as never)).toMatchObject({
      enabled: true, baseUrl: 'https://api.lishuyu.app/courses', tokenEnv: 'LSY_COURSES_PAT', timeZone: 'America/New_York', pollMinutes: 15,
      beforeHours: [72, 24, 6, 2], lateBeforeHours: [24, 6, 2], urgentWithinHours: 2, lookaheadDays: 7,
      quietHours: { followPresence: true, enabled: false, start: '01:00', end: '09:00' },
      sync: { alert: true, statuses: ['failing', 'missing'], staleHours: 24, repeatHours: 24 },
    })
  })

  it('fails at load on a lookahead shorter than a checkpoint, a bad zone, or an empty quiet window', async () => {
    fakeService()
    await expect(mount({ config: { beforeHours: [200] } })).rejects.toThrow('must cover the largest checkpoint')
    await expect(mount({ config: { timeZone: 'Mars/Olympus' } })).rejects.toThrow('not a valid IANA time zone')
    await expect(mount({ config: { quietHours: { start: '02:00', end: '02:00' } } })).rejects.toThrow('start and end must differ')
    await expect(mount({ config: { baseUrl: 'https://example.com/' } })).rejects.toThrow('without a trailing slash')
  })
})

describe('polling', () => {
  it('polls after firstPollSeconds and every pollMinutes, with the PAT, the agent name, and the report window', async () => {
    const service = fakeService()
    const { logs } = await mount()
    expect(service.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(service.calls.map(call => call.op)).toEqual(['report'])
    const [first] = service.calls
    expect(first?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(first?.headers.get('x-courses-agent')).toBe('DSH (lsy-courses)')
    expect(first?.body).toMatchObject({ view: 'deadlines', overdue: 'include', include_undated: 'exclude', coverage_limit: 1, to: iso(START + 60_000 + 7 * 24 * H) })
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(service.calls).toHaveLength(2)
    expect(logs.filter(line => line.includes('lsy-courses: poll (timer) ok'))).toHaveLength(2)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('sends one message per checkpoint and never repeats it, across polls and restarts', async () => {
    const service = fakeService()
    service.items = [taskRow('a', START + 5 * H), taskRow('b', START + 100 * H), taskRow('c', START + 3 * H, { submission_status: 'submitted' })]
    const first = await mount()
    expect(await first.courses.poll('manual')).toMatchObject({ ok: true, openTasks: 3, reminders: 1, outcome: 'sent' })
    expect(first.sent).toHaveLength(1)
    expect(first.sent[0]).toMatchObject({ title: '⏰ 课程 DDL 提醒：1 项快到截止', kinds: ['courses.deadline.due'] })
    expect(first.sent[0]?.origin).toContain('lsy-courses')
    expect(first.sent[0]?.body).toContain('Task a')
    expect(await first.courses.poll('manual')).toMatchObject({ reminders: 0, outcome: 'none' })
    await first.ctx.fiber.dispose()

    const second = await mount({ pool: first.pool })
    expect(await second.courses.poll('manual')).toMatchObject({ reminders: 0, outcome: 'none' })
    vi.setSystemTime(START + 3.5 * H)
    expect(await second.courses.poll('manual')).toMatchObject({ reminders: 1, outcome: 'sent' })
    expect(second.sent[0]?.body).toContain('还剩 1 小时')
    expect(second.courses.status().notes.map(note => note.outcome)).toEqual(['sent', 'sent'])
  })

  it('holds reminders while the owner sleeps or in the quiet window, and sends what is still due after', async () => {
    const service = fakeService()
    service.items = [taskRow('a', START + 20 * H)]
    const { courses, sent, presence, logs } = await mount({ asleep: true })
    expect(await courses.poll('manual')).toMatchObject({ outcome: 'held' })
    expect(sent).toHaveLength(0)
    expect(logs.some(line => line.includes('held 1 reminder(s) for quiet hours'))).toBe(true)
    presence.asleep = false
    expect(await courses.poll('manual')).toMatchObject({ outcome: 'sent' })
    expect(sent).toHaveLength(1)

    const quiet = await mount({ config: { quietHours: { followPresence: false, enabled: true, start: '11:00', end: '13:00' } } })
    expect(await quiet.courses.poll('manual')).toMatchObject({ outcome: 'held' })
    expect(quiet.courses.status().quietNow).toBe(true)
  })

  it('sends a deadline within urgentWithinHours even in quiet hours, marked urgent', async () => {
    const service = fakeService()
    service.items = [taskRow('a', START + 1.5 * H)]
    const { courses, sent } = await mount({ asleep: true })
    expect(await courses.poll('manual')).toMatchObject({ outcome: 'sent' })
    expect(sent[0]?.urgent).toBe(true)
  })

  it('keeps the keys unsent when the channel fails, so the next poll retries', async () => {
    const service = fakeService()
    service.items = [taskRow('a', START + 5 * H)]
    let fail = true
    const { courses, sent, logs } = await mount({ failSend: () => fail })
    expect(await courses.poll('manual')).toMatchObject({ outcome: 'failed' })
    expect(logs.some(line => line.startsWith('warn lsy-courses: could not send'))).toBe(true)
    fail = false
    expect(await courses.poll('manual')).toMatchObject({ outcome: 'sent' })
    expect(sent).toHaveLength(1)
    expect(courses.status().notes.map(note => note.outcome)).toEqual(['sent', 'failed'])
  })

  it('sends nothing and arms no timer while disabled; a manual poll still refreshes the status', async () => {
    const service = fakeService()
    service.items = [taskRow('a', START + 5 * H)]
    const { courses, sent } = await mount({ config: { enabled: false } })
    await vi.advanceTimersByTimeAsync(3 * H)
    expect(service.calls).toHaveLength(0)
    expect(await courses.poll('manual')).toMatchObject({ ok: true, outcome: 'disabled' })
    expect(sent).toHaveLength(0)
    expect(courses.status()).toMatchObject({ enabled: false, nextPollAt: null })
    expect(courses.status().upcoming.map(row => row.task.id)).toEqual(['a'])
  })
})

describe('sync health', () => {
  it('tells a broken sync once with the last clean run and the newest run\'s reason, then daily, then its recovery', async () => {
    const service = fakeService()
    service.health = { status: 'failing', latest_run_at: iso(START - H), last_clean_run_at: iso(START - 90 * H), failed_runs_since_clean: 14 }
    const { courses, sent } = await mount()
    await courses.poll('manual')
    expect(sent.map(note => note.title)).toEqual(['⚠️ 课程同步已经 3 天 18 小时没成功了'])
    expect(sent[0]?.body).toContain('原因：Browser is not available: iab')
    expect(service.calls.filter(call => call.op === 'get')).toHaveLength(1)
    await courses.poll('manual')
    expect(sent).toHaveLength(1)
    expect(service.calls.filter(call => call.op === 'get')).toHaveLength(1)
    expect(courses.status().sync).toMatchObject({ status: 'failing', failedRuns: 14, reason: 'Browser is not available: iab', alerting: true })
    vi.setSystemTime(START + 24 * H)
    await courses.poll('manual')
    expect(sent).toHaveLength(2)
    service.health = { status: 'ok', latest_run_at: iso(START + 25 * H), last_clean_run_at: iso(START + 25 * H), failed_runs_since_clean: 0 }
    vi.setSystemTime(START + 26 * H)
    await courses.poll('manual')
    expect(sent.map(note => note.title).at(-1)).toBe('✅ 课程同步恢复了')
    await courses.poll('manual')
    expect(sent).toHaveLength(3)
  })
})

describe('service outage', () => {
  it('tells the owner once after outageAlertAfter failed polls, and once when it answers again', async () => {
    const service = fakeService()
    service.down = true
    const { courses, sent, logs } = await mount()
    for (let i = 0; i < 5; i++) expect(await courses.poll('manual')).toMatchObject({ ok: false, error: 'courses report failed with HTTP 500: Internal error' })
    expect(sent.map(note => note.title)).toEqual(['⚠️ 连不上课程记录服务，DDL 提醒暂停了'])
    expect(logs.some(line => line.startsWith('warn lsy-courses: poll (manual) failed (5 in a row)'))).toBe(true)
    service.down = false
    await courses.poll('manual')
    expect(sent.map(note => note.title)).toEqual(['⚠️ 连不上课程记录服务，DDL 提醒暂停了', '✅ 课程记录服务恢复了'])
    expect(courses.status().outage).toEqual({ failures: 0, since: null, alerted: false })
  })

  it('reports a missing token as a failed poll without calling the service or messaging the owner', async () => {
    const service = fakeService()
    const { courses, sent } = await mount({ config: { tokenEnv: 'LSY_OTHER_PAT' } })
    for (let i = 0; i < 5; i++) expect(await courses.poll('manual')).toMatchObject({ ok: false, error: 'the courses token is not set' })
    expect(service.calls).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect(courses.status().outage.failures).toBe(5)
  })
})
