/**
 * The state a restart hands the browser, and how the plugin gets out of it.
 *
 * A previous process that died while Chromium still held the profile leaves
 * three `Singleton*` files naming a pid that is gone, and sometimes a Chromium
 * whose parent is gone too. The next launch then comes up over a profile another
 * browser still owns, and every page creation answers
 * `Target.createTarget: Failed to open a new tab` — the failure a course-sync
 * session sees after an upgrade. These tests pin the detection (a live pid is not
 * stale, a dead one is), the one-shot recovery (a lost context relaunches once and
 * retries; a second failure is reported with the profile path), shutdown (the
 * context closes and the child is killed as a last resort), and the rule that the
 * keepalives move to the context that came back.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserContext, Page } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChallengeFacts } from '../src/challenge.ts'
import type { Config } from '../src/config.ts'
import { KeepaliveService, type KeepalivePage } from '../src/keepalive.ts'
import {
  SINGLETON_FILES,
  detectStaleProfile,
  lockOwnerPid,
  parseProcessList,
  processesForProfile,
  recoverStaleProfile,
} from '../src/profile.ts'
import { BrowserUnavailableError, HeadlessBrowserSession, isLostContextError, type SessionDeps } from '../src/session.ts'
import { BrowserTabs } from '../src/tabs.ts'

const LOG = {
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
} satisfies Pick<Context['logger'], 'debug' | 'error' | 'info' | 'warn'>

const HOST = 'test-host.local'

const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.clearAllMocks()
})

/** A fresh directory for one test's profile. */
function temporaryDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
  temporary.push(root)
  return root
}

/** Write the three files a Chromium leaves in a profile it owns. */
function writeSingletons(profileDir: string, pid: number): void {
  mkdirSync(profileDir, { recursive: true })
  symlinkSync(`${HOST}-${String(pid)}`, join(profileDir, 'SingletonLock'))
  symlinkSync('1234567890123456789', join(profileDir, 'SingletonCookie'))
  symlinkSync('/tmp/dsh-test/SingletonSocket', join(profileDir, 'SingletonSocket'))
}

/** The config one test's session runs with; stealth stays off so no page tap is needed. */
function configFor(profileDir: string): Config {
  return {
    profileDir,
    headless: true,
    stealth: false,
    sensitiveActions: true,
    viewportWidth: 1280,
    viewportHeight: 800,
    jpegQuality: 60,
    snapshotDir: join(profileDir, 'snapshots'),
    keepalivePath: join(profileDir, 'keepalive.json'),
    keepaliveEscalateAfter: 3,
    downloadDir: join(profileDir, 'downloads'),
    maxDownloadMB: 256,
    downloadRetainDays: 7,
    downloadPdfs: true,
    credentialsPath: join(profileDir, 'credentials.json'),
    uploadDirs: [join(profileDir, 'uploads')],
    maxUploadMB: 25,
  }
}

/** How many navigations every fake page made, so a reused pool page still counts. */
const visits = { count: 0 }

/** A listener the fakes keep; it accepts every Playwright event payload and the fakes call it with none. */
type FakeListener = (...args: never[]) => void

/** What the session's page probe reads: a signed-in page with nothing blocking it. */
const SIGNED_IN: ChallengeFacts = { passwordField: false, oneTimeCode: false, accountLinks: 0 }

/** The page a tab model drives, and the page the session's keepalive page wraps. */
class FakePage {
  closed = false
  #url = 'about:blank'
  readonly #listeners = new Map<string, Set<FakeListener>>()
  /**
   * The Playwright page the session and the tab model receive. It has the members
   * the tab model and the keepalive page call (url, title, isClosed, goto, goBack,
   * goForward, reload, bringToFront, close, on, off, evaluate); every other member
   * is undefined.
   */
  readonly page: Page = this.#playwrightPage()

  async close(): Promise<void> {
    this.closed = true
    this.emit('close')
  }

  emit(event: string, ...args: never[]): void {
    for (const listener of [...this.#listeners.get(event) ?? []]) listener(...args)
  }

  #playwrightPage(): Page {
    const members: Partial<Page> = {
      url: () => this.#url,
      title: async () => 'page',
      isClosed: () => this.closed,
      goto: async (url: string) => {
        visits.count += 1
        this.#url = url
        this.emit('load')
        return null
      },
      goBack: async () => null,
      goForward: async () => null,
      reload: async () => null,
      bringToFront: async () => {},
      close: async () => { await this.close() },
      on: (event: string, listener: FakeListener): Page => {
        const set = this.#listeners.get(event) ?? new Set()
        set.add(listener)
        this.#listeners.set(event, set)
        return this.page
      },
      off: (event: string, listener: FakeListener): Page => {
        this.#listeners.get(event)?.delete(listener)
        return this.page
      },
      evaluate: async (): Promise<ChallengeFacts> => SIGNED_IN,
    }
    return members as Page
  }
}

/** The failure Chromium answers with when the profile it came up on is not its own. */
const TARGET_FAILURE = 'browserContext.newPage: Protocol error (Target.createTarget): Failed to open a new tab'

/** A context that can be told to refuse page creation, the way a stale profile does. */
class FakeContext {
  /** Every page this context created, closed ones included, in creation order. */
  readonly created: FakePage[] = []
  readonly #listeners = new Map<string, Set<FakeListener>>()
  closed = false
  newPageCalls = 0
  /** How many page creations to refuse before one succeeds. */
  failNewPage: number
  /**
   * The Playwright context a launch returns. It has the members the session's
   * launch, recovery, and shutdown call (on, off, newPage, close); every other
   * member is undefined. Its close runs this fake's `close`, so a test can replace that.
   */
  readonly context: BrowserContext = this.#playwrightContext()

  constructor(failNewPage = 0) {
    this.failNewPage = failNewPage
  }

  pagesList(): readonly FakePage[] { return this.created.filter(page => !page.closed) }

  async newPage(): Promise<FakePage> {
    this.newPageCalls += 1
    if (this.failNewPage > 0) {
      this.failNewPage -= 1
      throw new Error(TARGET_FAILURE)
    }
    const page = new FakePage()
    this.created.push(page)
    return page
  }

  async close(): Promise<void> {
    this.closed = true
    for (const listener of this.#listeners.get('close') ?? []) listener()
  }

  #playwrightContext(): BrowserContext {
    const members: Partial<BrowserContext> = {
      on: (event: string, listener: FakeListener): BrowserContext => {
        const set = this.#listeners.get(event) ?? new Set()
        set.add(listener)
        this.#listeners.set(event, set)
        return this.context
      },
      off: (event: string, listener: FakeListener): BrowserContext => {
        this.#listeners.get(event)?.delete(listener)
        return this.context
      },
      newPage: async () => (await this.newPage()).page,
      close: async () => { await this.close() },
    }
    return members as BrowserContext
  }
}

/** One test's launcher: every launch hands back the next scripted context. */
function launcher(script: readonly number[], profileDir: string): { deps: SessionDeps; contexts: FakeContext[]; kills: number[] } {
  const contexts: FakeContext[] = []
  const kills: number[] = []
  const deps: SessionDeps = {
    launch: async () => {
      const context = new FakeContext(script[contexts.length] ?? 0)
      contexts.push(context)
      return context.context
    },
    sleep: async () => {},
    probe: {
      hostname: HOST,
      // Only this process is alive, and nothing is ever signalled for real.
      alive: pid => pid === process.pid,
      signal: () => {},
      readLink: async () => undefined,
      // One Chromium this process launched, so shutdown has a pid to reach.
      listProcesses: async () => parseProcessList(`  4242 ${String(process.pid)} /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=${profileDir}\n`),
      remove: async () => {},
    },
    kill: (pid) => { kills.push(pid); return true },
  }
  return { deps, contexts, kills }
}

describe('stale profile detection', () => {
  it('reads ps lines and only claims processes that name the profile', () => {
    const rows = parseProcessList([
      '  101     1 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/p/one about:blank',
      '  102   100 node /usr/local/bin/dsh event',
      '',
      'not a ps line',
    ].join('\n'))
    expect(rows).toEqual([
      { pid: 101, ppid: 1, command: '/Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/p/one about:blank' },
      { pid: 102, ppid: 100, command: 'node /usr/local/bin/dsh event' },
    ])
    expect(processesForProfile(rows, '/p/one').map(row => row.pid)).toEqual([101])
    expect(processesForProfile(rows, '/p/two')).toEqual([])
  })

  it('reads the pid out of a lock target only when this machine wrote it', () => {
    expect(lockOwnerPid(`${HOST}-4321`, HOST)).toBe(4321)
    expect(lockOwnerPid('other-host.local-4321', HOST)).toBeUndefined()
    expect(lockOwnerPid('1234567890123456789', HOST)).toBeUndefined()
    expect(lockOwnerPid(undefined, HOST)).toBeUndefined()
  })

  it('treats a lock that names a live pid as owned, and leaves every file alone', async () => {
    const profileDir = temporaryDir()
    writeSingletons(profileDir, 4242)
    const stale = await detectStaleProfile(profileDir, {
      hostname: HOST,
      alive: pid => pid === 4242,
      listProcesses: async () => [],
    })
    expect(stale).toBeUndefined()
  })

  it('clears the three Singleton files when the pid they name is gone', async () => {
    const profileDir = temporaryDir()
    writeSingletons(profileDir, 989_898)
    const stale = await recoverStaleProfile(profileDir, {
      hostname: HOST,
      alive: () => false,
      listProcesses: async () => [],
      signal: () => {},
    })
    expect(stale?.deadPids).toEqual([989_898])
    expect(stale?.lockFiles).toHaveLength(SINGLETON_FILES.length)
    for (const name of SINGLETON_FILES) expect(existsSync(join(profileDir, name))).toBe(false)
  })

  it('kills a Chromium that runs this profile while its parent is gone', async () => {
    const profileDir = temporaryDir()
    const rows = parseProcessList(`  700     1 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=${profileDir} --headless\n`)
    const signals: [number, NodeJS.Signals][] = []
    const stale = await recoverStaleProfile(profileDir, {
      hostname: HOST,
      alive: pid => pid !== 700,
      readLink: async () => undefined,
      listProcesses: async () => rows,
      signal: (pid, name) => { signals.push([pid, name]) },
    })
    expect(stale?.orphanPids).toEqual([700])
    expect(signals).toEqual([[700, 'SIGKILL']])
  })

  it('leaves a Chromium alone while the process that launched it is running', async () => {
    const profileDir = temporaryDir()
    const rows = parseProcessList(`  800   799 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=${profileDir}\n`)
    const stale = await detectStaleProfile(profileDir, {
      hostname: HOST,
      alive: () => true,
      readLink: async () => undefined,
      listProcesses: async () => rows,
    })
    expect(stale).toBeUndefined()
  })
})

describe('browser recovery', () => {
  it('recognizes the failures a lost context answers with', () => {
    expect(isLostContextError(new Error(TARGET_FAILURE))).toBe(true)
    expect(isLostContextError(new Error('browserContext.newPage: Target page, context or browser has been closed'))).toBe(true)
    expect(isLostContextError(new Error('no element matches #go'))).toBe(false)
  })

  it('relaunches once and retries when the first page creation fails', async () => {
    const profileDir = temporaryDir()
    const { deps, contexts } = launcher([1, 0], profileDir)
    const session = new HeadlessBrowserSession(configFor(profileDir), LOG, undefined, deps)
    const relaunches: number[] = []
    session.onRelaunch(() => { relaunches.push(1) })

    const page = await session.keepalivePage()

    expect(page.url()).toBe('about:blank')
    expect(contexts).toHaveLength(2)
    expect(contexts[0]?.closed).toBe(true)
    expect(relaunches).toHaveLength(1)
    expect(LOG.warn).toHaveBeenCalledWith(
      'headless-browser: recovering the browser after %s; profile %s',
      expect.stringContaining('Failed to open a new tab'),
      profileDir,
    )
    await session.close()
  })

  it('reports the profile path when the retry fails too', async () => {
    const profileDir = temporaryDir()
    const { deps, contexts } = launcher([5, 5], profileDir)
    const session = new HeadlessBrowserSession(configFor(profileDir), LOG, undefined, deps)

    const failure = await session.keepalivePage().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BrowserUnavailableError)
    expect(String(failure)).toMatch(/relaunched once[\s\S]*Failed to open a new tab[\s\S]*profile/u)
    expect(String(failure)).toContain(profileDir)
    // One relaunch, never a loop: the second context is the last one tried.
    expect(contexts).toHaveLength(2)
    await session.close()
  })

  it('closes the context on dispose, and kills the browser only when that fails', async () => {
    const profileDir = temporaryDir()
    const { deps, contexts } = launcher([0, 0], profileDir)
    const session = new HeadlessBrowserSession(configFor(profileDir), LOG, undefined, deps)
    await session.ensure()
    await session.close()
    expect(contexts[0]?.closed).toBe(true)

    const stuck = launcher([0], profileDir)
    // A context that will not close, so shutdown has to reach the browser itself.
    const stuckDeps: SessionDeps = {
      ...stuck.deps,
      launch: async () => {
        const context = new FakeContext(0)
        context.close = async () => { throw new Error('close timed out') }
        stuck.contexts.push(context)
        return context.context
      },
    }
    const second = new HeadlessBrowserSession(configFor(profileDir), LOG, undefined, stuckDeps)
    await second.ensure()
    await second.close()
    expect(stuck.kills.length).toBeGreaterThan(0)
  })

  it('kills the browser from the exit hook when the process dies without a dispose', async () => {
    const profileDir = temporaryDir()
    const { deps, kills } = launcher([0], profileDir)
    let exitHook: (() => void) | undefined
    const session = new HeadlessBrowserSession(configFor(profileDir), LOG, undefined, {
      ...deps,
      onExit: (run) => { exitHook = run; return () => {} },
    })
    await session.ensure()
    expect(exitHook).toBeDefined()
    exitHook?.()
    expect(kills).toHaveLength(1)
  })

  it('does not end the process when the browser dies under the last tab', async () => {
    // Nobody awaits the tab model's close handler, so a dead browser there used
    // to be an unhandled rejection — which ends a Node process.
    const context = new FakeContext(0)
    const tabs = new BrowserTabs({
      context: async () => ({
        pages: () => context.pagesList().map(fake => fake.page),
        newPage: async () => (await context.newPage()).page,
      }),
      log: LOG,
    })
    await tabs.create()
    const page = context.created[0] as FakePage
    // Every page after this one fails, the way a browser that went away answers.
    context.failNewPage = 5
    await page.close()
    await vi.waitFor(() => {
      expect(LOG.warn).toHaveBeenCalledWith(
        'headless-browser: replacing the closed tab %s failed: %s',
        't1',
        expect.stringContaining('Failed to open a new tab'),
      )
    })
    expect(tabs.state()).toHaveLength(0)
  })

  it('moves the keepalives onto the context that came back', async () => {
    const profileDir = temporaryDir()
    // The first launch refuses one page creation; the relaunch is healthy.
    const { deps, contexts } = launcher([1, 0], profileDir)
    const session = new HeadlessBrowserSession(configFor(profileDir), LOG, undefined, deps)
    const timers: { delay: number; run: () => void }[] = []
    const keepalives = new KeepaliveService({
      path: join(profileDir, 'keepalive.json'),
      create: async (): Promise<KeepalivePage> => await session.keepalivePage(),
      log: LOG,
      emit: () => {},
      now: () => Date.parse('2026-11-18T00:00:00.000Z'),
      schedule: (delay, run) => {
        timers.push({ delay, run })
        return () => {}
      },
    })
    session.onRelaunch(() => { void keepalives.rearm() })
    await keepalives.add({ url: 'https://example.com/a', everyMinutes: 20 })
    const armed = timers.length
    expect(armed).toBeGreaterThan(0)

    // The visit that lands on the dead context recovers the browser and settles
    // on the new one; the re-arm is what the relaunch announces.
    timers.at(-1)?.run()
    await vi.waitFor(() => { expect(contexts).toHaveLength(2) })
    await vi.waitFor(() => {
      expect(LOG.info).toHaveBeenCalledWith('headless-browser: re-armed %d keepalive(s) after the browser came back', 1)
    })
    await vi.waitFor(() => {
      expect(keepalives.snapshot()[0]?.state).toBe('ok')
    })
    expect(contexts[1]?.newPageCalls).toBeGreaterThan(0)

    // A timer re-armed after the recovery drives a visit on the new context.
    const before = visits.count
    timers.at(-1)?.run()
    await vi.waitFor(() => { expect(visits.count).toBeGreaterThan(before) })
    await keepalives.close()
    await session.close()
  })
})
