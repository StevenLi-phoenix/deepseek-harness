/**
 * One persistent Chromium per plugin instance. The profile directory is the
 * browser's own state, so sign-ins survive a host restart; the launch is lazy
 * and single-flight, because the first tool call and the first page view race
 * each other and one Chromium must win.
 *
 * The browser keeps a tab model over that one context. Tools and the take-over
 * page act on the active tab unless they name another, and every tab shares the
 * profile, cookies, and context; only the page and its CDP session differ.
 *
 * @module @deepseek-ai/dsh-headless-browser/session
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { chromium, type BrowserContext, type CDPSession, type ElementHandle, type Frame, type Locator, type Page } from 'playwright-core'
import { probeChallenge, readChallengeFacts, type ChallengeFacts } from './challenge.ts'
import type { Config } from './config.ts'
import { cookieSnapshot, cookieSummary, type CookieResult } from './cookies.ts'
import { DOWNLOAD_START_WAIT_MS, DownloadStore, ensureDownloadPrefs, isDownloadStarting, type DownloadRecord } from './downloads.ts'
import { firstLine } from './error.ts'
import { ActionGuard, ActionRefusedError, blockedAction, pageOrigin, refusalOf, type Decision, type PointChoice, type TargetChoice } from './guard.ts'
import type { InputCommand, TabInfo, TabMessage } from './input.ts'
import { browserProcesses, killBrowserSync, recoverStaleProfile, removeBrowserOwner, writeBrowserOwner, type ProfileProbe } from './profile.ts'
import { MAX_READ_FRAMES, MIN_FRAME_AREA, readText, type FrameRef, type ReadPage, type ReadRequest, type ReadResult } from './read.ts'
import { cdpScrollChannel, scrollPage, type ScrollRequest, type ScrollResult } from './scroll.ts'
import { isComboboxInput, matchOption, readComboboxOptions, readOptions, readSelectOptions, type SelectOption } from './select.ts'
import type { KeepalivePage } from './keepalive.ts'
import { applyStealth, stealthIdentity, stealthLaunch } from './stealth.ts'
import { BrowserTabs, TabNavigationError, type ActiveTab, type ClosedTab, type PopupTab } from './tabs.ts'
import { findSameNameCover, probeElement, readElementFacts, type ElementFacts } from './visibility.ts'

/** How long a context gets to close before shutdown stops waiting for it. */
export const SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * How long a click waits for a download it may have started. A download event
 * follows the click within about a hundred milliseconds; a click that downloads
 * nothing pays this once.
 */
export const CLICK_DOWNLOAD_WAIT_MS = 250

/** How long choosing a `<select>` option waits; the option was just read, so a long wait only hides a stuck page. */
const SELECT_TIMEOUT_MS = 5_000

/** How long a searchable dropdown may take to list options after typing; an address lookup answers from the network. */
const COMBOBOX_WAIT_MS = 2_500

/** How often the dropdown's list is read while waiting for it. */
const COMBOBOX_POLL_MS = 250

/** How long a recovery waits after the old context closes, before it relaunches. */
export const RELAUNCH_SETTLE_MS = 1_500

/**
 * Failures that mean the context is gone rather than the request being wrong: a
 * browser that was killed under a live context, or a launch that came up while
 * the previous browser still owned the profile. Chromium's answer to a target
 * request in that state is `Target.createTarget: Failed to open a new tab`, and
 * Playwright's is `Target page, context or browser has been closed`.
 */
const LOST_CONTEXT = new RegExp([
  'Target\\.createTarget',
  'Failed to open a new tab',
  'Target page, context or browser has been closed',
  'browser has been closed',
  'Target closed',
  'Session closed',
  'ProcessSingleton',
  'has been disconnected',
  'Browser closed',
  'Protocol error \\(Target\\.',
].join('|'), 'iu')

/**
 * Whether one error says the browser context is gone, so a relaunch can put it back.
 * @param error - what the context or a page threw.
 * @returns whether a relaunch is worth trying.
 */
export function isLostContextError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return LOST_CONTEXT.test(text)
}

/** How the session reaches the browser and the machine; a test replaces every part. */
export interface SessionDeps {
  /** Launch a persistent context; the real Chromium by default. */
  readonly launch?: (profileDir: string, options: Record<string, unknown>) => Promise<BrowserContext>
  /** Wait between closing a lost context and relaunching; a timer by default. */
  readonly sleep?: (ms: number) => Promise<void>
  /** How the stale-profile check reads the machine. */
  readonly probe?: ProfileProbe
  /** Register the process-exit cleanup; `process.once('exit')` by default. */
  readonly onExit?: (run: () => void) => () => void
  /** Kill one browser pid; a synchronous `SIGKILL` by default. */
  readonly kill?: (pid: number) => boolean
}

/** The browser cannot run, so a tool reports the reason instead of retrying. */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserUnavailableError'
  }
}

/** No tab is open, so there is nothing to close. */
export class NoOpenTabError extends Error {
  constructor() {
    super('no tab is open; call headless_browser_open before closing one')
    this.name = 'NoOpenTabError'
  }
}

/** What the status route and a tool result can say about the browser without launching it. */
export interface BrowserStatus {
  /** Whether a Chromium context is open. */
  readonly launched: boolean
  /** Identity of the current launch; changes after a restart. */
  readonly sessionId?: string
  /** URL of the active tab while one is open. */
  readonly url?: string
  /** Number of open tabs. */
  readonly tabs?: number
}

/** A screencast target: the active tab and the CDP session that carries its frames and input. */
export interface CastTarget {
  readonly tabId: string
  readonly cdp: CDPSession
}

/** Which element a mutating tool acts on. */
export interface ActionTarget {
  /** CSS selector; every match is scored and the element a person would reach wins. */
  readonly selector?: string
  /** Accessibility id from a page read; it names exactly one element. */
  readonly axId?: string
  /** Viewport point in CSS pixels; the action lands there and the guard inspects what it hit. */
  readonly point?: { readonly x: number; readonly y: number }
}

/** One click or type request, as the model asked for it. */
export interface TargetRequest extends ActionTarget {
  /** Allow a move to another registrable domain, as the agent re-requested it after a refusal. */
  readonly allowOrigin?: boolean
}

/** What a mutating tool reports about the element it acted on. */
export interface ActionOutcome {
  /** Page URL after the action settled. */
  readonly url: string
  /** The element that was chosen, for a selector or an accessibility id. */
  readonly target?: TargetChoice
  /** The point a coordinate action hit, with the element and score it found there. */
  readonly point?: PointChoice
  /** Files the action made the browser download, already saved. */
  readonly downloads?: readonly DownloadRecord[]
  /** Windows the action opened (a "Continue with Google" sign-in), each now a tab and the active one. */
  readonly popups?: readonly PopupTab[]
  /** The option a type chose, when the field was a native `<select>`. */
  readonly selected?: string
}

/** What opening a URL settled on. */
export interface OpenResult {
  /** The tab's URL after the navigation. */
  readonly url: string
  /** The tab's document title. */
  readonly title: string
  /** Files the URL turned out to be, already saved; set instead of a page. */
  readonly downloads?: readonly DownloadRecord[]
}

/** The element handle an accessibility id resolves to. */
export type AxTargetHandle = ElementHandle<Element>

/**
 * Resolves an accessibility id from a page read to the element it names. The
 * id map belongs to the read tool that produced the ids; this package consumes
 * it and keeps no second map, so an id can never name two different elements.
 */
export interface AxTargetResolver {
  /**
   * @param page - the page the id was read from.
   * @param axId - the id the model named.
   * @returns the element, or nothing when the id is unknown or the page moved since the read.
   */
  resolve(page: Page, axId: string): Promise<AxTargetHandle | undefined>
}

/** What a locator or an element handle both offer a guarded action. */
interface Actionable {
  click(): Promise<void>
  fill(value: string): Promise<void>
  selectOption(values: { index: number }, options?: { timeout?: number }): Promise<string[]>
  evaluate<R>(probe: (node: HTMLElement | SVGElement) => R): Promise<R>
}

/** Which half of a saved account a secret fill writes. */
export type SecretField = 'password' | 'username'

/** Where `attachFiles` puts the files: a file input, or a control that opens the file chooser. */
export interface AttachTarget {
  /** CSS selector of an `input[type=file]`; hidden inputs are expected and allowed. */
  readonly selector?: string
  /** Which matching file input, in document order; 0 when omitted. */
  readonly index?: number
  /** A visible control whose click opens the file chooser, guarded like a click. */
  readonly trigger?: TargetRequest
}

/** What one attach did. */
export interface AttachOutcome {
  /** Page URL after the attach. */
  readonly url: string
  /** The selector or trigger that received the files. */
  readonly ref: string
  /** How many file inputs the selector matched, when a selector was used. */
  readonly inputs?: number
  /** The trigger the guard cleared, when one was used. */
  readonly target?: TargetChoice
}

/** A secret fill that the page refused before any character was written. */
export class SecretFieldError extends Error {
  override readonly name = 'SecretFieldError'
}

/** How long a trigger click waits for the file chooser. */
const FILE_CHOOSER_WAIT_MS = 10_000

/**
 * The bare host of a page address, lower case, for the credential host check.
 * @param url - the page URL.
 * @returns the host, or an empty string for an address without one.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** The elements one target request resolved to, before the guard chose among them. */
interface Resolution {
  /** The selector, accessibility id, or point, as the model wrote it. */
  readonly ref: string
  /** Facts for every candidate, in document order. */
  readonly facts: readonly ElementFacts[]
  /** The candidate at one index, ready to act on. */
  readonly element: (index: number) => Actionable
  /** The accessibility id that resolved to nothing, when it did. */
  readonly staleAxId?: string
  /** URL of the document the candidates are in: the page, or the embedded page that held the selector's matches. */
  readonly url: string
  /** Where follow-up lookups for the same element run, such as a dropdown's options: the page or that embedded page. */
  readonly scope: Page | Frame
}

/** Launch, navigate, inspect, and close one persistent Chromium with tabs. */
export class HeadlessBrowserSession {
  readonly #config: Config
  readonly #log: Pick<Context['logger'], 'debug' | 'info' | 'warn'>
  readonly #guard: ActionGuard
  readonly #deps: SessionDeps
  #axResolver: AxTargetResolver | undefined
  #context: BrowserContext | undefined
  #launching: Promise<BrowserContext> | undefined
  #recovering: Promise<void> | undefined
  #closed = false
  #sessionId: string | undefined
  #browserPid: number | undefined
  #detachExit: (() => void) | undefined
  #tabs: BrowserTabs<Page> | undefined
  /** Stops watching for pages once the context is gone. */
  #stopStealth: (() => void) | undefined
  /** Pages a keepalive opened: never a tab, so never part of the tab cap. */
  readonly #background = new WeakSet<object>()
  readonly #cdps = new WeakMap<Page, CDPSession>()
  readonly #relaunchListeners = new Set<() => void>()
  /** Keeps what the pages download; see `downloads.ts`. */
  readonly #downloads: DownloadStore

  /**
   * @param config - profile, viewport, and snapshot settings.
   * @param log - plugin logger for launch and shutdown facts.
   * @param guard - the action guard the tools consult.
   * @param deps - the launcher, timer, and machine access; the real ones by default.
   */
  constructor(
    config: Config,
    log: Pick<Context['logger'], 'debug' | 'info' | 'warn'>,
    guard: ActionGuard = new ActionGuard(),
    deps: SessionDeps = {},
  ) {
    this.#config = config
    this.#log = log
    this.#guard = guard
    this.#deps = deps
    this.#downloads = new DownloadStore({
      dir: config.downloadDir,
      maxBytes: config.maxDownloadMB * 1024 * 1024,
      retainMs: config.downloadRetainDays * 86_400_000,
      log,
    })
  }

  /**
   * The newest files the browser downloaded, once the ones in flight finished.
   * @param limit - most records to return.
   * @param waitMs - how long to wait for a download to start when none is in flight.
   * @returns the records, oldest first.
   */
  async downloads(limit: number, waitMs: number): Promise<DownloadRecord[]> {
    return await this.#downloads.recent(limit, waitMs)
  }

  /**
   * Register the accessibility id map a read tool owns, so click and type can
   * name an element by the id the model read.
   * @param resolver - the read tool's map, or nothing to stop resolving ids.
   */
  setAxResolver(resolver: AxTargetResolver | undefined): void {
    this.#axResolver = resolver
  }

  /**
   * Observe a relaunch: the context that was there is gone and a new one runs.
   * Keepalives re-arm from this, because their timers point at pages of the old
   * context.
   * @param listener - what to run after the browser came back.
   * @returns how to stop listening.
   */
  onRelaunch(listener: () => void): () => void {
    this.#relaunchListeners.add(listener)
    return () => {
      this.#relaunchListeners.delete(listener)
    }
  }

  /**
   * Pid of the Chromium this session launched, once one is known.
   * @returns the pid, or nothing before a launch, after a close, or when the process list did not show it.
   */
  browserPid(): number | undefined {
    return this.#browserPid
  }

  /**
   * Open the persistent context, reusing a live one.
   * @returns the open Chromium context.
   */
  async ensure(): Promise<BrowserContext> {
    if (this.#closed) throw new BrowserUnavailableError('the browser plugin is shutting down')
    if (this.#context !== undefined) return this.#context
    this.#launching ??= this.#launch()
    try {
      return await this.#launching
    } catch (error: unknown) {
      // A failed launch owns no context; the next caller may try again.
      this.#launching = undefined
      throw error
    }
  }

  /**
   * The tab model over the persistent context, created on first use.
   * @returns the tab manager; its pages are the context's Playwright pages.
   */
  tabs(): BrowserTabs<Page> {
    this.#tabs ??= new BrowserTabs<Page>({
      context: async () => await this.ensure(),
      log: this.#log,
      // A keepalive's offscreen page is nobody's tab: adopting it would spend
      // one of the eight slots a person's tabs share.
      reserved: page => this.#background.has(page),
      onAdopt: page => this.#downloads.attach(page),
    })
    return this.#tabs
  }

  /**
   * The tab strip's state, without launching the browser.
   * @returns the open tabs in opening order, or an empty list before the browser starts.
   */
  tabsState(): TabInfo[] {
    return this.#tabs?.state() ?? []
  }

  /**
   * Observe tab and active-tab changes.
   * @param listener - called after every change; it reads the new state from {@link tabsState}.
   * @returns how to stop listening.
   */
  onTabsChange(listener: () => void): () => void {
    return this.tabs().onChange(listener)
  }

  /**
   * The page an operation acts on; a closed page is replaced, because a
   * crashed renderer must not strand every later operation.
   * @param id - tab id, or nothing for the active tab.
   * @returns the live page.
   */
  async page(id?: string): Promise<Page> {
    return await this.tabs().page(id)
  }

  /**
   * The CDP session of one tab's page, created once per page.
   * @param id - tab id, or nothing for the active tab.
   * @returns the session that carries both live-view frames and forwarded input.
   */
  async cdp(id?: string): Promise<CDPSession> {
    const page = await this.page(id)
    const cached = this.#cdps.get(page)
    if (cached !== undefined) return cached
    const cdp = await page.context().newCDPSession(page)
    this.#cdps.set(page, cdp)
    return cdp
  }

  /**
   * The active tab and its CDP session, which is what the screencast follows.
   * @returns the tab id and its CDP session.
   */
  async castTarget(): Promise<CastTarget> {
    const tab: ActiveTab<Page> = await this.tabs().active()
    return { tabId: tab.id, cdp: await this.cdp(tab.id) }
  }

  /**
   * Perform one input command from the take-over page on one tab.
   * @param command - the validated command; `method` selects the CDP operation.
   * @param tabId - the tab the page sent it for, or nothing for the active tab.
   */
  async dispatch(command: InputCommand, tabId?: string): Promise<void> {
    const cdp = await this.cdp(tabId)
    switch (command.method) {
      case 'Input.dispatchMouseEvent':
        await cdp.send('Input.dispatchMouseEvent', command.params)
        return
      case 'Input.dispatchKeyEvent':
        await cdp.send('Input.dispatchKeyEvent', command.params)
        return
      case 'Input.insertText':
        await cdp.send('Input.insertText', command.params)
    }
  }

  /**
   * Apply one tab command from the take-over page.
   * @param message - the validated tab message.
   */
  async applyTabCommand(message: TabMessage): Promise<void> {
    return await this.#guarded('applying a tab command', async () => {
      await this.tabs().command(message.action, message.tabId, message.url)
    })
  }

  /**
   * Open a URL in the active tab, or in a new one.
   * @param url - absolute URL; the page reports a relative one as invalid.
   * @param newTab - open a new tab instead of reusing the active one.
   * @param allowOrigin - allow the move when the destination is another registrable domain.
   * @returns the settled URL and the document title.
   * @throws ActionRefusedError - when the destination is another site and this call did not allow it.
   */
  async open(url: string, newTab = false, allowOrigin = false): Promise<OpenResult> {
    return await this.#guarded('opening the page', async () => {
      const current = await this.page()
      const decision = this.#guard.decideNavigation({ action: 'open', url: current.url(), target: url, allowOrigin })
      if (!decision.allowed) throw new ActionRefusedError(blockedAction(refusalOf(decision)))
      const mark = this.#downloads.mark()
      let opened: { url: string; title: string }
      try {
        opened = newTab
          ? await this.#openTab(url)
          : await this.#openHere(url)
      } catch (error: unknown) {
        // A URL that answers with an attachment is a file, not a page: the
        // navigation fails and the download follows. Report the file.
        if (!(error instanceof TabNavigationError) || !isDownloadStarting(error.message)) throw error
        const downloads = await this.#downloads.since(mark, DOWNLOAD_START_WAIT_MS)
        if (downloads.length === 0) throw error
        const page = await this.page()
        this.#log.info('headless-browser: %s was a download, %d file(s) kept', url.split('?')[0], downloads.length)
        return { url: page.url(), title: await page.title(), downloads }
      }
      this.#guard.anchor(opened.url)
      return opened
    })
  }

  /**
   * Navigate the active tab and report what settled.
   * @param url - absolute URL to load.
   * @returns the settled URL and the document title.
   */
  async #openHere(url: string): Promise<{ url: string; title: string }> {
    await this.tabs().navigate(url)
    const page = await this.page()
    return { url: page.url(), title: await page.title() }
  }

  /**
   * Open a URL in a new tab and report what settled.
   * @param url - absolute URL to load.
   * @returns the new tab's URL and title.
   */
  async #openTab(url: string): Promise<{ url: string; title: string }> {
    const tab = await this.tabs().create(url)
    return { url: tab.url, title: tab.title }
  }

  /**
   * Close one tab; the last tab is replaced by a blank one so the browser stays open.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the closed id, whether a blank tab replaced it, and the tabs that remain.
   * @throws NoOpenTabError - when no tab is open, so closing cannot start the browser.
   */
  async closeTab(tabId?: string): Promise<ClosedTab> {
    return await this.#guarded('closing a tab', async () => {
      if (this.tabsState().length === 0) throw new NoOpenTabError()
      return await this.tabs().close(tabId)
    })
  }

  /**
   * Scroll one tab by a vertical distance or to an edge, without evaluating page script.
   * @param request - distance or edge, and the point whose element receives the wheel.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the resulting scroll position, page height, and whether an edge was reached.
   */
  async scroll(request: ScrollRequest, tabId?: string): Promise<ScrollResult> {
    return await this.#guarded('scrolling', async () => {
      const page = await this.page(tabId)
      const cdp = await this.cdp(tabId)
      const size = page.viewportSize() ?? { width: this.#config.viewportWidth, height: this.#config.viewportHeight }
      return await scrollPage(cdpScrollChannel(cdp), request, size)
    })
  }

  /**
   * Save a PNG of one tab for the model to read.
   * @param tabId - tab id, or nothing for the active tab.
   * @param fullPage - capture the whole scrollable page instead of the viewport.
   * @returns the file path and the page it captured.
   */
  async snapshot(tabId?: string, fullPage = false): Promise<{ path: string; url: string }> {
    return await this.#guarded('taking a snapshot', async () => {
      const page = await this.page(tabId)
      await mkdir(this.#config.snapshotDir, { recursive: true })
      const path = join(this.#config.snapshotDir, `page-${new Date().toISOString().replaceAll(':', '-')}.png`)
      await page.screenshot({ path, fullPage })
      return { path, url: page.url() }
    })
  }

  /**
   * Read one tab's text, cut to a character window.
   * @param request - the selector and the character window.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the window, the whole text's length, and the header line.
   * @throws SelectorMissError - when the selector matches no element.
   */
  async read(request: ReadRequest, tabId?: string): Promise<ReadResult> {
    return await this.#guarded('reading the page', async () => {
      const tab = tabId ?? (await this.tabs().active()).id
      const page = await this.page(tab)
      return await readText(readable(page), tab, request)
    })
  }

  /**
   * Click the element a person would reach among a selector's matches, the one
   * element an accessibility id names, or a viewport point, after the action
   * guard clears it.
   * @param request - the selector, accessibility id, or point, and whether the agent allowed a site change.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the page URL after the click and the element or point it acted on.
   * @throws ActionRefusedError - when visibility, a sensitive name, or origin refuses the click.
   */
  async click(request: TargetRequest, tabId?: string): Promise<ActionOutcome> {
    return await this.#guarded('clicking', async () => {
      const page = await this.page(tabId)
      if (request.point !== undefined) {
        const hit = await this.#hitFacts(page, request.point)
        const point = this.#acceptPoint(this.#guard.decidePoint({
          action: 'click',
          url: page.url(),
          x: request.point.x,
          y: request.point.y,
          ...tabId === undefined ? {} : { tabId },
          ...hit === undefined ? {} : { hit },
          allowOrigin: request.allowOrigin === true,
        }))
        const mark = this.#downloads.mark()
        const popupMark = this.tabs().popupMark()
        await page.mouse.click(request.point.x, request.point.y)
        this.#guard.anchor(page.url())
        return { url: page.url(), point, ...await this.#openedSince(mark, popupMark) }
      }
      const resolution = await this.#resolve(page, request)
      const target = this.#accept(this.#guard.decideTarget({
        action: 'click',
        url: resolution.url,
        ref: resolution.ref,
        candidates: resolution.facts,
        allowOrigin: request.allowOrigin === true,
        ...resolution.staleAxId === undefined ? {} : { staleAxId: resolution.staleAxId },
      }))
      const mark = this.#downloads.mark()
      const popupMark = this.tabs().popupMark()
      await resolution.element(target.index).click()
      this.#guard.anchor(page.url())
      return { url: page.url(), target, ...await this.#openedSince(mark, popupMark) }
    })
  }

  /**
   * The files a click started and the windows it opened, waited for together.
   * @param mark - the download marker taken before the click.
   * @param popupMark - the popup marker taken before the click.
   * @returns `downloads` and `popups` fields, each only when there is one.
   */
  async #openedSince(mark: number, popupMark: number): Promise<Pick<ActionOutcome, 'downloads' | 'popups'>> {
    const [downloads, popups] = await Promise.all([
      this.#downloadsSince(mark),
      this.tabs().popupsSince(popupMark, CLICK_DOWNLOAD_WAIT_MS),
    ])
    return { ...downloads, ...popups.length === 0 ? {} : { popups } }
  }

  /**
   * The files a click started, for the click's own result.
   * @param mark - the download marker taken before the click.
   * @returns a `downloads` field, or nothing when the click downloaded no file.
   */
  async #downloadsSince(mark: number): Promise<{ downloads: readonly DownloadRecord[] } | Record<string, never>> {
    const downloads = await this.#downloads.since(mark, CLICK_DOWNLOAD_WAIT_MS)
    return downloads.length === 0 ? {} : { downloads }
  }

  /**
   * Replace the editable value of the element a person would reach among a
   * selector's matches, the one element an accessibility id names, or the field
   * a viewport point focuses, after the action guard clears it.
   * @param request - the selector, accessibility id, or point, and whether the agent allowed a site change.
   * @param text - the value to write.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the page URL after typing and the element or point it acted on.
   * @throws ActionRefusedError - when visibility, a sensitive name, or origin refuses the type.
   */
  async fill(request: TargetRequest, text: string, tabId?: string): Promise<ActionOutcome> {
    return await this.#guarded('typing', async () => {
      const page = await this.page(tabId)
      if (request.point !== undefined) {
        const hit = await this.#hitFacts(page, request.point)
        const point = this.#acceptPoint(this.#guard.decidePoint({
          action: 'type',
          url: page.url(),
          x: request.point.x,
          y: request.point.y,
          ...tabId === undefined ? {} : { tabId },
          ...hit === undefined ? {} : { hit },
          allowOrigin: request.allowOrigin === true,
        }))
        await page.mouse.click(request.point.x, request.point.y)
        await page.keyboard.insertText(text)
        this.#guard.anchor(page.url())
        return { url: page.url(), point }
      }
      const resolution = await this.#resolve(page, request)
      const target = this.#accept(this.#guard.decideTarget({
        action: 'type',
        url: resolution.url,
        ref: resolution.ref,
        candidates: resolution.facts,
        allowOrigin: request.allowOrigin === true,
        ...resolution.staleAxId === undefined ? {} : { staleAxId: resolution.staleAxId },
      }))
      const element = resolution.element(target.index)
      if (resolution.facts[target.index]?.tag === 'select') {
        const selected = await this.#choose(element, resolution.ref, text)
        this.#guard.anchor(page.url())
        return { url: page.url(), target, selected }
      }
      if (await element.evaluate(isComboboxInput)) {
        const selected = await this.#typeIntoCombobox(page, resolution, element, text, request.allowOrigin === true)
        this.#guard.anchor(page.url())
        return { url: page.url(), target, ...selected === undefined ? {} : { selected } }
      }
      await element.fill(text)
      this.#guard.anchor(page.url())
      return { url: page.url(), target }
    })
  }

  /**
   * Type into a searchable dropdown the way a person does, then choose the
   * option the text names. A written value never opens react-select's list, so
   * the text goes in as keystrokes; the list it opens is read, and the one
   * option {@link matchOption} picks is clicked after the guard clears it like
   * any click. No list, or no single match, leaves the typed text with the list
   * open for the model to click the option it means.
   * @param page - the tab's page, whose keyboard types.
   * @param resolution - how the input was found: its reference, its document, and where to look up its options.
   * @param element - the combobox input.
   * @param text - the option's text.
   * @param allowOrigin - whether the agent allowed a site change for this action.
   * @returns the chosen option's label, or nothing when none was chosen.
   */
  async #typeIntoCombobox(
    page: Page,
    resolution: Resolution,
    element: Actionable,
    text: string,
    allowOrigin: boolean,
  ): Promise<string | undefined> {
    const ref = resolution.ref
    await element.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type(text)
    let options: readonly SelectOption[] = []
    for (let waited = 0; waited <= COMBOBOX_WAIT_MS && options.length === 0; waited += COMBOBOX_POLL_MS) {
      await page.waitForTimeout(COMBOBOX_POLL_MS)
      options = readSelectOptions(await element.evaluate(readComboboxOptions))
    }
    const index = matchOption(options, text)
    const option = index === undefined ? undefined : options[index]
    this.#log.info('headless-browser: %s listed %d option(s) after typing; %s', ref, options.length,
      option === undefined ? 'none chosen' : `choosing option ${String((index ?? 0) + 1)}`)
    if (option === undefined) return undefined
    const locator = resolution.scope.locator(`[id=${JSON.stringify(option.value)}]`)
    const facts = readElementFacts(await locator.evaluate(probeElement))
    this.#accept(this.#guard.decideTarget({
      action: 'click',
      url: resolution.url,
      ref: `${ref} option`,
      candidates: [facts],
      allowOrigin,
    }))
    await locator.click()
    return option.label
  }

  /**
   * Choose the option of a native `<select>` that a typed text names, since a
   * select has no editable value to replace.
   * @param element - the select.
   * @param ref - the selector or id, for the error.
   * @param text - the option's label or value.
   * @returns the chosen option's label.
   * @throws Error - when no option, or more than one, matches.
   */
  async #choose(element: Actionable, ref: string, text: string): Promise<string> {
    const options = readSelectOptions(await element.evaluate(readOptions))
    const index = matchOption(options, text)
    const option = index === undefined ? undefined : options[index]
    if (index === undefined || option === undefined) {
      throw new Error(`no single option of ${ref} matches ${JSON.stringify(text)}; read the select with headless_browser_read and its selector to see the options, then type one of them`)
    }
    await element.selectOption({ index }, { timeout: SELECT_TIMEOUT_MS })
    this.#log.info('headless-browser: %s chose option %d of %d', ref, index + 1, options.length)
    return option.label
  }

  /**
   * The address of one tab, read without acting on it.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the page URL.
   */
  async pageUrl(tabId?: string): Promise<string> {
    return await this.#guarded('reading the page address', async () => (await this.page(tabId)).url())
  }

  /**
   * The address of the document a field is in: the page, or the embedded page
   * (an iCIMS application iframe) that holds a selector the page itself does not
   * match. A saved credential belongs to that host, since that is where it is typed.
   * @param request - the selector or accessibility id of the field.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the URL of the field's document.
   */
  async fieldUrl(request: TargetRequest, tabId?: string): Promise<string> {
    return await this.#guarded('finding the field', async () => {
      const page = await this.page(tabId)
      if (request.point !== undefined) return page.url()
      return (await this.#resolve(page, request)).url
    })
  }

  /**
   * Write a saved credential into the field a selector or accessibility id
   * names, after the action guard clears the field like a type. The page must
   * still be on the host the credential belongs to at the moment of writing, and
   * a password only goes into an `input[type=password]`, so neither a navigation
   * between lookup and fill nor a page that labels a text box "password" can
   * receive it. The value never reaches a log line or a result.
   * @param request - the selector or accessibility id of the field; a point is refused.
   * @param secret - the value to write.
   * @param field - `password` requires a password input; `username` any editable field.
   * @param host - the host the credential belongs to.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the page URL and the element written.
   * @throws SecretFieldError - when the target is a point, the page left the host, or a password target is not a password input.
   */
  async fillSecret(request: TargetRequest, secret: string, field: SecretField, host: string, tabId?: string): Promise<ActionOutcome> {
    if (request.point !== undefined) throw new SecretFieldError('a saved credential goes into a field named by selector or axId, never a point')
    return await this.#guarded('filling a saved credential', async () => {
      const page = await this.page(tabId)
      const resolution = await this.#resolve(page, request)
      const target = this.#accept(this.#guard.decideTarget({
        action: 'type',
        url: resolution.url,
        ref: resolution.ref,
        candidates: resolution.facts,
        allowOrigin: false,
        ...resolution.staleAxId === undefined ? {} : { staleAxId: resolution.staleAxId },
      }))
      const element = resolution.element(target.index)
      if (field === 'password' && !await element.evaluate(node => node instanceof HTMLInputElement && node.type === 'password')) {
        throw new SecretFieldError(`${resolution.ref} is not a password input (input[type=password]); a saved password is only written into one`)
      }
      if (hostOf(resolution.url) !== host) {
        throw new SecretFieldError(`the field is on ${hostOf(resolution.url)}, not ${host}; a saved credential is only written on its own host`)
      }
      await element.fill(secret)
      this.#log.info('headless-browser: wrote the saved %s for %s into %s', field, host, resolution.ref)
      return { url: page.url(), target }
    })
  }

  /**
   * Attach local files to a file input, or to the file chooser a visible
   * control opens. A file input is usually hidden behind a styled button, so a
   * selector that names an `input[type=file]` is used without the visibility
   * score; a trigger is a click and passes the guard like one. The caller has
   * already checked the paths against the upload directories.
   * @param target - the file input selector, or the trigger control.
   * @param paths - absolute paths of the files.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the page URL and what received the files.
   * @throws Error - when the selector names no file input, or the trigger opened no chooser.
   */
  async attachFiles(target: AttachTarget, paths: readonly string[], tabId?: string): Promise<AttachOutcome> {
    return await this.#guarded('attaching files', async () => {
      const page = await this.page(tabId)
      if (target.trigger !== undefined) {
        const resolution = await this.#resolve(page, target.trigger)
        const choice = this.#accept(this.#guard.decideTarget({
          action: 'click',
          url: resolution.url,
          ref: resolution.ref,
          candidates: resolution.facts,
          allowOrigin: false,
          ...resolution.staleAxId === undefined ? {} : { staleAxId: resolution.staleAxId },
        }))
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: FILE_CHOOSER_WAIT_MS }),
          resolution.element(choice.index).click(),
        ])
        if (paths.length > 1 && !chooser.isMultiple()) throw new Error(`${resolution.ref} opens a chooser that takes one file; attach the files one call each`)
        await chooser.setFiles([...paths])
        this.#log.info('headless-browser: attached %d file(s) through %s on %s', paths.length, resolution.ref, pageOrigin(page.url()))
        return { url: page.url(), ref: resolution.ref, target: choice }
      }
      const selector = target.selector
      if (selector === undefined) throw new Error('give a file input selector or a trigger')
      const located = await locate(page, selector)
      const locator = located?.locator ?? page.locator(selector)
      const count = located?.count ?? 0
      const inputs: number[] = []
      for (let index = 0; index < count; index += 1) {
        if (await locator.nth(index).evaluate(node => node instanceof HTMLInputElement && node.type === 'file')) inputs.push(index)
      }
      if (inputs.length === 0) {
        throw new Error(`${selector} matches no input[type=file] (${String(count)} element(s) matched); name the file input, or pass trigger for the button that opens the chooser`)
      }
      const pick = inputs[target.index ?? 0]
      if (pick === undefined) throw new Error(`${selector} matches ${String(inputs.length)} file input(s); index ${String(target.index)} is out of range`)
      const input = locator.nth(pick)
      if (paths.length > 1 && !await input.evaluate(node => node instanceof HTMLInputElement && node.multiple)) {
        throw new Error(`${selector} takes one file; attach the files one call each`)
      }
      await input.setInputFiles([...paths])
      this.#log.info('headless-browser: attached %d file(s) to %s on %s', paths.length, selector, pageOrigin(page.url()))
      return { url: page.url(), ref: selector, inputs: inputs.length }
    })
  }

  /**
   * What a viewport point hits, measured with the same probe a selector target
   * gets, so the guard can apply the sensitive-name and origin rules to the
   * element a person would actually reach there.
   * @param point - viewport coordinates in CSS pixels.
   * @returns the facts of the element there, or nothing for a blank point.
   */
  async #hitFacts(page: Page, point: { readonly x: number; readonly y: number }): Promise<ElementFacts | undefined> {
    const handle = await page.evaluateHandle(
      (at: { x: number; y: number }) => {
        // Follow open shadow roots down, as the probe does, to the element a click there reaches.
        let hit = document.elementFromPoint(at.x, at.y)
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(at.x, at.y)
          if (inner === null || inner === hit) break
          hit = inner
        }
        return hit
      },
      { x: point.x, y: point.y },
    )
    try {
      const element = handle.asElement()
      if (element === null) return undefined
      return readElementFacts(await element.evaluate(probeElement))
    } finally {
      await handle.dispose()
    }
  }

  /**
   * Resolve a request to the candidates the guard scores. A selector keeps
   * every match; an accessibility id names one element through the read tool's
   * map, and an id that map does not know is reported as stale rather than
   * falling back to a selector or a coordinate.
   * @param page - the page the action runs in.
   * @param request - the target the model named.
   * @returns the candidates and the way to act on one of them.
   */
  async #resolve(page: Page, request: TargetRequest): Promise<Resolution> {
    if (request.axId !== undefined) {
      const resolver = this.#axResolver
      if (resolver === undefined) {
        throw new Error(`accessibility id ${request.axId} cannot be resolved: no page read has registered an id map in this build; pass a selector instead`)
      }
      const handle = await resolver.resolve(page, request.axId)
      if (handle === undefined) {
        return {
          ref: request.axId,
          facts: [],
          element: () => { throw new Error(`accessibility id ${request.axId} resolved to no element`) },
          staleAxId: request.axId,
          url: page.url(),
          scope: page,
        }
      }
      const facts = readElementFacts(await handle.evaluate(probeElement))
      return { ref: request.axId, facts: [facts], element: () => handle, url: page.url(), scope: page }
    }
    const selector = request.selector
    if (selector === undefined) throw new Error('a guarded action needs a selector, an accessibility id, or a point')
    const located = await locate(page, selector)
    if (located === undefined) throw new Error(`no element matches ${selector}`)
    const { locator, count, frame } = located
    if (frame !== undefined) {
      this.#log.info('headless-browser: %s matches nothing on %s; acting in its embedded page %s', selector, pageOrigin(page.url()), pageOrigin(frame.url()))
    }
    const facts: ElementFacts[] = []
    const covers: { readonly facts: ElementFacts; readonly element: Actionable }[] = []
    for (let index = 0; index < count; index += 1) {
      const candidate = readElementFacts(await locator.nth(index).evaluate(probeElement))
      facts.push(candidate)
      if (!candidate.ariaHidden && candidate.occlusion >= 1) continue
      // A same-name overlay on top is what a person's click reaches; it is scored after the matches.
      const cover = (await locator.nth(index).evaluateHandle(findSameNameCover)).asElement()
      if (cover === null) continue
      const coverFacts = readElementFacts(await cover.evaluate(probeElement))
      this.#log.info('headless-browser: %s match %d is covered by a %s named %s; scoring the cover too',
        selector, index, coverFacts.role ?? coverFacts.tag, JSON.stringify(coverFacts.name))
      covers.push({ facts: coverFacts, element: cover })
    }
    return {
      ref: selector,
      url: frame?.url() ?? page.url(),
      scope: frame ?? page,
      facts: [...facts, ...covers.map(cover => cover.facts)],
      element: (index) => {
        if (index < count) return locator.nth(index)
        const cover = covers[index - count]
        if (cover === undefined) throw new Error(`${selector} has no candidate ${String(index)}`)
        return cover.element
      },
    }
  }

  /**
   * Report the guard's refusal, or return the element it chose.
   * @param decision - the guard's answer.
   * @returns the chosen element.
   */
  #accept(decision: Decision): TargetChoice {
    if (!decision.allowed || decision.target === undefined) throw new ActionRefusedError(blockedAction(refusalOf(decision)))
    return decision.target
  }

  /**
   * Report the guard's refusal, or return the point it allowed.
   * @param decision - the guard's answer.
   * @returns the point the action hit.
   */
  #acceptPoint(decision: Decision): PointChoice {
    if (!decision.allowed || decision.point === undefined) throw new ActionRefusedError(blockedAction(refusalOf(decision)))
    return decision.point
  }

  /**
   * The context's cookies, filtered to one domain, with the Cookie header a
   * plain HTTP fetch would send. Values are credentials: the log line names the
   * cookies and their value lengths, never a value.
   * @param domain - domain suffix to keep, or nothing for every cookie in the context.
   * @returns the matching cookies and their Cookie header.
   */
  async cookies(domain?: string): Promise<CookieResult> {
    return await this.#guarded('reading cookies', async () => {
      const context = await this.ensure()
      const result = cookieSnapshot(await context.cookies(), domain)
      this.#log.debug('headless-browser: %s', cookieSummary(result.cookies, domain))
      return result
    })
  }

  /**
   * A page a keepalive check drives: created in this context, so it carries the
   * same profile, cookies, and stealth identity, and kept out of the tab model
   * so it never counts against the tab cap or moves the active tab.
   * @returns the page, which the caller closes.
   */
  async keepalivePage(): Promise<KeepalivePage> {
    return await this.#guarded('opening a keepalive page', async () => {
      const context = await this.ensure()
      const active = this.#tabs?.state().find(tab => tab.active)?.id
      const page = await context.newPage()
      this.#background.add(page)
      if (active !== undefined) {
        // Opening a page activates it in Chromium; put the agent's tab back in
        // front so a keepalive never moves the page a person is looking at.
        try {
          await (await this.tabs().page(active)).bringToFront()
        } catch (error: unknown) {
          void firstLine(error)
        }
      }
      return {
        url: () => page.url(),
        isClosed: () => page.isClosed(),
        goto: async (url, options) => (await page.goto(url, options))?.status(),
        challenge: async (): Promise<ChallengeFacts> => readChallengeFacts(await page.evaluate(probeChallenge)),
        text: async () => await page.evaluate(() => document.body?.innerText ?? ''),
        close: async () => {
          this.#background.delete(page)
          await page.close()
        },
      }
    })
  }

  /**
   * What the browser is doing now, without launching it.
   * @returns whether a context is open, its session id, and the active tab's URL.
   */
  status(): BrowserStatus {
    if (this.#context === undefined) return { launched: false }
    const tabs = this.#tabs?.state() ?? []
    const active = tabs.find(tab => tab.active)
    return {
      launched: true,
      ...this.#sessionId === undefined ? {} : { sessionId: this.#sessionId },
      ...active === undefined || active.url === '' ? {} : { url: active.url },
      tabs: tabs.length,
    }
  }

  /**
   * Close the context and wait for Chromium to exit; later calls stay closed.
   * Shutdown is graceful on purpose: a browser left running holds the profile
   * against the next start, which is why a restart could not open a tab.
   */
  async close(): Promise<void> {
    this.#closed = true
    const launching = this.#launching
    if (launching !== undefined) {
      try {
        await launching
      } catch (error: unknown) {
        // Shutdown raced the launch: the launcher already released its context.
        void error
      }
    }
    const context = this.#context
    const pid = this.#browserPid
    this.#context = undefined
    this.#browserPid = undefined
    this.#stopStealth?.()
    this.#stopStealth = undefined
    this.#tabs?.dispose()
    this.#tabs = undefined
    this.#detachExit?.()
    this.#detachExit = undefined
    if (context !== undefined) {
      try {
        await withDeadline(context.close(), SHUTDOWN_TIMEOUT_MS)
      } catch (error: unknown) {
        this.#log.warn('headless-browser: closing the context failed (%s); killing chromium %s', firstLine(error), String(pid ?? 'unknown'))
        // A browser that outlived its context would hold the profile against the next start.
        if (pid !== undefined) this.#kill(pid)
      }
    }
    await removeBrowserOwner(this.#config.profileDir).catch((error: unknown) => {
      this.#log.warn('headless-browser: forgetting the browser owner failed: %s', firstLine(error))
    })
  }

  /**
   * Run one page operation, and put the browser back once when the context under
   * it is gone. A second failure is reported with the profile path, because by
   * then something outside this process holds it.
   * @param what - the operation, for the log and for the error.
   * @param run - the operation itself.
   * @returns the operation's result.
   * @throws BrowserUnavailableError - when the operation still fails after one relaunch.
   */
  async #guarded<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error: unknown) {
      if (this.#closed || !isLostContextError(error)) throw error
      await this.#recover(`${what} failed: ${firstLine(error)}`)
      try {
        return await run()
      } catch (again: unknown) {
        if (!isLostContextError(again)) throw again
        throw new BrowserUnavailableError(`the headless browser was relaunched once and ${what} still failed (${firstLine(again)}); profile ${this.#config.profileDir} may be held by another process`)
      }
    }
  }

  /**
   * Relaunch the browser once, sharing a relaunch already in flight so two
   * tools racing each other do not start two browsers.
   * @param reason - what went wrong, for the log.
   */
  async #recover(reason: string): Promise<void> {
    this.#recovering ??= this.#relaunch(reason).finally(() => { this.#recovering = undefined })
    await this.#recovering
  }

  /**
   * Close the context that died, wait for Chromium to let go of the profile, and
   * launch again; then tell everyone whose timers point at the old context.
   * @param reason - what went wrong, for the log.
   */
  async #relaunch(reason: string): Promise<void> {
    if (this.#closed) throw new BrowserUnavailableError('the browser plugin is shutting down')
    const previous = this.#context
    const previousPid = this.#browserPid
    this.#log.warn('headless-browser: recovering the browser after %s; profile %s', reason, this.#config.profileDir)
    this.#context = undefined
    this.#launching = undefined
    this.#browserPid = undefined
    this.#stopStealth?.()
    this.#stopStealth = undefined
    this.#tabs?.dispose()
    this.#tabs = undefined
    if (previous !== undefined) {
      try {
        await withDeadline(previous.close(), SHUTDOWN_TIMEOUT_MS)
      } catch (error: unknown) {
        void firstLine(error)
      }
    }
    if (previousPid !== undefined) this.#kill(previousPid)
    await (this.#deps.sleep ?? sleepMs)(RELAUNCH_SETTLE_MS)
    await this.ensure()
    for (const listener of [...this.#relaunchListeners]) {
      try {
        listener()
      } catch (error: unknown) {
        this.#log.warn('headless-browser: a relaunch listener failed: %s', firstLine(error))
      }
    }
    this.#log.info('headless-browser: the browser is back as session %s', String(this.#sessionId ?? 'unknown'))
  }

  /**
   * Launch one context and record which browser it is, so shutdown and the next
   * start can reach it.
   * @returns the open context.
   */
  async #launch(): Promise<BrowserContext> {
    await mkdir(this.#config.profileDir, { recursive: true })
    // A previous process may have died while its Chromium still held this
    // profile; clearing that first is what a launch after a restart needs.
    const stale = await recoverStaleProfile(this.#config.profileDir, this.#deps.probe, this.#log)
    if (stale !== undefined) {
      this.#log.warn('headless-browser: cleared a stale profile before launch: %s', stale.reasons.join('; '))
    }
    await ensureDownloadPrefs(this.#config.profileDir, this.#config.downloadPdfs, this.#log).catch((error: unknown) => {
      this.#log.warn('headless-browser: setting the profile download preferences failed: %s', firstLine(error))
    })
    const context = await this.#launchContext()
    if (this.#closed) {
      await context.close()
      throw new BrowserUnavailableError('the browser plugin is shutting down')
    }
    this.#context = context
    this.#sessionId = randomUUID()
    this.#browserPid = await this.#findBrowserPid()
    this.#installExitHook()
    if (this.#browserPid !== undefined) {
      await writeBrowserOwner(this.#config.profileDir, {
        pid: this.#browserPid,
        ownerPid: process.pid,
        startedAt: new Date().toISOString(),
      }).catch((error: unknown) => {
        this.#log.warn('headless-browser: recording the browser owner failed: %s', firstLine(error))
      })
    }
    context.on('close', () => {
      this.#stopStealth?.()
      this.#stopStealth = undefined
      this.#context = undefined
      this.#launching = undefined
      this.#tabs?.dispose()
      this.#tabs = undefined
    })
    this.#log.info('headless-browser: launched session %s with profile %s', this.#sessionId, this.#config.profileDir)
    if (this.#config.stealth) {
      const stealth = stealthIdentity()
      this.#stopStealth = await applyStealth<Page>(context, this.#log, stealth)
    }
    return context
  }

  /**
   * One persistent launch with the configured viewport and identity.
   * @returns the open context.
   * @throws BrowserUnavailableError - when Chromium does not start.
   */
  async #launchContext(): Promise<BrowserContext> {
    // One identity for the whole context: the launch settings, and later the
    // per-page overrides that keep the client hints in step with it.
    const stealth = this.#config.stealth ? stealthIdentity() : undefined
    const options: Record<string, unknown> = {
      headless: this.#config.headless,
      viewport: { width: this.#config.viewportWidth, height: this.#config.viewportHeight },
      ...stealth === undefined ? {} : stealthLaunch(stealth),
    }
    try {
      return this.#deps.launch === undefined
        ? await chromium.launchPersistentContext(this.#config.profileDir, options)
        : await this.#deps.launch(this.#config.profileDir, options)
    } catch (error: unknown) {
      throw new BrowserUnavailableError(`the headless browser could not start: ${firstLine(error)}`)
    }
  }

  /**
   * The Chromium this process just started for this profile.
   * @returns its pid, or nothing when the listing does not name it.
   */
  async #findBrowserPid(): Promise<number | undefined> {
    try {
      const rows = await browserProcesses(this.#config.profileDir, this.#deps.probe)
      const mine = rows.find(row => row.ppid === process.pid)
      return (mine ?? rows[0])?.pid
    } catch (error: unknown) {
      this.#log.warn('headless-browser: finding the chromium pid failed: %s', firstLine(error))
      return undefined
    }
  }

  /**
   * Kill one pid of this profile's browser: the last resort when a context could
   * not be closed, and the exit hook's only move.
   * @param pid - the browser process.
   * @returns whether the signal was sent.
   */
  #kill(pid: number): boolean {
    return (this.#deps.kill ?? killBrowserSync)(pid)
  }

  /**
   * Register the best-effort kill of this process's browser for the moment the
   * process exits without a plugin dispose: only synchronous work is allowed
   * there, which is why this one path is not awaited.
   */
  #installExitHook(): void {
    if (this.#detachExit !== undefined) return
    const run = (): void => {
      const pid = this.#browserPid
      if (pid === undefined) return
      this.#kill(pid)
    }
    const register = this.#deps.onExit ?? ((listener: () => void) => {
      process.once('exit', listener)
      return () => { process.off('exit', listener) }
    })
    this.#detachExit = register(run)
  }
}

/**
 * Wait for one promise, or give up on it.
 * @param work - the work to bound.
 * @param ms - how long it may take.
 * @returns the work's result.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => { reject(new Error(`timed out after ${String(ms)}ms`)) }, ms)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The wait between closing a lost context and relaunching. It is a plain timer
 * on purpose: a recovery is work the caller is waiting for, so it must keep the
 * event loop alive rather than let a short-lived process exit in the middle.
 * @param ms - how long to wait.
 */
async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}


/**
 * A read over one Playwright page: the body, or the first match of a selector.
 * Playwright's `innerText` is the element's own rendered text, so a hidden
 * element contributes nothing, and a selector that matches nothing reports
 * nothing rather than waiting out the locator timeout.
 * @param page - the tab's page.
 * @returns the page operations one read needs.
 */
function readable(page: Page): ReadPage {
  return {
    url: () => page.url(),
    innerText: async (selector) => {
      const target = page.locator(selector ?? 'body').first()
      const own = await target.count() === 0 ? undefined : await target.innerText()
      const frames = await formFrames(page)
      if (selector !== undefined) {
        if (own !== undefined) return own
        // A selector the page does not match may name a field of an embedded form.
        for (const { frame } of frames) {
          const inner = frame.locator(selector).first()
          if (await inner.count().catch(() => 0) > 0) return await inner.innerText({ timeout: FRAME_READ_TIMEOUT_MS })
        }
        return undefined
      }
      // A person reads an embedded form as part of the page, so its text follows the page's own.
      const parts = [own ?? '']
      for (const { frame, ref } of frames) {
        try {
          const body = frame.locator('body').first()
          const text = await body.count() === 0 ? '' : await body.innerText({ timeout: FRAME_READ_TIMEOUT_MS })
          if (text.trim() !== '') parts.push(`[frame ${ref.url}]\n${text}`)
        } catch (error: unknown) {
          // A frame that navigated or detached while it was read adds nothing.
          void firstLine(error)
        }
      }
      return parts.join('\n\n')
    },
    frames: async () => (await childFrames(page)).map(entry => entry.ref),
  }
}

/** How long reading one embedded page's text may take before the read goes on without it. */
const FRAME_READ_TIMEOUT_MS = 5000

/**
 * The http(s) pages embedded in a page's main frame, with their box on screen;
 * a frame that detached while it was listed is left out.
 * @param page - the tab's page.
 * @returns each child frame with an address and a box, in document order.
 */
async function childFrames(page: Page): Promise<{ readonly frame: Frame; readonly ref: FrameRef }[]> {
  const found: { frame: Frame; ref: FrameRef }[] = []
  for (const frame of page.mainFrame().childFrames()) {
    const url = frame.url()
    if (!/^https?:/iu.test(url)) continue
    try {
      const box = await (await frame.frameElement()).boundingBox()
      if (box !== null) found.push({ frame, ref: { url, width: Math.round(box.width), height: Math.round(box.height) } })
    } catch (error: unknown) {
      void firstLine(error)
    }
  }
  return found
}

/**
 * The embedded pages big enough to hold a form, the ones a whole-page read lists:
 * at least {@link MIN_FRAME_AREA}, at most {@link MAX_READ_FRAMES}.
 * @param page - the tab's page.
 * @returns those frames, in document order.
 */
async function formFrames(page: Page): Promise<{ readonly frame: Frame; readonly ref: FrameRef }[]> {
  return (await childFrames(page)).filter(entry => entry.ref.width * entry.ref.height >= MIN_FRAME_AREA).slice(0, MAX_READ_FRAMES)
}

/** A selector's matches, and the embedded page they are in when the page itself had none. */
interface Located {
  readonly locator: Locator
  readonly count: number
  readonly frame?: Frame
}

/**
 * Find a selector's matches on the page, or else in the first embedded form page
 * that has any: iCIMS renders its whole application inside a same-site iframe,
 * and opening that iframe's address on its own redirects back to the outer page.
 * @param page - the tab's page.
 * @param selector - the model's selector.
 * @returns the matches and the frame they are in, or nothing when no document matches.
 */
async function locate(page: Page, selector: string): Promise<Located | undefined> {
  const locator = page.locator(selector)
  const count = await locator.count()
  if (count > 0) return { locator, count }
  for (const { frame } of await formFrames(page)) {
    const inner = frame.locator(selector)
    const innerCount = await inner.count().catch(() => 0)
    if (innerCount > 0) return { locator: inner, count: innerCount, frame }
  }
  return undefined
}
