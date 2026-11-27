/** Bounded, Session-keyed access to job-browser screenshots; no path is opened for reading. */
import { randomUUID } from 'node:crypto'

const MAX_SNAPSHOTS = 16
const MAX_BYTES = 32 * 1024 * 1024

/** Stores only screenshot bytes supplied by the owned browser. */
export class JobSnapshots {
  readonly #images = new Map<string, { readonly owner: string; readonly data: Buffer }>()
  #bytes = 0

  /** @param owner - trusted Session key. @param data - newly captured PNG. @returns its opaque identifier. */
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

  /** @param owner - trusted Session key. @param id - exact screenshot identifier. @returns that Session's image if retained. */
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
