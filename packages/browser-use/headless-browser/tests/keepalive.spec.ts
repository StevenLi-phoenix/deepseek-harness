/**
 * The keepalive store and its timer: registration bounds, the retry state
 * machine that never parks a dead session on the owner, the notice cap, the
 * file it survives a restart through, and the tab cap it is exempt from. The
 * clock and the timer are the test's, so a five-minute backoff costs nothing;
 * Chromium's own behavior is covered by `browser.spec.ts`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChallengeFacts } from '../src/challenge.ts'
import {
  KeepalivePagePool,
  KeepaliveService,
  MAX_EVERY_MINUTES,
  MIN_EVERY_MINUTES,
  NOTICE_INTERVAL_MS,
  RETRY_BACKOFF_MINUTES,
  type KeepaliveEvent,
  type KeepalivePage,
  type KeepaliveStatus,
} from '../src/keepalive.ts'
import type { KeepaliveExpectation } from '../src/keepalive-expect.ts'
import { BrowserTabs, MAX_TABS, TabLimitError, type TabsPage } from '../src/tabs.ts'

const LOG = {
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
} satisfies Pick<Context['logger'], 'debug' | 'error' | 'info' | 'warn'>

/** Start of the test's clock, so every timestamp in a result is readable. */
const START = Date.parse('2026-01-01T00:00:00.000Z')

const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.clearAllMocks()
})

/** A fresh directory for one test's files. */
function temporaryDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-keepalive-'))
  temporary.push(root)
  return root
}

/** What the next visit lands on and shows. */
interface Landing {
  /** URL the visit settles on; the requested URL when absent. */
  readonly url?: string
  /** What the document shows; a signed-in page when absent. */
  readonly facts?: Partial<ChallengeFacts>
  readonly text?: string
  /** HTTP status of the landed document; 200 when absent. */
  readonly status?: number
  /** URL the page moves to while the check reads its text. */
  readonly movesTo?: string
  /** Make the visit itself fail, as a timeout or a dead network would; `url`, when set, is where the page stopped. */
  readonly error?: string
}

/** The fake site every page of one test consults. */
class FakeSite {
  landing: Landing = {}
  visits = 0
  readonly pages: FakePage[] = []
  /** While set, every visit waits for it before it loads. */
  hold: Promise<void> | undefined
  /** Make opening a page fail with this message. */
  createError: string | undefined

  async page(): Promise<FakePage> {
    if (this.createError !== undefined) throw new Error(this.createError)
    const page = new FakePage(this)
    this.pages.push(page)
    return page
  }
}

/** One page that satisfies both the tab model and a keepalive check. */
class FakePage implements TabsPage, KeepalivePage {
  closed = false
  #url = 'about:blank'
  #listeners = new Map<string, Set<(...args: never[]) => void>>()

  /**
   * @param site - the site this page visits.
   */
  constructor(readonly site: FakeSite) {}

  url(): string { return this.#url }
  isClosed(): boolean { return this.closed }
  async title(): Promise<string> { return 'page' }
  async goto(url: string, _options?: { waitUntil?: string; timeout?: number }): Promise<number> {
    this.site.visits += 1
    await this.site.hold
    const { error } = this.site.landing
    if (error !== undefined) {
      if (this.site.landing.url !== undefined) this.#url = this.site.landing.url
      throw new Error(error)
    }
    this.#url = this.site.landing.url ?? url
    return this.site.landing.status ?? 200
  }
  async text(): Promise<string> {
    const { movesTo } = this.site.landing
    if (movesTo !== undefined) this.#url = movesTo
    return this.site.landing.text ?? ''
  }
  async challenge(): Promise<ChallengeFacts> {
    return { passwordField: false, oneTimeCode: false, accountLinks: 0, ...this.site.landing.facts }
  }
  async goBack(): Promise<unknown> { return null }
  async goForward(): Promise<unknown> { return null }
  async reload(): Promise<unknown> { return null }
  async bringToFront(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true
    this.emit('close')
  }
  on(event: string, listener: (...args: never[]) => void): this {
    const set = this.#listeners.get(event) ?? new Set()
    set.add(listener)
    this.#listeners.set(event, set)
    return this
  }
  off(event: string, listener: (...args: never[]) => void): this {
    this.#listeners.get(event)?.delete(listener)
    return this
  }
  emit(event: string, ...args: never[]): void {
    for (const listener of [...this.#listeners.get(event) ?? []]) listener(...args)
  }
}

/** A clock and a timer this test advances and fires by hand. */
class ManualTimer {
  #now = START
  readonly scheduled: { delay: number; run: () => void; cancelled: boolean }[] = []

  now = (): number => this.#now

  schedule = (delay: number, run: () => void): (() => void) => {
    const entry = { delay, run, cancelled: false }
    this.scheduled.push(entry)
    return () => { entry.cancelled = true }
  }

  advance(ms: number): void {
    this.#now += ms
  }

  /** The timer still waiting to fire, if any. */
  pending(): { delay: number; run: () => void; cancelled: boolean } | undefined {
    return [...this.scheduled].reverse().find(entry => !entry.cancelled)
  }

  /** Fire the pending timer, as an elapsed `setTimeout` would. */
  fire(): void {
    const entry = this.pending()
    if (entry === undefined) throw new Error('no timer is pending')
    entry.cancelled = true
    entry.run()
  }
}

/** One booted service, with the pieces a test inspects. */
interface Bench {
  readonly service: KeepaliveService
  readonly events: KeepaliveEvent[]
  readonly timer: ManualTimer
  readonly site: FakeSite
  readonly path: string
}

/**
 * Boot one service over a fresh file.
 * @param options - the settings a test changes, and the file to reuse.
 * @returns the service and everything the test needs to drive it.
 */
function boot(options: { path?: string; escalateAfter?: number; maxConcurrent?: number; site?: FakeSite } = {}): Bench {
  const timer = new ManualTimer()
  const site = options.site ?? new FakeSite()
  const path = options.path ?? join(temporaryDir(), 'keepalive.json')
  const events: KeepaliveEvent[] = []
  const service = new KeepaliveService({
    path,
    create: async () => await site.page(),
    log: LOG,
    emit: (event) => { events.push(event) },
    ...options.escalateAfter === undefined ? {} : { escalateAfter: options.escalateAfter },
    ...options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent },
    now: timer.now,
    schedule: timer.schedule,
  })
  return { service, events, timer, site, path }
}

/** Let a fired timer's attempt finish, since a timer callback cannot be awaited. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await new Promise<void>((resolve) => { setImmediate(resolve) })
}

/** The kinds of the events one bench published. */
function kinds(bench: Bench): string[] {
  return bench.events.map(event => event.kind)
}

describe('registering a keepalive', () => {
  it('registers a URL with the minimum interval, a label, and an attempt due at once', async () => {
    const bench = boot()
    const added = await bench.service.add({ url: 'https://example.com' })
    expect(added).toEqual({
      id: 'k1',
      label: 'example.com',
      url: 'https://example.com/',
      everyMinutes: MIN_EVERY_MINUTES,
      state: 'recovering',
      consecutiveFailures: 0,
      nextAttemptAt: '2026-01-01T00:00:00.000Z',
    })
    expect(bench.timer.pending()?.delay).toBe(0)
    await expect(bench.service.list()).resolves.toEqual([added])
  })

  it('keeps a named label, interval, and site', async () => {
    const bench = boot()
    const added = await bench.service.add({
      url: 'https://mail.example.com/inbox?page=2',
      domain: 'Example.COM',
      everyMinutes: 30,
      label: '  mail  ',
    })
    expect(added).toMatchObject({
      label: 'mail',
      url: 'https://mail.example.com/inbox?page=2',
      everyMinutes: 30,
      domain: 'example.com',
    })
    expect(bench.timer.pending()?.delay).toBe(0)
  })

  it('refuses a URL a later visit could not make sense of', async () => {
    const bench = boot()
    await expect(bench.service.add({ url: '   ' })).rejects.toThrow('a keepalive needs a url')
    await expect(bench.service.add({ url: '/inbox' })).rejects.toThrow('must be an absolute http or https URL')
    await expect(bench.service.add({ url: 'file:///etc/passwd' })).rejects.toThrow('must be an absolute http or https URL')
    await expect(bench.service.add({ url: 'https://user:pw@example.com/' }))
      .rejects.toThrow('must not carry a username or password')
  })

  it('refuses an interval outside five minutes through a day', async () => {
    const bench = boot()
    await expect(bench.service.add({ url: 'https://example.com/a', everyMinutes: MIN_EVERY_MINUTES - 1 }))
      .rejects.toThrow('everyMinutes must be 5 through 1440')
    await expect(bench.service.add({ url: 'https://example.com/a', everyMinutes: MAX_EVERY_MINUTES + 1 }))
      .rejects.toThrow('everyMinutes must be 5 through 1440')
    await expect(bench.service.add({ url: 'https://example.com/a', everyMinutes: 7.5 }))
      .rejects.toThrow('everyMinutes must be a whole number of minutes')
    await expect(bench.service.add({ url: 'https://example.com/a', everyMinutes: MAX_EVERY_MINUTES }))
      .resolves.toMatchObject({ everyMinutes: MAX_EVERY_MINUTES })
  })

  it('refuses the same URL twice, however it is spelled', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/', label: 'first' })
    await expect(bench.service.add({ url: 'https://example.com', label: 'again' }))
      .rejects.toThrow('k1 (first) already visits https://example.com/')
    await expect(bench.service.add({ url: 'https://example.com/other' })).resolves.toMatchObject({ id: 'k2' })
  })

  it('refuses a site that names no host', async () => {
    const bench = boot()
    await expect(bench.service.add({ url: 'https://example.com/', domain: 'not a host' }))
      .rejects.toThrow('domain must name a host')
    await expect(bench.service.add({ url: 'https://example.com/a', domain: 'https://example.com/inbox' }))
      .resolves.toMatchObject({ domain: 'example.com' })
  })

  it('labels an entry with its URL when the host is nothing but the www prefix', async () => {
    const bench = boot()
    await expect(bench.service.add({ url: 'https://www./' })).resolves.toMatchObject({ label: 'https://www./' })
  })

  it.each<[string, KeepaliveExpectation[], string]>([
    ['a matcher that sets nothing', [{}], 'each expectation must set a matcher'],
    ['a wait outside 1 through 30000 ms', [{ expectText: 'Inbox', waitForTextMs: 0 }], 'waitForTextMs must be a whole number from 1 to 30000'],
    ['a wait with no text to wait for', [{ forbidText: 'Sign in', waitForTextMs: 10 }], 'waitForTextMs requires expectText or expectRegex in the same matcher'],
    ['a host with a path', [{ allowHosts: ['example.com/inbox'] }], 'allowHosts must name canonical hostnames without paths or ports'],
    ['an origin with a path', [{ allowOrigins: ['https://example.com/inbox'] }], 'allowOrigins must name canonical HTTP(S) origins without paths'],
    ['a forbidden path with a trailing slash', [{ forbidPath: ['/access/'] }], 'forbidPath entries must start with / and have no trailing slash'],
    ['a regular expression that does not compile', [{ expectRegex: '(' }], 'invalid expectRegex: Invalid regular expression'],
  ])('refuses %s as a landing expectation', async (_name, expectation, message) => {
    const bench = boot()
    await expect(bench.service.add({ url: 'https://example.com/a', expect: expectation })).rejects.toThrow(message)
    await expect(bench.service.list()).resolves.toEqual([])
  })

  it('refuses a profile override it could not apply, naming the keepalive', () => {
    expect(() => new KeepaliveService({
      path: join(temporaryDir(), 'keepalive.json'),
      create: async () => await new FakeSite().page(),
      log: LOG,
      emit: () => {},
      expectById: { k3: [{}] },
    })).toThrow('k3: each expectation must set a matcher')
  })

  it('removes one entry and keeps the rest in order', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    await bench.service.add({ url: 'https://example.com/b' })
    await bench.service.remove('k1')
    await expect(bench.service.list()).resolves.toMatchObject([{ id: 'k2' }])
    await expect(bench.service.remove('k1')).rejects.toThrow('no keepalive named k1')
    await expect(bench.service.check('k9')).rejects.toThrow('no keepalive named k9')
    expect(bench.timer.pending()?.delay).toBe(0)
  })
})

describe('persistence', () => {
  it('writes the file and re-arms the same entries after a restart', async () => {
    const first = boot()
    await first.service.add({ url: 'https://example.com/a', everyMinutes: 15, label: 'a' })
    await first.service.add({ url: 'https://example.com/b', everyMinutes: 45, label: 'b' })
    await first.service.close()

    const second = boot({ path: first.path })
    await expect(second.service.list()).resolves.toMatchObject([
      { id: 'k1', label: 'a', url: 'https://example.com/a', everyMinutes: 15, state: 'recovering' },
      { id: 'k2', label: 'b', url: 'https://example.com/b', everyMinutes: 45, state: 'recovering' },
    ])
    // Both entries have a timer, and a new entry continues the sequence.
    expect(second.timer.scheduled.filter(entry => !entry.cancelled)).toHaveLength(2)
    await expect(second.service.add({ url: 'https://example.com/c' })).resolves.toMatchObject({ id: 'k3' })
  })

  it('invalidates legacy healthy records and applies profile overrides on the first recheck', async () => {
    const path = join(temporaryDir(), 'keepalive.json')
    writeFileSync(path, JSON.stringify({ version: 1, entries: [{
      id: 'k2', url: 'https://app.example.com/postings', state: 'ok', expect: [{ expectText: 'Registered marker' }],
      lastOkAt: new Date(START).toISOString(), nextAttemptAt: new Date(START + 60_000).toISOString(),
    }] }))
    const site = new FakeSite()
    const timer = new ManualTimer()
    const service = new KeepaliveService({
      path, log: LOG, emit: () => {}, now: timer.now, schedule: timer.schedule,
      create: async () => await site.page(),
      expectById: { k2: [{ forbidPath: ['/access'], expectText: 'Profile marker' }] },
    })
    await expect(service.list()).resolves.toMatchObject([{ id: 'k2', state: 'recovering', consecutiveFailures: 0 }])
    expect(timer.pending()?.delay).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 2, entries: [{ id: 'k2', state: 'recovering' }] })
    site.landing = { url: 'https://app.example.com/access/continue', text: 'Profile marker' }
    await expect(service.check('k2')).resolves.toMatchObject({ state: 'recovering', reason: 'sso_redirect:app.example.com' })
    site.landing = { text: 'Profile marker' }
    await expect(service.check('k2')).resolves.toMatchObject({ state: 'ok' })
    await service.close()
  })

  it('restores an entry that still needed a person, with its counters and backoff', async () => {
    const first = boot({ escalateAfter: 1 })
    const added = await first.service.add({ url: 'https://example.com/a', everyMinutes: 20 })
    first.site.landing = { url: 'https://example.com/login', facts: { passwordField: true } }
    await first.service.check(added.id)
    await first.service.close()

    const second = boot({ path: first.path })
    const [restored] = await second.service.list() as [KeepaliveStatus]
    expect(restored).toMatchObject({
      id: 'k1',
      state: 'needs-human',
      consecutiveFailures: 1,
      blockedStep: 'password',
      lastUrl: 'https://example.com/login',
      lastError: 'the page shows a password field',
    })
    expect(restored.firstFailureAt).toBe('2026-01-01T00:00:00.000Z')
    // Armed for the moment the backoff ends, not for a fresh interval.
    expect(second.timer.pending()?.delay).toBe(5 * 60_000)
  })

  it('keeps working when the file is missing, malformed, or holds junk', async () => {
    const root = temporaryDir()
    const missing = boot({ path: join(root, 'absent.json') })
    await expect(missing.service.list()).resolves.toEqual([])

    const malformed = join(root, 'malformed.json')
    writeFileSync(malformed, '{ not json', 'utf8')
    await expect(boot({ path: malformed }).service.list()).resolves.toEqual([])
    expect(LOG.warn).toHaveBeenCalledWith(expect.stringContaining('is not valid JSON'), expect.anything(), expect.anything())

    const unshaped = join(root, 'unshaped.json')
    writeFileSync(unshaped, JSON.stringify({ version: 1 }), 'utf8')
    await expect(boot({ path: unshaped }).service.list()).resolves.toEqual([])

    const junk = join(root, 'junk.json')
    writeFileSync(junk, JSON.stringify({
      version: 1,
      entries: [
        null,
        { id: '', url: 'https://example.com/' },
        { id: 'k1', url: 'not a url' },
        { id: 'k2', url: 'https://example.com/a', everyMinutes: 1, state: 'nonsense', consecutiveFailures: -3, blockedStep: 'nonsense', domain: '  ' },
        { id: 'k2', url: 'https://example.com/duplicate' },
        { id: 7, url: 'https://example.com/numeric-id' },
        { id: 'k3', url: 42 },
        { id: 'k4', url: 'https://example.com/empty-matcher', expect: [{}] },
        { id: 'k5', url: 'https://example.com/numeric-text', expect: [{ expectText: 42 }] },
        { id: 'k6', url: 'https://example.com/text-list', expect: 'nonsense' },
      ],
    }), 'utf8')
    const restored = await boot({ path: junk }).service.list()
    expect(restored).toEqual([{
      id: 'k2',
      label: 'https://example.com/a',
      url: 'https://example.com/a',
      everyMinutes: MIN_EVERY_MINUTES,
      state: 'recovering',
      consecutiveFailures: 0,
    }])
    expect(LOG.warn).toHaveBeenCalledWith(expect.stringContaining('skipped'), 9, junk)
  })

  it('restores a bare list from the oldest file and continues the sequence past ids it did not mint', async () => {
    const path = join(temporaryDir(), 'keepalive.json')
    writeFileSync(path, JSON.stringify([
      { id: 'imported', url: 'https://example.com/i' },
      { id: 'k4', url: 'https://example.com/j', state: 'ok', lastOkAt: new Date(START).toISOString() },
    ]), 'utf8')
    const bench = boot({ path })
    await expect(bench.service.list()).resolves.toMatchObject([
      { id: 'imported', state: 'recovering' },
      { id: 'k4', state: 'recovering' },
    ])
    // A healthy record from a file without a version is checked again before it counts as healthy.
    expect((await bench.service.list())[1]?.lastOkAt).toBeUndefined()
    await expect(bench.service.add({ url: 'https://example.com/k' })).resolves.toMatchObject({ id: 'k5' })
  })

  it('drops stored profile rules once the profile no longer names the keepalive', async () => {
    const path = join(temporaryDir(), 'keepalive.json')
    writeFileSync(path, JSON.stringify({ version: 2, entries: [{
      id: 'k1', url: 'https://example.com/a', state: 'ok', profileExpect: [{ expectText: 'Old marker' }],
      lastOkAt: new Date(START).toISOString(),
    }] }), 'utf8')
    const bench = boot({ path })
    await expect(bench.service.list()).resolves.toMatchObject([{ id: 'k1', state: 'recovering', consecutiveFailures: 0 }])
    const [stored] = (JSON.parse(readFileSync(path, 'utf8')) as { entries: Record<string, unknown>[] }).entries
    expect(stored).toMatchObject({ id: 'k1', state: 'recovering' })
    expect(stored).not.toHaveProperty('profileExpect')
    expect(stored).not.toHaveProperty('lastOkAt')
    // The registered text no longer applies, so a page without it is healthy.
    bench.site.landing = { text: 'Welcome' }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'ok' })
  })

  it('reminds at once about a restored entry that needs a person but records no notice', async () => {
    const path = join(temporaryDir(), 'keepalive.json')
    writeFileSync(path, JSON.stringify({ version: 2, entries: [{
      id: 'k1', url: 'https://example.com/a', state: 'needs-human', consecutiveFailures: 3, blockedStep: 'password',
      firstFailureAt: new Date(START).toISOString(),
    }] }), 'utf8')
    const bench = boot({ path })
    bench.site.landing = { url: 'https://example.com/login', facts: { passwordField: true } }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'needs-human', consecutiveFailures: 4 })
    expect(bench.events).toMatchObject([{ kind: 'reminder', consecutiveFailures: 4, blockedStep: 'password' }])
  })

  it('logs a write it cannot make instead of failing the caller', async () => {
    const root = temporaryDir()
    const path = join(root, 'keepalive.json')
    const bench = boot({ path })
    await bench.service.add({ url: 'https://example.com/a' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 2,
      entries: [{ id: 'k1', url: 'https://example.com/a', everyMinutes: MIN_EVERY_MINUTES }],
    })
    // A directory where the file should be: the write fails, the entry stays.
    const blockedPath = join(root, 'blocked.json')
    mkdirSync(blockedPath, { recursive: true })
    const blocked = boot({ path: blockedPath })
    await expect(blocked.service.add({ url: 'https://example.com/b' })).resolves.toMatchObject({ id: 'k1' })
    await blocked.service.close()
    expect(LOG.warn).toHaveBeenCalledWith(expect.stringContaining('writing'), expect.anything(), expect.anything())
  })
})

describe('the retry state machine', () => {
  it('goes ok to recovering on one failed check and retries in five minutes', async () => {
    const bench = boot()
    const added = await bench.service.add({ url: 'https://example.com/a', everyMinutes: 60 })
    bench.site.landing = { url: 'https://example.com/login', facts: { passwordField: true } }
    const failed = await bench.service.check(added.id)
    expect(failed).toMatchObject({
      state: 'recovering',
      consecutiveFailures: 1,
      blockedStep: 'password',
      lastError: 'the page shows a password field',
      lastUrl: 'https://example.com/login',
      firstFailureAt: '2026-01-01T00:00:00.000Z',
      lastAttemptAt: '2026-01-01T00:00:00.000Z',
      lastCheckAt: '2026-01-01T00:00:00.000Z',
      nextAttemptAt: '2026-01-01T00:05:00.000Z',
    })
    expect(kinds(bench)).toEqual(['recovering'])
  })

  it('retries on the 5m, 15m, 1h schedule and caps at an hour', async () => {
    const bench = boot({ escalateAfter: 9 })
    const added = await bench.service.add({ url: 'https://example.com/a' })
    bench.site.landing = { facts: { passwordField: true } }
    const delays: number[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const status = await bench.service.check(added.id)
      delays.push(Date.parse(status.nextAttemptAt as string) - Date.parse(status.lastAttemptAt as string))
      bench.timer.advance(RETRY_BACKOFF_MINUTES.at(-1) as number * 60_000)
    }
    expect(delays).toEqual([
      5 * 60_000,
      15 * 60_000,
      60 * 60_000,
      60 * 60_000,
      60 * 60_000,
    ])
    // Only the first check is a transition; the rest stay where they are.
    expect(kinds(bench)).toEqual(['recovering'])
  })

  it('escalates to needs-human after three interactive challenges, with what the owner needs', async () => {
    const bench = boot()
    const added = await bench.service.add({ url: 'https://example.com/a', label: 'assignments' })
    bench.site.landing = { url: 'https://example.com/login', facts: { passwordField: true } }
    await bench.service.check(added.id)
    await bench.service.check(added.id)
    expect((await bench.service.check(added.id)).state).toBe('needs-human')
    expect(bench.events.at(-1)).toMatchObject({
      kind: 'needs-human',
      id: 'k1',
      label: 'assignments',
      url: 'https://example.com/a',
      state: 'needs-human',
      consecutiveFailures: 3,
      firstFailureAt: '2026-01-01T00:00:00.000Z',
      lastUrl: 'https://example.com/login',
      blockedStep: 'password',
    })
    expect(kinds(bench)).toEqual(['recovering', 'needs-human'])
  })

  it('recovers with exactly one event and resets every count', async () => {
    const bench = boot()
    const added = await bench.service.add({ url: 'https://example.com/a', everyMinutes: 20 })
    bench.site.landing = { facts: { passwordField: true } }
    await bench.service.check(added.id)
    await bench.service.check(added.id)
    await bench.service.check(added.id)
    const recovered = bench.events.length
    bench.timer.advance(60 * 60_000)
    bench.site.landing = { url: 'https://example.com/a' }
    const status = await bench.service.check(added.id)
    expect(status).toEqual({
      id: 'k1',
      label: 'example.com',
      url: 'https://example.com/a',
      everyMinutes: 20,
      state: 'ok',
      consecutiveFailures: 0,
      lastOkAt: '2026-01-01T01:00:00.000Z',
      lastAttemptAt: '2026-01-01T01:00:00.000Z',
      lastCheckAt: '2026-01-01T01:00:00.000Z',
      nextAttemptAt: '2026-01-01T01:20:00.000Z',
      lastUrl: 'https://example.com/a',
    })
    expect(bench.events.length).toBe(recovered + 1)
    expect(bench.events.at(-1)).toMatchObject({ kind: 'recovered', state: 'ok', consecutiveFailures: 0 })
    // A second success is not a transition and publishes nothing.
    await bench.service.check(added.id)
    expect(bench.events.length).toBe(recovered + 1)
  })

  it('says error, not needs-human, when the visit itself could not run', async () => {
    const bench = boot({ escalateAfter: 2 })
    const added = await bench.service.add({ url: 'https://example.com/a' })
    bench.site.landing = { error: 'net::ERR_CONNECTION_RESET' }
    const first = await bench.service.check(added.id)
    expect(first.state).toBe('error')
    expect(first.lastError).toBe('net::ERR_CONNECTION_RESET')
    expect(first.reason).toBe('network')
    expect(first.blockedStep).toBeUndefined()
    const second = await bench.service.check(added.id)
    expect(second.state).toBe('error')
    expect(second.consecutiveFailures).toBe(2)
    expect(kinds(bench)).toEqual(['error'])
  })

  it('keeps needs-human through a transport failure, because signing in is still what is missing', async () => {
    const bench = boot({ escalateAfter: 1 })
    const added = await bench.service.add({ url: 'https://example.com/a' })
    bench.site.landing = { facts: { oneTimeCode: true } }
    await bench.service.check(added.id)
    expect(bench.events.at(-1)).toMatchObject({ kind: 'needs-human', blockedStep: 'mfa' })
    bench.timer.advance(60 * 60_000)
    bench.site.landing = { error: 'net::ERR_TIMED_OUT' }
    const status = await bench.service.check(added.id)
    expect(status.state).toBe('needs-human')
    expect(status.reason).toBe('timeout')
    expect(status.blockedStep).toBeUndefined()
    expect(kinds(bench)).toEqual(['needs-human'])
  })

  it('reports an SSO redirect without a password form and escalates on the existing retry schedule', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://lms.example.com/home', domain: 'lms.example.com' })
    bench.site.landing = { url: 'https://login.microsoftonline.com/tenant/authorize' }
    for (const state of ['recovering', 'recovering', 'needs-human']) {
      await expect(bench.service.check('k1')).resolves.toMatchObject({ state, reason: 'sso_redirect:login.microsoftonline.com' })
    }
    await bench.service.close()
    await expect(boot({ path: bench.path }).service.list()).resolves.toMatchObject([
      { id: 'k1', state: 'needs-human', reason: 'sso_redirect:login.microsoftonline.com' },
    ])
    expect(kinds(bench)).toEqual(['recovering', 'needs-human'])
  })

  it.each(['https://sso.example.com/authorize', 'https://app.example.com/d2l/error/403', 'https://app.example.com/challenge'])('rejects the same-site sign-in destination %s', async (url) => {
    const bench = boot()
    await bench.service.add({ url: 'https://app.example.com/home', domain: 'example.com' })
    bench.site.landing = { url }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'recovering', reason: `sso_redirect:${new URL(url).hostname}` })
  })

  it('requires authenticated text on a 200 page and clears the reason once all matchers pass', async () => {
    const bench = boot()
    await bench.service.add({
      url: 'https://app.example.com/home',
      expect: [{ expectRegex: 'My\\s+Courses' }, { forbidText: 'Sign in to continue' }],
    })
    bench.site.landing = { text: 'Welcome' }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'recovering', reason: 'missing_text:My\\s+Courses' })
    bench.site.landing = { text: 'My Courses — Sign in to continue' }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'recovering', reason: 'forbidden_text' })
    bench.site.landing = { text: 'My\nCourses' }
    const good = await bench.service.check('k1')
    expect(good.state).toBe('ok')
    expect(good.reason).toBeUndefined()
  })

  it('waits for asynchronous text, and leaves a timed-out marker in recovering', async () => {
    const bench = boot({ escalateAfter: 1 })
    await bench.service.add({ url: 'https://example.com/postings', expect: [{ expectText: 'jobs found', waitForTextMs: 10 }] })
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'recovering', reason: 'timeout' })
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'recovering', reason: 'timeout' })
    const page = bench.site.pages[0] as FakePage
    vi.spyOn(page, 'text').mockResolvedValueOnce('Loading').mockResolvedValueOnce('862 jobs found')
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'ok' })
  })

  it('uses an explicit allowed origin instead of the default registrable domain', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a', expect: [{ allowOrigins: ['https://work.example.net'] }] })
    bench.site.landing = { url: 'https://work.example.net/a' }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'ok' })
    bench.site.landing = { url: 'https://example.com/a' }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'recovering', reason: 'sso_redirect:example.com' })
  })

  it('allows sibling hosts within the same registrable domain by default', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://app.example.co.uk/a', domain: 'app.example.co.uk' })
    bench.site.landing = { url: 'https://dashboard.example.co.uk/a' }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'ok' })
    bench.site.landing = { url: 'https://dashboard.other.co.uk/a' }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'recovering', reason: 'sso_redirect:dashboard.other.co.uk' })
  })

  it.each([401, 403])('treats an HTTP %i answer as a sign-in the site asks for', async (status) => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    bench.site.landing = { status }
    await expect(bench.service.check('k1')).resolves.toMatchObject({
      state: 'recovering',
      reason: `auth_required:${String(status)}`,
      blockedStep: 'redirect',
      lastError: `the page refused access (HTTP ${String(status)})`,
    })
  })

  it('says error for a server failure, because signing in would not fix it', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    bench.site.landing = { status: 502 }
    const status = await bench.service.check('k1')
    expect(status).toMatchObject({ state: 'error', reason: 'network', lastError: 'HTTP 502' })
    expect(status.blockedStep).toBeUndefined()
  })

  it('names an unknown site when the visit settles on no URL', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    bench.site.landing = { url: '' }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'recovering', reason: 'sso_redirect:unknown', blockedStep: 'redirect' })
  })

  it.each([
    ['https://login.elsewhere.test/form', 'sso_redirect:login.elsewhere.test'],
    ['', 'sso_redirect:unknown'],
  ])('fails a check whose page moves to %j while its text is read', async (movesTo, reason) => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a', expect: [{ expectText: 'Inbox' }] })
    bench.site.landing = { text: 'Inbox', movesTo }
    await expect(bench.service.check('k1')).resolves.toMatchObject({
      state: 'recovering',
      reason,
      blockedStep: 'redirect',
      lastError: 'the page moved to a location that is not allowed',
      lastUrl: movesTo,
    })
  })

  it('accepts a wait on a regular expression and a host allowlist', async () => {
    const bench = boot()
    await bench.service.add({
      url: 'https://example.com/a',
      expect: [{ expectRegex: 'In+box', waitForTextMs: 10 }, { allowHosts: ['mail.example.net'] }],
    })
    bench.site.landing = { url: 'https://mail.example.net/inbox', text: 'Innbox' }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'ok', lastUrl: 'https://mail.example.net/inbox' })
    bench.site.landing = { url: 'https://other.example.net/inbox', text: 'Innbox' }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'recovering', reason: 'sso_redirect:other.example.net' })
  })

  it('keeps a localhost keepalive healthy on its own host', async () => {
    const bench = boot()
    await bench.service.add({ url: 'http://localhost:8080/app' })
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'ok', lastUrl: 'http://localhost:8080/app' })
  })

  it.each([
    ['the URL the page stopped on', 'https://example.com/partial', 'https://example.com/partial'],
    ['the requested URL when the page stopped on none', '', 'https://example.com/a'],
  ])('reports %s for a visit that failed', async (_name, stoppedAt, lastUrl) => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    bench.site.landing = { error: 'net::ERR_ABORTED', url: stoppedAt }
    await expect(bench.service.check('k1')).resolves.toMatchObject({ state: 'error', reason: 'network', lastUrl })
  })

  it('says error with the requested URL when no page could be opened for the visit', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    bench.site.createError = 'the browser is not running'
    await expect(bench.service.check('k1')).resolves.toMatchObject({
      state: 'error',
      reason: 'network',
      lastError: 'the browser is not running',
      lastUrl: 'https://example.com/a',
    })
    expect(bench.site.visits).toBe(0)
  })

  it('escalates after the configured number of failures, not a fixed one', async () => {
    const bench = boot({ escalateAfter: 2 })
    const added = await bench.service.add({ url: 'https://example.com/a' })
    bench.site.landing = { facts: { accountLinks: 3 }, url: 'https://accounts.elsewhere.test/chooser' }
    expect((await bench.service.check(added.id)).state).toBe('recovering')
    expect((await bench.service.check(added.id)).state).toBe('needs-human')
    expect(bench.events.at(-1)).toMatchObject({ blockedStep: 'account-chooser' })
  })
})

describe('the notice cap', () => {
  it('repeats a needs-human notice at most once an hour, always with the same facts', async () => {
    const bench = boot()
    const added = await bench.service.add({ url: 'https://example.com/a', label: 'mail' })
    bench.site.landing = { url: 'https://example.com/login', facts: { passwordField: true } }
    await bench.service.check(added.id)
    await bench.service.check(added.id)
    await bench.service.check(added.id)
    expect(kinds(bench)).toEqual(['recovering', 'needs-human'])

    // Twenty minutes later, still dead: no second notice yet.
    bench.timer.advance(20 * 60_000)
    await bench.service.check(added.id)
    expect(kinds(bench)).toEqual(['recovering', 'needs-human'])

    // An hour after the escalation, the owner gets the same facts again.
    bench.timer.advance(NOTICE_INTERVAL_MS - 20 * 60_000)
    await bench.service.check(added.id)
    expect(bench.events.at(-1)).toMatchObject({
      kind: 'reminder',
      id: 'k1',
      label: 'mail',
      consecutiveFailures: 5,
      firstFailureAt: '2026-01-01T00:00:00.000Z',
      lastUrl: 'https://example.com/login',
      blockedStep: 'password',
    })

    // And never twice in the same hour.
    bench.timer.advance(30 * 60_000)
    await bench.service.check(added.id)
    expect(kinds(bench)).toEqual(['recovering', 'needs-human', 'reminder'])
  })
})

describe('the timer', () => {
  it('runs an attempt when the timer fires', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    bench.timer.advance(5 * 60_000)
    bench.site.landing = { facts: { passwordField: true } }
    bench.timer.fire()
    await flush()
    expect(bench.site.visits).toBe(1)
    const [status] = await bench.service.list() as [KeepaliveStatus]
    expect(status.state).toBe('recovering')
    expect(bench.events).toHaveLength(1)
  })

  it('runs one attempt at once for a forced check, before the timer is due', async () => {
    const bench = boot()
    const added = await bench.service.add({ url: 'https://example.com/a', everyMinutes: 120 })
    expect(bench.timer.scheduled).toHaveLength(1)
    const status = await bench.service.check(added.id)
    expect(bench.site.visits).toBe(1)
    expect(status.lastAttemptAt).toBe('2026-01-01T00:00:00.000Z')
    // The pending timer was replaced by one for the new due time.
    expect(bench.timer.scheduled[0]?.cancelled).toBe(true)
    expect(bench.timer.pending()?.delay).toBe(120 * 60_000)
  })

  it('cancels every timer on close and refuses a new entry afterwards', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    await bench.service.close()
    expect(bench.timer.scheduled.every(entry => entry.cancelled)).toBe(true)
    await expect(bench.service.add({ url: 'https://example.com/b' })).rejects.toThrow('shutting down')
  })

  it('leaves an entry untouched when it is checked after close', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    await bench.service.close()
    const status = await bench.service.check('k1')
    expect(status.lastAttemptAt).toBeUndefined()
    expect(bench.site.visits).toBe(0)
    await expect(bench.service.rearm()).resolves.toBe(0)
    expect(bench.timer.pending()).toBeUndefined()
  })

  it('re-arms every entry on the context that came back', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    await bench.service.add({ url: 'https://example.com/b' })
    const before = bench.timer.scheduled.length
    await expect(bench.service.rearm()).resolves.toBe(2)
    expect(bench.timer.scheduled.slice(before).filter(entry => !entry.cancelled)).toHaveLength(2)
    await bench.service.close()
  })

  it('does not re-arm an entry that was removed while its check ran', async () => {
    const bench = boot()
    await bench.service.add({ url: 'https://example.com/a' })
    const hold = Promise.withResolvers<undefined>()
    bench.site.hold = hold.promise
    const checking = bench.service.check('k1')
    await vi.waitFor(() => { expect(bench.site.visits).toBe(1) })
    await bench.service.remove('k1')
    hold.resolve(undefined)
    await expect(checking).resolves.toMatchObject({ id: 'k1', state: 'ok' })
    expect(bench.timer.pending()).toBeUndefined()
    await expect(bench.service.list()).resolves.toEqual([])
    expect(JSON.parse(readFileSync(bench.path, 'utf8'))).toEqual({ version: 2, entries: [] })
  })

  it('runs at most the configured number of checks at once and starts the next when one ends', async () => {
    const bench = boot({ maxConcurrent: 1 })
    await bench.service.add({ url: 'https://example.com/a' })
    await bench.service.add({ url: 'https://example.com/b' })
    const hold = Promise.withResolvers<undefined>()
    bench.site.hold = hold.promise
    const first = bench.service.check('k1')
    const second = bench.service.check('k2')
    await vi.waitFor(() => { expect(bench.site.visits).toBe(1) })
    await flush()
    // The second check waits for the slot, so it has not visited yet.
    expect(bench.site.visits).toBe(1)
    hold.resolve(undefined)
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ state: 'ok' }, { state: 'ok' }])
    expect(bench.site.visits).toBe(2)
    await bench.service.close()
  })

  it('lets a check waiting for a slot go without a visit when the service closes', async () => {
    const bench = boot({ maxConcurrent: 1 })
    await bench.service.add({ url: 'https://example.com/a' })
    await bench.service.add({ url: 'https://example.com/b' })
    const hold = Promise.withResolvers<undefined>()
    bench.site.hold = hold.promise
    const first = bench.service.check('k1')
    const second = bench.service.check('k2')
    await vi.waitFor(() => { expect(bench.site.visits).toBe(1) })
    await bench.service.close()
    const waited = await second
    expect(waited.lastAttemptAt).toBeUndefined()
    hold.resolve(undefined)
    await expect(first).resolves.toMatchObject({ id: 'k1', state: 'ok' })
    expect(bench.site.visits).toBe(1)
    expect(bench.timer.pending()).toBeUndefined()
  })

  it('defaults to the wall clock and a timer that does not hold the process open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: START })
    try {
      const site = new FakeSite()
      const service = new KeepaliveService({
        path: join(temporaryDir(), 'keepalive.json'),
        create: async () => await site.page(),
        log: LOG,
        emit: () => {},
      })
      await expect(service.add({ url: 'https://example.com/a' })).resolves.toMatchObject({ nextAttemptAt: '2026-01-01T00:00:00.000Z' })
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(0)
      // The timer started the visit; a check shares it and returns once it has settled and re-armed.
      await expect(service.check('k1')).resolves.toMatchObject({
        state: 'ok',
        lastAttemptAt: '2026-01-01T00:00:00.000Z',
        nextAttemptAt: '2026-01-01T00:05:00.000Z',
      })
      expect(site.visits).toBe(1)
      // The success armed the next visit five minutes out, and close cancels it.
      expect(vi.getTimerCount()).toBe(1)
      await service.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares an attempt already in flight instead of starting a second', async () => {
    const bench = boot()
    const added = await bench.service.add({ url: 'https://example.com/a' })
    const [first, second] = await Promise.all([
      bench.service.check(added.id),
      bench.service.check(added.id),
    ])
    expect(first.state).toBe('ok')
    expect(second.state).toBe('ok')
    expect(bench.site.visits).toBe(1)
  })
})

describe('the page pool', () => {
  it('reuses an idle page and replaces one that closed', async () => {
    const site = new FakeSite()
    const pool = new KeepalivePagePool({ create: async () => await site.page(), log: LOG })
    const first = await pool.acquire() as FakePage
    pool.release(first)
    const again = await pool.acquire() as FakePage
    expect(again).toBe(first)
    pool.release(again)
    await again.close()
    const replacement = await pool.acquire() as FakePage
    expect(replacement).not.toBe(again)
    pool.release(replacement)
    await pool.close()
    expect(replacement.closed).toBe(true)
    await expect(pool.acquire()).rejects.toThrow('the keepalive pages are closed')
  })

  it('closes a page it cannot keep, and a release after close', async () => {
    const site = new FakeSite()
    const pool = new KeepalivePagePool({ create: async () => await site.page(), log: LOG })
    const first = await pool.acquire() as FakePage
    await pool.close()
    pool.release(first)
    expect(first.closed).toBe(true)
    // Closing a page twice is the page's own no-op, not an error.
    const second = await site.page()
    await second.close()
    pool.release(second)
    expect(second.closed).toBe(true)
  })

  it('closes an idle page and reports a page that refuses to close', async () => {
    const site = new FakeSite()
    const pool = new KeepalivePagePool({ create: async () => await site.page(), log: LOG })
    const page = await site.page()
    vi.spyOn(page, 'close').mockRejectedValue(new Error('already gone'))
    pool.release(page)
    await pool.close()
    expect(LOG.warn).toHaveBeenCalledWith(expect.stringContaining('closing a keepalive page failed'), 'already gone')
  })
})

describe('the tab cap', () => {
  it('checks a keepalive while the browser is at its eight-tab limit, without spending a tab', async () => {
    const site = new FakeSite()
    const context = {
      pages: (): readonly TabsPage[] => site.pages,
      newPage: async (): Promise<TabsPage> => await site.page(),
    }
    const tabs = new BrowserTabs({ context: async () => context, log: LOG })
    for (let index = 0; index < MAX_TABS; index += 1) await tabs.create()
    await expect(tabs.create()).rejects.toThrow(TabLimitError)

    const timer = new ManualTimer()
    const service = new KeepaliveService({
      path: join(temporaryDir(), 'keepalive.json'),
      create: async () => await site.page(),
      log: LOG,
      emit: () => {},
      now: timer.now,
      schedule: timer.schedule,
    })
    const added = await service.add({ url: 'https://example.com/a' })
    const status = await service.check(added.id)
    expect(status.state).toBe('ok')
    expect(tabs.state()).toHaveLength(MAX_TABS)
    expect(site.pages).toHaveLength(MAX_TABS + 1)
    await service.close()
  })
})
