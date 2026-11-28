// @vitest-environment jsdom

/**
 * The session's own decisions over fake Playwright objects: when it launches,
 * relaunches, and gives up; what it records about the browser it started; how it
 * shuts down; and the checks it runs before it writes a secret, attaches a file,
 * or acts at a point. The fake page is this file's jsdom document, so the
 * functions the session hands to `evaluate` run here against real elements; only
 * the visibility probe answers with facts a test sets, because jsdom has no
 * layout. Embedded pages are separate jsdom documents.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserContext, CDPSession, ElementHandle, FileChooser, Frame, JSHandle, Keyboard, Locator, Mouse, Page } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.ts'
import { DOWNLOAD_START_WAIT_MS } from '../src/downloads.ts'
import { ActionGuard, ActionRefusedError, type Decision, type TargetDecisionInput } from '../src/guard.ts'
import { OWNER_FILE, type ProfileProbe, type ProfileProcess } from '../src/profile.ts'
import { DEFAULT_MISS_ADVICE } from '../src/near-miss.ts'
import { SelectorMissError } from '../src/read.ts'
import {
  BrowserUnavailableError,
  HeadlessBrowserSession,
  NoOpenTabError,
  RELAUNCH_SETTLE_MS,
  SHUTDOWN_TIMEOUT_MS,
  SecretFieldError,
  isLostContextError,
  type SessionDeps,
} from '../src/session.ts'
import { TabNavigationError } from '../src/tabs.ts'
import { findHiddenTextHolder, findSameNameCover, findToggleStandIn, probeElement, type ElementFacts } from '../src/visibility.ts'

const LOG = {
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
} satisfies Pick<Context['logger'], 'debug' | 'error' | 'info' | 'warn'>

const HOST = 'test-host.local'

/** The failure Chromium answers with when the profile it came up on is not its own. */
const TARGET_FAILURE = 'browserContext.newPage: Protocol error (Target.createTarget): Failed to open a new tab'

const temporary: string[] = []
const children: ChildProcess[] = []
const restores: (() => void)[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const restore of restores.splice(0).reverse()) restore()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

/** A fresh profile directory for one test. */
function profileDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-'))
  temporary.push(root)
  return root
}

/** The config one test's session runs with; stealth stays off so no page tap is needed. */
function configFor(dir: string): Config {
  return {
    profileDir: dir,
    headless: true,
    stealth: false,
    sensitiveActions: true,
    viewportWidth: 1280,
    viewportHeight: 800,
    jpegQuality: 60,
    snapshotDir: join(dir, 'snapshots'),
    keepalivePath: join(dir, 'keepalive.json'),
    keepaliveEscalateAfter: 3,
    downloadDir: join(dir, 'downloads'),
    maxDownloadMB: 256,
    downloadRetainDays: 7,
    downloadPdfs: true,
    credentialsPath: join(dir, 'credentials.json'),
    uploadDirs: [join(dir, 'uploads')],
    maxUploadMB: 25,
  }
}

/** Facts of an element a person can see and reach, named by its label or text. */
function visibleFacts(node: Element, overrides: Partial<ElementFacts> = {}): ElementFacts {
  return {
    name: node.getAttribute('aria-label') ?? node.textContent.trim(),
    value: '',
    href: null,
    formAction: null,
    tag: node.tagName.toLowerCase(),
    role: node.getAttribute('role'),
    display: 'block',
    visibility: 'visible',
    opacity: 1,
    pointerEvents: 'auto',
    ariaHidden: false,
    width: 160,
    height: 32,
    viewportFraction: 1,
    occlusion: 1,
    clippedBy: 0,
    clippingFraction: 1,
    ...overrides,
  }
}

/** A function the session runs on an element; Playwright also accepts source text, which the session never sends. */
type OnElement = string | ((node: Element, arg?: unknown) => unknown)

/** A function the session runs in the page. */
type InPage = string | ((arg?: unknown) => unknown)

/** How a locator over an embedded page misbehaves, the way a frame that detached mid-read does. */
interface LocatorFaults {
  readonly countFails?: boolean
}

/** An embedded page: its address, its box on screen, and its own document. */
interface FakeFrameSpec {
  readonly url: string
  /** The iframe's box; `null` when it has none, `detached` when the frame element cannot be read. */
  readonly box: { readonly width: number; readonly height: number } | null | 'detached'
  /** The frame document's body markup, or nothing for a document without a body. */
  readonly body?: string
  readonly faults?: LocatorFaults
}

/** A file chooser the next trigger click opens, the input behind it, and the files it received. */
interface FakeChooser {
  readonly multiple: boolean
  readonly input?: Element
  files?: readonly string[]
}

/** One tab's page, backed by the jsdom document. */
class FakePage {
  closed = false
  address = 'about:blank'
  /** Set to make every navigation reject with this message. */
  gotoFailure: string | undefined
  /** Set to make bringing the page to the front reject. */
  failFront = false
  /** Set to make every click reject; `closes` names what closes first, as a popup's own click handler or a dying browser does. */
  clickFailure: { readonly message: string; readonly closes?: 'page' | 'browser' } | undefined
  /** Probe facts that differ from {@link visibleFacts}, per element. */
  readonly facts = new Map<Element, Partial<ElementFacts>>()
  /** The same-name control drawn over an element, per element. */
  readonly covers = new Map<Element, Element>()
  /** The label or box a person clicks for a checkbox or radio the page hides, per element. */
  readonly standIns = new Map<Element, Element>()
  readonly holders = new Map<Element, Element>()
  readonly frames: FakeFrameSpec[] = []
  chooser: FakeChooser | undefined
  readonly mouseClicks: [number, number][] = []
  readonly inserted: string[] = []
  /** Keys pressed, as `<element id>:<key>` for an element press and `keyboard:<key>` for the page keyboard. */
  readonly pressed: string[] = []
  readonly clicked: Element[] = []
  readonly focused: Element[] = []
  /** Text typed as keystrokes on the page keyboard. */
  readonly typed: string[] = []
  readonly filled = new Map<Element, string>()
  readonly attached = new Map<Element, readonly string[]>()
  /** The address an element handle's frame reports; the page's own when unset, none when `null`. */
  ownerFrameUrl: string | null | undefined
  /** Called when a locator pins its element to a handle, as a page script that changes the element in between would. */
  onPin: ((node: Element) => void) | undefined
  /** Called while a screenshot is taken. */
  onScreenshot: (() => void) | undefined
  /** Set to make every close reject, as a page of a browser that went away does. */
  closeFailure: string | undefined
  /** Markup a selector wait finds appended to the body, as a step that draws late; without it a wait times out. */
  lateMarkup: string | undefined
  /** Set to detach what a selector wait found before the wait returns, as a step that redraws at once does. */
  lateDetaches = false
  /** The `document.documentURI` the page reports; jsdom's own when unset. */
  documentURI: string | undefined
  /** How the main frame's control count fails for the resume probe: its frame detached, or it is still attached. */
  countFailure: 'detached' | 'attached' | undefined
  /** The page whose script opened this one. */
  openerPage: Page | null = null
  reloads = 0
  readonly #listeners = new Map<string, Set<(...args: never[]) => void>>()
  readonly #context: FakeContext
  readonly #main: Frame
  readonly page: Page

  constructor(context: FakeContext) {
    this.#context = context
    this.#main = this.#mainFrame()
    this.page = this.#playwrightPage()
  }

  /** Fire one page event with its payload, as Playwright does for `popup`, `request`, and `response`. */
  fire(event: string, payload: unknown): void {
    for (const listener of [...this.#listeners.get(event) ?? []]) (listener as (payload: unknown) => void)(payload)
  }

  /** Answer one element function: the probe from the set facts, everything else by running it. */
  run(fn: OnElement, node: Element, arg?: unknown): unknown {
    if (typeof fn === 'string') throw new Error('the fake page runs functions, not source text')
    if (fn === probeElement) return visibleFacts(node, this.facts.get(node))
    return fn(node, arg)
  }

  /** Record one click, then fail it the way {@link clickFailure} says. */
  async clickWith(record: () => void): Promise<void> {
    record()
    const failure = this.clickFailure
    if (failure === undefined) return
    if (failure.closes === 'page') await this.page.close()
    if (failure.closes === 'browser') await this.#context.context.close()
    throw new Error(failure.message)
  }

  /** The handle of one element, as `evaluateHandle` and an accessibility id map return it. */
  elementHandle(node: Element): ElementHandle<Element> {
    return {
      evaluate: async (fn: OnElement, arg?: unknown): Promise<unknown> => this.run(fn, node, arg),
      evaluateHandle: async (fn: OnElement): Promise<JSHandle> => this.#coverHandle(fn, node),
      click: async (): Promise<void> => { this.clicked.push(node) },
      fill: async (value: string): Promise<void> => { this.filled.set(node, value) },
      press: async (key: string): Promise<void> => { this.pressed.push(`${node.id}:${key}`) },
      focus: async (): Promise<void> => { this.focused.push(node) },
      ownerFrame: async (): Promise<Frame | null> => {
        const url = this.ownerFrameUrl === undefined ? this.address : this.ownerFrameUrl
        return url === null ? null : { url: (): string => url } as Partial<Frame> as Frame
      },
      dispose: async (): Promise<void> => {},
    } as Partial<ElementHandle<Element>> as ElementHandle<Element>
  }

  /** A locator over the elements one query returns now. */
  locator(nodes: () => Element[], faults: LocatorFaults = {}): Locator {
    const only = (): Element => {
      const [node] = nodes()
      if (node === undefined) throw new Error('the locator matches no element')
      return node
    }
    return {
      count: async (): Promise<number> => {
        if (faults.countFails === true) throw new Error('frame.locator: Frame was detached')
        return nodes().length
      },
      nth: (index: number): Locator => this.locator(() => nodes().slice(index, index + 1), faults),
      first: (): Locator => this.locator(() => nodes().slice(0, 1), faults),
      evaluate: async (fn: OnElement, arg?: unknown): Promise<unknown> => this.run(fn, only(), arg),
      evaluateHandle: async (fn: OnElement): Promise<JSHandle> => this.#coverHandle(fn, only()),
      click: async (): Promise<void> => { await this.clickWith(() => { this.clicked.push(only()) }) },
      fill: async (value: string): Promise<void> => { this.filled.set(only(), value) },
      press: async (key: string): Promise<void> => { this.pressed.push(`${only().id}:${key}`) },
      focus: async (): Promise<void> => { this.focused.push(only()) },
      setInputFiles: async (files: readonly string[]): Promise<void> => { this.attached.set(only(), files) },
      innerText: async (): Promise<string> => only().textContent,
      elementHandle: async (): Promise<ElementHandle<Element>> => {
        const node = only()
        this.onPin?.(node)
        return this.elementHandle(node)
      },
      waitFor: async (): Promise<void> => {
        const late = this.lateMarkup
        this.lateMarkup = undefined
        if (late !== undefined) document.body.insertAdjacentHTML('beforeend', late)
        const found = nodes()
        if (this.lateDetaches) for (const node of found) node.remove()
        if (found.length === 0) throw new Error('locator.waitFor: Timeout 2500ms exceeded.')
      },
    } as Partial<Locator> as Locator
  }

  #mainFrame(): Frame {
    const frame = {
      url: (): string => this.address,
      parentFrame: (): null => null,
      childFrames: (): Frame[] => this.frames.map(spec => this.#frame(spec)),
      isDetached: (): boolean => this.countFailure === 'detached',
      locator: (selector: string): Locator => {
        const failure = this.countFailure
        const locator = this.locator(() => [...document.querySelectorAll(selector)])
        if (failure === undefined) return locator
        return { ...locator, count: async (): Promise<number> => { throw new Error('frame.locator: Frame was detached') } }
      },
    }
    return frame as Partial<Frame> as Frame
  }

  #jsHandle(value: Element | null): JSHandle {
    return {
      asElement: (): ElementHandle<Element> | null => value === null ? null : this.elementHandle(value),
      dispose: async (): Promise<void> => {},
    } as Partial<JSHandle> as JSHandle
  }

  #coverHandle(fn: OnElement, node: Element): JSHandle {
    if (fn === findToggleStandIn) return this.#jsHandle(this.standIns.get(node) ?? null)
    if (fn === findHiddenTextHolder) return this.#jsHandle(this.holders.get(node) ?? null)
    if (fn !== findSameNameCover) throw new Error('the fake page only hands out cover, stand-in and holder handles')
    return this.#jsHandle(this.covers.get(node) ?? null)
  }

  #emit(event: string, ...payload: never[]): void {
    for (const listener of [...this.#listeners.get(event) ?? []]) listener(...payload)
  }

  #frame(spec: FakeFrameSpec): Frame {
    const doc = document.implementation.createHTMLDocument('frame')
    if (spec.body === undefined) doc.body.remove()
    else doc.body.innerHTML = spec.body
    const { box } = spec
    const element = {
      boundingBox: async (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
        box === null || box === 'detached' ? null : { x: 0, y: 0, ...box },
    } as Partial<ElementHandle> as ElementHandle
    return {
      url: (): string => spec.url,
      frameElement: async (): Promise<ElementHandle> => {
        if (box === 'detached') throw new Error('frame.frameElement: Frame has been detached')
        return element
      },
      locator: (selector: string): Locator => this.locator(() => [...doc.querySelectorAll(selector)], spec.faults),
    } as Partial<Frame> as Frame
  }

  #playwrightPage(): Page {
    const mouse = {
      click: async (x: number, y: number): Promise<void> => { await this.clickWith(() => { this.mouseClicks.push([x, y]) }) },
    } as Partial<Mouse> as Mouse
    const keyboard = {
      insertText: async (text: string): Promise<void> => { this.inserted.push(text) },
      press: async (key: string): Promise<void> => { this.pressed.push(`keyboard:${key}`) },
      type: async (text: string): Promise<void> => { this.typed.push(text) },
    } as Partial<Keyboard> as Keyboard
    const chooserOf = (): FakeChooser | undefined => this.chooser
    const handleOf = (node: Element): ElementHandle<Element> => this.elementHandle(node)
    // Playwright overloads waitForEvent per event; the fake answers the file chooser and refuses every other event.
    function waitForEvent(event: 'filechooser'): Promise<FileChooser>
    function waitForEvent(event: string): Promise<never>
    async function waitForEvent(event: string): Promise<FileChooser> {
      const chooser = chooserOf()
      if (event !== 'filechooser' || chooser === undefined) throw new Error(`page.waitForEvent: Timeout waiting for ${event}`)
      return {
        isMultiple: (): boolean => chooser.multiple,
        element: (): ElementHandle<Element> => handleOf(chooser.input ?? document.body),
        setFiles: async (files: readonly string[]): Promise<void> => { chooser.files = files },
      } as Partial<FileChooser> as FileChooser
    }
    return {
      url: (): string => this.address,
      title: async (): Promise<string> => document.title,
      isClosed: (): boolean => this.closed,
      goto: async (url: string): Promise<null> => {
        if (this.gotoFailure !== undefined) throw new Error(this.gotoFailure)
        this.address = url
        this.#emit('framenavigated', this.#main as never)
        this.#emit('load')
        return null
      },
      reload: async (): Promise<null> => {
        this.reloads += 1
        this.#emit('load')
        return null
      },
      bringToFront: async (): Promise<void> => {
        if (this.failFront) throw new Error('page.bringToFront: Target closed')
      },
      close: async (): Promise<void> => {
        if (this.closeFailure !== undefined) throw new Error(this.closeFailure)
        this.closed = true
        this.#emit('close')
      },
      on: (event: string, listener: (...args: never[]) => void): Page => {
        const set = this.#listeners.get(event) ?? new Set()
        set.add(listener)
        this.#listeners.set(event, set)
        return this.page
      },
      off: (event: string, listener: (...args: never[]) => void): Page => {
        this.#listeners.get(event)?.delete(listener)
        return this.page
      },
      evaluate: async (fn: InPage, arg?: unknown): Promise<unknown> => {
        if (fn === 'document.documentURI') return this.documentURI ?? document.documentURI
        if (typeof fn === 'string') throw new Error('the fake page runs functions, not source text')
        return await fn(arg)
      },
      evaluateHandle: async (fn: InPage, arg?: unknown): Promise<JSHandle | ElementHandle<Element>> => {
        if (typeof fn === 'string') throw new Error('the fake page runs functions, not source text')
        const value = fn(arg)
        return this.#jsHandle(value instanceof Element ? value : null)
      },
      locator: (selector: string): Locator => this.locator(() => [...document.querySelectorAll(selector)]),
      mainFrame: (): Frame => this.#main,
      frames: (): Frame[] => [this.#main],
      routeWebSocket: async (): Promise<void> => {},
      screenshot: async (): Promise<Buffer> => {
        this.onScreenshot?.()
        return Buffer.from('png')
      },
      opener: async (): Promise<Page | null> => this.openerPage,
      mouse,
      keyboard,
      context: (): BrowserContext => this.#context.context,
      viewportSize: (): null => null,
      waitForEvent,
    } as Partial<Page> as Page
  }
}

/** How a fake context answers a close. */
type CloseBehavior = 'closes' | 'fails' | 'hangs'

/** A persistent context whose page creations follow a script. */
class FakeContext {
  readonly created: FakePage[] = []
  /** One entry per page creation, in order: an error message to throw, or nothing to succeed. */
  readonly newPageFailures: (string | undefined)[]
  closeBehavior: CloseBehavior = 'closes'
  closed = false
  /** Every CDP command the session sent, with its parameters. */
  readonly sent: [string, unknown][] = []
  /** The `Fetch.requestPaused` listener of each guarded job page, in guarding order. */
  readonly paused: ((event: unknown) => void)[] = []
  /** Set to make the next page creation's first navigation reject with this message. */
  nextGotoFailure: string | undefined
  readonly #listeners = new Map<string, Set<(...args: never[]) => void>>()
  readonly context: BrowserContext

  constructor(newPageFailures: (string | undefined)[] = []) {
    this.newPageFailures = newPageFailures
    const cdp = {
      send: async (method: string, params?: object): Promise<unknown> => {
        this.sent.push([method, params])
        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: { pageX: 0, pageY: 0, clientHeight: 800 }, cssContentSize: { height: 800 } }
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
        return {}
      },
      on: (_event: string, listener: (event: unknown) => void): CDPSession => {
        this.paused.push(listener)
        return cdp
      },
    } as Partial<CDPSession> as CDPSession
    this.context = {
      on: (event: string, listener: (...args: never[]) => void): BrowserContext => {
        const set = this.#listeners.get(event) ?? new Set()
        set.add(listener)
        this.#listeners.set(event, set)
        return this.context
      },
      off: (event: string, listener: (...args: never[]) => void): BrowserContext => {
        this.#listeners.get(event)?.delete(listener)
        return this.context
      },
      pages: (): Page[] => this.created.filter(page => !page.closed).map(page => page.page),
      newPage: async (): Promise<Page> => {
        const failure = this.newPageFailures.shift()
        if (failure !== undefined) throw new Error(failure)
        const page = new FakePage(this)
        page.gotoFailure = this.nextGotoFailure
        this.nextGotoFailure = undefined
        this.created.push(page)
        return page.page
      },
      newCDPSession: async (): Promise<CDPSession> => cdp,
      close: async (): Promise<void> => {
        if (this.closeBehavior === 'fails') throw new Error('browserContext.close: Target closed')
        if (this.closeBehavior === 'hangs') return await new Promise<never>(() => {})
        this.closed = true
        for (const listener of [...this.#listeners.get('close') ?? []]) listener()
      },
    } as Partial<BrowserContext> as BrowserContext
  }

  /** The page of the first tab. */
  first(): FakePage {
    const [page] = this.created
    if (page === undefined) throw new Error('the context has no page yet')
    return page
  }
}

/** One test's session over scripted launches. */
interface Harness {
  readonly dir: string
  readonly session: HeadlessBrowserSession
  /** Every context a launch returned, in launch order. */
  readonly contexts: FakeContext[]
  /** Pids the session killed through the recorded kill. */
  readonly kills: number[]
}

/** How one harness reaches the browser and the machine. */
interface HarnessOptions {
  /** What each launch does, in order: return the context, or throw the message. A healthy context after the script runs out. */
  readonly launches?: (FakeContext | string)[]
  /** Replaces part of the machine probe; by default one Chromium of this profile runs as this process's child. */
  readonly probe?: (dir: string) => Partial<ProfileProbe>
  /** Use the session's own relaunch timer instead of an instant one. */
  readonly realSleep?: boolean
  /** Use the session's own kill and process-exit hook instead of recorded ones. */
  readonly realProcess?: boolean
  readonly launch?: SessionDeps['launch']
  readonly guard?: ActionGuard
}

function harness(options: HarnessOptions = {}): Harness {
  const dir = profileDir()
  const script = [...options.launches ?? []]
  const contexts: FakeContext[] = []
  const kills: number[] = []
  const probe: ProfileProbe = {
    hostname: HOST,
    alive: pid => pid === process.pid,
    signal: () => {},
    readLink: async () => undefined,
    remove: async () => {},
    listProcesses: async () => [{ pid: 4242, ppid: process.pid, command: `/opt/chromium/chrome --user-data-dir=${dir}` }],
    ...options.probe?.(dir),
  }
  const deps: SessionDeps = {
    launch: options.launch ?? (async () => {
      const next = script.shift() ?? new FakeContext()
      if (typeof next === 'string') throw new Error(next)
      contexts.push(next)
      return next.context
    }),
    probe,
    ...options.realSleep === true ? {} : { sleep: async () => {} },
    ...options.realProcess === true ? {} : {
      kill: (pid: number) => { kills.push(pid); return true },
      // The process-exit hook is its own test's subject; elsewhere it stays off the worker process.
      onExit: () => () => {},
    },
  }
  return { dir, session: new HeadlessBrowserSession(configFor(dir), LOG, options.guard, deps), contexts, kills }
}

/** Replace one member of an object for the rest of the test. */
function stub<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  const own = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { value, configurable: true, writable: true })
  restores.push(() => {
    if (own === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, own)
  })
}

/** Remove the document's body for the rest of the test. */
function removeBody(): void {
  document.body.remove()
  restores.push(() => { document.documentElement.append(document.createElement('body')) })
}

/** A guard that clears every target and names one fixed candidate, as a guard with a defect would. */
class FixedIndexGuard extends ActionGuard {
  readonly #index: number

  constructor(index: number) {
    super()
    this.#index = index
  }

  override decideTarget(input: TargetDecisionInput): Decision {
    return { allowed: true, target: { ref: input.ref, index: this.#index, name: '', score: 1 } }
  }
}

/** A child Node process that idles until it is killed, standing in for the browser. */
async function idleChild(): Promise<{ pid: number; exited: Promise<NodeJS.Signals | null> }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' })
  children.push(child)
  const exited = new Promise<NodeJS.Signals | null>((resolve) => { child.once('exit', (_code, signal) => { resolve(signal) }) })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  if (child.pid === undefined) throw new Error('the child process has no pid')
  return { pid: child.pid, exited }
}

/** The one element a selector names in the jsdom document. */
function element(selector: string): Element {
  const found = document.querySelector(selector)
  if (found === null) throw new Error(`the test page has no ${selector}`)
  return found
}

/** A session with one open tab, and that tab's fake page. */
async function withTab(options: HarnessOptions = {}, url?: string): Promise<Harness & { page: FakePage }> {
  const state = harness(options)
  if (url === undefined) await state.session.page()
  else await state.session.open(url)
  const [context] = state.contexts
  if (context === undefined) throw new Error('the session did not launch')
  return Object.assign(state, { page: context.first() })
}

describe('lost-context errors', () => {
  it('reads a thrown string the same way as an error', () => {
    expect(isLostContextError('Target closed')).toBe(true)
    expect(isLostContextError(42)).toBe(false)
  })
})

describe('launch and shutdown', () => {
  it('reports no browser before the first launch, then the session, the pid, and the owner marker it recorded', async () => {
    const { session, dir } = harness()
    expect(session.status()).toEqual({ launched: false })
    expect(session.tabsState()).toEqual([])
    await session.ensure()
    const status = session.status()
    expect(status).toMatchObject({ launched: true, tabs: 0 })
    expect(status.sessionId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(status.url).toBeUndefined()
    expect(session.browserPid()).toBe(4242)
    expect(existsSync(join(dir, OWNER_FILE))).toBe(true)
    await session.close()
    expect(existsSync(join(dir, OWNER_FILE))).toBe(false)
    expect(session.browserPid()).toBeUndefined()
    await expect(session.ensure()).rejects.toThrow('the browser plugin is shutting down')
  })

  it('closes a session that never launched without starting a browser', async () => {
    const { session, contexts } = harness()
    await session.close()
    expect(contexts).toEqual([])
  })

  it('reports a browser that cannot start, and tries again on the next call', async () => {
    const { session, contexts } = harness({ launches: ['browserType.launchPersistentContext: spawn ENOENT'] })
    const failure = await session.ensure().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BrowserUnavailableError)
    expect(String(failure)).toContain('the headless browser could not start: browserType.launchPersistentContext: spawn ENOENT')
    await session.ensure()
    expect(contexts).toHaveLength(1)
    await session.close()
  })

  it('closes a context that finished launching after shutdown began', async () => {
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const context = new FakeContext()
    const { session } = harness({
      launch: async () => {
        started.resolve(undefined)
        await release.promise
        return context.context
      },
    })
    const ensuring = session.ensure().catch((error: unknown) => error)
    await started.promise
    const closing = session.close()
    release.resolve(undefined)
    await closing
    const failure = await ensuring
    expect(failure).toBeInstanceOf(BrowserUnavailableError)
    expect(String(failure)).toContain('the browser plugin is shutting down')
    expect(context.closed).toBe(true)
  })

  it('launches when the process list cannot be read, and closes a context that fails without a pid to kill', async () => {
    const context = new FakeContext()
    context.closeBehavior = 'fails'
    const { session, kills } = harness({
      launches: [context],
      probe: () => ({ listProcesses: async () => { throw new Error('ps: command not found') } }),
    })
    await session.ensure()
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: cleared a stale profile before launch: %s', 'the process list could not be read: ps: command not found')
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: finding the chromium pid failed: %s', 'ps: command not found')
    expect(session.browserPid()).toBeUndefined()
    await session.close()
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: closing the context failed (%s); killing chromium %s', 'browserContext.close: Target closed', 'unknown')
    expect(kills).toEqual([])
  })

  it('takes the first browser of the profile when none is this process\'s own child', async () => {
    const { session } = harness({
      probe: dir => ({
        alive: () => true,
        listProcesses: async (): Promise<readonly ProfileProcess[]> => [{ pid: 777, ppid: 4243, command: `/opt/chromium/chrome --user-data-dir=${dir}` }],
      }),
    })
    await session.ensure()
    expect(session.browserPid()).toBe(777)
    await session.close()
  })

  it('still launches when the download preferences or the owner marker cannot be written, and says so', async () => {
    const { session, dir } = harness()
    mkdirSync(join(dir, 'Default', 'Preferences.dsh-tmp'), { recursive: true })
    mkdirSync(join(dir, OWNER_FILE))
    await session.ensure()
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: setting the profile download preferences failed: %s', expect.stringContaining('EISDIR'))
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: recording the browser owner failed: %s', expect.stringContaining('EISDIR'))
    await session.close()
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: forgetting the browser owner failed: %s', expect.any(String))
  })

  it('gives up on a context that does not close within the shutdown deadline and kills its browser', async () => {
    const context = new FakeContext()
    context.closeBehavior = 'hangs'
    const { session, kills } = harness({ launches: [context] })
    await session.ensure()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const closing = session.close()
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS)
    vi.useRealTimers()
    await closing
    expect(LOG.warn).toHaveBeenCalledWith(
      'headless-browser: closing the context failed (%s); killing chromium %s',
      `timed out after ${String(SHUTDOWN_TIMEOUT_MS)}ms`,
      '4242',
    )
    expect(kills).toEqual([4242])
  })

  it('registers its exit cleanup on the process while a browser runs, and removes it on close', async () => {
    const { session } = harness({ realProcess: true })
    const before = process.listenerCount('exit')
    await session.ensure()
    expect(process.listenerCount('exit')).toBe(before + 1)
    await session.close()
    expect(process.listenerCount('exit')).toBe(before)
  })

  it('kills its browser from the exit cleanup with a real signal, and signals nothing once it closed', async () => {
    const browser = await idleChild()
    const state = harness({
      realProcess: true,
      probe: dir => ({
        listProcesses: async (): Promise<readonly ProfileProcess[]> => [{ pid: browser.pid, ppid: process.pid, command: `/opt/chromium/chrome --user-data-dir=${dir}` }],
      }),
    })
    const hooks: (() => void)[] = []
    const once = process.once.bind(process)
    vi.spyOn(process, 'once').mockImplementation((event, listener) => {
      if (event === 'exit') hooks.push(() => { listener() })
      return once(event, listener)
    })
    await state.session.ensure()
    expect(state.session.browserPid()).toBe(browser.pid)
    const [hook] = hooks
    hook?.()
    expect(await browser.exited).toBe('SIGKILL')
    await state.session.close()
    const kill = vi.spyOn(process, 'kill')
    hook?.()
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('recovery', () => {
  it('relaunches once when the first launch finds the profile held by another browser', async () => {
    const { session, contexts, kills } = harness({ launches: ['browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory'] })
    const page = await session.keepalivePage()
    expect(page.url()).toBe('about:blank')
    expect(contexts).toHaveLength(1)
    expect(kills).toEqual([])
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: recovering the browser after %s; profile %s', expect.stringContaining('ProcessSingleton'), expect.any(String))
    await page.close()
    await session.close()
  })

  it('relaunches past a context that will not close, and tells every relaunch listener even when one throws', async () => {
    const first = new FakeContext([TARGET_FAILURE])
    first.closeBehavior = 'fails'
    const { session, contexts, kills } = harness({ launches: [first] })
    const calls: string[] = []
    session.onRelaunch(() => { throw new Error('the keepalive store is gone') })
    session.onRelaunch(() => { calls.push('re-armed') })
    const stop = session.onRelaunch(() => { calls.push('unsubscribed') })
    stop()
    const page = await session.keepalivePage()
    expect(page.isClosed()).toBe(false)
    expect(contexts).toHaveLength(2)
    expect(kills).toEqual([4242])
    expect(calls).toEqual(['re-armed'])
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: a relaunch listener failed: %s', 'the keepalive store is gone')
    expect(LOG.info).toHaveBeenCalledWith('headless-browser: the browser is back as session %s', expect.any(String))
    await session.close()
  })

  it('reports a failure after the relaunch as itself when it does not say the context is gone', async () => {
    const { session, contexts } = harness({ launches: [new FakeContext([TARGET_FAILURE]), new FakeContext(['browserContext.newPage: quota exceeded'])] })
    const failure = await session.keepalivePage().catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(BrowserUnavailableError)
    expect(String(failure)).toContain('quota exceeded')
    expect(contexts).toHaveLength(2)
    await session.close()
  })

  it('waits for the old browser to let go of the profile before it relaunches', async () => {
    const { session, contexts } = harness({ launches: [new FakeContext([TARGET_FAILURE])], realSleep: true })
    await session.ensure()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = session.keepalivePage()
    await vi.advanceTimersByTimeAsync(RELAUNCH_SETTLE_MS - 1)
    expect(contexts[0]?.closed).toBe(true)
    expect(LOG.info).not.toHaveBeenCalledWith('headless-browser: the browser is back as session %s', expect.anything())
    await vi.advanceTimersByTimeAsync(1)
    vi.useRealTimers()
    const page = await pending
    expect(page.isClosed()).toBe(false)
    expect(contexts).toHaveLength(2)
    await session.close()
  })
})

describe('take-over input and tab commands', () => {
  it('forwards key and text input to the tab\'s CDP session and opens a tab the page asks for', async () => {
    const { session, contexts } = await withTab()
    await session.dispatch({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0, text: 'a' },
    })
    await session.dispatch({ method: 'Input.insertText', params: { text: '你好' } })
    expect(contexts[0]?.sent.map(([method]) => method)).toEqual(['Input.dispatchKeyEvent', 'Input.insertText'])
    await session.applyTabCommand({ type: 'tab', action: 'new', url: 'https://example.com/b' })
    expect(session.tabsState().map(tab => [tab.url, tab.active])).toEqual([['about:blank', false], ['https://example.com/b', true]])
    await session.close()
  })

  it('scrolls around the centre of the configured viewport when the page reports none', async () => {
    const { session } = await withTab()
    expect(await session.scroll({})).toMatchObject({ x: 640, y: 400, scrollY: 0, pageHeight: 800 })
    await session.close()
  })

  it('refuses to close a tab before any tab is open, without starting the browser', async () => {
    const { session, contexts } = harness()
    await expect(session.closeTab()).rejects.toBeInstanceOf(NoOpenTabError)
    expect(contexts).toEqual([])
  })

  it('reports a URL that said it was a download but delivered none as the navigation failure', async () => {
    const { session, page } = await withTab({}, 'https://files.example.com/')
    page.gotoFailure = 'page.goto: Download is starting'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const failure = session.open('https://files.example.com/report.pdf').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(DOWNLOAD_START_WAIT_MS)
    vi.useRealTimers()
    const error = await failure
    expect(error).toBeInstanceOf(TabNavigationError)
    expect(String(error)).toContain('Download is starting')
    await session.close()
  })
})

describe('acting at a point', () => {
  it('types at a point into the element a hit test reaches through open shadow roots', async () => {
    document.body.innerHTML = '<div id="host"></div>'
    const host = element('#host')
    const outer = host.attachShadow({ mode: 'open' })
    outer.innerHTML = '<div id="inner" aria-label="Email"></div>'
    const inner = outer.querySelector('#inner')
    if (inner === null) throw new Error('the shadow root has no #inner')
    const innerRoot = inner.attachShadow({ mode: 'open' })
    stub(document, 'elementFromPoint', () => host)
    stub(outer, 'elementFromPoint', () => inner)
    // The point lands on the inner host itself, so the walk stops there.
    stub(innerRoot, 'elementFromPoint', () => inner)
    const { session, page } = await withTab()
    const outcome = await session.fill({ point: { x: 12, y: 34 } }, 'ada@example.com', 't1')
    expect(outcome.point).toMatchObject({ x: 12, y: 34, name: 'Email' })
    expect(page.mouseClicks).toEqual([[12, 34]])
    expect(page.inserted).toEqual(['ada@example.com'])
    expect(await session.fieldUrl({ point: { x: 12, y: 34 } })).toBe('about:blank')
    await session.close()
  })
})

describe('guarded targets', () => {
  it('refuses a guarded action that names no target', async () => {
    const { session } = await withTab()
    await expect(session.click({})).rejects.toThrow('a guarded action needs a selector, an accessibility id, or a point')
    await session.close()
  })

  it('refuses an accessibility id the page no longer has, for a type, a saved credential, and an upload trigger', async () => {
    const { session } = await withTab()
    session.setAxResolver({ resolve: async () => undefined })
    await expect(session.fill({ axId: 'ax7' }, 'x')).rejects.toBeInstanceOf(ActionRefusedError)
    await expect(session.fillSecret({ axId: 'ax7' }, 'x', 'username', 'example.com')).rejects.toBeInstanceOf(ActionRefusedError)
    await expect(session.attachFiles({ trigger: { axId: 'ax7' } }, ['/tmp/a.pdf'])).rejects.toBeInstanceOf(ActionRefusedError)
    await session.close()
  })

  it('fails loudly instead of acting on an element the guard named but the page does not have', async () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    const { session, page } = await withTab({ guard: new FixedIndexGuard(3) })
    session.setAxResolver({ resolve: async () => undefined })
    await expect(session.click({ axId: 'ax7' })).rejects.toThrow('accessibility id ax7 resolved to no element')
    await expect(session.click({ selector: '#go' })).rejects.toThrow('#go has no candidate 3')
    expect(page.clicked).toEqual([])
    await session.close()
  })

  it('clicks a same-name overlay without a role, naming it by its tag', async () => {
    document.body.innerHTML = '<button id="go" aria-label="Continue"></button><div id="overlay" aria-label="Continue"></div>'
    const { session, page } = await withTab()
    page.facts.set(element('#go'), { occlusion: 0 })
    page.covers.set(element('#go'), element('#overlay'))
    const outcome = await session.click({ selector: '#go' })
    expect(outcome.target).toMatchObject({ index: 1, name: 'Continue' })
    expect(page.clicked).toEqual([element('#overlay')])
    expect(LOG.info).toHaveBeenCalledWith('headless-browser: %s match %d is covered by a %s named %s; scoring the cover too', '#go', 0, 'div', '"Continue"')
    await session.close()
  })

  it('clicks the box that stands in for a checkbox the page hides, and leaves a visible input alone', async () => {
    document.body.innerHTML = '<div id="row" aria-label="Follow Cassidy"><input type="checkbox" id="follow" aria-label="Follow Cassidy"></div>'
      + '<input type="checkbox" id="plain" aria-label="Remember me">'
    const { session, page } = await withTab()
    page.facts.set(element('#follow'), { width: 0, height: 0, opacity: 0, pointerEvents: 'none' })
    page.standIns.set(element('#follow'), element('#row'))
    page.standIns.set(element('#plain'), element('#row'))
    const outcome = await session.click({ selector: '#follow' })
    expect(outcome.target).toMatchObject({ index: 1, name: 'Follow Cassidy' })
    expect(page.clicked).toEqual([element('#row')])
    expect(LOG.info).toHaveBeenCalledWith('headless-browser: %s match %d is a hidden %s; scoring the %s named %s that stands in for it',
      '#follow', 0, 'toggle', 'div', '"Follow Cassidy"')
    await session.click({ selector: '#plain' })
    expect(page.clicked).toEqual([element('#row'), element('#plain')])
    await session.close()
  })

  it('clicks the paragraph that holds painted aria-hidden text, and leaves an unpainted one refused', async () => {
    document.body.innerHTML = '<p id="title"><span id="hidden" aria-hidden="true">Software Engineer</span></p>'
      + '<p id="blank"><span id="ghost" aria-hidden="true">Software Engineer</span></p>'
    const { session, page } = await withTab()
    page.facts.set(element('#hidden'), { ariaHidden: true, occlusion: 0.6 })
    page.facts.set(element('#ghost'), { ariaHidden: true, opacity: 0 })
    page.holders.set(element('#hidden'), element('#title'))
    page.holders.set(element('#ghost'), element('#blank'))
    const outcome = await session.click({ selector: '#hidden' })
    expect(outcome.target).toMatchObject({ index: 1, name: 'Software Engineer' })
    expect(page.clicked).toEqual([element('#title')])
    expect(LOG.info).toHaveBeenCalledWith('headless-browser: %s match %d is aria-hidden text; scoring the %s named %s that holds it',
      '#hidden', 0, 'p', '"Software Engineer"')
    await expect(session.click({ selector: '#ghost' })).rejects.toThrow(/under the 0.2 threshold/)
    expect(page.clicked).toEqual([element('#title')])
    await session.close()
  })
})

describe('a page that closes itself on a click', () => {
  /** The message Playwright rejects a call with once its page has closed. */
  const CLOSED = 'locator.click: Target page, context or browser has been closed'

  /** A session with the opener tab `t1` and a second tab `t2`, and `t2`'s page. */
  async function withPopup(): Promise<Harness & { popup: FakePage }> {
    const state = await withTab()
    await state.session.applyTabCommand({ type: 'tab', action: 'new', url: 'https://accounts.example/signin' })
    const popup = state.contexts[0]?.created[1]
    if (popup === undefined) throw new Error('the session opened no second tab')
    return Object.assign(state, { popup })
  }

  it('takes the click as done when its page closes in answer, and relaunches nothing', async () => {
    document.body.innerHTML = '<button id="account">cv@example.com</button>'
    const { session, contexts, popup } = await withPopup()
    popup.clickFailure = { message: CLOSED, closes: 'page' }
    const outcome = await session.click({ selector: '#account' }, 't2')
    expect(outcome).toMatchObject({ url: 'https://accounts.example/signin', target: { name: 'cv@example.com' } })
    expect(popup.clicked).toEqual([element('#account')])
    expect(contexts).toHaveLength(1)
    expect(LOG.info).toHaveBeenCalledWith('headless-browser: the page closed itself on the click (%s)', CLOSED)
    await session.close()
  })

  it('still relaunches when the whole browser went down with the page', async () => {
    document.body.innerHTML = '<button id="account">cv@example.com</button>'
    const { session, contexts, page } = await withTab()
    page.clickFailure = { message: CLOSED, closes: 'browser' }
    await session.click({ selector: '#account' })
    expect(contexts).toHaveLength(2)
    expect(contexts[1]?.first().clicked).toEqual([element('#account')])
    await session.close()
  })

  it('reports a click that failed on a page that is still open', async () => {
    document.body.innerHTML = '<button id="account">cv@example.com</button>'
    const { session, contexts, popup } = await withPopup()
    popup.clickFailure = { message: 'locator.click: Timeout 30000ms exceeded' }
    await expect(session.click({ selector: '#account' }, 't2')).rejects.toThrow(/Timeout 30000ms/u)
    expect(contexts).toHaveLength(1)
    await session.close()
  })

  it('reports a failure that is not a lost target even when the page closed', async () => {
    document.body.innerHTML = '<button id="account">cv@example.com</button>'
    const { session, contexts, popup } = await withPopup()
    popup.clickFailure = { message: 'locator.click: Element is not attached to the DOM', closes: 'page' }
    await expect(session.click({ selector: '#account' }, 't2')).rejects.toThrow(/not attached/u)
    expect(contexts).toHaveLength(1)
    await session.close()
  })
})

describe('pressing Enter after a type', () => {
  it('presses Enter in the field only when the type asks for it, for a selector and for a point', async () => {
    // A Workday prompt: the search box lists schools only after Enter.
    document.body.innerHTML = '<input id="school" aria-label="School or University" placeholder="Search">'
    const { session, page } = await withTab()
    await session.fill({ selector: '#school' }, 'New York University', 't1')
    expect(page.pressed).toEqual([])
    await session.fill({ selector: '#school' }, 'New York University', 't1', { enter: true })
    expect(page.filled.get(element('#school'))).toBe('New York University')
    expect(page.pressed).toEqual(['school:Enter'])
    stub(document, 'elementFromPoint', () => element('#school'))
    await session.fill({ point: { x: 12, y: 34 } }, 'Computer Science', 't1', { enter: true })
    expect(page.inserted).toEqual(['Computer Science'])
    expect(page.pressed).toEqual(['school:Enter', 'keyboard:Enter'])
    await session.close()
  })

  it('presses nothing when the guard refuses the field', async () => {
    document.body.innerHTML = '<input id="school" aria-label="School or University">'
    const { session, page } = await withTab()
    page.facts.set(element('#school'), { occlusion: 0 })
    await expect(session.fill({ selector: '#school' }, 'New York University', 't1', { enter: true })).rejects.toBeInstanceOf(ActionRefusedError)
    expect(page.pressed).toEqual([])
    expect(page.filled.has(element('#school'))).toBe(false)
    await session.close()
  })
})

describe('typing into a spin-button segment', () => {
  it('focuses a role=spinbutton field and sends keystrokes instead of writing its value', async () => {
    // Workday's date segments take digits from keydown; a written value leaves the display at "YYYY".
    document.body.innerHTML = '<input id="year" role="spinbutton" aria-label="Year" aria-valuetext="YYYY">'
    const { session, page } = await withTab()
    await session.fill({ selector: '#year' }, '2023', 't1')
    expect(page.focused).toEqual([element('#year')])
    expect(page.pressed).toEqual(['keyboard:ControlOrMeta+A', 'keyboard:Backspace'])
    expect(page.typed).toEqual(['2023'])
    expect(page.filled.has(element('#year'))).toBe(false)
    await session.close()
  })
})

describe('saved credentials', () => {
  it('writes a saved password only into a password input, and nothing on a page without a host', async () => {
    document.body.innerHTML = '<input id="user" aria-label="Username"><input id="pass" type="password" aria-label="Password">'
    const { session, page } = await withTab({}, 'https://accounts.example.com/login')
    const refused = await session.fillSecret({ selector: '#user' }, 'hunter2', 'password', 'accounts.example.com').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(SecretFieldError)
    expect(String(refused)).toContain('#user is not a password input')
    expect(await session.fillSecret({ selector: '#pass' }, 'hunter2', 'password', 'accounts.example.com')).toMatchObject({ url: 'https://accounts.example.com/login' })
    expect(page.filled.get(element('#pass'))).toBe('hunter2')
    expect(page.filled.has(element('#user'))).toBe(false)
    page.address = 'not a url'
    await expect(session.fillSecret({ selector: '#user' }, 'ada', 'username', 'accounts.example.com'))
      .rejects.toThrow('the field is on , not accounts.example.com')
    expect(page.filled.has(element('#user'))).toBe(false)
    await session.close()
  })
})

describe('attaching files', () => {
  it('refuses an attach that names neither a file input nor a trigger', async () => {
    const { session } = await withTab()
    await expect(session.attachFiles({}, ['/tmp/a.pdf'])).rejects.toThrow('give a file input selector or a trigger')
    await session.close()
  })

  it('says how many elements a selector matched when none of them is a file input', async () => {
    document.body.innerHTML = '<div class="upload">Upload</div>'
    const { session } = await withTab()
    await expect(session.attachFiles({ selector: '.upload' }, ['/tmp/a.pdf'])).rejects.toThrow(/\.upload matches no input\[type=file\] \(1 element\(s\) matched\)/u)
    await expect(session.attachFiles({ selector: '#none' }, ['/tmp/a.pdf'])).rejects.toThrow(/#none matches no input\[type=file\] \(0 element\(s\) matched\)/u)
    await session.close()
  })

  it('refuses an index past the file inputs and several files for a single input, and attaches several to a multiple input', async () => {
    document.body.innerHTML = '<input type="file" id="one"><input type="file" id="many" multiple>'
    const { session, page } = await withTab()
    const files = ['/tmp/a.pdf', '/tmp/b.pdf']
    await expect(session.attachFiles({ selector: 'input[type=file]', index: 5 }, files)).rejects.toThrow('input[type=file] matches 2 file input(s); index 5 is out of range')
    await expect(session.attachFiles({ selector: 'input[type=file]' }, files)).rejects.toThrow('input[type=file] takes one file; attach the files one call each')
    expect(await session.attachFiles({ selector: 'input[type=file]', index: 1 }, files)).toMatchObject({ ref: 'input[type=file]', inputs: 2 })
    expect(page.attached.get(element('#many'))).toEqual(files)
    expect(page.attached.has(element('#one'))).toBe(false)
    await session.close()
  })

  it('refuses several files for a chooser that takes one, and hands them to one that takes several', async () => {
    document.body.innerHTML = '<button id="pick">Choose a file</button>'
    const { session, page } = await withTab()
    const files = ['/tmp/a.pdf', '/tmp/b.pdf']
    page.chooser = { multiple: false }
    await expect(session.attachFiles({ trigger: { selector: '#pick' } }, files)).rejects.toThrow('#pick opens a chooser that takes one file; attach the files one call each')
    const several: FakeChooser = { multiple: true }
    page.chooser = several
    expect(await session.attachFiles({ trigger: { selector: '#pick' } }, files)).toMatchObject({ ref: '#pick', target: { name: 'Choose a file' } })
    expect(several.files).toEqual(files)
    await session.close()
  })
})

describe('keepalive pages', () => {
  it('keeps the agent\'s tab where it was even when bringing it back fails, and reads the page text', async () => {
    const { session, page } = await withTab({}, 'https://mail.example.com/')
    page.failFront = true
    const before = session.tabsState()
    const kept = await session.keepalivePage()
    expect(session.tabsState()).toEqual(before)
    stub(document.body, 'innerText', 'Inbox (3)')
    expect(await kept.text()).toBe('Inbox (3)')
    removeBody()
    expect(await kept.text()).toBe('')
    await kept.close()
    await session.close()
  })
})

describe('reading embedded pages', () => {
  const box = { width: 400, height: 300 }

  it('finds a selector in the first embedded page that has it, past frames it cannot measure or read', async () => {
    document.body.innerHTML = '<p>Outer page</p>'
    const { session, page } = await withTab({}, 'https://jobs.example.com/apply')
    page.frames.push(
      { url: 'about:blank', box, body: '<p id="q">blank</p>' },
      { url: 'https://a.example/hidden', box: null, body: '<p id="q">hidden</p>' },
      { url: 'https://b.example/gone', box: 'detached', body: '<p id="q">gone</p>' },
      { url: 'https://c.example/detaching', box, body: '<p id="q">detaching</p>', faults: { countFails: true } },
      { url: 'https://d.example/form', box, body: '<label id="q">Why this role?</label>' },
      { url: 'https://e.example/no-body', box },
      { url: 'https://f.example/blank', box, body: '   ' },
    )
    expect((await session.read({ selector: '#q' })).text).toBe('Why this role?')
    await expect(session.read({ selector: '#nowhere' })).rejects.toBeInstanceOf(SelectorMissError)
    const whole = await session.read({})
    expect(whole.text).toBe('Outer page\n\n[frame https://d.example/form]\nWhy this role?')
    expect(whole.frames?.map(frame => frame.url)).toEqual(['https://c.example/detaching', 'https://d.example/form', 'https://e.example/no-body', 'https://f.example/blank'])
    expect(await session.fieldUrl({ selector: '#q' })).toBe('https://d.example/form')
    await session.close()
  })

  it('reads nothing from a page without a body', async () => {
    const { session } = await withTab()
    removeBody()
    expect((await session.read({})).text).toBe('')
    await session.close()
  })
})

describe('one failed launch with two callers waiting', () => {
  it('fails both callers, and the next call launches again', async () => {
    const { session, contexts } = harness({ launches: ['browserType.launchPersistentContext: spawn ENOENT'] })
    const [first, second] = await Promise.allSettled([session.ensure(), session.ensure()])
    expect([first?.status, second?.status]).toEqual(['rejected', 'rejected'])
    await session.ensure()
    expect(contexts).toHaveLength(1)
    await session.close()
  })
})

describe('a trigger that names the file input itself', () => {
  it('takes the files the way a selector-named input does, refusing an index past the inputs and several files for one input', async () => {
    document.body.innerHTML = '<input type="file" id="one"><input type="file" id="many" multiple>'
    const { session, page } = await withTab()
    const files = ['/tmp/a.pdf', '/tmp/b.pdf']
    const trigger = { selector: 'input[type=file]' }
    await expect(session.attachFiles({ trigger, index: 5 }, files)).rejects.toThrow('input[type=file] matches 2 file input(s); index 5 is out of range')
    await expect(session.attachFiles({ trigger }, files)).rejects.toThrow('input[type=file] takes one file; attach the files one call each')
    expect(await session.attachFiles({ trigger, index: 1 }, files)).toEqual({ url: 'about:blank', ref: 'input[type=file]', inputs: 2 })
    expect(page.attached.get(element('#many'))).toEqual(files)
    await session.close()
  })
})

describe('a selector that matches late', () => {
  it('reads and acts on an element that attaches within the settle wait', async () => {
    document.body.innerHTML = '<p>Loading</p>'
    const { session, page } = await withTab()
    page.lateMarkup = '<p id="late">Continue to step 2</p>'
    expect((await session.read({ selector: '#late' })).text).toBe('Continue to step 2')
    document.body.innerHTML = '<p>Loading</p>'
    page.lateMarkup = '<button id="next">Next</button>'
    await session.click({ selector: '#next' })
    expect(page.clicked).toEqual([element('#next')])
    expect(LOG.info).toHaveBeenCalledWith('headless-browser: %s appeared on %s within the settle wait', '#next', expect.any(String) as string)
    await session.close()
  })

  it('reports a miss for an element that attached within the wait and was gone before the action', async () => {
    document.body.innerHTML = '<p>Loading</p>'
    const { session, page } = await withTab()
    page.lateMarkup = '<button id="next">Next</button>'
    page.lateDetaches = true
    await expect(session.click({ selector: '#next' })).rejects.toBeInstanceOf(SelectorMissError)
    expect(page.clicked).toEqual([])
    await session.close()
  })

  it('keeps the plain advice when looking for what a miss meant fails', async () => {
    document.body.innerHTML = '<p>Loading</p>'
    const { session } = await withTab()
    stub(document.body, 'querySelectorAll', () => { throw new Error('the page navigated') })
    await expect(session.click({ selector: 'button[aria-label="Apply"]' })).rejects.toThrow(DEFAULT_MISS_ADVICE)
    expect(LOG.debug).toHaveBeenCalledWith('headless-browser: looking for what %s meant failed: %s', 'button[aria-label="Apply"]', 'the page navigated')
    await session.close()
  })
})

describe('resuming a tab', () => {
  /** A main-frame request the page reports, as Playwright's `request` event carries it. */
  function navigation(page: FakePage, method: string, frame: () => Frame = () => page.page.mainFrame()) {
    return { isNavigationRequest: () => true, frame, method: () => method }
  }

  it('reloads a Chromium error page only after a GET navigation of the main frame', async () => {
    const { session, page } = await withTab({}, 'https://jobs.example.com/apply')
    page.fire('request', { isNavigationRequest: () => false, method: () => 'GET' })
    page.fire('request', navigation(page, 'GET', () => { throw new Error('the request has no frame yet') }))
    page.address = 'chrome-error://chromewebdata/'
    expect(await session.resumeTab({ tab: 't1' })).toMatchObject({ tab: 't1', hasForm: false })
    expect(page.reloads).toBe(0)
    page.fire('request', navigation(page, 'GET'))
    page.address = 'https://jobs.example.com/apply'
    page.documentURI = 'chrome-error://chromewebdata/'
    expect(await session.resumeTab({ tab: 't1' })).toMatchObject({ hasForm: false })
    expect(page.reloads).toBe(1)
    await session.close()
  })

  it('counts a frame that detached while it was read as holding no form, and reports a frame that failed while attached', async () => {
    document.body.innerHTML = '<input id="email">'
    const { session, page } = await withTab({}, 'https://jobs.example.com/apply')
    page.countFailure = 'detached'
    expect(await session.resumeTab({ tab: 't1' })).toMatchObject({ hasForm: false })
    page.countFailure = 'attached'
    await expect(session.resumeTab({ tab: 't1' })).rejects.toThrow('frame.locator: Frame was detached')
    page.countFailure = undefined
    expect(await session.resumeTab({ tab: 't1' })).toMatchObject({ hasForm: true })
    await session.close()
  })
})

/** Run one call as a job-apply Session, under the guard the job-apply scope gives it unless another is named. */
async function asJob<T>(session: HeadlessBrowserSession, run: () => Promise<T>, worker = 'w', guard = new ActionGuard({ sensitivePolicy: 'job-apply' })): Promise<T> {
  return await session.runJob(worker, guard, run)
}

/** A session with one job-apply tab open on a careers page, and that tab's fake page. */
async function withJobTab(url = 'https://jobs.example.com/apply', options: HarnessOptions = {}) {
  const state = harness(options)
  const opened = await asJob(state.session, async () => await state.session.open(url, true))
  const [context] = state.contexts
  const page = context?.created.at(-1)
  if (context === undefined || page === undefined) throw new Error('the session opened no job tab')
  return Object.assign(state, { context, page, tab: opened.tab })
}

describe('job-apply calls over the fake page', () => {
  it('names no current host or links before the browser has a tab', async () => {
    const { session } = harness()
    expect(await session.currentJobHost('w')).toBeNull()
    expect(await session.currentJobLinkHosts('w')).toEqual([])
    expect(await session.currentJobFrameHosts('w')).toEqual([])
    await session.close()
  })

  it('names the http(s) hosts the current job page embeds, once each, for an ATS form inside an employer page', async () => {
    const { session, page } = await withJobTab('https://www.esri.com/careers/5070853007')
    page.frames.push(
      { url: 'https://job-boards.greenhouse.io/embed/job_app?for=esri', box: { width: 600, height: 900 }, body: '<input id="code">' },
      { url: 'about:blank', box: { width: 1, height: 1 }, body: '' },
      { url: 'https://Job-Boards.Greenhouse.io./embed/other', box: { width: 600, height: 900 }, body: '' },
    )
    expect(await session.currentJobFrameHosts('w')).toEqual(['job-boards.greenhouse.io'])
    expect(await session.currentJobFrameHosts('other')).toEqual([])
    await session.close()
  })

  it('reads the employer hosts a page links to, and none from a page whose read fails', async () => {
    document.body.innerHTML = '<a href="https://www.employer.example/about">About</a><a href="mailto:jobs@employer.example">Mail</a>'
    const { session, page } = await withJobTab()
    expect(await session.currentJobHost('w')).toBe('jobs.example.com')
    expect(await session.currentJobLinkHosts('w')).toEqual(['www.employer.example'])
    stub(page.page, 'evaluate', async () => { throw new Error('Execution context was destroyed') })
    expect(await session.currentJobLinkHosts('w')).toEqual([])
    await session.close()
  })

  it('reads no links from a page that does not answer in time', async () => {
    const { session, page } = await withJobTab()
    stub(page.page, 'evaluate', async () => await new Promise<never>(() => {}))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const reading = session.currentJobLinkHosts('w')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await reading).toEqual([])
    vi.useRealTimers()
    await session.close()
  })

  it('stops reading links once the request is cancelled, and names no host for a tab on a denied page', async () => {
    const { session, context } = await withJobTab()
    await asJob(session, async () => await session.open('https://jobs.example.com/posting', true))
    const controller = new AbortController()
    let reads = 0
    const read = async (): Promise<string[]> => { reads += 1; controller.abort(); return ['https://www.employer.example/'] }
    for (const fake of context.created) stub(fake.page, 'evaluate', read)
    expect(await session.currentJobLinkHosts('w', controller.signal)).toEqual(['www.employer.example'])
    expect(reads).toBe(1)
    for (const fake of context.created) fake.address = 'https://mail.google.com/mail/u/0'
    expect(await session.currentJobHost('w')).toBeNull()
    await session.close()
  })

  it('logs a refused subresource once per host, and closes the tab for a refused main-frame load', async () => {
    const { session, context, tab } = await withJobTab()
    const paused = context.paused.at(-1)
    const request = (requestId: string, url: string, resourceType = 'XHR') => ({ requestId, request: { url }, resourceType, frameId: 'main' })
    paused?.(request('r1', 'https://api.github.com/user'))
    paused?.(request('r2', 'https://api.github.com/repos'))
    await vi.waitFor(() => { expect(context.sent.filter(([method]) => method === 'Fetch.failRequest')).toHaveLength(2) })
    expect(LOG.warn.mock.calls.filter(([, message]) => message === 'navigation_refused: api.github.com')).toHaveLength(1)
    paused?.(request('r3', 'https://mail.google.com/mail', 'Document'))
    await vi.waitFor(() => { expect(session.tabsState().map(entry => entry.id)).not.toContain(tab) })
    expect(LOG.warn.mock.calls.filter(([, message]) => message === 'navigation_refused: mail.google.com')).toHaveLength(1)
    await session.close()
  })

  it('needs a tab id, a tab this Session may use, and a guarded page for every call', async () => {
    const { session, tab } = await withJobTab()
    await expect(asJob(session, async () => await session.read({}))).rejects.toThrow('the tab is not owned by this job-apply Session; name one of its tabs')
    const plain = await session.open('https://jobs.example.com/other', true)
    session.tabs().setOwner(plain.tab, 'job-apply:w')
    await expect(asJob(session, async () => await session.read({}, plain.tab))).rejects.toThrow('no protected job-apply tab is open')
    expect((await asJob(session, async () => await session.read({}, tab))).text).toBe('')
    await session.close()
  })

  it('resumes by URL only a tab this Session may use, and only when one matches', async () => {
    const { session, tab } = await withJobTab()
    await asJob(session, async () => await session.open('https://jobs.example.com/apply/2', true))
    await expect(asJob(session, async () => await session.resumeTab({ urlSubstring: '/nowhere' }))).rejects.toThrow('no tab this job-apply Session may use matches that URL')
    await expect(asJob(session, async () => await session.resumeTab({ urlSubstring: '/apply' }))).rejects.toThrow('more than one tab matches that URL')
    expect(await asJob(session, async () => await session.resumeTab({ urlSubstring: 'apply/2' }))).toMatchObject({ url: 'https://jobs.example.com/apply/2' })
    expect(await asJob(session, async () => await session.closeTab(tab))).toMatchObject({ closed: tab })
    await session.close()
  })

  it('lists only the tabs this Session may use after it closes one', async () => {
    const { session, tab } = await withJobTab()
    await session.open('https://owner.example.com/inbox', true)
    const kept = await asJob(session, async () => await session.open('https://jobs.example.com/apply/2', true))
    const closed = await asJob(session, async () => await session.closeTab(tab))
    expect(closed.tabs.map(entry => entry.id)).toEqual([kept.tab])
    await session.close()
  })

  it('reports a full strip, a failed first load, and any other failure to open without naming the page', async () => {
    const { session, context } = await withJobTab()
    context.nextGotoFailure = 'net::ERR_CONNECTION_REFUSED at https://jobs.example.com/down'
    await expect(asJob(session, async () => await session.open('https://jobs.example.com/down', true))).rejects.toBeInstanceOf(TabNavigationError)
    context.newPageFailures.push('newPage: renderer out of memory')
    await expect(asJob(session, async () => await session.open('https://jobs.example.com/again', true))).rejects.toThrow(/^job-apply navigation failed$/u)
    while (session.tabsState().length < 8) await session.open(`https://owner.example.com/${String(session.tabsState().length)}`, true)
    await expect(asJob(session, async () => await session.open('https://jobs.example.com/full', true))).rejects.toThrow(/at most 8 tabs/u)
    await session.close()
  })

  it('refuses a snapshot when the tab moves while it is captured', async () => {
    const { session, page, tab } = await withJobTab()
    const shot = await asJob(session, async () => await session.snapshot(tab))
    expect(session.jobSnapshot('w', shot.path)).toEqual(Buffer.from('png'))
    page.onScreenshot = () => { page.address = 'https://jobs.example.com/next' }
    await expect(asJob(session, async () => await session.snapshot(tab))).rejects.toThrow('The tab moved during screenshot capture.')
    await session.close()
  })

  it('writes a saved password only through a pinned handle still on its host and still a password input', async () => {
    document.body.innerHTML = '<input id="pass" type="password" aria-label="Password">'
    const { session, page, tab } = await withJobTab()
    const write = async (request: { selector: string } | { axId: string }) =>
      await asJob(session, async () => await session.fillSecret(request, 'hunter2', 'password', 'jobs.example.com', tab))
    expect(await write({ selector: '#pass' })).toMatchObject({ url: 'https://jobs.example.com/apply' })
    expect(page.filled.get(element('#pass'))).toBe('hunter2')
    page.ownerFrameUrl = 'https://other.example.com/login'
    await expect(write({ selector: '#pass' })).rejects.toThrow('the credential target moved away from its saved host')
    page.ownerFrameUrl = undefined
    page.onPin = (node) => { node.setAttribute('type', 'text') }
    await expect(write({ selector: '#pass' })).rejects.toThrow('the credential target is no longer a password input')
    element('#pass').setAttribute('type', 'password')
    page.onPin = undefined
    session.setAxResolver({ resolve: async () => page.elementHandle(element('#pass')) })
    page.filled.clear()
    await write({ axId: 'ax3' })
    expect(page.filled.get(element('#pass'))).toBe('hunter2')
    page.ownerFrameUrl = null
    await expect(write({ axId: 'ax3' })).rejects.toThrow('the credential target moved away from its saved host')
    await session.close()
  })

  it('checks each file input and chooser against the network policy before it takes files', async () => {
    document.body.innerHTML = '<input type="file" id="resume"><button id="pick">Upload</button><input type="file" id="behind">'
    const { session, page, tab } = await withJobTab()
    const attach = async (target: Parameters<HeadlessBrowserSession['attachFiles']>[0]) =>
      await asJob(session, async () => await session.attachFiles(target, ['/tmp/a.pdf'], tab))
    expect(await attach({ selector: '#resume' })).toMatchObject({ ref: '#resume', inputs: 1 })
    expect(await attach({ trigger: { selector: '#resume' } })).toMatchObject({ ref: '#resume', inputs: 1 })
    page.chooser = { multiple: false, input: element('#behind') }
    expect(await attach({ trigger: { selector: '#pick' } })).toMatchObject({ ref: '#pick' })
    page.ownerFrameUrl = null
    await expect(attach({ trigger: { selector: '#pick' } })).rejects.toThrow('navigation_refused: [invalid URL]')
    page.ownerFrameUrl = undefined
    document.body.innerHTML = '<p>The form is embedded</p>'
    page.frames.push({ url: 'https://ats.example.com/form', box: { width: 400, height: 300 }, body: '<input type="file" id="resume">' })
    expect(await attach({ selector: '#resume' })).toMatchObject({ ref: '#resume', inputs: 1 })
    await session.close()
  })

  it('clicks the control around what a point hits, through labels and shadow hosts, and refuses an embedded frame', async () => {
    document.body.innerHTML = '<button id="go"><span id="icon">Go</span></button>'
      + '<label for="agree"><span id="agree-text">I agree</span></label><input type="checkbox" id="agree" aria-label="Agree">'
      + '<button id="host-button" aria-label="Next"><div id="host"></div></button><div id="plain">Plain text</div><iframe id="frame"></iframe>'
    const shadow = element('#host').attachShadow({ mode: 'open' })
    shadow.innerHTML = '<span id="arrow">→</span>'
    const arrow = shadow.querySelector('#arrow')
    const { session, tab } = await withJobTab()
    const at = async (hit: Element | null): Promise<string | undefined> => {
      stub(document, 'elementFromPoint', () => hit === arrow ? element('#host') : hit)
      stub(shadow, 'elementFromPoint', () => arrow)
      const outcome = await asJob(session, async () => await session.click({ point: { x: 5, y: 5 } }, tab))
      return outcome.point?.name
    }
    expect(await at(element('#icon'))).toBe('Go')
    expect(await at(element('#agree-text'))).toBe('Agree')
    expect(await at(arrow)).toBe('Next')
    expect(await at(element('#plain'))).toBe('Plain text')
    await expect(at(element('#frame'))).rejects.toThrow('Use a selector for controls inside an embedded frame.')
    await session.close()
  })

  it('types at a point only into the editable field the click focused, through open shadow roots', async () => {
    document.body.innerHTML = '<input id="email" aria-label="Email"><textarea id="letter" aria-label="Letter"></textarea>'
      + '<input id="locked" aria-label="Locked" readonly><button id="send">Send</button><div id="host"></div>'
    const shadow = element('#host').attachShadow({ mode: 'open' })
    shadow.innerHTML = '<input id="inner" aria-label="Inner">'
    const { session, page, tab } = await withJobTab()
    const typeInto = async (field: HTMLElement) => {
      stub(document, 'elementFromPoint', () => field.getRootNode() === shadow ? element('#host') : field)
      stub(shadow, 'elementFromPoint', () => field)
      field.focus()
      return await asJob(session, async () => await session.fill({ point: { x: 5, y: 5 } }, 'text', tab))
    }
    await typeInto(element('#email') as HTMLElement)
    await typeInto(element('#letter') as HTMLElement)
    await typeInto(shadow.querySelector('#inner') as HTMLElement)
    expect(page.inserted).toEqual(['text', 'text', 'text'])
    await expect(typeInto(element('#locked') as HTMLElement)).rejects.toThrow('The viewport point did not focus an editable field.')
    await expect(typeInto(element('#send') as HTMLElement)).rejects.toThrow('The viewport point did not focus an editable field.')
    await session.close()
  })

  it('checks the link and form a click would follow against the network policy and the call’s site boundary', async () => {
    document.body.innerHTML = '<a id="inbox" href="https://mail.google.com/">Inbox</a><a id="script" href="javascript:void(0)">Questions</a>'
      + '<button id="post">Send</button><button id="local">Save</button>'
    const { session, page, tab } = await withJobTab()
    page.facts.set(element('#inbox'), { href: 'https://mail.google.com/' })
    page.facts.set(element('#script'), { href: 'javascript:void(0)' })
    page.facts.set(element('#post'), { formAction: 'https://forms.other.example/submit' })
    page.facts.set(element('#local'), { formAction: 'https://mail.google.com/submit' })
    const click = async (selector: string, guard?: ActionGuard) => await asJob(session, async () => await session.click({ selector }, tab), 'w', guard)
    await expect(click('#inbox')).rejects.toThrow('navigation_refused: mail.google.com')
    await click('#script')
    await click('#post')
    await expect(click('#local')).rejects.toThrow('navigation_refused: mail.google.com')
    const bounded = new ActionGuard()
    bounded.anchor('https://jobs.example.com/apply')
    await expect(click('#post', bounded)).rejects.toBeInstanceOf(ActionRefusedError)
    expect(page.clicked).toEqual([element('#script'), element('#post')])
    await session.close()
  })

  it('closes a popup that opens on a denied page, even when that close fails', async () => {
    const { session, context, page } = await withJobTab()
    const popup = new FakePage(context)
    popup.address = 'https://mail.google.com/mail'
    popup.closeFailure = 'Target page, context or browser has been closed'
    page.fire('popup', popup.page)
    await vi.waitFor(() => { expect(LOG.warn).toHaveBeenCalledWith('headless-browser: adopting a popup of %s failed: %s', 't1', 'navigation_refused: mail.google.com') })
    expect(session.tabsState().map(entry => entry.id)).toEqual(['t1'])
    await session.close()
  })
})
