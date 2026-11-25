/** The plain helpers: polling, the shared read, the times, and the status line. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dateTime, formatDuration, shareInFlight, stampTime, startPolling, statusLine, type PageVisibility } from '../src/client.ts'

afterEach(() => {
  vi.useRealTimers()
})

/** A page whose visibility the test switches. */
function fakePage(state: DocumentVisibilityState = 'visible'): PageVisibility & { show(next: DocumentVisibilityState): void; listeners: number } {
  const listeners = new Set<() => void>()
  const page = {
    visibilityState: state,
    addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    show(next: DocumentVisibilityState) {
      page.visibilityState = next
      for (const listener of listeners) listener()
    },
    get listeners() { return listeners.size },
  }
  return page
}

describe('startPolling', () => {
  it('refreshes at once and on every period until stopped, without a document outside a browser', () => {
    expect('document' in globalThis).toBe(false)
    vi.useFakeTimers()
    const refresh = vi.fn()
    const stop = startPolling(refresh, 1000)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    expect(refresh).toHaveBeenCalledTimes(4)
    stop()
    vi.advanceTimersByTime(3000)
    expect(refresh).toHaveBeenCalledTimes(4)
  })

  it('stops while the page is hidden and refreshes at once when it shows again', () => {
    vi.useFakeTimers()
    const page = fakePage('hidden')
    const refresh = vi.fn()
    const stop = startPolling(refresh, 1000, page)
    vi.advanceTimersByTime(2000)
    expect(refresh).toHaveBeenCalledTimes(0)
    page.show('visible')
    expect(refresh).toHaveBeenCalledTimes(1)
    page.show('visible')
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    page.show('hidden')
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
    expect(page.listeners).toBe(0)
  })

  it('asks a period function for the next period after each refresh', () => {
    vi.useFakeTimers()
    let period = 1000
    const refresh = vi.fn()
    const stop = startPolling(refresh, () => period, fakePage())
    expect(refresh).toHaveBeenCalledTimes(1)
    period = 5000
    vi.advanceTimersByTime(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(4999)
    expect(refresh).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
  })

  it('polls without a visibility source when given null', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const stop = startPolling(refresh, 1000, null)
    vi.advanceTimersByTime(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe('shareInFlight', () => {
  it('joins the run in flight and starts a new one after it settles, rejected or not', async () => {
    const settle: Array<(fail: boolean) => void> = []
    const run = vi.fn(() => new Promise<void>((resolve, reject) => { settle.push((fail) => { if (fail) reject(new Error('read failed')); else resolve() }) }))
    const read = shareInFlight(run)
    const first = read()
    expect(read()).toBe(first)
    expect(run).toHaveBeenCalledTimes(1)
    settle[0]!(true)
    await expect(first).rejects.toThrow('read failed')
    const second = read()
    expect(second).not.toBe(first)
    expect(run).toHaveBeenCalledTimes(2)
    settle[1]!(false)
    await expect(second).resolves.toBeUndefined()
  })
})

describe('times', () => {
  it('prints a time of day, a date and time in a zone, and a coarse duration', () => {
    const at = Date.UTC(2026, 10, 24, 9, 5, 7)
    expect(stampTime(at)).toMatch(/^\d{2}:05:07$/)
    expect(dateTime(at, 'UTC')).toBe('11-24 09:05')
    expect(dateTime(at)).toMatch(/^\d{2}-\d{2} \d{2}:05$/)
    const t = (key: string, params: Record<string, number>): string => `${key} ${JSON.stringify(params)}`
    expect(formatDuration(3 * 86_400 + 5 * 3600, t)).toBe('duration.days {"days":3,"hours":5}')
    expect(formatDuration(2 * 3600 + 7 * 60, t)).toBe('duration.hours {"hours":2,"minutes":7}')
    expect(formatDuration(59, t)).toBe('duration.minutes {"minutes":0}')
    expect(formatDuration(-10, t)).toBe('duration.minutes {"minutes":0}')
  })
})

describe('statusLine', () => {
  const t = (key: string, params?: Record<string, string>): string => (params === undefined ? key : `${key} ${params['time']}`)
  const time = (ms: number): string => `@${ms}`

  it('waits in the section\'s tone, fails before any data, and dates the data it shows', () => {
    expect(statusLine(null, false, t, { time, waiting: 'idle' })).toEqual({ tone: 'idle', text: 'status.loading' })
    expect(statusLine(null, false, t, { time, waiting: 'loading' })).toEqual({ tone: 'loading', text: 'status.loading' })
    expect(statusLine(null, true, t, { time, waiting: 'idle' })).toEqual({ tone: 'stale', text: 'status.failed' })
    expect(statusLine(5, true, t, { time, waiting: 'idle' })).toEqual({ tone: 'stale', text: 'status.stale @5' })
    expect(statusLine(5, false, t, { time, waiting: 'idle' })).toEqual({ tone: 'live', text: 'status.live @5' })
  })
})
