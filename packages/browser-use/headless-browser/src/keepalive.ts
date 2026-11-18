/**
 * Session-warming keepalives. A signed-in session dies when nobody visits it:
 * the site's own session expires, and the next real task starts at a sign-in
 * page. A keepalive is a URL the browser revisits on a timer in its own
 * offscreen page, so the visit renews the upstream session while that session
 * is still alive. Nothing here names a site, a selector, or a token: the check
 * only asks whether the page it landed on still looks like the signed-in page
 * (see `challenge.ts`), which is what makes it work for any logged-in site.
 *
 * A dead session is the plugin's problem, not the owner's. A failed check moves
 * the entry to `recovering` and retries on a 5m/15m/1h backoff, because many
 * outages are the site's own and clear themselves when the next visit renews
 * the session. Only repeated interactive challenges — a password field, a
 * one-time code, an account chooser — mean a person has to sign in; then the
 * entry says `needs-human` and repeats at most one notice an hour, always with
 * since when, how many attempts, the last URL, and the step that blocked.
 *
 * Nothing outside the tab model is touched: a check uses its own page pool with
 * at most two pages, so a keepalive never counts against the eight-tab cap the
 * user's tabs share.
 *
 * @module @deepseek-ai/dsh-headless-browser/keepalive
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { classifyChallenge, type BlockedStep, type Challenge, type ChallengeFacts } from './challenge.ts'
import { firstLine } from './error.ts'

/** Fewest minutes between two checks of one keepalive. */
export const MIN_EVERY_MINUTES = 5
/** Most minutes between two checks of one keepalive: a day. */
export const MAX_EVERY_MINUTES = 1_440
/** Retry delays after consecutive failures, in minutes; the last one is the cap. */
export const RETRY_BACKOFF_MINUTES: readonly number[] = [5, 15, 60]
/** Consecutive interactive challenges after which a person has to sign in. */
export const DEFAULT_ESCALATE_AFTER = 3
/** Shortest gap between two notices for one keepalive that stays `needs-human`. */
export const NOTICE_INTERVAL_MS = 3_600_000
/** Most checks that may run at once. */
export const MAX_CONCURRENT_CHECKS = 2
/** Most offscreen pages a check's pool keeps open. */
export const MAX_KEEPALIVE_PAGES = 2
/** Deadline for one visit, so a silent site does not hold a slot forever. */
export const KEEPALIVE_TIMEOUT_MS = 30_000

/** Version of the persisted file's shape. */
const FILE_VERSION = 1

/** Where one keepalive stands. A dead session is tried again, never parked. */
export type KeepaliveState = 'ok' | 'recovering' | 'needs-human' | 'error'

/** One state transition, or one repeated notice, as a host can watch it. */
export type KeepaliveEventKind = 'recovering' | 'needs-human' | 'error' | 'recovered' | 'reminder'

/** A keepalive the caller asked for. */
export interface KeepaliveRequest {
  /** Absolute http or https URL the check visits. */
  readonly url: string
  /** Site the check treats as on-site; defaults to the URL's own origin. */
  readonly domain?: string
  /** Minutes between checks, 5 through 1440; 5 when omitted. */
  readonly everyMinutes?: number
  /** Short human name; the host name when omitted. */
  readonly label?: string
}

/** One keepalive as the tools, the status route, and the file report it. */
export interface KeepaliveStatus {
  /** Stable id, `k1`, `k2`, … */
  readonly id: string
  /** Short human name. */
  readonly label: string
  /** Absolute URL the check visits. */
  readonly url: string
  /** Minutes between checks while the session is healthy. */
  readonly everyMinutes: number
  /** Where the keepalive stands now. */
  readonly state: KeepaliveState
  /** Consecutive failed checks; zero after a success. */
  readonly consecutiveFailures: number
  /** Site the check treats as on-site, when the caller named one. */
  readonly domain?: string
  /** When a check last found the signed-in page. */
  readonly lastOkAt?: string
  /** When the last attempt started; the same instant as `lastAttemptAt`. */
  readonly lastCheckAt?: string
  /** When the last attempt started. */
  readonly lastAttemptAt?: string
  /** When the next attempt is due: the interval after a success, the backoff after a failure. */
  readonly nextAttemptAt?: string
  /** When the current run of failures started. */
  readonly firstFailureAt?: string
  /** Why the last attempt failed, in one line. */
  readonly lastError?: string
  /** URL the last attempt settled on. */
  readonly lastUrl?: string
  /** The interactive step that stopped the last attempt, when one did. */
  readonly blockedStep?: BlockedStep
}

/** One keepalive as the service keeps it, including bookkeeping the status omits. */
interface KeepaliveRecord {
  readonly id: string
  readonly label: string
  readonly url: string
  readonly everyMinutes: number
  readonly createdAt: string
  readonly domain?: string
  state: KeepaliveState
  consecutiveFailures: number
  lastOkAt?: string
  lastAttemptAt?: string
  nextAttemptAt?: string
  lastError?: string
  lastUrl?: string
  blockedStep?: BlockedStep
  firstFailureAt?: string
  /** When the last `needs-human` notice went out, which caps notices at one an hour. */
  lastNoticeAt?: string
}

/** One transition or notice, as a host that watches the plugin sees it. */
export interface KeepaliveEvent {
  /** ISO 8601 time the event was published. */
  readonly at: string
  /** Transition kind, or `reminder` for the repeated notice of a session that stays dead. */
  readonly kind: KeepaliveEventKind
  /** Id of the keepalive. */
  readonly id: string
  /** Short human name. */
  readonly label: string
  /** URL the keepalive visits. */
  readonly url: string
  /** State after the transition. */
  readonly state: KeepaliveState
  /** Consecutive failed checks at the time of the event. */
  readonly consecutiveFailures: number
  /** URL the last attempt settled on. */
  readonly lastUrl?: string
  /** The interactive step that blocked the last attempt. */
  readonly blockedStep?: BlockedStep
  /** When the run of failures started, which is the "since when" of an escalation. */
  readonly firstFailureAt?: string
  /** When the last attempt started. */
  readonly lastAttemptAt?: string
}

/** One page a check drives; the session's offscreen page satisfies it. */
export interface KeepalivePage {
  /** URL the page has settled on. */
  url(): string
  /** Whether the page is already gone. */
  isClosed(): boolean
  /**
   * Visit a URL and wait for its load event.
   * @param url - absolute URL to load.
   * @param options - the wait state and the deadline.
   */
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>
  /** @returns the document's structural facts, measured by the challenge probe. */
  challenge(): Promise<ChallengeFacts>
  /** Close the page, so the pool can replace it. */
  close(): Promise<void>
}

/** What the keepalive service needs to run. */
export interface KeepaliveOptions {
  /** JSON file the records persist to. */
  readonly path: string
  /** Opens one page outside the tab model. */
  readonly create: () => Promise<KeepalivePage>
  /** Plugin logger for persistence, pool, and attempt failures. */
  readonly log: Context['logger']
  /** Publishes one transition, and at most one reminder an hour. */
  readonly emit: (event: KeepaliveEvent) => void
  /** Consecutive interactive challenges that mean a person must sign in. */
  readonly escalateAfter?: number
  /** Clock; defaults to `Date.now`. */
  readonly now?: () => number
  /** Timer factory; defaults to an unref'd `setTimeout`. */
  readonly schedule?: (delayMs: number, run: () => void) => () => void
  /** Most checks that may run at once; defaults to {@link MAX_CONCURRENT_CHECKS}. */
  readonly maxConcurrent?: number
}

/** The keepalive operations the model tools call. */
export interface KeepaliveTools {
  add(request: KeepaliveRequest): Promise<KeepaliveStatus>
  remove(id: string): Promise<void>
  list(): Promise<KeepaliveStatus[]>
  check(id: string): Promise<KeepaliveStatus>
}

/** A keepalive request that cannot be accepted, or an id that names none. */
export class KeepaliveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeepaliveError'
  }
}

/**
 * The offscreen pages keepalive checks borrow, at most
 * {@link MAX_KEEPALIVE_PAGES} of them: never a tab, so never part of the
 * eight-tab cap the user's tabs share.
 */
export class KeepalivePagePool {
  readonly #create: () => Promise<KeepalivePage>
  readonly #log: Context['logger']
  readonly #idle: KeepalivePage[] = []
  #disposed = false

  /**
   * @param options - how to open a page, and the plugin logger.
   */
  constructor(options: { readonly create: () => Promise<KeepalivePage>; readonly log: Context['logger'] }) {
    this.#create = options.create
    this.#log = options.log
  }

  /**
   * Borrow a page, reusing an idle one unless it is already gone.
   * @returns a page the caller must return with {@link release}.
   */
  async acquire(): Promise<KeepalivePage> {
    if (this.#disposed) throw new KeepaliveError('the keepalive pages are closed')
    while (this.#idle.length > 0) {
      const page = this.#idle.pop() as KeepalivePage
      if (!page.isClosed()) return page
      await closeQuietly(page, this.#log)
    }
    return await this.#create()
  }

  /**
   * Return a borrowed page to the pool, or close it when the pool is full or done.
   * @param page - the page the check borrowed.
   */
  release(page: KeepalivePage): void {
    if (this.#disposed || page.isClosed() || this.#idle.length >= MAX_KEEPALIVE_PAGES) {
      void closeQuietly(page, this.#log)
      return
    }
    this.#idle.push(page)
  }

  /** Close every idle page; later acquires are refused. */
  async close(): Promise<void> {
    this.#disposed = true
    await this.drop()
  }

  /** Close every idle page but keep the pool usable, for a context that came back. */
  async drop(): Promise<void> {
    const idle = this.#idle.splice(0)
    await Promise.all(idle.map(async page => await closeQuietly(page, this.#log)))
  }
}

/** The keepalive store and its timers. */
export class KeepaliveService implements KeepaliveTools {
  readonly #options: KeepaliveOptions
  readonly #records = new Map<string, KeepaliveRecord>()
  readonly #order: string[] = []
  readonly #timers = new Map<string, () => void>()
  readonly #inflight = new Map<string, Promise<void>>()
  readonly #waiters: (() => void)[] = []
  readonly #pages: KeepalivePagePool
  readonly #now: () => number
  readonly #schedule: (delayMs: number, run: () => void) => () => void
  readonly #escalateAfter: number
  readonly #maxConcurrent: number
  #loaded: Promise<void> | undefined
  #saving: Promise<void> = Promise.resolve()
  #sequence = 0
  #active = 0
  #disposed = false

  /**
   * @param options - the file, the page source, the logger, and the event sink.
   */
  constructor(options: KeepaliveOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#schedule = options.schedule ?? unrefTimer
    this.#escalateAfter = Math.max(1, Math.trunc(options.escalateAfter ?? DEFAULT_ESCALATE_AFTER))
    this.#maxConcurrent = Math.max(1, Math.trunc(options.maxConcurrent ?? MAX_CONCURRENT_CHECKS))
    this.#pages = new KeepalivePagePool({ create: options.create, log: options.log })
  }

  /**
   * Read the persisted records and arm their timers, once.
   * @returns when the store is ready.
   */
  async load(): Promise<void> {
    this.#loaded ??= this.#restore()
    await this.#loaded
  }

  /**
   * Every keepalive, in the order it was added.
   * @returns the status list the tools and the status route report.
   */
  snapshot(): KeepaliveStatus[] {
    return this.#order.map(id => statusOf(this.#records.get(id) as KeepaliveRecord))
  }

  /**
   * Every keepalive, after the store has read its file.
   * @returns the status list.
   */
  async list(): Promise<KeepaliveStatus[]> {
    await this.load()
    return this.snapshot()
  }

  /**
   * Register one URL to be visited on a timer.
   * @param request - the URL, the optional site, interval, and label.
   * @returns the new entry's status.
   * @throws KeepaliveError - when the URL, interval, or domain is unusable, or the URL is already kept.
   */
  async add(request: KeepaliveRequest): Promise<KeepaliveStatus> {
    await this.load()
    this.#assertOpen()
    const target = normalizeTarget(request.url)
    const domain = domainFilterOf(request.domain)
    const everyMinutes = intervalOf(request.everyMinutes)
    for (const record of this.#records.values()) {
      if (record.url === target) {
        throw new KeepaliveError(`${record.id} (${record.label}) already visits ${target}`)
      }
    }
    const at = this.#now()
    const record: KeepaliveRecord = {
      id: `k${String(++this.#sequence)}`,
      label: labelOf(request.label, target),
      url: target,
      everyMinutes,
      createdAt: iso(at),
      state: 'ok',
      consecutiveFailures: 0,
      // The first visit is due at once: adding a keepalive is already a sign the
      // session matters, and an immediate visit renews it before the interval passes.
      nextAttemptAt: iso(at),
      ...domain === undefined ? {} : { domain },
    }
    this.#records.set(record.id, record)
    this.#order.push(record.id)
    this.#arm(record)
    await this.#save()
    return statusOf(record)
  }

  /**
   * Forget one keepalive and cancel its timer.
   * @param id - the entry's id.
   * @throws KeepaliveError - when no entry has that id.
   */
  async remove(id: string): Promise<void> {
    await this.load()
    const record = this.#records.get(id)
    if (record === undefined) throw new KeepaliveError(`no keepalive named ${id}`)
    this.#cancel(record.id)
    this.#records.delete(id)
    const index = this.#order.indexOf(id)
    if (index >= 0) this.#order.splice(index, 1)
    await this.#save()
  }

  /**
   * Run one attempt now, whatever the timer says.
   * @param id - the entry's id.
   * @returns the entry's status after the attempt.
   * @throws KeepaliveError - when no entry has that id.
   */
  async check(id: string): Promise<KeepaliveStatus> {
    await this.load()
    const record = this.#records.get(id)
    if (record === undefined) throw new KeepaliveError(`no keepalive named ${id}`)
    this.#cancel(id)
    await this.#run(id)
    return statusOf(record)
  }

  /** Stop every timer, release the waiting checks, and close the pages. */
  async close(): Promise<void> {
    this.#disposed = true
    for (const cancel of [...this.#timers.values()]) cancel()
    this.#timers.clear()
    for (const wake of this.#waiters.splice(0)) wake()
    await this.#pages.close()
    await this.#saving
  }

  /**
   * Move every timer onto the context that just came back. The pages this
   * service held died with the old context, so they are dropped rather than
   * reused, and an attempt that is already due runs as soon as its timer fires.
   * @returns how many keepalives were re-armed.
   */
  async rearm(): Promise<number> {
    await this.load()
    if (this.#disposed) return 0
    await this.#pages.drop()
    for (const id of [...this.#order]) {
      const record = this.#records.get(id)
      if (record !== undefined) this.#arm(record)
    }
    this.#options.log.info('headless-browser: re-armed %d keepalive(s) after the browser came back', this.#order.length)
    return this.#order.length
  }

  /** Read the file and arm every record's timer. */
  async #restore(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.#options.path, 'utf8')
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.#options.log.warn('headless-browser: reading %s failed: %s', this.#options.path, firstLine(error))
      }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error: unknown) {
      this.#options.log.warn('headless-browser: %s is not valid JSON (%s); keepalives start empty', this.#options.path, firstLine(error))
      return
    }
    const entries = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown }).entries
    if (!Array.isArray(entries)) {
      this.#options.log.warn('headless-browser: %s has no entries list; keepalives start empty', this.#options.path)
      return
    }
    let skipped = 0
    for (const entry of entries) {
      const record = restoreRecord(entry, iso(this.#now()))
      if (record === undefined || this.#records.has(record.id)) {
        skipped += 1
        continue
      }
      this.#records.set(record.id, record)
      this.#order.push(record.id)
      this.#sequence = Math.max(this.#sequence, sequenceOf(record.id))
    }
    if (skipped > 0) {
      this.#options.log.warn('headless-browser: skipped %d unusable keepalive record(s) in %s', skipped, this.#options.path)
    }
    for (const id of [...this.#order]) this.#arm(this.#records.get(id) as KeepaliveRecord)
    this.#options.log.info('headless-browser: %d keepalive(s) re-armed from %s', this.#order.length, this.#options.path)
  }

  /**
   * Arm one entry's timer for its next due attempt, replacing any pending one.
   * @param record - the entry to arm.
   */
  #arm(record: KeepaliveRecord): void {
    if (this.#disposed || !this.#records.has(record.id)) return
    this.#cancel(record.id)
    const due = record.nextAttemptAt === undefined ? Number.NaN : Date.parse(record.nextAttemptAt)
    const delay = Number.isFinite(due) ? Math.max(0, due - this.#now()) : 0
    const cancel = this.#schedule(delay, () => {
      this.#timers.delete(record.id)
      void this.#run(record.id)
    })
    this.#timers.set(record.id, cancel)
  }

  /**
   * Cancel one entry's pending attempt.
   * @param id - the entry's id.
   */
  #cancel(id: string): void {
    const cancel = this.#timers.get(id)
    if (cancel === undefined) return
    cancel()
    this.#timers.delete(id)
  }

  /**
   * Run one attempt for one entry, sharing an attempt already in flight.
   * @param id - the entry's id.
   */
  async #run(id: string): Promise<void> {
    const record = this.#records.get(id)
    if (record === undefined) return
    const running = this.#inflight.get(id)
    if (running !== undefined) {
      await running
      return
    }
    const task = this.#attempt(record).finally(() => { this.#inflight.delete(id) })
    this.#inflight.set(id, task)
    await task
  }

  /**
   * One visit: borrow a page, open the URL, read what the page shows, and
   * settle the entry from it.
   * @param record - the entry to check.
   */
  async #attempt(record: KeepaliveRecord): Promise<void> {
    if (this.#disposed) return
    await this.#slot()
    if (this.#disposed) {
      this.#release()
      return
    }
    const at = this.#now()
    const atIso = iso(at)
    record.lastAttemptAt = atIso
    let page: KeepalivePage | undefined
    let finalUrl = record.url
    try {
      page = await this.#pages.acquire()
      await page.goto(record.url, { waitUntil: 'load', timeout: KEEPALIVE_TIMEOUT_MS })
      finalUrl = page.url() || record.url
      const challenge = classifyChallenge({
        requestedUrl: record.url,
        finalUrl,
        facts: await page.challenge(),
        ...record.domain === undefined ? {} : { domain: record.domain },
      })
      this.#settle(record, finalUrl, challenge, atIso, at)
    } catch (error: unknown) {
      if (page !== undefined) finalUrl = page.url() || record.url
      this.#fail(record, finalUrl, undefined, firstLine(error), atIso, at)
    } finally {
      if (page !== undefined) this.#pages.release(page)
      this.#release()
      await this.#save()
      this.#arm(record)
    }
  }

  /**
   * Record a visit that found the signed-in page, and clear every failure mark.
   * @param record - the entry that was checked.
   * @param finalUrl - URL the page settled on.
   * @param challenge - what blocked it, or nothing when it passed.
   * @param atIso - the attempt's time.
   * @param at - the attempt's time in milliseconds.
   */
  #settle(record: KeepaliveRecord, finalUrl: string, challenge: Challenge | undefined, atIso: string, at: number): void {
    if (challenge !== undefined) {
      this.#fail(record, finalUrl, challenge, challenge.reason, atIso, at)
      return
    }
    const previous = record.state
    record.state = 'ok'
    record.lastOkAt = atIso
    record.lastUrl = finalUrl
    record.consecutiveFailures = 0
    delete record.firstFailureAt
    delete record.blockedStep
    delete record.lastError
    delete record.lastNoticeAt
    record.nextAttemptAt = iso(at + record.everyMinutes * 60_000)
    // One event per transition, never one per successful check.
    if (previous !== 'ok') this.#publish(record, 'recovered', atIso)
  }

  /**
   * Record a failed check. An interactive step escalates after the configured
   * number of consecutive failures and then repeats one notice an hour; a
   * transport failure only says `error`, because signing in would not fix it.
   * @param record - the entry that was checked.
   * @param finalUrl - URL the page settled on, or the requested one.
   * @param challenge - the step that blocked the visit, when the page was a sign-in page.
   * @param detail - what to report as `lastError`.
   * @param atIso - the attempt's time.
   * @param at - the attempt's time in milliseconds.
   */
  #fail(record: KeepaliveRecord, finalUrl: string, challenge: Challenge | undefined, detail: string, atIso: string, at: number): void {
    const previous = record.state
    record.consecutiveFailures += 1
    record.firstFailureAt ??= atIso
    record.lastUrl = finalUrl
    if (challenge === undefined) {
      delete record.blockedStep
    } else {
      record.blockedStep = challenge.step
    }
    record.lastError = detail
    record.nextAttemptAt = iso(at + backoffMs(record.consecutiveFailures))
    if (challenge !== undefined && record.consecutiveFailures >= this.#escalateAfter) {
      record.state = 'needs-human'
      if (previous !== 'needs-human') {
        this.#publish(record, 'needs-human', atIso)
        record.lastNoticeAt = atIso
      } else if (noticeDue(record, at)) {
        this.#publish(record, 'reminder', atIso)
        record.lastNoticeAt = atIso
      }
      return
    }
    // A session already known to need a person stays that way until a check passes.
    record.state = previous === 'needs-human' ? 'needs-human' : challenge === undefined ? 'error' : 'recovering'
    if (record.state !== previous) this.#publish(record, record.state === 'error' ? 'error' : 'recovering', atIso)
  }

  /**
   * Publish one event for one transition or notice.
   * @param record - the entry the event describes.
   * @param kind - the transition, or `reminder` for the repeated notice.
   * @param atIso - when it happened.
   */
  #publish(record: KeepaliveRecord, kind: KeepaliveEventKind, atIso: string): void {
    this.#options.emit({
      at: atIso,
      kind,
      id: record.id,
      label: record.label,
      url: record.url,
      state: record.state,
      consecutiveFailures: record.consecutiveFailures,
      ...record.lastUrl === undefined ? {} : { lastUrl: record.lastUrl },
      ...record.blockedStep === undefined ? {} : { blockedStep: record.blockedStep },
      ...record.firstFailureAt === undefined ? {} : { firstFailureAt: record.firstFailureAt },
      ...record.lastAttemptAt === undefined ? {} : { lastAttemptAt: record.lastAttemptAt },
    })
  }

  /** Take one of the {@link MAX_CONCURRENT_CHECKS} slots, waiting when all are taken. */
  async #slot(): Promise<void> {
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1
      return
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(() => {
        this.#active += 1
        resolve()
      })
    })
  }

  /** Give a slot back, handing it to the next waiting check. */
  #release(): void {
    this.#active = Math.max(0, this.#active - 1)
    this.#waiters.shift()?.()
  }

  /**
   * Write every record to the file, one write at a time so two attempts cannot
   * interleave half a file.
   * @returns when this write has finished.
   */
  #save(): Promise<void> {
    const body = `${JSON.stringify({ version: FILE_VERSION, entries: this.#persisted() }, undefined, 2)}\n`
    this.#saving = this.#saving.then(async () => {
      try {
        await mkdir(dirname(this.#options.path), { recursive: true })
        await writeFile(this.#options.path, body, 'utf8')
      } catch (error: unknown) {
        this.#options.log.warn('headless-browser: writing %s failed: %s', this.#options.path, firstLine(error))
      }
    })
    return this.#saving
  }

  /** The records as the file holds them. */
  #persisted(): KeepaliveRecord[] {
    return this.#order.map(id => this.#records.get(id) as KeepaliveRecord)
  }

  /** Refuse a new entry once the plugin is shutting down. */
  #assertOpen(): void {
    if (this.#disposed) throw new KeepaliveError('the keepalive service is shutting down')
  }
}

/**
 * Shape one record for a tool result or the status route.
 * @param record - the entry as the service keeps it.
 * @returns the fields the caller reads, without the bookkeeping.
 */
function statusOf(record: KeepaliveRecord): KeepaliveStatus {
  return {
    id: record.id,
    label: record.label,
    url: record.url,
    everyMinutes: record.everyMinutes,
    state: record.state,
    consecutiveFailures: record.consecutiveFailures,
    ...record.domain === undefined ? {} : { domain: record.domain },
    ...record.lastOkAt === undefined ? {} : { lastOkAt: record.lastOkAt },
    ...record.lastAttemptAt === undefined ? {} : { lastCheckAt: record.lastAttemptAt, lastAttemptAt: record.lastAttemptAt },
    ...record.nextAttemptAt === undefined ? {} : { nextAttemptAt: record.nextAttemptAt },
    ...record.firstFailureAt === undefined ? {} : { firstFailureAt: record.firstFailureAt },
    ...record.lastError === undefined ? {} : { lastError: record.lastError },
    ...record.lastUrl === undefined ? {} : { lastUrl: record.lastUrl },
    ...record.blockedStep === undefined ? {} : { blockedStep: record.blockedStep },
  }
}

/**
 * Validate one record read from the file, clamping rather than dropping an
 * entry a hand-edited interval made unusable.
 * @param value - one entry from the parsed file.
 * @param nowIso - the current time, for an entry that lost its own.
 * @returns the record, or nothing when the entry names no id or no usable URL.
 */
function restoreRecord(value: unknown, nowIso: string): KeepaliveRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (id === '') return undefined
  const url = targetOf(entry.url)
  if (url === undefined) return undefined
  const everyMinutes = typeof entry.everyMinutes === 'number' && Number.isFinite(entry.everyMinutes)
    ? clampInterval(entry.everyMinutes)
    : MIN_EVERY_MINUTES
  const state = typeof entry.state === 'string' && isState(entry.state) ? entry.state : 'ok'
  const failures = typeof entry.consecutiveFailures === 'number' && Number.isFinite(entry.consecutiveFailures)
    ? Math.max(0, Math.trunc(entry.consecutiveFailures))
    : 0
  const domain = textOf(entry.domain)
  const lastOkAt = textOf(entry.lastOkAt)
  const lastAttemptAt = textOf(entry.lastAttemptAt)
  const nextAttemptAt = textOf(entry.nextAttemptAt)
  const lastError = textOf(entry.lastError)
  const lastUrl = textOf(entry.lastUrl)
  const firstFailureAt = textOf(entry.firstFailureAt)
  const lastNoticeAt = textOf(entry.lastNoticeAt)
  return {
    id,
    label: textOf(entry.label) ?? url,
    url,
    everyMinutes,
    createdAt: textOf(entry.createdAt) ?? nowIso,
    state,
    consecutiveFailures: failures,
    ...domain === undefined ? {} : { domain },
    ...lastOkAt === undefined ? {} : { lastOkAt },
    ...lastAttemptAt === undefined ? {} : { lastAttemptAt },
    ...nextAttemptAt === undefined ? {} : { nextAttemptAt },
    ...lastError === undefined ? {} : { lastError },
    ...lastUrl === undefined ? {} : { lastUrl },
    ...firstFailureAt === undefined ? {} : { firstFailureAt },
    ...lastNoticeAt === undefined ? {} : { lastNoticeAt },
    ...typeof entry.blockedStep === 'string' && isStep(entry.blockedStep) ? { blockedStep: entry.blockedStep } : {},
  }
}

/**
 * A non-empty trimmed string, or nothing.
 * @param value - an unknown field from the file.
 * @returns the text, or nothing when it is absent or empty.
 */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/**
 * Normalize the URL a keepalive visits.
 * @param value - the URL a caller passed.
 * @returns the normalized absolute URL.
 * @throws KeepaliveError - when the URL is empty, relative, not http(s), or carries credentials.
 */
function normalizeTarget(value: string): string {
  const target = targetOf(value)
  if (target === undefined) {
    const text = value.trim()
    if (text === '') throw new KeepaliveError('a keepalive needs a url')
    let parsed: URL | undefined
    try {
      parsed = new URL(text)
    } catch (error: unknown) {
      void error
    }
    if (parsed !== undefined && (parsed.username !== '' || parsed.password !== '')) {
      throw new KeepaliveError('a keepalive url must not carry a username or password; the browser profile holds the sign-in')
    }
    throw new KeepaliveError(`a keepalive url must be an absolute http or https URL, not ${text.slice(0, 120)}`)
  }
  return target
}

/**
 * Normalize one URL without throwing.
 * @param value - the URL, from a caller or from the file.
 * @returns the normalized absolute URL, or nothing when it is not usable.
 */
function targetOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch (error: unknown) {
    void error
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  return parsed.href
}

/**
 * Normalize the optional site a caller named.
 * @param value - a domain or URL the caller passed.
 * @returns the lower-case host, or nothing when the caller named no site.
 * @throws KeepaliveError - when the value names no host.
 */
function domainFilterOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim().toLowerCase()
  if (text === '') return undefined
  const host = text.includes('://') ? hostOf(text) : text.split('/')[0] ?? ''
  const bare = host.replace(/^\.+/u, '').replace(/\.+$/u, '').replace(/:\d+$/u, '')
  if (bare === '' || bare.includes('@') || !bare.includes('.') && bare !== 'localhost') {
    throw new KeepaliveError(`domain must name a host, such as example.com, not ${text.slice(0, 120)}`)
  }
  return bare
}

/**
 * The interval one entry is checked at.
 * @param minutes - the caller's interval, or nothing for the minimum.
 * @returns the interval in minutes.
 * @throws KeepaliveError - when it is not a whole number inside the bounds.
 */
function intervalOf(minutes: number | undefined): number {
  if (minutes === undefined) return MIN_EVERY_MINUTES
  if (!Number.isInteger(minutes)) throw new KeepaliveError('everyMinutes must be a whole number of minutes')
  if (minutes < MIN_EVERY_MINUTES || minutes > MAX_EVERY_MINUTES) {
    throw new KeepaliveError(`everyMinutes must be ${String(MIN_EVERY_MINUTES)} through ${String(MAX_EVERY_MINUTES)}: 5 minutes through 24 hours`)
  }
  return minutes
}

/**
 * Keep a restored interval inside the accepted bounds.
 * @param minutes - a number read from the file.
 * @returns the clamped interval, rounded to whole minutes.
 */
function clampInterval(minutes: number): number {
  return Math.min(MAX_EVERY_MINUTES, Math.max(MIN_EVERY_MINUTES, Math.round(minutes)))
}

/**
 * The delay before the next attempt after a failure.
 * @param failures - consecutive failed checks, at least one.
 * @returns the delay in milliseconds, capped at the last backoff step.
 */
function backoffMs(failures: number): number {
  const index = Math.min(Math.max(failures, 1), RETRY_BACKOFF_MINUTES.length) - 1
  return (RETRY_BACKOFF_MINUTES[index] as number) * 60_000
}

/**
 * Whether a keepalive that stays `needs-human` may send its reminder now.
 * @param record - the entry.
 * @param at - now, in milliseconds.
 * @returns whether an hour has passed since the last notice.
 */
function noticeDue(record: KeepaliveRecord, at: number): boolean {
  if (record.lastNoticeAt === undefined) return true
  const last = Date.parse(record.lastNoticeAt)
  return !Number.isFinite(last) || at - last >= NOTICE_INTERVAL_MS
}

/**
 * The label a new entry gets.
 * @param label - the caller's label, when it gave one.
 * @param url - the entry's normalized URL.
 * @returns the trimmed label, or the host without `www.`.
 */
function labelOf(label: string | undefined, url: string): string {
  const text = label?.trim()
  if (text !== undefined && text !== '') return text.slice(0, 120)
  return hostOf(url).replace(/^www\./u, '') || url.slice(0, 120)
}

/**
 * The numeric suffix of a `k<n>` id.
 * @param id - an entry's id.
 * @returns the number, or zero for an id this service did not mint.
 */
function sequenceOf(id: string): number {
  const match = /^k(\d+)$/u.exec(id)
  return match === null ? 0 : Number(match[1])
}

/**
 * Whether a value is one of the four states.
 * @param value - a value from the file.
 * @returns whether it names a state.
 */
function isState(value: string): value is KeepaliveState {
  return value === 'ok' || value === 'recovering' || value === 'needs-human' || value === 'error'
}

/**
 * Whether a value names a blocking step.
 * @param value - a value from the file.
 * @returns whether it names a step.
 */
function isStep(value: string): value is BlockedStep {
  return value === 'account-chooser' || value === 'password' || value === 'mfa' || value === 'redirect'
}

/**
 * The lower-case host of a URL, or the empty string.
 * @param url - an absolute URL.
 * @returns the host without a port, or nothing when it does not parse.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch (error: unknown) {
    void error
    return ''
  }
}

/**
 * An ISO 8601 time from milliseconds.
 * @param at - a Unix time in milliseconds.
 * @returns the ISO 8601 form.
 */
function iso(at: number): string {
  return new Date(at).toISOString()
}

/**
 * Close one page, reporting rather than throwing when it is already gone.
 * @param page - the page to close.
 * @param log - the plugin logger.
 */
async function closeQuietly(page: KeepalivePage, log: Context['logger']): Promise<void> {
  if (page.isClosed()) return
  try {
    await page.close()
  } catch (error: unknown) {
    log.warn('headless-browser: closing a keepalive page failed: %s', firstLine(error))
  }
}

/**
 * A timer that does not keep the process alive on its own.
 * @param delayMs - how long to wait.
 * @param run - what to run when it fires.
 * @returns the canceller.
 */
function unrefTimer(delayMs: number, run: () => void): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref()
  return () => { clearTimeout(timer) }
}
