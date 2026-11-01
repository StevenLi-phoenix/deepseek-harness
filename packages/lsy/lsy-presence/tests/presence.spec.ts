import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { LsyEventInput } from '@deepseek-ai/dsh-lsy-event-bus'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Ingest from '../../lsy-event-ingest/src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import LsyPresence, { Config, DEFAULT_URGENT_KINDS, hours, type DeferralHolder } from '../src/index.ts'

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

function event(kind: string, source = 'presence'): LsyEventInput {
  return { source, kind, key: String(Date.now()), subject: 'owner', title: kind }
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
  await ctx.plugin(LsyPresence, Config(options.config as never ?? {}))
  await vi.advanceTimersByTimeAsync(0)
  const presence = ctx.lsyPresence
  const flips: boolean[] = []
  presence.onChange(state => flips.push(state.asleep))
  return { ctx, presence, pool, logs, flips }
}

describe('configuration', () => {
  it('defaults to a 03:30-10:30 window in New York, the lead\'s Focus holding times, and urgent kinds for disk and Bilibili risk', () => {
    expect(Config({} as never)).toEqual({
      timeZone: 'America/New_York',
      window: { enabled: true, start: '03:30', end: '10:30' },
      focusFreshHours: 20,
      sleepMaxHours: 14,
      manualMaxHours: 12,
      urgentKinds: [...DEFAULT_URGENT_KINDS],
      ingestPath: '/hooks/lsy',
      tokenEnv: 'LSY_INGEST_TOKEN_PRESENCE',
    })
    expect(DEFAULT_URGENT_KINDS).toEqual(['host.disk.full', 'host.*.critical', 'bili.risk.*', 'bili.gate.readonly'])
  })

  it('fails at load on a zone that does not exist, an empty window, or a URL that is not one', async () => {
    await expect(mount({ config: { timeZone: 'Mars/Olympus' } })).rejects.toThrow('not a valid IANA time zone')
    await expect(mount({ config: { window: { start: '04:00', end: '04:00' } } })).rejects.toThrow('start and end must differ')
    await expect(mount({ config: { ingestUrl: 'nope' } })).rejects.toThrow('ingestUrl must be a URL')
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
    expect(flips).toEqual([false, true])
    expect(logs.filter(line => line.startsWith('info lsy-presence: asleep by focus'))).toHaveLength(2)
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
    expect(logs.some(line => line === 'info lsy-presence: awake by window (time passed)')).toBe(true)
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
    expect(second.presence.view()).toMatchObject({ asleep: false, source: 'manual', manual: { asleep: false, until: at('20:00') }, lastFocus: { asleep: true, at: at('17:00') } })
    expect(second.logs.some(line => line.startsWith('info lsy-presence: awake by manual; window 03:30-10:30 America/New_York'))).toBe(true)
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
    expect(logs).toContain('warn lsy-presence: broken could not flush: window closed')
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
    expect(logs).toContain('warn lsy-presence: a listener failed: boom')
  })
})

describe('ingest door', () => {
  it('never publishes a presence event on the bus, so no subscription can start a Session or send a note', async () => {
    const { ctx, presence } = await mount()
    const routes: Array<{ handler: (request: unknown, response: unknown) => Promise<void> }> = []
    const published: LsyEventInput[] = []
    ctx.provide('webServer', { register: (route: (typeof routes)[number]) => { routes.push(route); return () => {} } } as never)
    ctx.provide('credentials', { resolve: () => Promise.resolve({ value: 'p-secret' }) } as never)
    ctx.provide('lsyEventBus', { publish: (input: LsyEventInput) => { published.push(input); return Promise.resolve('accepted') } } as never)
    await ctx.plugin(Ingest, { sources: [{ id: 'presence', tokenEnv: 'LSY_INGEST_TOKEN_PRESENCE', sink: 'lsyPresence' }] })
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
