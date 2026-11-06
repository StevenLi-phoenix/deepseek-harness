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
  /** Replaces the report answer's `result`, given the request body. */
  reportResult?: (body: Record<string, unknown>) => unknown
  /** The `get` of a sync run answers 500. */
  getDown: boolean
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
  const service: FakeService = {
    items: [],
    health: { status: 'ok', latest_run_at: iso(START - H), last_clean_run_at: iso(START - H), failed_runs_since_clean: 0 },
    down: false,
    getDown: false,
    calls: [],
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const op = url.slice(url.lastIndexOf('/') + 1)
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>
    service.calls.push({ op, body, headers: new Headers(init.headers) })
    if (service.down) return Response.json({ ok: false, error: 'Internal error' }, { status: 500 })
    if (op === 'report' && service.reportResult !== undefined) return Response.json({ ok: true, result: service.reportResult(body) })
    if (op === 'get' && service.getDown) return Response.json({ ok: false, error: 'Internal error' }, { status: 500 })
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
  /** The notifier throws this value (not an Error) when it is set and returns true. */
  throwValue?: () => unknown
  noNotifier?: boolean
  noPresence?: boolean
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
  if (options.noNotifier !== true) {
    ctx.provide('lsyNotifier', {
      send: async (note: LsyNote) => {
        const thrown = options.throwValue?.()
        if (thrown !== undefined) throw thrown
        if (options.failSend?.() === true) throw new Error('storage failed')
        sent.push(note)
      },
    } as never)
  }
  const presence = { asleep: options.asleep ?? false }
  if (options.noPresence !== true) ctx.provide('lsyPresence', { isAsleep: () => presence.asleep } as never)
  await ctx.plugin(LsyCourses, Config(options.config as never ?? {}))
  await vi.advanceTimersByTimeAsync(0)
  return { ctx, courses: ctx.lsyCourses, sent, logs, pool, presence }
}

describe('configuration', () => {
  it('defaults to New York, a 15-minute poll, 48/24/3 h checkpoints, 12/3 h in the late window, and the PAT LSY_COURSES_PAT', () => {
    expect(Config({} as never)).toMatchObject({
      enabled: true, baseUrl: 'https://api.lishuyu.app/courses', tokenEnv: 'LSY_COURSES_PAT', timeZone: 'America/New_York', pollMinutes: 15,
      beforeHours: [48, 24, 3], lateBeforeHours: [12, 3], urgentWithinHours: 3, lookaheadDays: 7,
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
    service.items = [taskRow('a', START + 5 * H), taskRow('b', START + 60 * H), taskRow('c', START + 3 * H, { submission_status: 'submitted' })]
    const first = await mount()
    expect(await first.courses.poll('manual')).toMatchObject({ ok: true, openTasks: 3, reminders: 1, outcome: 'sent' })
    expect(first.sent).toHaveLength(1)
    expect(first.sent[0]).toMatchObject({ title: '⏰ 课程 DDL 提醒：1 项快到截止', kinds: ['courses.deadline.due'] })
    expect(first.sent[0]?.origin).toContain('lsy-courses')
    expect(first.sent[0]?.body).toContain('Task a')
    expect(first.sent[0]?.body).toContain('接下来')
    expect(first.sent[0]?.body).toContain('Task b')
    expect(first.sent[0]?.body).not.toContain('Task c')
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

describe('configuration edge cases', () => {
  it('fails at load when beforeHours has no checkpoint', async () => {
    fakeService()
    await expect(mount({ config: { beforeHours: [] } })).rejects.toThrow('beforeHours needs at least one checkpoint')
  })

  it('exposes the zone the owner reads times in', async () => {
    fakeService()
    const { courses } = await mount({ config: { timeZone: 'Asia/Shanghai' } })
    expect(courses.timeZone).toBe('Asia/Shanghai')
  })

  it('is never quiet from sleep when no presence service is mounted', async () => {
    fakeService()
    const { courses } = await mount({ noPresence: true })
    expect(courses.status().quietNow).toBe(false)
  })
})

describe('status before any poll', () => {
  it('has no last poll, no sync health, no notes, and an empty outage', async () => {
    fakeService()
    const { courses } = await mount()
    expect(courses.status()).toMatchObject({
      lastPoll: null, sync: null, notes: [], upcoming: [], outage: { failures: 0, since: null, alerted: false },
    })
  })

  it('answers with empty notes before the domain has opened', async () => {
    fakeService()
    const ctx = new Context()
    contexts.push(ctx)
    const pool = new MemoryMediaPool()
    const backend = new MemoryStorageBackend(pool)
    await ctx.plugin(Timer)
    await ctx.plugin(Storage)
    ctx.effect(() => ctx.storage.backend.register('fixture', backend))
    const facility = new DomainFacility(ctx, { backend: 'fixture' })
    ctx.effect(() => {
      const unmount = ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      return async () => { await facility.closeAll(); unmount() }
    })
    ctx.provide('credentials', { resolve: async () => ({ value: TOKEN, source: 'env' }) } as never)
    const loading = ctx.plugin(LsyCourses, Config({} as never))
    while (ctx.lsyCourses === undefined) await Promise.resolve()
    const courses = ctx.lsyCourses
    expect(courses.status()).toMatchObject({ lastPoll: null, notes: [] })
    await loading
    await vi.advanceTimersByTimeAsync(0)
    expect(courses.status().notes).toEqual([])
  })
})

describe('restart log', () => {
  it('says on restart that the last poll failed and how many reminder keys are stored', async () => {
    const service = fakeService()
    service.down = true
    const first = await mount()
    await first.courses.poll('manual')
    await first.ctx.fiber.dispose()
    const second = await mount({ pool: first.pool })
    expect(second.logs.some(line => /reminders on, every 15 min.*0 reminder keys stored, last poll \S+ failed$/u.test(line))).toBe(true)
  })

  it('stores no reminder key past 30 days after its deadline', async () => {
    const service = fakeService()
    service.items = [taskRow('a', START + 5 * H)]
    const first = await mount()
    await first.courses.poll('manual')
    await first.ctx.fiber.dispose()
    const second = await mount({ pool: first.pool })
    expect(second.logs.some(line => line.includes(' 1 reminder keys stored'))).toBe(true)
    vi.setSystemTime(START + 5 * H + 31 * 24 * H)
    service.items = []
    await second.courses.poll('manual')
    await second.ctx.fiber.dispose()
    const third = await mount({ pool: first.pool })
    expect(third.logs.some(line => line.includes(' 0 reminder keys stored'))).toBe(true)
  })
})

describe('report reading', () => {
  it('reads every page of the report until the service gives no next offset, and keeps the first page\'s health', async () => {
    const service = fakeService()
    service.reportResult = body => body['offset'] === 0
      ? { items: [taskRow('a', START + 5 * H)], next_offset: 100, coverage: { health: service.health, items: [{ id: 'run-7' }] } }
      : { items: [taskRow('b', START + 6 * H)], next_offset: null, coverage: { health: { status: 'failing' } } }
    const { courses } = await mount()
    expect(await courses.poll('manual')).toMatchObject({ ok: true, openTasks: 2, syncStatus: 'ok' })
    expect(service.calls.map(call => call.body['offset'])).toEqual([0, 100])
  })

  it('stops after five pages even when the service keeps offering more', async () => {
    const service = fakeService()
    service.reportResult = body => ({ items: [], next_offset: Number(body['offset']) + 100, coverage: { health: service.health } })
    const { courses } = await mount()
    expect(await courses.poll('manual')).toMatchObject({ ok: true, openTasks: 0 })
    expect(service.calls.map(call => call.body['offset'])).toEqual([0, 100, 200, 300, 400])
  })

  it('fails the poll when the report is not an object or has no items list', async () => {
    const service = fakeService()
    const { courses } = await mount()
    service.reportResult = () => null
    expect(await courses.poll('manual')).toMatchObject({ ok: false, error: 'the courses report has no items list' })
    service.reportResult = () => ({ items: 'none' })
    expect(await courses.poll('manual')).toMatchObject({ ok: false, error: 'the courses report has no items list' })
  })

  it('logs a sync with no clean run without the last-clean detail and warns the records may be stale', async () => {
    const service = fakeService()
    service.health = { status: 'missing', latest_run_at: null, last_clean_run_at: null }
    service.items = [taskRow('a', START + 5 * H)]
    const { courses, sent, logs } = await mount()
    await courses.poll('manual')
    expect(logs.some(line => line.endsWith('1 reminder(s) sent, sync missing'))).toBe(true)
    expect(sent[0]?.body).toContain('（课程记录可能过时：还没有过成功的同步；新作业和提交状态可能没更新。）')
    expect(sent.map(note => note.title)).toContain('⚠️ 课程同步还没有成功过')
  })
})

describe('delivery', () => {
  it('records a failed message when no notifier is mounted, and keeps only the latest 20 messages', async () => {
    const service = fakeService()
    service.items = [taskRow('a', START + 5 * H)]
    const { courses, logs } = await mount({ noNotifier: true })
    for (let i = 0; i < 21; i++) expect(await courses.poll('manual')).toMatchObject({ outcome: 'failed' })
    expect(logs.some(line => line.includes('no lsyNotifier service is mounted; the next poll retries'))).toBe(true)
    const { notes } = courses.status()
    expect(notes).toHaveLength(20)
    expect(notes[0]).toMatchObject({ seq: 21, outcome: 'failed', error: 'no lsyNotifier service is mounted' })
    expect(notes.at(-1)?.seq).toBe(2)
  })

  it('reports a notifier that throws something other than an Error by its text', async () => {
    const service = fakeService()
    service.items = [taskRow('a', START + 5 * H)]
    const { courses } = await mount({ throwValue: () => 'channel closed' })
    expect(await courses.poll('manual')).toMatchObject({ outcome: 'failed' })
    expect(courses.status().notes[0]).toMatchObject({ outcome: 'failed', error: 'channel closed' })
  })
})

describe('sync health alerts', () => {
  const failing = (): Record<string, unknown> => ({
    status: 'failing', latest_run_at: iso(START - H), last_clean_run_at: iso(START - 90 * H), failed_runs_since_clean: 3,
  })

  it('sends no sync message when sync.alert is off', async () => {
    const service = fakeService()
    service.health = failing()
    const { courses, sent } = await mount({ config: { sync: { alert: false } } })
    await courses.poll('manual')
    expect(sent).toHaveLength(0)
    expect(courses.status().sync).toMatchObject({ status: 'failing', reason: 'Browser is not available: iab', alerting: false })
  })

  it('holds the sync alert while the owner sleeps and sends it after', async () => {
    const service = fakeService()
    service.health = failing()
    const { courses, sent, presence, logs } = await mount({ asleep: true })
    await courses.poll('manual')
    expect(sent).toHaveLength(0)
    expect(logs).toContain('info lsy-courses: the sync alert waits for quiet hours to end')
    presence.asleep = false
    await courses.poll('manual')
    expect(sent.map(note => note.kinds)).toEqual([['courses.sync.failing']])
  })

  it('retries the sync alert on the next poll when the channel fails', async () => {
    const service = fakeService()
    service.health = failing()
    let fail = true
    const { courses, sent } = await mount({ failSend: () => fail })
    await courses.poll('manual')
    expect(courses.status().sync?.alerting).toBe(false)
    fail = false
    await courses.poll('manual')
    expect(sent.map(note => note.kinds)).toEqual([['courses.sync.failing']])
    expect(courses.status().sync?.alerting).toBe(true)
  })

  it('goes on without a reason when the newest run cannot be read, and says so in the log', async () => {
    const service = fakeService()
    service.health = failing()
    service.getDown = true
    const { courses, sent, logs } = await mount()
    await courses.poll('manual')
    const prefix = 'info lsy-courses: could not read sync run run-7: courses get failed with HTTP 500'
    expect(logs.some(line => line.startsWith(prefix))).toBe(true)
    expect(sent[0]?.body).not.toContain('原因')
    expect(courses.status().sync?.reason).toBeNull()
  })
})

describe('outage across restarts', () => {
  it('ends a told outage silently when reminders are switched off before the service answers again', async () => {
    const service = fakeService()
    service.down = true
    const first = await mount()
    for (let i = 0; i < 4; i++) await first.courses.poll('manual')
    expect(first.sent).toHaveLength(1)
    await first.ctx.fiber.dispose()
    service.down = false
    const second = await mount({ pool: first.pool, config: { enabled: false } })
    await second.courses.poll('manual')
    expect(second.sent).toHaveLength(0)
    expect(second.logs.some(line => line.includes('the courses service answers again after 4 failed poll(s)'))).toBe(true)
    expect(second.courses.status().outage).toEqual({ failures: 0, since: null, alerted: false })
  })
})

describe('poll failures outside the report', () => {
  it('does not arm again or poll a closed store when it stops during a timer poll', async () => {
    const service = fakeService()
    let answer = (response: Response): void => { void response }
    const pending = new Promise<Response>((resolve) => { answer = resolve })
    vi.stubGlobal('fetch', vi.fn(() => { service.calls.push({ op: 'report', body: {}, headers: new Headers() }); return pending }))
    const { ctx } = await mount()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(service.calls).toHaveLength(1)
    const stopping = ctx.fiber.dispose()
    answer(Response.json({ ok: true, result: { items: [], next_offset: null, coverage: {} } }))
    await vi.advanceTimersByTimeAsync(0)
    await stopping
    expect(vi.getTimerCount()).toBe(0)
  })

  it('logs a timer poll that rejects and polls again on schedule', async () => {
    const service = fakeService()
    const { logs, courses } = await mount()
    const poll = vi.spyOn(courses, 'poll').mockRejectedValueOnce(new Error('the store is gone'))
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => { expect(logs.some(line => line.includes('lsy-courses: poll failed: the store is gone'))).toBe(true) })
    poll.mockRestore()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(service.calls.map(call => call.op)).toEqual(['report'])
  })

  it('rejects a poll whose storage is gone and still runs the polls after it', async () => {
    fakeService()
    const { ctx, courses } = await mount()
    await ctx.fiber.dispose()
    await expect(courses.poll('manual')).rejects.toThrow()
    await expect(courses.poll('manual')).rejects.toThrow()
  })
})
