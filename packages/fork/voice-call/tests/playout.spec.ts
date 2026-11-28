import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRAME_SAMPLES, ULAW_SILENCE, ulawDecode } from '../src/audio.ts'
import { Playout } from '../src/playout.ts'

interface Sent {
  samples: Int16Array
  marker: boolean
  silence: boolean
}

function harness(): { playout: Playout; sent: Sent[]; advance: (ms: number) => void } {
  let clock = 1000
  const sent: Sent[] = []
  const playout = new Playout((payload, marker) => {
    sent.push({ samples: ulawDecode(payload), marker, silence: payload.every(byte => byte === ULAW_SILENCE) })
  }, () => clock)
  return { playout, sent, advance: (ms) => { clock += ms } }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('paced playout', () => {
  it('sends nothing before the clock starts', () => {
    const { playout, sent } = harness()
    playout.tick()
    expect(sent).toEqual([])
  })

  it('sends silence every 20 ms while nothing is queued', () => {
    const { playout, sent, advance } = harness()
    playout.start()
    playout.tick()
    expect(sent).toHaveLength(1)
    playout.tick()
    expect(sent).toHaveLength(1)
    advance(40)
    playout.tick()
    expect(sent).toHaveLength(3)
    expect(sent.every(frame => frame.silence && !frame.marker)).toBe(true)
    playout.stop()
  })

  it('cuts queued speech into 20 ms frames, marking only the first frame of each talk spurt', () => {
    const { playout, sent, advance } = harness()
    playout.start()
    playout.enqueue(new Int16Array(100).fill(1000))
    playout.enqueue(new Int16Array(100).fill(-1000))
    expect(playout.speaking).toBe(true)
    playout.tick()
    advance(20)
    playout.tick()
    advance(20)
    playout.tick()
    expect(sent.map(frame => frame.marker)).toEqual([true, false, false])
    // The first frame spans both chunks; the second holds the rest padded with zeros.
    expect(sent[0]?.samples.subarray(0, 100).every(sample => sample > 0)).toBe(true)
    expect(sent[0]?.samples.subarray(100).every(sample => sample < 0)).toBe(true)
    expect(sent[1]?.samples.subarray(0, 40).every(sample => sample < 0)).toBe(true)
    expect(sent[1]?.samples.subarray(40).every(sample => sample === 0)).toBe(true)
    expect(sent[2]?.silence).toBe(true)
    expect(playout.speaking).toBe(false)

    playout.enqueue(new Int16Array(FRAME_SAMPLES).fill(500))
    advance(20)
    playout.tick()
    expect(sent[3]?.marker).toBe(true)
    playout.stop()
  })

  it('ignores an empty chunk', () => {
    const { playout } = harness()
    playout.enqueue(new Int16Array(0))
    expect(playout.speaking).toBe(false)
  })

  it('resolves idle at once when nothing is queued and after the queue drains', async () => {
    const { playout, advance } = harness()
    await expect(playout.idle()).resolves.toBeUndefined()
    playout.start()
    playout.enqueue(new Int16Array(FRAME_SAMPLES * 2))
    let drained = false
    const waiting = playout.idle().then(() => { drained = true })
    playout.tick()
    await Promise.resolve()
    expect(drained).toBe(false)
    advance(20)
    playout.tick()
    await waiting
    expect(drained).toBe(true)
    playout.stop()
  })

  it('drops queued speech on clear and releases waiters', async () => {
    const { playout, sent } = harness()
    playout.start()
    playout.enqueue(new Int16Array(FRAME_SAMPLES * 10).fill(800))
    const waiting = playout.idle()
    playout.clear()
    await waiting
    expect(playout.speaking).toBe(false)
    playout.tick()
    expect(sent[0]?.silence).toBe(true)
    playout.stop()
  })

  it('catches up at most five frames after a stall and skips the rest', () => {
    const { playout, sent, advance } = harness()
    playout.start()
    playout.enqueue(new Int16Array(FRAME_SAMPLES * 20).fill(300))
    advance(200)
    playout.tick()
    expect(sent).toHaveLength(5)
    playout.tick()
    expect(sent).toHaveLength(5)
    advance(20)
    playout.tick()
    expect(sent).toHaveLength(6)
    playout.stop()
  })

  it('runs its own clock once started, starts only once, and stops dropping queued speech', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
    const sent: boolean[] = []
    const playout = new Playout((_payload, marker) => { sent.push(marker) })
    playout.start()
    playout.start()
    playout.enqueue(new Int16Array(FRAME_SAMPLES * 50))
    vi.advanceTimersByTime(100)
    expect(sent.length).toBeGreaterThanOrEqual(4)
    expect(sent.length).toBeLessThanOrEqual(7)
    expect(sent[0]).toBe(true)
    playout.stop()
    expect(playout.speaking).toBe(false)
    const count = sent.length
    vi.advanceTimersByTime(100)
    expect(sent).toHaveLength(count)
    playout.stop()
  })
})
