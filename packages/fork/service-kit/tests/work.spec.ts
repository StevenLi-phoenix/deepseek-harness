/** Background work a service drains at teardown, and the pause between attempts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackgroundWork, pause, type WakeSlot } from '../src/index.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('BackgroundWork', () => {
  it('runs serialized pieces one at a time and keeps the chain going after a rejection', async () => {
    const work = new BackgroundWork(() => {})
    const order: string[] = []
    let release!: () => void
    const first = work.serialize(() => new Promise<void>((resolve) => { release = () => { order.push('first'); resolve() } }))
    const second = work.serialize(async () => { order.push('second'); throw new Error('second failed') })
    const third = work.serialize(async () => { order.push('third'); return 3 })
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await first
    await expect(second).rejects.toThrow('second failed')
    await expect(third).resolves.toBe(3)
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('reports a tracked failure, returns held work unchanged, and drains both and the chain', async () => {
    const failures: unknown[] = []
    const work = new BackgroundWork((error) => { failures.push(error) })
    let settleTracked!: () => void
    let settleHeld!: (value: string) => void
    let settleChain!: () => void
    work.track(new Promise<void>((_resolve, reject) => { settleTracked = () => { reject(new Error('detached')) } }))
    const held = work.hold(new Promise<string>((resolve) => { settleHeld = resolve }))
    void work.serialize(() => new Promise<void>((resolve) => { settleChain = resolve }))
    let drained = false
    const draining = work.drain().then(() => { drained = true })
    settleTracked()
    settleHeld('kept')
    await expect(held).resolves.toBe('kept')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(failures).toEqual([new Error('detached')])
    expect(drained).toBe(false)
    settleChain()
    await draining
    expect(drained).toBe(true)
  })

  it('holds a rejected piece without reporting it: the caller handles its outcome', async () => {
    const failures: unknown[] = []
    const work = new BackgroundWork((error) => { failures.push(error) })
    await expect(work.hold(Promise.reject(new Error('caller sees it')))).rejects.toThrow('caller sees it')
    await work.drain()
    expect(failures).toEqual([])
  })
})

describe('pause', () => {
  it('ends on its timer, on abort, or when woken, and clears the slot it armed', async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const slot: WakeSlot = { wake: undefined }
    let ended = false
    const timed = pause(1000, abort.signal, slot).then(() => { ended = true })
    expect(slot.wake).toBeDefined()
    await vi.advanceTimersByTimeAsync(999)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await timed
    expect(slot.wake).toBeUndefined()

    const woken = pause(60_000, abort.signal, slot)
    slot.wake!()
    await woken
    expect(slot.wake).toBeUndefined()

    const aborted = pause(60_000, abort.signal)
    abort.abort()
    await aborted
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the wake of a later pause when an earlier one ends', async () => {
    vi.useFakeTimers()
    const signal = new AbortController().signal
    const slot: WakeSlot = { wake: undefined }
    const first = pause(5, signal, slot)
    const second = pause(60_000, signal, slot)
    await vi.advanceTimersByTimeAsync(5)
    await first
    expect(slot.wake).toBeDefined()
    slot.wake!()
    await second
    expect(slot.wake).toBeUndefined()
  })
})
