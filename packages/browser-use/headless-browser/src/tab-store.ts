/**
 * Storage and restart reconciliation for the browser plugin's tab metadata.
 *
 * @module @deepseek-ai/dsh-headless-browser/tab-store
 */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { firstLine } from './error.ts'

/** Tab metadata only; never a snapshot of a browser document or profile. */
interface TabRecord {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly openedBySessionId: string | null
  readonly status: 'open' | 'closed' | 'lost'
}

/** Tab identity and navigation metadata captured from the live browser. */
export interface TabObservation {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly openedAt: string
  readonly lastNavigatedAt: string
  readonly openedBySessionId: string | null
}

const HISTORY_LIMIT = 64

/** One append-and-replace ledger for the browser plugin, not one per DSH Session. */
export class TabStore {
  readonly #path: string
  readonly #log: Context['logger']
  readonly #records = new Map<string, TabRecord>()
  #loaded: Promise<void> | undefined
  #pending: Promise<void> = Promise.resolve()

  constructor(path: string, log: Context['logger']) {
    this.#path = path
    this.#log = log
  }

  /**
   * Check whether boot needs a live context to reconcile formerly open tabs.
   * @returns whether the ledger contains at least one open tab.
   */
  async hasOpenTabs(): Promise<boolean> {
    await this.#load()
    return [...this.#records.values()].some(row => row.status === 'open')
  }

  /** Wait for all updates queued so far, including the atomic write. */
  async flush(): Promise<void> {
    await this.#pending
  }

  /**
   * Queue a tab opening or navigation without persisting URL secrets or inline documents.
   * @param tab - the live tab observation.
   */
  see(tab: TabObservation): void {
    const row: TabRecord = {
      id: tab.id,
      url: addressForStorage(tab.url),
      title: tab.title.slice(0, 256),
      firstSeenAt: tab.openedAt,
      lastSeenAt: tab.lastNavigatedAt,
      openedBySessionId: tab.openedBySessionId,
      status: 'open',
    }
    this.#update(() => {
      const old = this.#records.get(row.id)
      if (old?.status === 'open' && old.url === row.url && old.title === row.title
        && old.lastSeenAt === row.lastSeenAt && old.openedBySessionId === row.openedBySessionId) return false
      this.#records.set(row.id, row)
      return true
    })
  }

  /**
   * Keep a tombstone for a known close, distinct from unexpected disappearance.
   * @param id - the tab identity that closed.
   * @param at - the close time as an ISO timestamp.
   */
  closed(id: string, at: string): void {
    this.#update(() => {
      const row = this.#records.get(id)
      if (row?.status !== 'open') return false
      this.#records.set(id, { ...row, status: 'closed', lastSeenAt: at })
      return true
    })
  }

  /**
   * Mark previously open tabs missing from the live context as lost; never infer identity from a URL.
   * @param ids - the tab identities currently in the live context.
   */
  async reconcile(ids: readonly string[]): Promise<void> {
    const live = new Set(ids)
    this.#update(() => {
      let changed = false
      for (const row of this.#records.values()) {
        if (row.status !== 'open' || live.has(row.id)) continue
        this.#records.set(row.id, { ...row, status: 'lost' })
        changed = true
      }
      return changed
    })
    await this.flush()
  }

  #load(): Promise<void> {
    this.#loaded ??= this.#read()
    return this.#loaded
  }

  async #read(): Promise<void> {
    try {
      const doc: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      if (!isObject(doc) || doc['version'] !== 1 || !Array.isArray(doc['tabs'])) {
        throw new Error('invalid tab ledger')
      }
      for (const value of doc['tabs']) {
        const row = readRow(value)
        if (row !== undefined) this.#records.set(row.id, row)
      }
    } catch (error: unknown) {
      if (isObject(error) && error['code'] === 'ENOENT') return
      // JSON parser diagnostics can contain raw file text; do not log it.
      this.#log.warn('headless-browser: could not read tabs.json')
    }
  }

  #update(change: () => boolean): void {
    this.#pending = this.#pending.then(async () => {
      await this.#load()
      if (change()) await this.#write()
    }).catch((error: unknown) => {
      this.#log.warn('headless-browser: could not save tabs.json: %s', firstLine(error))
    })
  }

  async #write(): Promise<void> {
    const history = [...this.#records.values()].filter(row => row.status !== 'open')
      .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))
    for (const row of history.slice(0, Math.max(0, history.length - HISTORY_LIMIT))) this.#records.delete(row.id)
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    const temp = `${this.#path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify({ version: 1, tabs: [...this.#records.values()] }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await chmod(temp, 0o600)
      await rename(temp, this.#path)
    } finally {
      await rm(temp, { force: true })
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRow(value: unknown): TabRecord | undefined {
  if (!isObject(value)) return undefined
  const { id, url, title, firstSeenAt, lastSeenAt, openedBySessionId, status } = value
  if (typeof id !== 'string' || typeof url !== 'string' || typeof title !== 'string'
    || typeof firstSeenAt !== 'string' || typeof lastSeenAt !== 'string'
    || (openedBySessionId !== null && typeof openedBySessionId !== 'string')
    || (status !== 'open' && status !== 'closed' && status !== 'lost')) return undefined
  return { id, url: addressForStorage(url), title: title.slice(0, 256), firstSeenAt, lastSeenAt, openedBySessionId, status }
}

function addressForStorage(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      if (url.protocol === 'about:' && url.pathname === 'blank') return 'about:blank'
      return url.protocol
    }
    return `${url.origin}${url.pathname}`.slice(0, 2_048)
  } catch {
    return ''
  }
}
