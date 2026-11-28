/** Bounded, Session-keyed access to job-browser screenshots; no path is opened for reading. */
import { randomUUID } from 'node:crypto'

const MAX_SNAPSHOTS = 16
const MAX_BYTES = 32 * 1024 * 1024

/** Stores only screenshot bytes supplied by the owned browser. */
export class JobSnapshots {
  readonly #images = new Map<string, { readonly owner: string; readonly data: Buffer }>()
  #bytes = 0

  /**
   * Retain a screenshot for one Session, evicting the oldest images while the count or total bytes exceed their limits.
   * @param owner - trusted Session key.
   * @param data - newly captured PNG.
   * @returns the opaque identifier for later retrieval.
   * @throws Error - when the image alone exceeds the byte limit.
   */
  add(owner: string, data: Buffer): string {
    if (data.length > MAX_BYTES) throw new Error('The browser snapshot is too large; capture the viewport instead.')
    const id = `job-snapshot:${randomUUID()}.png`
    this.#images.set(id, { owner, data })
    this.#bytes += data.length
    for (const [key, image] of this.#images) {
      if (this.#images.size <= MAX_SNAPSHOTS && this.#bytes <= MAX_BYTES) break
      this.#images.delete(key)
      this.#bytes -= image.data.length
    }
    return id
  }

  /**
   * Look up a retained screenshot, visible only to the Session that stored it.
   * @param owner - trusted Session key.
   * @param id - exact screenshot identifier.
   * @returns the PNG bytes, or undefined when the id is unknown, evicted, or owned by another Session.
   */
  get(owner: string, id: string): Buffer | undefined {
    const image = this.#images.get(id)
    return image?.owner === owner ? image.data : undefined
  }

  /** Drop references to screenshot bytes on disposal. */
  clear(): void {
    this.#images.clear()
    this.#bytes = 0
  }
}
