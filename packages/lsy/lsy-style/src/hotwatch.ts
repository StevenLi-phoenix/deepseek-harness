/**
 * HotWatch, the trending-topics service on the tailnet, as a supplement to the memes the groups use: the `meme` domain's
 * hottest titles for the index (cached for `ttlMs`), and one event's summary for `meme_lookup` (cached the same). Titles
 * and summaries are third-party text: they pass the note filter before use. A failure degrades to nothing and is
 * logged once per kind of failure.
 */

import { normalizeLine, screenNote } from './filter.ts'
import { termKey } from './notes.ts'

/** A trending meme title. */
export interface HotMeme {
  readonly id: string
  readonly title: string
  readonly heat: number
}

/** How the client reaches HotWatch. */
export interface HotWatchOptions {
  readonly url: string
  readonly limit: number
  readonly ttlMs: number
  readonly timeoutMs: number
  readonly fetch: typeof fetch
  readonly warn: (message: string) => void
  readonly now?: () => number
}

/** The HotWatch client. */
export class HotWatch {
  private list: { at: number; memes: HotMeme[] } | undefined
  private readonly summaries = new Map<string, { at: number; summary: string | undefined }>()
  private readonly warned = new Set<string>()

  /** @param options - address, limits, cache lifetime, fetch, and the warning sink. */
  constructor(private readonly options: HotWatchOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.options.fetch(`${this.options.url}${path}`, { signal: AbortSignal.timeout(this.options.timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    return await response.json()
  }

  private fail(kind: string, error: unknown): void {
    if (this.warned.has(kind)) return
    this.warned.add(kind)
    this.options.warn(`lsy-style: HotWatch ${kind} unavailable (${error instanceof Error ? error.message : String(error)}); using the groups' memes only`)
  }

  private loading: Promise<HotMeme[]> | undefined

  /**
   * The trending meme titles.
   * @returns the hottest meme titles that pass the filter, cached; empty when HotWatch cannot be reached.
   */
  async memes(): Promise<HotMeme[]> {
    if (this.list !== undefined && this.now() - this.list.at < this.options.ttlMs) return this.list.memes
    // Callers that arrive while a read is in flight share it.
    this.loading ??= this.load().finally(() => { this.loading = undefined })
    return await this.loading
  }

  private async load(): Promise<HotMeme[]> {
    try {
      const body = await this.get(`/events?domain=meme&order=heat&limit=${String(this.options.limit)}`)
      const rows: unknown[] = Array.isArray(body) ? body : []
      const memes = rows.flatMap((row): HotMeme[] => {
        const { subevent_id: id, title, heat } = typeof row === 'object' && row !== null ? row as Record<string, unknown> : {}
        if ((typeof id !== 'string' && typeof id !== 'number') || typeof title !== 'string') return []
        const clean = normalizeLine(title)
        if (screenNote(clean, 40) !== undefined) return []
        return [{ id: String(id), title: clean, heat: typeof heat === 'number' ? heat : 0 }]
      })
      this.list = { at: this.now(), memes }
      this.warned.delete('list')
    } catch (error: unknown) {
      this.fail('list', error)
      this.list = { at: this.now(), memes: [] }
    }
    return this.list.memes
  }

  /**
   * One meme's summary.
   * @param term - what the agent asked about; matches a title containing it.
   * @returns the title and summary, or undefined when nothing matches or HotWatch cannot answer.
   */
  async lookup(term: string): Promise<{ title: string; summary: string } | undefined> {
    const key = termKey(term)
    if (key === '') return undefined
    const meme = (await this.memes()).find(candidate => termKey(candidate.title).includes(key) || key.includes(termKey(candidate.title)))
    if (meme === undefined) return undefined
    let cached = this.summaries.get(meme.id)
    if (cached === undefined || this.now() - cached.at >= this.options.ttlMs) {
      try {
        const body = await this.get(`/events/${encodeURIComponent(meme.id)}`)
        const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['summary'] : undefined
        const summary = typeof raw === 'string' ? Array.from(normalizeLine(raw)).slice(0, 300).join('') : undefined
        cached = { at: this.now(), summary: summary !== undefined && screenNote(summary, 300) === undefined ? summary : undefined }
        this.warned.delete('event')
      } catch (error: unknown) {
        this.fail('event', error)
        cached = { at: this.now(), summary: undefined }
      }
      this.summaries.set(meme.id, cached)
    }
    return cached.summary === undefined ? undefined : { title: meme.title, summary: cached.summary }
  }
}
