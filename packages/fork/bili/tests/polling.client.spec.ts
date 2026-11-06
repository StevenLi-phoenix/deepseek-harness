/** The section's poller outside a browser, where there is no page to watch. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPolling } from '../src/client/bili.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('startPolling without a document', () => {
  it('refreshes at once and on every period until stopped', () => {
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
})
