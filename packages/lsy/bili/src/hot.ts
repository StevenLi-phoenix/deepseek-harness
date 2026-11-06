/**
 * `ctx.biliHot`: what Bilibili's public reads showed of the site's current slang, kept for a daily meme miner
 * (lsy-style). Two sources, both reads the `bili` Session already makes: the hot comments of `bili_video` and
 * `bili_comments`, and the hot-search list of `bili_hot_searches`. No new request is ever made for it.
 *
 * A comment is kept only as text, likes, video, and the time it was read: no UID, nickname, or link to a person.
 * The store is bounded (most rows, oldest dropped first) and rows expire; both bounds are checked on every write
 * and every read. Its text is strangers' public words: the consumer filters it and quotes it as data.
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { CommentView, HotSearch } from './api.ts'
import type { biliDomain } from './storage.ts'

/** Comments below this many likes are not worth learning from. */
export const HOT_MIN_LIKES = 20
/** Most comments kept. */
export const HOT_MAX_COMMENTS = 2000
/** Most hot-search words kept. */
export const HOT_MAX_WORDS = 500
/** Rows older than this are dropped. */
export const HOT_TTL_MS = 14 * 86_400_000
/** Longest kept comment, in characters. */
export const HOT_COMMENT_CHARS = 200

/** One hot comment, without any person. */
export interface BiliHotComment {
  text: string
  likes: number
  /** The video it was read under. */
  bvid: string
  /** When it was last read, Unix epoch milliseconds. */
  at: number
}

/** `ctx.biliHot`: the hot comments and hot-search words recent public reads showed. */
export interface BiliHot {
  /**
   * Hot comments (at least {@link HOT_MIN_LIKES} likes) read since a time.
   * @param options - `since` in Unix epoch milliseconds; omitted, every kept comment.
   * @returns comments, newest read first; expired rows are never returned.
   */
  comments(options?: { since?: number }): Promise<BiliHotComment[]>
  /**
   * Hot-search keywords seen since a time.
   * @param options - `since` in Unix epoch milliseconds; omitted, every kept word.
   * @returns the words, most recently listed first; expired rows are never returned.
   */
  words(options?: { since?: number }): Promise<string[]>
}

/** What the store needs from the host. */
export interface HotDeps {
  ready: Promise<Domain<typeof biliDomain>>
  now: () => number
  logger: { info(message: string): void; warn(message: string): void }
}

/** `回复 @name :` at the start of a reply, which names a person. */
const REPLY_PREFIX = /^回复\s*@[^:：]{1,40}[:：]\s*/u

/**
 * A comment's text as it may be kept.
 * @param text - the comment, already bounded by the read.
 * @returns the text, or undefined when it names a person or is too short to carry slang.
 */
export function hotText(text: string): string | undefined {
  const cleaned = text.replace(REPLY_PREFIX, '').replace(/\s+/gu, ' ').trim()
  const characters = Array.from(cleaned)
  if (characters.length < 2 || cleaned.includes('@')) return undefined
  return characters.slice(0, HOT_COMMENT_CHARS).join('')
}

/** The write-through store behind {@link BiliHot}; the account notes what its reads showed. */
export class HotStore implements BiliHot {
  private chain: Promise<unknown> = Promise.resolve()

  /** @param deps - storage, clock, and logger. */
  constructor(private readonly deps: HotDeps) {}

  /** Run storage work one piece at a time; a failure reaches the caller and does not break the chain. */
  private serialize<T>(work: (domain: Domain<typeof biliDomain>) => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => work(await this.deps.ready))
    this.chain = result.catch(() => undefined)
    return result
  }

  /**
   * Remember the hot comments of a read. A failure is logged, never thrown: the read it came from must not fail.
   * @param bvid - the video.
   * @param rows - comments the read returned.
   */
  async noteComments(bvid: string, rows: readonly CommentView[]): Promise<void> {
    const keep = rows.flatMap((row) => {
      const text = hotText(row.text)
      /* v8 ignore next -- a row without likes fails the HOT_MIN_LIKES test first, so the second `?? 0` only narrows the type. */
      return text === undefined || (row.likes ?? 0) < HOT_MIN_LIKES ? [] : [{ rpid: row.rpid, text, likes: row.likes ?? 0 }]
    })
    if (keep.length === 0) return
    try {
      const at = this.deps.now()
      const dropped = await this.serialize(async (domain) => {
        const table = domain.table('hot_comments')
        for (const row of keep) {
          const known = table.get(row.rpid)
          await table.put(row.rpid, { text: row.text, likes: Math.max(row.likes, known?.likes ?? 0), bvid, at })
        }
        return prune(table, at, HOT_MAX_COMMENTS)
      })
      this.deps.logger.info(`bili: hot comments: kept ${keep.length} of ${rows.length} under ${bvid} (at least ${HOT_MIN_LIKES} likes)${dropped > 0 ? `; dropped ${dropped} expired or over the ${HOT_MAX_COMMENTS} cap` : ''}`)
    } catch (error: unknown) {
      this.deps.logger.warn(`bili: hot comments not kept: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Remember the hot-search list of a read. A failure is logged, never thrown.
   * @param list - the keywords the read returned.
   */
  async noteWords(list: readonly HotSearch[]): Promise<void> {
    const words = [...new Set(list.flatMap(item => [item.keyword, item.label ?? '']).map(word => word.trim()).filter(word => word !== '' && !word.includes('@')))]
    if (words.length === 0) return
    try {
      const at = this.deps.now()
      const dropped = await this.serialize(async (domain) => {
        const table = domain.table('hot_words')
        for (const word of words) await table.put(word, { at })
        return prune(table, at, HOT_MAX_WORDS)
      })
      this.deps.logger.info(`bili: hot words: ${words.length} listed${dropped > 0 ? `; dropped ${dropped} expired or over the ${HOT_MAX_WORDS} cap` : ''}`)
    } catch (error: unknown) {
      this.deps.logger.warn(`bili: hot words not kept: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  comments(options: { since?: number } = {}): Promise<BiliHotComment[]> {
    const floor = Math.max(options.since ?? 0, this.deps.now() - HOT_TTL_MS)
    return this.serialize(domain => Promise.resolve([...domain.table('hot_comments').entries()]
      .map(([, row]) => row)
      .filter(row => row.at >= floor && row.likes >= HOT_MIN_LIKES)
      .sort((a, b) => b.at - a.at || b.likes - a.likes)))
  }

  words(options: { since?: number } = {}): Promise<string[]> {
    const floor = Math.max(options.since ?? 0, this.deps.now() - HOT_TTL_MS)
    return this.serialize(domain => Promise.resolve([...domain.table('hot_words').entries()]
      .filter(([, row]) => row.at >= floor)
      .sort((a, b) => b[1].at - a[1].at)
      .map(([word]) => word)))
  }
}

/** The slice of a domain table {@link prune} uses. */
interface PrunableTable<V extends { at: number }> {
  entries(): Iterable<[string, V]>
  delete(key: string): Promise<unknown>
}

/**
 * Drop expired rows, then the oldest rows beyond the cap.
 * @param table - the rows.
 * @param now - the clock.
 * @param cap - most rows kept.
 * @returns how many rows were dropped.
 */
async function prune<V extends { at: number }>(table: PrunableTable<V>, now: number, cap: number): Promise<number> {
  const rows = [...table.entries()].sort((a, b) => b[1].at - a[1].at)
  const drop = rows.filter(([, row], index) => row.at < now - HOT_TTL_MS || index >= cap)
  for (const [key] of drop) await table.delete(key)
  return drop.length
}
