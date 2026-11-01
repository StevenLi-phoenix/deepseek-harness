import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_ARCHIVE_DEFAULTS, MAX_RECENT_ARCHIVED, resolveAutoArchive, selectSessions, type AutoArchiveConfig, type SessionProtector, type SessionRow,
} from '../src/index.ts'
import { SessionArchiver, type ArchiveHost } from '../src/archive.ts'
import { baseConfig, disposeAll, fakeController, fakeRegistry, harness, withConfig, type FakeController } from './harness.ts'

const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = Date.parse('2026-11-01T00:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(async () => {
  await disposeAll()
  vi.useRealTimers()
})

/** A Session row last touched `days` ago. */
function row(id: string, days: number, extra: Partial<SessionRow> = {}): SessionRow {
  return { id, updatedAt: NOW - days * DAY, running: false, subagent: false, ...extra }
}

const select = (rows: SessionRow[], extra: Partial<Parameters<typeof selectSessions>[1]> = {}) => selectSessions(rows, {
  now: NOW, inactiveMs: 7 * DAY, archived: new Set(), pinned: new Set(), builtin: new Map(), protectors: [], ...extra,
})

describe('selectSessions', () => {
  it('selects idle Sessions oldest first and counts every skip in exactly one category', async () => {
    const result = await select([
      row('new', 1), row('old-2', 9), row('old-1', 30), row('sub', 20, { subagent: true }), row('busy', 20, { running: true }),
      row('pin', 20), row('persist', 20), row('owner', 20), row('done', 20), row('wx', 20),
    ], {
      archived: new Set(['done']),
      pinned: new Set(['pin']),
      builtin: new Map([['persist', 'persistent'], ['owner', 'subscription']]),
      protectors: [{ label: 'wechat', check: session => session.id === 'wx' }],
    })
    expect(result.candidates.map(entry => entry.id)).toEqual(['old-1', 'old-2'])
    expect(Object.fromEntries(result.skipped)).toEqual({
      recent: ['new'], subagent: ['sub'], running: ['busy'], pinned: ['pin'], persistent: ['persist'], subscription: ['owner'], wechat: ['wx'],
    })
    expect(result.alreadyArchived).toBe(1)
  })

  it('keeps a Session exactly at the threshold only when it is younger than it', async () => {
    const result = await select([row('edge', 7), row('younger', 6.99)])
    expect(result.candidates.map(entry => entry.id)).toEqual(['edge'])
  })

  it('lets the first protector that claims a Session win, awaits async ones, and treats a throw as a claim', async () => {
    const calls: string[] = []
    const errors: string[] = []
    const protectors: Array<{ label: string; check: SessionProtector }> = [
      { label: 'a', check: async (session) => { calls.push(`a:${session.id}`); return session.id === 'x' ? 'reason' : undefined } },
      { label: 'b', check: (session) => { calls.push(`b:${session.id}`); if (session.id === 'boom') throw new Error('nope'); return false } },
    ]
    const result = await select([row('x', 10), row('boom', 11), row('free', 12)], { protectors, onProtectorError: (label, id) => { errors.push(`${label}:${id}`) } })
    expect(result.candidates.map(entry => entry.id)).toEqual(['free'])
    expect(Object.fromEntries(result.skipped)).toEqual({ a: ['x'], b: ['boom'] })
    expect(errors).toEqual(['b:boom'])
    // Protectors only see Sessions that are otherwise due.
    expect(calls).not.toContain('a:new')
  })

  it('never calls a protector for a recent, running, pinned, or archived Session', async () => {
    const check = vi.fn(() => false)
    await select([row('r', 1), row('run', 30, { running: true }), row('pin', 30), row('arch', 30)], { pinned: new Set(['pin']), archived: new Set(['arch']), protectors: [{ label: 'p', check }] })
    expect(check).not.toHaveBeenCalled()
  })
})

describe('resolveAutoArchive', () => {
  it('stays off without a block and fills the defaults of a partial one', () => {
    expect(resolveAutoArchive(undefined).enabled).toBe(false)
    expect(resolveAutoArchive({ inactiveDays: 3 })).toEqual({ ...AUTO_ARCHIVE_DEFAULTS, inactiveDays: 3 })
    expect(AUTO_ARCHIVE_DEFAULTS).toMatchObject({ enabled: true, inactiveDays: 7, dryRun: false, maxPerSweep: 50, firstSweepMinutes: 10, sweepHours: 6 })
  })
})

/** A host double over a mutable Session list; archiving moves a Session into the archived set. */
function fakeHost(rows: SessionRow[], extra: { active?: Set<string>; fail?: Set<string>; builtin?: Map<string, string> } = {}) {
  const archived = new Set<string>()
  const log: string[] = []
  const host: ArchiveHost = {
    now: () => Date.now(),
    list: async () => rows,
    archivedIds: () => archived,
    pinnedIds: () => new Set(),
    builtinProtected: () => extra.builtin ?? new Map(),
    archive: async (id) => {
      log.push(id)
      if (extra.active?.has(id)) throw Object.assign(new Error('active'), { name: 'WorkspaceActiveSessionError' })
      if (extra.fail?.has(id)) throw new Error('disk full')
      archived.add(id)
    },
  }
  return { host, archived, log }
}

function logger() {
  const lines: string[] = []
  return { lines, logger: { info: (m: string) => { lines.push(m) }, warn: (m: string) => { lines.push(`WARN ${m}`) }, debug: (m: string) => { lines.push(`DEBUG ${m}`) } } }
}

const config = (extra: Partial<AutoArchiveConfig> = {}): AutoArchiveConfig => ({ ...AUTO_ARCHIVE_DEFAULTS, ...extra })

/** A scheduler double that records the armed delay and fires on demand. */
function fakeTimeout() {
  const armed: Array<{ ms: number; fire: () => void; cancelled: boolean; fired: boolean }> = []
  const timeout = (callback: () => void, ms: number): (() => void) => {
    const entry = { ms, cancelled: false, fired: false, fire: () => { entry.fired = true; callback() } }
    armed.push(entry)
    return () => { entry.cancelled = true }
  }
  return { armed, timeout, live: () => armed.filter(entry => !entry.cancelled && !entry.fired) }
}

describe('SessionArchiver', () => {
  it('archives due Sessions up to maxPerSweep, oldest first, and defers the rest to the next sweep', async () => {
    const { host, log } = fakeHost([row('a', 10), row('b', 20), row('c', 30), row('fresh', 1)])
    const { lines, logger: out } = logger()
    const archiver = new SessionArchiver(config({ maxPerSweep: 2 }), host, out, fakeTimeout().timeout)
    const report = await archiver.sweep()
    expect(log).toEqual(['c', 'b'])
    expect(report).toMatchObject({ scanned: 4, due: 3, archived: ['c', 'b'], skipped: { recent: 1, overLimit: 1 } })
    expect(lines.some(line => line.includes('archived 2') && line.includes('overLimit=1') && line.includes('c, b'))).toBe(true)
    const second = await archiver.sweep()
    expect(second).toMatchObject({ alreadyArchived: 2, archived: ['a'] })
    expect(archiver.status().recent.map(entry => entry.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('archives nothing in a dry run and lists what it would archive', async () => {
    const { host, log } = fakeHost([row('a', 10, { title: 'Old chat' }), row('b', 2)])
    const archiver = new SessionArchiver(config({ dryRun: true }), host, logger().logger, fakeTimeout().timeout)
    const report = await archiver.sweep()
    expect(log).toEqual([])
    expect(report).toMatchObject({ dryRun: true, archived: [], wouldArchive: [{ id: 'a', title: 'Old chat' }] })
    expect(archiver.status().recent).toEqual([])
    // A manual preview overrides a live configuration without touching it.
    const live = new SessionArchiver(config(), host, logger().logger, fakeTimeout().timeout)
    expect((await live.sweep('manual', { dryRun: true })).wouldArchive.map(entry => entry.id)).toEqual(['a'])
    expect(log).toEqual([])
  })

  it('counts a Session the Host refuses as active separately from a real failure, and keeps going', async () => {
    const { host, log } = fakeHost([row('busy', 30), row('broken', 20), row('ok', 10)], { active: new Set(['busy']), fail: new Set(['broken']) })
    const { lines, logger: out } = logger()
    const report = await new SessionArchiver(config(), host, out, fakeTimeout().timeout).sweep()
    expect(log).toEqual(['busy', 'broken', 'ok'])
    expect(report).toMatchObject({ archived: ['ok'], skipped: { active: 1 }, errors: ['broken: disk full'] })
    expect(lines.some(line => line.startsWith('WARN') && line.includes('broken: disk full'))).toBe(true)
  })

  it('reports an aborted sweep when the Session list fails, and joins a sweep already running', async () => {
    const { host } = fakeHost([])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let listed = 0
    const slow: ArchiveHost = { ...host, list: async () => { listed += 1; await gate; if (listed === 1) throw new Error('db down'); return [] } }
    const archiver = new SessionArchiver(config(), slow, logger().logger, fakeTimeout().timeout)
    const first = archiver.sweep()
    const joined = archiver.sweep()
    expect(joined).toBe(first)
    release()
    expect(await first).toMatchObject({ aborted: 'could not list Sessions: db down', scanned: 0 })
    expect(listed).toBe(1)
  })

  it('keeps the recently-archived table bounded, newest first', async () => {
    const rows = Array.from({ length: MAX_RECENT_ARCHIVED + 5 }, (_, index) => row(`s${index}`, 10 + index))
    const { host } = fakeHost(rows)
    const archiver = new SessionArchiver(config({ maxPerSweep: rows.length }), host, logger().logger, fakeTimeout().timeout)
    await archiver.sweep()
    const recent = archiver.status().recent
    expect(recent).toHaveLength(MAX_RECENT_ARCHIVED)
    expect(new Set(recent.map(entry => entry.sessionId)).size).toBe(MAX_RECENT_ARCHIVED)
  })

  it('arms the first sweep after firstSweepMinutes, repeats every sweepHours, and stop() cancels the timer', async () => {
    const { host, log } = fakeHost([row('a', 10)])
    const clock = fakeTimeout()
    const archiver = new SessionArchiver(config({ firstSweepMinutes: 10, sweepHours: 6 }), host, logger().logger, clock.timeout)
    await archiver.start()
    expect(clock.armed.map(entry => entry.ms)).toEqual([10 * 60_000])
    expect(archiver.status().nextSweepAt).toBe(NOW + 10 * 60_000)
    clock.armed[0]!.fire()
    await vi.waitFor(() => { expect(clock.armed).toHaveLength(2) })
    expect(log).toEqual(['a'])
    expect(clock.armed[1]!.ms).toBe(6 * HOUR)
    await archiver.stop()
    expect(clock.live()).toHaveLength(0)
    expect(archiver.status().nextSweepAt).toBeUndefined()
  })

  it('arms nothing while disabled, and the registry of protectors adds and withdraws claims', async () => {
    const { host, log } = fakeHost([row('a', 10), row('b', 11)])
    const clock = fakeTimeout()
    const archiver = new SessionArchiver(config({ enabled: false }), host, logger().logger, clock.timeout)
    await archiver.start()
    expect(clock.armed).toHaveLength(0)
    const withdraw = archiver.protect('qq', session => session.id === 'a')
    archiver.protect('qq', session => session.id === 'b')
    expect(archiver.status().protectors).toEqual(['qq'])
    expect((await archiver.sweep()).skipped).toEqual({ qq: 2 })
    withdraw()
    withdraw()
    expect((await archiver.sweep()).archived).toEqual(['a'])
    expect(log).toEqual(['a'])
  })
})

/** A Session list row as `sessionController.list` serves it. */
function listed(id: string, days: number, extra: Partial<FakeController['rows'][number]> = {}): FakeController['rows'][number] {
  return { sessionId: id, updatedAt: NOW - days * DAY, running: false, blank: false, ...extra }
}

const archiveConfig = (extra: Partial<AutoArchiveConfig> = {}) => withConfig(baseConfig, { autoArchive: config(extra) })

describe('ForkEventBus auto-archive', () => {
  it('archives an idle Session after the first sweep delay through the Host registry, and logs the sweep', async () => {
    const controller = fakeController()
    controller.rows.push(listed('old', 12, { cwd: '/w', projections: { values: { title: 'Old chat' } } }), listed('fresh', 1))
    const registry = fakeRegistry()
    const logs: string[] = []
    const { bus } = await harness({ config: archiveConfig(), controller, registry, logs })
    expect(bus.archiveStatus()).toMatchObject({ enabled: true, inactiveDays: 7, nextSweepAt: NOW + 10 * 60_000, protectors: [] })
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(registry.archivedSessionIds).toEqual([])
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(registry.archivedSessionIds).toEqual(['old'])
    const status = bus.archiveStatus()
    expect(status.recent).toMatchObject([{ sessionId: 'old', title: 'Old chat', cwd: '/w', lastActiveAt: NOW - 12 * DAY }])
    expect(status.lastSweep).toMatchObject({ trigger: 'timer', scanned: 2, archived: ['old'], skipped: { recent: 1 } })
    expect(status.nextSweepAt).toBe(NOW + 10 * 60_000 + 6 * HOUR)
    expect(logs.some(line => line.includes('auto-archive sweep (timer): scanned 2') && line.includes('archived old'))).toBe(true)
  })

  it('leaves persistent bus Sessions, subscription creators, Host-active, pinned, and plugin-protected Sessions alone', async () => {
    const controller = fakeController()
    for (const id of ['persist', 'creator', 'active', 'pinned', 'chat', 'wx', 'qq-group', 'plain']) controller.rows.push(listed(id, 30))
    controller.rows.push(listed('turn', 30, { running: true }), listed('child', 30, { origin: 'subagent' }))
    const registry = fakeRegistry()
    registry.active.add('active')
    registry.pinnedSessionIds.push('pinned')
    const { bus } = await harness({ config: archiveConfig(), controller, registry })
    // A Session that created a run-time subscription (a watch) belongs to it.
    await bus.subscribe({ id: 'mine', sources: ['github'], kinds: [], subjects: [], action: 'notify', coalesceMs: 1000, maxPerHour: 1 }, { createdBy: 'creator' })
    // A persistent subscription Session is reached through the stored table; seed it through the bus's own API.
    const persistentSessions = vi.spyOn(bus, 'persistentSessions').mockReturnValue([{ subscription: 'x', sessionId: 'persist', createdAt: 0, batches: 1, compactions: 0 }] as never)
    const disposeWx = bus.protectSessions('wechat', session => session.id === 'wx')
    bus.protectSessions('qq', session => (session.id === 'qq-group' ? 'resident group' : false))
    const report = await bus.sweepArchive()
    expect(persistentSessions).toHaveBeenCalled()
    expect(registry.archivedSessionIds.sort()).toEqual(['chat', 'plain'])
    expect(report.skipped).toEqual({ persistent: 1, subscription: 1, active: 1, pinned: 1, running: 1, subagent: 1, wechat: 1, qq: 1 })
    expect(bus.archiveStatus().protectors).toEqual(['wechat', 'qq'])
    disposeWx()
    expect(bus.archiveStatus().protectors).toEqual(['qq'])
  })

  it('previews with dryRun and archives nothing', async () => {
    const controller = fakeController()
    controller.rows.push(listed('old', 12))
    const registry = fakeRegistry()
    const { bus } = await harness({ config: archiveConfig({ dryRun: true }), controller, registry })
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(registry.archivedSessionIds).toEqual([])
    expect(bus.archiveStatus().lastSweep).toMatchObject({ dryRun: true, wouldArchive: [{ id: 'old' }] })
  })

  it('is on with the schema defaults for a configuration without the block, and off when disabled', async () => {
    const controller = fakeController()
    controller.rows.push(listed('old', 12))
    const registry = fakeRegistry()
    const plain = await harness({ config: baseConfig, controller, registry })
    expect(plain.bus.archiveStatus()).toMatchObject({ enabled: true, inactiveDays: 7, maxPerSweep: 50, sweepHours: 6 })
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(registry.archivedSessionIds).toEqual(['old'])
    await disposeAll()
    const registry2 = fakeRegistry()
    const off = await harness({ config: archiveConfig({ enabled: false }), controller, registry: registry2 })
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(off.bus.archiveStatus()).toMatchObject({ enabled: false })
    expect(off.bus.archiveStatus().nextSweepAt).toBeUndefined()
    expect(registry2.archivedSessionIds).toEqual([])
  })

  it('reports an aborted sweep instead of throwing when the Host services are missing', async () => {
    const logs: string[] = []
    const { bus } = await harness({ config: archiveConfig(), logs })
    expect((await bus.sweepArchive()).aborted).toContain('no sessionController service is mounted')
    expect(logs.some(line => line.includes('auto-archive sweep aborted'))).toBe(true)
    const controller = fakeController()
    controller.rows.push(listed('old', 12))
    const noRegistry = await harness({ config: archiveConfig(), controller })
    expect((await noRegistry.bus.sweepArchive()).errors).toEqual(['old: no workspaceRegistry service is mounted'])
  })

  it('cancels the sweep timer and drops the protectors when the bus is disposed (HMR)', async () => {
    const controller = fakeController()
    controller.rows.push(listed('old', 12))
    const registry = fakeRegistry()
    const mounted = await harness({ config: archiveConfig(), controller, registry })
    mounted.bus.protectSessions('wechat', () => false)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    const before = vi.getTimerCount()
    await mounted.ctx.fiber.dispose()
    expect(vi.getTimerCount()).toBeLessThan(before)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(registry.archivedSessionIds).toEqual([])
    expect(mounted.bus.archiveStatus().nextSweepAt).toBeUndefined()
  })
})
