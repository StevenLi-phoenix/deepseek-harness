import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Subscription } from '../src/types.ts'
import { disposeAll, harness } from './harness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
})

afterEach(async () => {
  await disposeAll()
  vi.useRealTimers()
})

const watch = (id: string): Subscription => ({
  id, sources: ['github'], kinds: ['github.tag'], subjects: ['octo/repo'], action: 'notify', coalesceMs: 30_000, maxPerHour: 3,
})

describe('ForkEventBus session handover', () => {
  it('moves the subscriptions the old Sessions created and runs every registered mover', async () => {
    const { bus } = await harness()
    await bus.subscribe(watch('from-old'), { createdBy: 'old' })
    await bus.subscribe(watch('from-older'), { createdBy: 'older' })
    await bus.subscribe(watch('from-other'), { createdBy: 'other' })
    const calls: Array<[string[], string]> = []
    bus.registerHandover('monitor', (from, to) => {
      calls.push([[...from], to])
      return [{ id: 'mon-1', label: 'tail the build log' }]
    })
    bus.registerHandover('idle', () => [])

    const report = await bus.handOverSessions(['old', 'older', 'new'], 'new')

    expect(report).toEqual({
      moved: [
        { kind: 'subscription', items: [{ id: 'from-old', label: 'from-old' }, { id: 'from-older', label: 'from-older' }] },
        { kind: 'monitor', items: [{ id: 'mon-1', label: 'tail the build log' }] },
      ],
      failed: [],
    })
    expect(calls).toEqual([[['old', 'older'], 'new']])
    expect(Object.fromEntries(bus.listSubscriptions().map(view => [view.id, view.createdBy]))).toMatchObject({
      'from-old': 'new', 'from-older': 'new', 'from-other': 'other',
    })
    // A repeat finds nothing left to move.
    expect((await bus.handOverSessions(['old', 'older'], 'new')).moved).toEqual([{ kind: 'monitor', items: [{ id: 'mon-1', label: 'tail the build log' }] }])
  })

  it('reports a failing mover and still runs the others; a disposed mover is not asked', async () => {
    const logs: string[] = []
    const { bus } = await harness({ logs })
    bus.registerHandover('broken', () => { throw new Error('store closed') })
    const dispose = bus.registerHandover('gone', () => [{ id: 'x', label: 'x' }])
    bus.registerHandover('ok', async () => [{ id: 'y', label: 'y' }])
    dispose()

    const report = await bus.handOverSessions(['old'], 'new')

    expect(report).toEqual({ moved: [{ kind: 'ok', items: [{ id: 'y', label: 'y' }] }], failed: [{ kind: 'broken', error: 'store closed' }] })
    expect(logs.some(line => line.includes('handover mover broken failed: store closed'))).toBe(true)
  })

  it('moves nothing for an empty source list', async () => {
    const { bus } = await harness()
    const mover = vi.fn(() => [])
    bus.registerHandover('monitor', mover)
    expect(await bus.handOverSessions(['new'], 'new')).toEqual({ moved: [], failed: [] })
    expect(mover).not.toHaveBeenCalled()
  })

  it('says nothing moved when no subscription and no mover had anything, and a mover can be withdrawn twice', async () => {
    const logs: string[] = []
    const { bus } = await harness({ logs })
    const withdraw = bus.registerHandover('idle', () => [])
    expect(await bus.handOverSessions(['old'], 'new')).toEqual({ moved: [], failed: [] })
    expect(logs).toContain('info: fork-event-bus: handed Session(s) old over to new: nothing to move')
    withdraw()
    withdraw()
    bus.registerHandover('later', () => [{ id: 'z', label: 'z' }])
    expect((await bus.handOverSessions(['old'], 'new')).moved).toEqual([{ kind: 'later', items: [{ id: 'z', label: 'z' }] }])
  })
})
