/**
 * Files the headless browser downloads. Chromium never asks where to save in
 * this browser: it runs headless, and Playwright pins every download to a
 * private artifact directory, so no save panel can open. What went wrong was
 * the opposite, silent kind: a link that answers `Content-Disposition:
 * attachment` made `page.goto` fail with `Download is starting`, and the file
 * sat in a temporary directory that is deleted when the browser closes, with
 * nothing telling the model it existed.
 *
 * This module keeps each download: it copies the finished file into one
 * configured directory (owner-only, a name the page cannot steer out of it, a
 * size cap, an age limit) and remembers a short record the tools report.
 *
 * @module @deepseek-ai/dsh-headless-browser/downloads
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { firstLine } from './error.ts'

/** Longest a download may take to finish before it is cancelled. */
export const DOWNLOAD_TIMEOUT_MS = 120_000
/** How long a navigation that failed with "Download is starting" waits for the download itself. */
export const DOWNLOAD_START_WAIT_MS = 5_000
/** Most records the store remembers. */
export const MAX_REMEMBERED = 50
/** Longest wait a tool may ask for. */
export const MAX_DOWNLOAD_WAIT_MS = 30_000
/** Pruning of old files runs at most this often. */
const PRUNE_EVERY_MS = 60 * 60 * 1000
/** Longest kept file name, extension included. */
const MAX_NAME = 120

/** Playwright's navigation error for a URL that turned out to be a download. */
const DOWNLOAD_STARTING = /Download is starting/iu

/**
 * Whether one navigation error only says the URL is a download.
 * @param message - the error message.
 * @returns whether a download follows.
 */
export function isDownloadStarting(message: string): boolean {
  return DOWNLOAD_STARTING.test(message)
}

/** The Playwright `Download` operations this module uses. */
export interface DownloadLike {
  url(): string
  suggestedFilename(): string
  path(): Promise<string | null>
  saveAs(path: string): Promise<void>
  delete(): Promise<void>
  cancel(): Promise<void>
  failure(): Promise<string | null>
}

/** The page operation that delivers downloads; a Playwright `Page` satisfies it. */
export interface DownloadPage {
  on(event: 'download', listener: (download: DownloadLike) => void): unknown
  off(event: 'download', listener: (download: DownloadLike) => void): unknown
}

/** One download, finished or failed. */
export interface DownloadRecord {
  /** Order the download started in, from 1. */
  readonly seq: number
  /** The address the file came from, without its query string. */
  readonly url: string
  /** The name the site suggested, reduced to a safe file name. */
  readonly filename: string
  /** Where the file now is; absent when the download failed. */
  readonly path?: string
  /** File size in bytes; absent when the download failed. */
  readonly bytes?: number
  /** Why the download failed, when it did. */
  readonly error?: string
  /** ISO time the download finished. */
  readonly savedAt: string
}

/** What a store needs to keep downloads. */
export interface DownloadStoreOptions {
  /** Directory that receives the files. */
  readonly dir: string
  /** Largest file kept, in bytes. */
  readonly maxBytes: number
  /** Age after which a kept file is deleted, in milliseconds; 0 keeps every file. */
  readonly retainMs: number
  /** Plugin logger. */
  readonly log: Pick<Context['logger'], 'debug' | 'info' | 'warn'>
  /** Clock, for tests. */
  readonly now?: () => number
}

/**
 * Reduce a site-suggested file name to one safe path segment.
 * @param suggested - the name from `Content-Disposition` or the URL.
 * @returns a name with no separator, control character, or leading dot.
 */
export function safeFileName(suggested: string): string {
  const base = suggested.replace(/^.*[\\/]/su, '')
  let name = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[.\s_]+/u, '').trim()
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : ''
    name = name.slice(0, MAX_NAME - ext.length) + ext
  }
  return name === '' ? 'download' : name
}

/**
 * The address of a download for a record or a log line: origin and path, never
 * the query string, which often carries a signed token.
 * @param url - the download's address.
 * @returns the address without query or fragment.
 */
export function plainUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch (error: unknown) {
    void error
    return 'unparseable-url'
  }
}

/** Keeps the downloads of every page it is attached to. */
export class DownloadStore {
  readonly #options: DownloadStoreOptions
  readonly #now: () => number
  readonly #records: DownloadRecord[] = []
  readonly #inflight = new Map<number, Promise<void>>()
  readonly #starts = new Set<() => void>()
  #seq = 0
  #prunedAt = 0

  constructor(options: DownloadStoreOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  /**
   * A marker for "downloads that start after now".
   * @returns the number of downloads started so far.
   */
  mark(): number {
    return this.#seq
  }

  /**
   * Keep every download this page starts.
   * @param page - a page of the browser context.
   * @returns how to stop listening.
   */
  attach(page: DownloadPage): () => void {
    const onDownload = (download: DownloadLike): void => { this.#start(download) }
    page.on('download', onDownload)
    return () => { page.off('download', onDownload) }
  }

  /**
   * The downloads that started after a marker, once each has finished.
   * @param mark - a value {@link mark} returned.
   * @param waitMs - how long to wait for one to start when none has; 0 does not wait.
   * @returns the records, oldest first.
   */
  async since(mark: number, waitMs: number): Promise<DownloadRecord[]> {
    if (this.#seq === mark && waitMs > 0) await this.#nextStart(waitMs)
    await this.#settled(mark)
    return this.#records.filter(record => record.seq > mark)
  }

  /**
   * The newest downloads, once the ones in flight have finished.
   * @param limit - most records to return.
   * @param waitMs - how long to wait for one to start when none is in flight; 0 does not wait.
   * @returns the records, oldest first.
   */
  async recent(limit: number, waitMs: number): Promise<DownloadRecord[]> {
    if (this.#inflight.size === 0 && waitMs > 0) await this.#nextStart(waitMs)
    await this.#settled(0)
    return this.#records.slice(-limit)
  }

  async #settled(mark: number): Promise<void> {
    const pending = [...this.#inflight].filter(([seq]) => seq > mark).map(([, done]) => done)
    await Promise.all(pending)
  }

  async #nextStart(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      this.#starts.add(() => { done() })
    })
  }

  #start(download: DownloadLike): void {
    const seq = ++this.#seq
    const waiters = [...this.#starts]
    this.#starts.clear()
    for (const wake of waiters) wake()
    const done = this.#keep(seq, download).then((record) => {
      this.#records.push(record)
      if (this.#records.length > MAX_REMEMBERED) this.#records.splice(0, this.#records.length - MAX_REMEMBERED)
    }).finally(() => { this.#inflight.delete(seq) })
    this.#inflight.set(seq, done)
  }

  async #keep(seq: number, download: DownloadLike): Promise<DownloadRecord> {
    const log = this.#options.log
    const url = plainUrl(download.url())
    const filename = safeFileName(download.suggestedFilename())
    log.debug('headless-browser: download #%d started from %s as %s', seq, url, filename)
    try {
      await this.#prune()
      const temp = await this.#finished(download)
      const { size } = await stat(temp)
      if (size > this.#options.maxBytes) {
        await download.delete().catch(() => undefined)
        throw new Error(`the file is ${String(size)} bytes, over the ${String(this.#options.maxBytes)}-byte limit`)
      }
      await mkdir(this.#options.dir, { recursive: true, mode: 0o700 })
      const dest = join(this.#options.dir, `${String(this.#now())}-${randomBytes(3).toString('hex')}-${filename}`)
      await download.saveAs(dest)
      await chmod(dest, 0o600)
      await download.delete().catch(() => undefined)
      log.info('headless-browser: saved download #%d (%d bytes) from %s to %s', seq, size, url, dest)
      return { seq, url, filename, path: dest, bytes: size, savedAt: new Date(this.#now()).toISOString() }
    } catch (error: unknown) {
      log.warn('headless-browser: download #%d from %s failed: %s', seq, url, firstLine(error))
      return { seq, url, filename, error: firstLine(error), savedAt: new Date(this.#now()).toISOString() }
    }
  }

  /** Wait for the browser to finish the file; cancel it when it takes too long. */
  async #finished(download: DownloadLike): Promise<string> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void download.cancel().catch(() => undefined)
        reject(new Error(`the download did not finish within ${String(DOWNLOAD_TIMEOUT_MS / 1000)}s and was cancelled`))
      }, DOWNLOAD_TIMEOUT_MS)
    })
    try {
      const path = await Promise.race([download.path(), timeout])
      if (path === null) throw new Error(await download.failure() ?? 'the browser reported no file')
      return path
    } finally {
      clearTimeout(timer)
    }
  }

  /** Delete files older than the retention, at most once an hour. */
  async #prune(): Promise<void> {
    const { retainMs, dir, log } = this.#options
    const now = this.#now()
    if (retainMs <= 0 || now - this.#prunedAt < PRUNE_EVERY_MS) return
    this.#prunedAt = now
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error: unknown) {
      void error
      return
    }
    let removed = 0
    for (const name of names) {
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (info.isFile() && now - info.mtimeMs > retainMs) {
          await rm(path, { force: true })
          removed += 1
        }
      } catch (error: unknown) {
        log.warn('headless-browser: pruning %s failed: %s', path, firstLine(error))
      }
    }
    if (removed > 0) log.info('headless-browser: removed %d downloads older than %d days', removed, Math.round(retainMs / 86_400_000))
  }
}

/**
 * Make the profile's own download settings match how this browser works: a PDF
 * is a download (the headless browser has no viewer to read one with, and a
 * viewer's save button is the one path that opens a native save dialog in a
 * browser with a window), and Chromium never asks where to save. Merged into
 * `Default/Preferences` before launch, only when the profile is closed; the
 * file is left alone when it cannot be read as JSON.
 * @param profileDir - the persistent profile.
 * @param pdfsAsDownloads - whether a PDF should download instead of opening in the viewer.
 * @param log - plugin logger.
 * @returns whether the file changed.
 */
export async function ensureDownloadPrefs(
  profileDir: string,
  pdfsAsDownloads: boolean,
  log: Pick<Context['logger'], 'debug' | 'info' | 'warn'>,
): Promise<boolean> {
  const path = join(profileDir, 'Default', 'Preferences')
  let prefs: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object')
    prefs = parsed as Record<string, unknown>
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('headless-browser: leaving the profile preferences alone, they do not read as JSON: %s', firstLine(error))
      return false
    }
  }
  const section = (key: string): Record<string, unknown> => {
    const value = prefs[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    const fresh: Record<string, unknown> = {}
    prefs[key] = fresh
    return fresh
  }
  let changed = false
  const download = section('download')
  if (download['prompt_for_download'] !== false) {
    download['prompt_for_download'] = false
    changed = true
  }
  const plugins = section('plugins')
  if (plugins['always_open_pdf_externally'] !== pdfsAsDownloads) {
    plugins['always_open_pdf_externally'] = pdfsAsDownloads
    changed = true
  }
  if (!changed) return false
  await mkdir(join(profileDir, 'Default'), { recursive: true })
  const temp = `${path}.dsh-tmp`
  await writeFile(temp, JSON.stringify(prefs), { mode: 0o600 })
  await rename(temp, path)
  log.info('headless-browser: set the profile download preferences (prompt_for_download=false, always_open_pdf_externally=%s)', String(pdfsAsDownloads))
  return true
}
