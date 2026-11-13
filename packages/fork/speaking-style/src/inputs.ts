/**
 * What the meme miner reads, public text only: recorded QQ messages, Bilibili hot comments and hot-search words
 * (`ctx.biliHot`, kept by the `bili` plugin from reads it already makes), and the pages the main agent searched or
 * fetched (an inbox of their text, bounded and short-lived). Never memory, WeChat, or the owner's messages, and no
 * author of any text: only the text, the likes, and the time.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { cleanBiliText, cleanQqText, normalizeLine } from './filter.ts'
import type { QqSource } from './collect.ts'
import type { MineInput } from './miner.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The slice of `ctx.biliHot` the miner reads (the `bili` plugin's `BiliHot`; rows carry no person). */
export interface HotSource {
  comments(options?: { since?: number }): HotRows<{
    readonly text: string
    readonly likes: number
    readonly bvid?: string
    readonly at?: number
  }>
  words(options?: { since?: number }): HotRows<{ readonly word: string } | string>
}

/** A list the `bili` plugin returns now or after a read. */
type HotRows<T> = ReadonlyArray<T> | Promise<ReadonlyArray<T>>

/** Where the miner reads QQ from and how far back. */
export interface QqWindow {
  readonly hours: number
  /** Messages read per group at most. */
  readonly limit: number
  /** Messages newer than this many milliseconds wait for the next run (a sender can recall one for 2 minutes). */
  readonly settleMs: number
}

/** The lines of a page worth reading as messages: short enough to be a comment, long enough to hold a word. */
const LINE = { min: 4, max: 200 }

/**
 * Split a page's text into lines the miner can treat as messages.
 * @param text - search or fetch result text.
 * @returns trimmed lines of reasonable length.
 */
export function webLines(text: string): string[] {
  return text.split(/[\n\r]+/u).flatMap(line => line.split(/(?<=[。！？!?])/u)).map(normalizeLine).filter((line) => {
    const size = Array.from(line).length
    return size >= LINE.min && size <= LINE.max
  })
}

/**
 * Gather the inputs of one run. Each source is optional; a source that fails is skipped with a warning.
 * @param sources - the QQ observer, the Bilibili hot source, the web inbox lines, the QQ window, the earliest hot row,
 * the clock, and the warning sink.
 * @returns the texts to mine, with their kind and likes.
 */
export async function gatherInputs(sources: {
  readonly qq?: QqSource | undefined
  readonly hot?: HotSource | undefined
  readonly web?: readonly string[]
  readonly window: QqWindow
  readonly sinceMs: number
  readonly now: number
  readonly warn: (message: string) => void
}): Promise<MineInput[]> {
  const out: MineInput[] = []
  const { qq, hot, window, now } = sources
  if (qq !== undefined) {
    try {
      for (const group of await qq.groupOverview()) {
        if (!group.recorded) continue
        for (const message of await qq.recentMessages(group.groupId, { hours: window.hours, limit: window.limit })) {
          if (message.at > now - window.settleMs) continue
          const clean = cleanQqText(message.text, message.kinds)
          if ('reason' in clean || clean.text.trim() === '') continue
          out.push({ kind: 'qq', text: clean.text, likes: 0 })
        }
      }
    } catch (error: unknown) {
      sources.warn(`speaking-style: miner could not read QQ: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (hot !== undefined) {
    try {
      for (const row of await hot.comments({ since: sources.sinceMs })) out.push({ kind: 'comment', text: cleanBiliText(row.text), likes: row.likes })
      for (const row of await hot.words({ since: sources.sinceMs })) out.push({ kind: 'hot', text: typeof row === 'string' ? row : row.word, likes: 0 })
    } catch (error: unknown) {
      sources.warn(`speaking-style: miner could not read ctx.biliHot: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const line of sources.web ?? []) out.push({ kind: 'web', text: line, likes: 0 })
  return out
}

const foldText = (text: string): string => normalizeLine(text).normalize('NFKC').toLowerCase()

/** One page's text the main agent read. */
interface WebItem {
  readonly id: string
  readonly at: number
  readonly text: string
}

/**
 * Pages the main agent searched or fetched, kept briefly for the miner: the result text only, never the query. Written
 * whole through a temporary file; old items and items beyond the cap go.
 */
export class WebInbox {
  /**
   * @param file - absolute path of `web-inbox.json`.
   * @param limits - items kept, characters per item, and days an item lives.
   * @param now - clock; injectable for tests.
   */
  constructor(
    private readonly file: string,
    private readonly limits: { readonly items: number; readonly chars: number; readonly days: number },
    private readonly now: () => number = Date.now,
  ) {}

  private chain: Promise<unknown> = Promise.resolve()

  private async load(): Promise<WebItem[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      const rows: unknown[] = Array.isArray(parsed) ? parsed : []
      return rows.filter((row): row is WebItem => typeof row === 'object' && row !== null && typeof (row as WebItem).text === 'string' && typeof (row as WebItem).at === 'number')
    } catch {
      return []
    }
  }

  /**
   * Remember page text.
   * @param texts - result texts of web searches or fetches.
   */
  async add(texts: readonly string[]): Promise<void> {
    const work = async (): Promise<void> => {
      const items = await this.load()
      const at = this.now()
      for (const raw of texts) {
        const text = Array.from(raw).slice(0, this.limits.chars).join('')
        const id = createHash('sha1').update(text).digest('hex').slice(0, 12)
        if (text.trim() === '' || items.some(item => item.id === id)) continue
        items.push({ id, at, text })
      }
      const oldest = at - this.limits.days * 86_400_000
      const kept = items.filter(item => item.at >= oldest).toSorted((a, b) => b.at - a.at).slice(0, this.limits.items)
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${String(process.pid)}.tmp`
      await writeFile(temporary, `${JSON.stringify(kept)}\n`, { mode: 0o600 })
      await rename(temporary, this.file)
    }
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    await next
  }

  /**
   * The lines of live items that mention a term, as material for its meaning.
   * @param term - the meme.
   * @param chars - characters returned at most.
   * @returns the lines joined by newlines; undefined when no live page mentions the term.
   */
  async around(term: string, chars: number): Promise<string | undefined> {
    const needle = foldText(term)
    if (needle === '') return undefined
    const lines = (await this.lines()).filter(line => foldText(line).includes(needle))
    if (lines.length === 0) return undefined
    return Array.from(lines.join('\n')).slice(0, chars).join('')
  }

  /**
   * The text of the live pages, line by line.
   * @returns the lines of every live item, as miner inputs' text.
   */
  async lines(): Promise<string[]> {
    const oldest = this.now() - this.limits.days * 86_400_000
    return (await this.load()).filter(item => item.at >= oldest).flatMap(item => webLines(item.text))
  }
}

/** Tools whose results fill the inbox. */
const INBOX_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch'])

/**
 * The result text of a web search or fetch in a Session event, when the event is one. The tool name comes from the
 * Session's own `tool/call` event, so a result is matched to its tool by the host's ids, not by anything the model
 * wrote; the query and URL are never read.
 * @param names - open tool calls of this feed (call id → tool name); updated here.
 * @param event - one Session event.
 * @returns the result's text, or undefined for any other event.
 */
export function webResultText(names: Map<string, string>, event: SessionEvent): string | undefined {
  if (event.type === 'tool/call') {
    if (INBOX_TOOLS.has(event.data.name)) names.set(String(event.data.callId), event.data.name)
    return undefined
  }
  if (event.type !== 'tool/result') return undefined
  const id = String(event.data.message.toolCallId)
  if (!names.delete(id)) return undefined
  const content: unknown = event.data.message.content
  if (!Array.isArray(content)) return undefined
  const text = (content as Array<{ type?: string; text?: string }>).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  return text === '' ? undefined : text
}
