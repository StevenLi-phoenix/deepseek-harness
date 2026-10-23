import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SysmonSnapshot } from '../src/snapshot.ts'
import { SysmonLoader, createSysmonStore, parseSnapshot, startPolling, type VisibilitySource } from '../src/client/sysmon.ts'

const SNAPSHOT: SysmonSnapshot = {
  sampledAt: 1_000,
  uptime: 600,
  cpu: { usage: 0.5, cores: 10, load: [1, 2, 3] },
  memory: { total: 100, used: 50, swapTotal: 10, swapUsed: 1, approximate: false },
  power: null,
  temperature: null,
  disks: [],
  skippedMounts: [],
  sources: { macmon: 'missing' },
}

/** A document double whose visibility the test flips. */
function page(initial: DocumentVisibilityState): VisibilitySource & { show: (state: DocumentVisibilityState) => void; listeners: number } {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: initial,
    addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    show: (state: DocumentVisibilityState) => { doc.visibilityState = state; for (const listener of listeners) listener() },
    get listeners() { return listeners.size },
  }
  return doc
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SysmonLoader', () => {
  it('publishes an answer with its time and shares one request between concurrent refreshes', async () => {
    const store = createSysmonStore()
    const read = vi.fn(() => Promise.resolve(SNAPSHOT))
    const loader = new SysmonLoader(store, read, () => 42)
    const pending = Promise.all([loader.refresh(), loader.refresh()])
    expect(store.getSnapshot().refreshing).toBe(true)
    await pending
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toEqual({ snapshot: SNAPSHOT, checkedAt: 42, stale: false, refreshing: false })
    await loader.refresh()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps the last snapshot through failures, marks it stale, and warns once per outage', async () => {
    const store = createSysmonStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers: (SysmonSnapshot | Error)[] = [SNAPSHOT, new Error('offline'), new Error('offline'), { ...SNAPSHOT, sampledAt: 2_000 }, new Error('again')]
    let now = 0
    const loader = new SysmonLoader(store, () => {
      const answer = answers.shift()!
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    }, () => now)
    await loader.refresh()
    now = 5
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ snapshot: SNAPSHOT, checkedAt: 5, stale: true })
    now = 10
    await loader.refresh()
    expect(warn).toHaveBeenCalledTimes(1)
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ snapshot: { sampledAt: 2_000 }, stale: false })
    await loader.refresh()
    expect(warn).toHaveBeenCalledTimes(2)
    // The reason stays generic: nothing the Host returned reaches the console.
    expect(warn.mock.calls.flat()).toEqual(['[lsy-sysmon] system status read failed', '[lsy-sysmon] system status read failed'])
  })
})

describe('parseSnapshot', () => {
  it('accepts the route answer and refuses anything else', () => {
    expect(parseSnapshot(JSON.parse(JSON.stringify(SNAPSHOT)))).toEqual(SNAPSHOT)
    for (const body of [null, 'x', {}, { ...SNAPSHOT, disks: 'none' }, { ...SNAPSHOT, sampledAt: '1' }]) {
      expect(() => parseSnapshot(body)).toThrow('unexpected system status answer')
    }
  })
})

describe('startPolling', () => {
  it('refreshes at once and every interval while visible, pauses while hidden, and stops for good', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const doc = page('visible')
    const stop = startPolling(refresh, 5000, doc)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    doc.show('hidden')
    vi.advanceTimersByTime(60_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    doc.show('visible')
    expect(refresh).toHaveBeenCalledTimes(4)
    doc.show('visible')
    expect(refresh).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(5_000)
    expect(refresh).toHaveBeenCalledTimes(5)
    stop()
    expect(doc.listeners).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(refresh).toHaveBeenCalledTimes(5)
  })

  it('waits for a page that opens hidden, and polls without a document', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const doc = page('hidden')
    const stop = startPolling(refresh, 5000, doc)
    vi.advanceTimersByTime(20_000)
    expect(refresh).not.toHaveBeenCalled()
    doc.show('visible')
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
    const headless = vi.fn()
    const stopHeadless = startPolling(headless, 1000, null)
    vi.advanceTimersByTime(3_000)
    expect(headless).toHaveBeenCalledTimes(4)
    stopHeadless()
  })
})
