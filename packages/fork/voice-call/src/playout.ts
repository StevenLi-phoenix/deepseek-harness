/**
 * Paced playout of the agent's speech: one PCMU frame every 20 ms, silence between talk spurts so
 * the far end's jitter buffer and the network path stay alive, and an RTP marker on the first frame
 * of each spurt. Barge-in clears the queue at once.
 */

import { FRAME_MS, FRAME_SAMPLES, ULAW_SILENCE, ulawEncode } from './audio.ts'

/** Receives each frame as it is due. */
export type FrameSink = (payload: Buffer, marker: boolean) => void

/** Most frames sent in one tick to catch up after the event loop stalled. */
const MAX_CATCH_UP = 5

const SILENCE_FRAME = Buffer.alloc(FRAME_SAMPLES, ULAW_SILENCE)

/** One call leg's outgoing audio clock. */
export class Playout {
  private readonly queue: Int16Array[] = []
  /** Samples of the head of the queue already sent. */
  private offset = 0
  private startedAt: number | undefined
  private sent = 0
  private talking = false
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly drained = new Set<() => void>()

  /**
   * @param sink - takes each 20 ms frame.
   * @param now - monotonic clock in milliseconds.
   */
  constructor(private readonly sink: FrameSink, private readonly now: () => number = () => performance.now()) {}

  /** Whether speech is queued or being sent. */
  get speaking(): boolean {
    return this.queue.length > 0
  }

  /** Start the 20 ms clock; idempotent. */
  start(): void {
    if (this.timer !== undefined) return
    this.startedAt = this.now()
    this.sent = 0
    this.timer = setInterval(() => { this.tick() }, FRAME_MS / 2)
  }

  /** Stop the clock and drop queued speech. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.clear()
  }

  /**
   * Queue speech after what is already queued.
   * @param samples - 8 kHz samples.
   */
  enqueue(samples: Int16Array): void {
    if (samples.length > 0) this.queue.push(samples)
  }

  /** Drop all queued speech (barge-in); waiters on {@link idle} resolve. */
  clear(): void {
    this.queue.length = 0
    this.offset = 0
    this.settle()
  }

  /**
   * Wait until the queue is empty.
   * @returns settlement once every queued sample was sent or cleared.
   */
  idle(): Promise<void> {
    if (!this.speaking) return Promise.resolve()
    return new Promise((resolve) => { this.drained.add(resolve) })
  }

  /** Send every frame due by now. Called by the clock; tests call it directly. */
  tick(): void {
    if (this.startedAt === undefined) return
    const due = Math.floor((this.now() - this.startedAt) / FRAME_MS) + 1 - this.sent
    // After a long stall, skip ahead rather than burst.
    if (due > MAX_CATCH_UP) this.sent += due - MAX_CATCH_UP
    for (let index = 0; index < Math.min(due, MAX_CATCH_UP); index += 1) this.sendFrame()
  }

  private sendFrame(): void {
    this.sent += 1
    if (this.queue.length === 0) {
      this.talking = false
      this.sink(SILENCE_FRAME, false)
      return
    }
    const frame = new Int16Array(FRAME_SAMPLES)
    let filled = 0
    while (filled < FRAME_SAMPLES && this.queue.length > 0) {
      const head = this.queue[0] as Int16Array
      const take = Math.min(FRAME_SAMPLES - filled, head.length - this.offset)
      frame.set(head.subarray(this.offset, this.offset + take), filled)
      filled += take
      this.offset += take
      if (this.offset >= head.length) {
        this.queue.shift()
        this.offset = 0
      }
    }
    const marker = !this.talking
    this.talking = true
    this.sink(ulawEncode(frame), marker)
    if (this.queue.length === 0) this.settle()
  }

  private settle(): void {
    for (const resolve of [...this.drained]) resolve()
    this.drained.clear()
  }
}
