/**
 * A queue that runs asynchronous work one item at a time, in call order.
 */

/** Work that starts only after every item queued before it settles; a failed item does not stop the items after it. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * Queue one item.
   * @param work - starts after every earlier item settles.
   * @returns the item's result or rejection.
   */
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => undefined)
    return result
  }

  /**
   * The settlement of every item queued so far.
   * @returns a promise that never rejects.
   */
  idle(): Promise<unknown> {
    return this.tail
  }
}
