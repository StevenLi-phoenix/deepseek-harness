import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { ForkEventInput } from '@deepseek-ai/dsh-fork-event-bus'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Ingest from '../../fork-event-ingest/src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ForkPresence, { Config, DEFAULT_URGENT_KINDS, hours, type DeferralHolder } from '../src/index.ts'

/** 2026-11-03 in New York is EST (UTC-5). */
const at = (hhmm: string, day = 3): number => Date.parse(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00Z`)

const contexts: Context[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(at('17:00'))
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
})

function event(kind: string, source = 'presence', key = `sleep-${String(Date.now())}`): ForkEventInput {
  return { source, kind, key, subject: 'owner', title: kind }
}

/** A heartbeat of focus-watch: the same kinds, with a `heartbeat-` key. */
function heartbeat(kind: 'presence.sleep.on' | 'presence.sleep.off'): ForkEventInput {
  return event(kind, 'presence', `heartbeat-${String(Math.floor(Date.now() / 1_800_000))}`)
}

/** Mount presence over memory storage; `pool` carries the stored state across restarts. */
async function mount(options: { pool?: MemoryMediaPool; config?: Record<string, unknown> } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type} ${String(message.args[0])}`) } })
  const pool = options.pool ?? new MemoryMediaPool()
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  await ctx.plugin(ForkPresence, Config(options.config as never ?? {}))
  await vi.advanceTimersByTimeAsync(0)
  const presence = ctx.forkPresence
  const flips: boolean[] = []
  presence.onChange(state => flips.push(state.asleep))
  return { ctx, presence, pool, logs, flips }
}

describe('configuration', () => {
  it('defaults to a 03:30-10:30 window in New York, a 2 h hold for a signal the 30 min heartbeat refreshes, and urgent kinds for disk and Bilibili risk', () => {
    expect(Config({} as never)).toEqual({
      timeZone: 'America/New_York',
      window: { enabled: true, start: '03:30', end: '10:30' },
      focusFreshHours: 2,
      sleepMaxHours: 14,
      manualMaxHours: 12,
      urgentKinds: [...DEFAULT_URGENT_KINDS],
    })
    expect(DEFAULT_URGENT_KINDS).toEqual(['host.disk.full', 'host.*.critical', 'bili.risk.*', 'bili.gate.readonly'])
  })

  it('fails at load on a zone that does not exist, an empty window, or a window that is empty', async () => {
    await expect(mount({ config: { timeZone: 'Mars/Olympus' } })).rejects.toThrow('not a valid IANA time zone')
    await expect(mount({ config: { window: { start: '04:00', end: '04:00' } } })).rejects.toThrow('start and end must differ')
    expect(() => Config({ window: { start: '3:30' } } as never)).toThrow()
  })
})

describe('state', () => {
  it('follows the daily window when no signal has come', async () => {
    const { presence } = await mount()
    expect(presence.isAsleep()).toBe(false)
    vi.setSystemTime(at('10:00'))
    expect(presence.isAsleep()).toBe(true)
    expect(presence.view()).toMatchObject({ asleep: true, source: 'window', since: at('08:30'), until: at('15:30'), manual: null, lastFocus: null })
  })

  it('takes Focus signals over the window, and tells listeners only when the answer flips', async () => {
    vi.setSystemTime(at('10:00'))
    const { presence, flips, logs } = await mount()
    // Inside the window already asleep: a Focus-on changes the source, not the answer.
    expect(await presence.ingest(event('presence.sleep.on'))).toBe('asleep')
    expect(flips).toEqual([])
    // Focus off at 05:00 EST wakes the owner in the middle of the window.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(await presence.ingest(event('presence.sleep.off'))).toBe('awake')
    expect(flips).toEqual([false])
    expect(presence.view()).toMatchObject({ asleep: false, source: 'focus', since: at('10:05'), lastFocus: { asleep: false, at: at('10:05') } })
    await vi.advanceTimersByTimeAsync(at('19:00') - Date.now())
    await presence.ingest(event('presence.sleep.on'))
    // The off signal held 2 h, then the window took over (asleep) until it closed at 10:30 EST, then Focus on.
    expect(flips).toEqual([false, true, false, true])
    expect(logs.filter(line => line.startsWith('info fork-presence: asleep by focus'))).toHaveLength(2)
  })

  it('refuses any other kind or source', async () => {
    const { presence } = await mount()
    await expect(presence.ingest(event('presence.sleep.maybe'))).rejects.toThrow('use presence.sleep.on or presence.sleep.off')
    await expect(presence.ingest(event('host.sleep.on', 'host'))).rejects.toThrow('unknown presence kind')
  })

  it('flips at the window edges by itself and tells listeners', async () => {
    const { presence, flips, logs } = await mount()
    // 12:00 EST: the window opens at 03:30 EST next day.
    await vi.advanceTimersByTimeAsync(at('08:30', 4) - Date.now() + 1000)
    expect(presence.isAsleep()).toBe(true)
    expect(flips).toEqual([true])
    await vi.advanceTimersByTimeAsync(at('15:30', 4) + 2000 - Date.now())
    expect(presence.isAsleep()).toBe(false)
    expect(flips).toEqual([true, false])
    expect(logs.some(line => line === 'info fork-presence: awake by window (time passed)')).toBe(true)
  })

  it('lets an asleep Focus signal lapse after sleepMaxHours when its off signal never comes', async () => {
    const { presence, flips } = await mount({ config: { window: { enabled: false } } })
    await presence.ingest(event('presence.sleep.on'))
    expect(presence.isAsleep()).toBe(true)
    await vi.advanceTimersByTimeAsync(hours(14) - 1000)
    expect(presence.isAsleep()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(presence.isAsleep()).toBe(false)
    expect(flips).toEqual([true, false])
  })
})

describe('heartbeat', () => {
  it('keeps the state without waking listeners, flushing, or moving its start: repeats change nothing', async () => {
    vi.setSystemTime(at('08:00'))
    const { presence, flips, logs } = await mount({ config: { window: { enabled: false } } })
    const held = { flush: vi.fn(() => Promise.resolve(0)), count: () => 0, name: 'x' }
    presence.registerHolder(held)
    await presence.ingest(event('presence.sleep.on', 'presence', 'sleep-on-1'))
    const first = presence.view()
    expect(flips).toEqual([true])
    const lines = logs.length
    for (let n = 0; n < 4; n += 1) {
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(await presence.ingest(heartbeat('presence.sleep.on'))).toBe('asleep')
    }
    expect(flips).toEqual([true])
    expect(held.flush).not.toHaveBeenCalled()
    expect(logs.slice(lines)).toEqual([])
    const view = presence.view()
    expect(view).toMatchObject({ asleep: true, source: 'focus', since: first.since, lastFocus: { asleep: true, since: first.since, at: Date.now(), heartbeatAt: Date.now() } })
    expect(view.until).toBe(Date.now() + hours(14))
  })

  it('refreshes the hold: awake outlasts focusFreshHours while heartbeats come, and lapses 2 h after they stop', async () => {
    vi.setSystemTime(at('17:00'))
    const { presence, flips } = await mount()
    await presence.ingest(event('presence.sleep.off', 'presence', 'sleep-off-1'))
    for (let n = 0; n < 6; n += 1) {
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      await presence.ingest(heartbeat('presence.sleep.off'))
    }
    // Three hours on: past the 2 h hold of the change itself, still by the focus.
    expect(presence.view()).toMatchObject({ asleep: false, source: 'focus', since: at('17:00') })
    expect(presence.view().lastFocus).toMatchObject({ since: at('17:00'), at: at('20:00'), heartbeatAt: at('20:00') })
    await vi.advanceTimersByTimeAsync(2 * 3_600_000 + 1000)
    expect(presence.view()).toMatchObject({ source: 'window', asleep: false })
    expect(flips).toEqual([])
  })

  it('a heartbeat off while awake by any source changes nothing; a heartbeat that flips the state is a change', async () => {
    vi.setSystemTime(at('17:00'))
    const { presence, flips } = await mount()
    await presence.ingest(heartbeat('presence.sleep.off'))
    expect(flips).toEqual([])
    expect(presence.view()).toMatchObject({ asleep: false, source: 'focus', since: at('17:00') })
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    await presence.ingest(heartbeat('presence.sleep.off'))
    expect(presence.view().since).toBe(at('17:00'))
    // A missed change shows up as a heartbeat of the other state.
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    await presence.ingest(heartbeat('presence.sleep.on'))
    expect(flips).toEqual([true])
    expect(presence.view()).toMatchObject({ asleep: true, since: at('18:00') })
  })

  it('leaves a button alone, but a change ends it', async () => {
    vi.setSystemTime(at('17:00'))
    const { presence } = await mount()
    await presence.ingest(event('presence.sleep.off', 'presence', 'sleep-off-1'))
    await presence.setManual(true)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    await presence.ingest(heartbeat('presence.sleep.off'))
    expect(presence.view()).toMatchObject({ asleep: true, source: 'manual' })
    await presence.ingest(event('presence.sleep.on', 'presence', 'sleep-on-2'))
    expect(presence.view()).toMatchObject({ asleep: true, source: 'focus', manual: null })
    await presence.ingest(event('presence.sleep.off', 'presence', 'sleep-off-2'))
    expect(presence.view()).toMatchObject({ asleep: false, source: 'focus' })
  })

  it('says the watcher is silent after an hour without a signal, or before the first, and survives a restart with the heartbeat time', async () => {
    vi.setSystemTime(at('17:00'))
    const first = await mount()
    expect(first.presence.view()).toMatchObject({ signalSilent: true, lastFocus: null, focusFreshHours: 2 })
    await first.presence.ingest(heartbeat('presence.sleep.off'))
    expect(first.presence.view().signalSilent).toBe(false)
    await vi.advanceTimersByTimeAsync(3_600_000 + 1000)
    expect(first.presence.view().signalSilent).toBe(true)
    await first.presence.ingest(heartbeat('presence.sleep.off'))
    await first.ctx.fiber.dispose()
    const second = await mount({ pool: first.pool })
    expect(second.presence.view()).toMatchObject({ signalSilent: false, lastFocus: { asleep: false, since: at('17:00'), heartbeatAt: Date.now() } })
  })
})

describe('manual override', () => {
  it('sleeps now, wakes now, and quiets until a clock time', async () => {
    const { presence, flips } = await mount()
    await presence.setManual(true)
    expect(presence.view()).toMatchObject({ asleep: true, source: 'manual', manual: { asleep: true, at: at('17:00'), until: at('17:00') + hours(12) } })
    await presence.setManual(false)
    expect(presence.isAsleep()).toBe(false)
    // 12:00 EST -> quiet until 14:00 EST (19:00Z).
    expect(await presence.quietUntil('14:00')).toBe(at('19:00'))
    expect(presence.view()).toMatchObject({ asleep: true, source: 'manual', until: at('19:00') })
    expect(flips).toEqual([true, false, true])
    await vi.advanceTimersByTimeAsync(2 * 3_600_000 + 1000)
    expect(presence.isAsleep()).toBe(false)
    expect(flips).toEqual([true, false, true, false])
  })

  it('is replaced by the next Focus signal, and clearing hands the decision back', async () => {
    const { presence } = await mount()
    await presence.setManual(true)
    await presence.ingest(event('presence.sleep.off'))
    expect(presence.view()).toMatchObject({ asleep: false, source: 'focus', manual: null })
    await presence.setManual(true)
    await presence.clearManual()
    expect(presence.view()).toMatchObject({ asleep: false, source: 'focus', manual: null })
  })
})

describe('window setting', () => {
  it('replaces the configured window and survives a restart', async () => {
    const first = await mount()
    await first.presence.setWindow({ enabled: true, start: '23:00', end: '07:00' })
    vi.setSystemTime(at('04:30', 4))
    expect(first.presence.isAsleep()).toBe(true)
    await first.ctx.fiber.dispose()
    const second = await mount({ pool: first.pool })
    expect(second.presence.view().window).toEqual({ enabled: true, start: '23:00', end: '07:00' })
    expect(second.presence.isAsleep()).toBe(true)
  })
})

describe('persistence', () => {
  it('keeps the Focus signal and the button across a restart, and logs what it restored', async () => {
    const first = await mount()
    await first.presence.ingest(event('presence.sleep.on'))
    await first.presence.setManual(false, at('20:00'))
    await first.ctx.fiber.dispose()
    vi.setSystemTime(at('18:00'))
    const second = await mount({ pool: first.pool })
    expect(second.presence.view()).toMatchObject({ asleep: false, source: 'manual', manual: { asleep: false, until: at('20:00') }, lastFocus: { asleep: true, at: at('17:00'), since: at('17:00'), heartbeatAt: null } })
    expect(second.logs.some(line => line.startsWith('info fork-presence: awake by manual; window 03:30-10:30 America/New_York'))).toBe(true)
  })

  it('starts with the window while nothing is stored', async () => {
    const { logs } = await mount()
    expect(logs.some(line => line.endsWith('no Focus signal yet'))).toBe(true)
  })
})

describe('urgent kinds', () => {
  it('matches the configured globs, case-insensitively, and honours the sender\'s mark', async () => {
    const { presence } = await mount()
    expect(presence.isUrgent({ kinds: ['host.disk.full'] })).toBe(true)
    expect(presence.isUrgent({ kinds: ['host.disk.critical'] })).toBe(true)
    expect(presence.isUrgent({ kinds: ['bili.risk.brake', 'bili.api.error'] })).toBe(true)
    expect(presence.isUrgent({ kinds: ['bili.gate.readonly'] })).toBe(true)
    expect(presence.isUrgent({ kinds: ['bili.gate.open'] })).toBe(false)
    expect(presence.isUrgent({ kinds: ['host.disk.warn', 'bili.archive.done'] })).toBe(false)
    expect(presence.isUrgent({})).toBe(false)
    expect(presence.isUrgent({ urgent: true })).toBe(true)
    const custom = await mount({ config: { urgentKinds: ['kaorou.*'] } })
    expect(custom.presence.isUrgent({ kinds: ['kaorou.job.failed'] })).toBe(true)
    expect(custom.presence.isUrgent({ kinds: ['host.disk.full'] })).toBe(false)
  })
})

describe('holders', () => {
  it('counts what the channels hold and flushes them, surviving one that fails', async () => {
    const { presence, logs } = await mount()
    const wechat: DeferralHolder = { name: 'wechat', count: () => 3, flush: () => Promise.resolve(3) }
    const broken: DeferralHolder = { name: 'broken', count: () => 1, flush: () => Promise.reject(new Error('window closed')) }
    const stop = presence.registerHolder(wechat)
    presence.registerHolder(broken)
    expect(presence.deferredCount()).toBe(4)
    expect(presence.view().deferred).toBe(4)
    expect(await presence.flushNow()).toBe(3)
    expect(logs).toContain('warn fork-presence: broken could not flush: window closed')
    stop()
    expect(presence.deferredCount()).toBe(1)
  })

  it('keeps a listener that throws from stopping the others', async () => {
    const { presence, logs } = await mount()
    const seen: boolean[] = []
    presence.onChange(() => { throw new Error('boom') })
    presence.onChange(state => seen.push(state.asleep))
    await presence.setManual(true)
    expect(seen).toEqual([true])
    expect(logs).toContain('warn fork-presence: a listener failed: boom')
  })
})

describe('ingest door', () => {
  it('never publishes a presence event on the bus, so no subscription can start a Session or send a note', async () => {
    const { ctx, presence } = await mount()
    const routes: Array<{ handler: (request: unknown, response: unknown) => Promise<void> }> = []
    const published: ForkEventInput[] = []
    ctx.provide('webServer', { register: (route: (typeof routes)[number]) => { routes.push(route); return () => {} } } as never)
    ctx.provide('credentials', { resolve: () => Promise.resolve({ value: 'p-secret' }) } as never)
    ctx.provide('forkEventBus', { publish: (input: ForkEventInput) => { published.push(input); return Promise.resolve('accepted') } } as never)
    await ctx.plugin(Ingest, { sources: [{ id: 'presence', tokenEnv: 'FORK_INGEST_TOKEN_PRESENCE', sink: 'forkPresence' }] })
    expect(routes).toHaveLength(1)
    const body = JSON.stringify({ kind: 'presence.sleep.on', key: 'k1', subject: 'owner', title: 'Sleep Focus on' })
    const status = await new Promise<number>((resolve) => {
      const request = Object.assign((async function* () { yield Buffer.from(body) })(), { method: 'POST', headers: { authorization: 'Bearer p-secret', 'content-type': 'application/json' } })
      const response = { setHeader() {}, writeHead(code: number) { resolve(code) }, end() {} }
      void routes[0]!.handler(request, response)
    })
    expect(status).toBe(202)
    expect(presence.view()).toMatchObject({ asleep: true, source: 'focus' })
    expect(published).toEqual([])
  })
})
