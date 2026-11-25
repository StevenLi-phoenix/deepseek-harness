/** Background work a long-running service keeps until teardown, and the pause between its attempts. */

/**
 * The work a service starts and must see settle before it closes its storage: one chain of storage writes run one at
 * a time, background work whose failure is only logged, and work another service awaits.
 */
export class BackgroundWork {
  readonly #inflight = new Set<Promise<void>>()
  #chain: Promise<unknown> = Promise.resolve()

  /** @param onFailure - receives the failure of a piece passed to {@link track}; it logs, never throws. */
  constructor(private readonly onFailure: (error: unknown) => void) {}

  /**
   * Run `work` after every earlier serialized piece has settled.
   * @param work - one piece of storage work.
   * @returns its result; a rejection reaches the caller without breaking the chain.
   */
  serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(work)
    this.#chain = result.catch(() => undefined)
    return result
  }

  /**
   * Keep background work alive until {@link drain}; its failure goes to `onFailure`.
   * @param work - the running work.
   */
  track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => { this.onFailure(error) }).finally(() => this.#inflight.delete(tracked))
    this.#inflight.add(tracked)
  }

  /**
   * Keep work another service awaits alive until {@link drain}; its outcome stays the caller's.
   * @param work - the running work.
   * @returns `work` itself.
   */
  hold<T>(work: Promise<T>): Promise<T> {
    const held = work.then(() => undefined, () => undefined).finally(() => this.#inflight.delete(held))
    this.#inflight.add(held)
    return work
  }

  /**
   * Wait for every tracked and held piece, then for the serialized chain.
   * @returns settlement once all of it has settled; it never rejects.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#inflight])
    await this.#chain
  }
}

/** Where a running pause keeps the function that ends it early. */
export interface WakeSlot {
  wake: (() => void) | undefined
}

/**
 * Wait `ms`, or less: until `signal` aborts, or until `slot.wake` is called. The slot holds the wake function while the
 * pause runs and is cleared when it ends, unless a later pause took it over.
 * @param ms - the longest wait.
 * @param signal - ends the wait when it aborts.
 * @param slot - where the wake function is kept; omitted, only the timer and `signal` end the wait.
 * @returns settlement when the wait ends; it never rejects.
 */
export function pause(ms: number, signal: AbortSignal, slot?: WakeSlot): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      if (slot?.wake === done) slot.wake = undefined
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (slot !== undefined) slot.wake = done
    signal.addEventListener('abort', done, { once: true })
  })
}
