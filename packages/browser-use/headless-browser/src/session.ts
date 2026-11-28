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

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { chromium, type BrowserContext, type CDPSession, type ElementHandle, type Frame, type Locator, type Page, type Request, type Response } from 'playwright-core'
import { probeChallenge, readChallengeFacts, type ChallengeFacts } from './challenge.ts'
import type { Config } from './config.ts'
import { cookieSnapshot, cookieSummary, type CookieResult } from './cookies.ts'
import { DOWNLOAD_START_WAIT_MS, DownloadStore, ensureDownloadPrefs, isDownloadStarting, type DownloadRecord } from './downloads.ts'
import { firstLine } from './error.ts'
import {
  ActionGuard, ActionRefusedError, blockedAction, pageOrigin, refusalOf,
  type Decision, type PointChoice, type PointDecisionInput, type TargetChoice, type TargetDecisionInput,
} from './guard.ts'
import type { InputCommand, TabInfo, TabMessage } from './input.ts'
import { browserProcesses, killBrowserSync, recoverStaleProfile, removeBrowserOwner, writeBrowserOwner, type ProfileProbe } from './profile.ts'
import { findNearMisses, missAdvice, selectorKey } from './near-miss.ts'
import { MAX_READ_FRAMES, MIN_FRAME_AREA, readText, SelectorMissError, type FrameRef, type ReadPage, type ReadRequest, type ReadResult } from './read.ts'
import { cdpScrollChannel, scrollPage, type ScrollRequest, type ScrollResult } from './scroll.ts'
import { isComboboxInput, matchOption, readComboboxOptions, readOptions, readSelectOptions, type SelectOption } from './select.ts'
import type { KeepalivePage } from './keepalive.ts'
import { deniedJobUrl, JobNavigationRefused, protectJobPage, safeHost } from './job-apply-network.ts'
import { JobSnapshots } from './job-snapshots.ts'
import { applyStealth, stealthIdentity, stealthLaunch } from './stealth.ts'
import type { TabStore } from './tab-store.ts'
import { BrowserTabs, MAX_TABS, ResumeTabError, TabLimitError, TabNavigationError, type ActiveTab, type ClosedTab, type ListedTab, type PopupTab, type ResumedTab, type ResumeProbe, type ResumeTarget } from './tabs.ts'
import { findHiddenTextHolder, findSameNameCover, findToggleAim, findToggleStandIn, probeElement, readElementFacts, scoreVisibility, VISIBILITY_THRESHOLD, type ElementFacts } from './visibility.ts'

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

/** How long a listed option may take to finish appearing (a fade or slide-in) before the guard judges it. */
const OPTION_SETTLE_MS = 1_500

/**
 * How long a selector that matches nothing gets to appear before the miss is
 * reported: a click that opens the next step returns before the step draws, and
 * the next call usually names an element of that step. The wait ends as soon as
 * a match attaches, so only a selector that is wrong pays all of it.
 */
export const MISS_SETTLE_MS = 1_500

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
  /** Plugin-owned metadata journal; direct callers can construct an ephemeral browser. */
  readonly tabStore?: TabStore
  /** How long a job-apply Session must make no browser call before another may close or take over its tabs. */
  readonly jobTabIdleMs?: number
  /** Clock for the job-apply tab leases; tests pass a fake one. */
  readonly now?: () => number
}

const JOB_OWNER_PREFIX = 'job-apply:'
/**
 * A job-apply Session that has made no browser call this long has finished or stopped: at the tab cap another
 * Session's open may close its tabs, and another job-apply Session may take one over, as a worker the lead sends to
 * continue a form does. Workers act every few seconds; waiting for an emailed code is the longest pause, about two
 * minutes. On 2026-11-27 finished workers' tabs filled the eight shared slots, and a lease measured per tab instead of
 * per Session closed a worker's Apply popup one second after it opened. A Session still working may also lose a side
 * tab it has not used this long, but never its current tab or a tab that opened another still open.
 */
export const JOB_TAB_IDLE_MS = 5 * 60_000

/** One open tab as the tab-cap check weighs it. */
interface SlotRow {
  readonly id: string
  readonly url: string
  readonly owner: string | null | undefined
  /** When a job-apply call last used the tab; 0 when none has. */
  readonly used: number
}
/** How long reading a job page's links may take before it counts as none. */
const JOB_LINK_READ_MS = 2_000

interface JobCall {
  readonly owner: string
  readonly guard: ActionGuard
}

/** In-memory attachment validated and read from one file descriptor. */
export interface UploadPayload {
  readonly name: string
  readonly mimeType: string
  readonly buffer: Buffer
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

/** How a type finishes once the text is in. */
export interface FillOptions {
  /** Press Enter in the field after typing, for a search box that lists its matches only on Enter. */
  readonly enter?: boolean
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
  /**
   * Id of the tab the URL loaded in. Agents sharing the browser pass it as `tab`
   * on every later call, since another agent can change the active tab.
   */
  readonly tab: string
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
type Actionable = (Locator | ElementHandle<Element>) & {
  evaluate<R>(probe: (node: Element) => R): Promise<R>
}

/**
 * @param resolution - the candidates a target resolved to.
 * @returns indices of the candidates that are `input[type=file]`, in document order.
 */
async function fileInputsOf(resolution: Resolution): Promise<number[]> {
  const inputs: number[] = []
  for (let index = 0; index < resolution.facts.length; index += 1) {
    if (await resolution.element(index).evaluate(node => node instanceof HTMLInputElement && node.type === 'file')) inputs.push(index)
  }
  return inputs
}

function passwordInput(node: Element): boolean {
  return node instanceof HTMLInputElement && node.type === 'password'
}

/** Which half of a saved account a secret fill writes. */
export type SecretField = 'password' | 'username'

/** Where `attachFiles` puts the files: a file input, or a control that opens the file chooser. */
export interface AttachTarget {
  /** CSS selector of an `input[type=file]`; hidden inputs are expected and allowed. */
  readonly selector?: string
  /** Which matching file input, in document order; 0 when omitted. */
  readonly index?: number
  /**
   * A visible control whose click opens the file chooser, guarded like a click;
   * one that names only file inputs is used as a selector is.
   */
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
  /** Where inside that candidate a click lands, when not at its centre. */
  readonly aim?: (index: number) => ClickPoint | undefined
  /** The accessibility id that resolved to nothing, when it did. */
  readonly staleAxId?: string
  /** URL of the document the candidates are in: the page, or the embedded page that held the selector's matches. */
  readonly url: string
  /** Where follow-up lookups for the same element run, such as a dropdown's options: the page or that embedded page. */
  readonly scope: Page | Frame
}

/**
 * @param page - a job page.
 * @returns distinct http(s) hostnames of the main frame's first 500 anchors, or none when the page does not answer
 *   within {@link JOB_LINK_READ_MS}.
 */
async function linkHosts(page: Page): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<string[]>((resolve) => { timer = setTimeout(() => { resolve([]) }, JOB_LINK_READ_MS) })
  const read = page.evaluate(() => Array.from(document.querySelectorAll('a[href]'), anchor => (anchor as HTMLAnchorElement).href).slice(0, 500))
    .catch((): string[] => [])
  try {
    const hosts = new Set<string>()
    for (const href of await Promise.race([read, late])) {
      // A page's malformed href parses to null and names no host.
      const url = URL.parse(href)
      if (url !== null && (url.protocol === 'https:' || url.protocol === 'http:')) hosts.add(url.hostname)
    }
    return [...hosts]
  } finally {
    clearTimeout(timer)
  }
}

/** A click position inside an element, in CSS pixels from its top-left corner. */
interface ClickPoint {
  readonly x: number
  readonly y: number
}

/** Launch, navigate, inspect, and close one persistent Chromium with tabs. */
export class HeadlessBrowserSession {
  readonly #config: Config
  readonly #log: Pick<Context['logger'], 'debug' | 'info' | 'warn'>
  readonly #guard: ActionGuard
  readonly #deps: SessionDeps
  readonly #job = new AsyncLocalStorage<JobCall>()
  readonly #jobPages = new WeakSet<Page>()
  /** When a job-apply Session last acted on each of its tabs, or a site opened it as a popup. */
  readonly #jobTabUse = new Map<string, number>()
  /** When each job-apply Session, by owner, last started or finished a browser call. */
  readonly #jobOwnerUse = new Map<string, number>()
  /** The owner of each job-apply browser call in flight, once per call. */
  readonly #jobInFlight: string[] = []
  readonly #jobSnapshots = new JobSnapshots()
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
  readonly #httpErrors = new WeakMap<Page, string>()
  readonly #navigationMethods = new WeakMap<Page, string>()
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
    const launch = this.#launching ??= this.#launch()
    try {
      return await launch
    } catch (error: unknown) {
      // Do not clear a newer launch if a second caller already retried this one.
      if (this.#launching === launch) this.#launching = undefined
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
      onAdopt: (page, owner, id) => {
        // A popup the site opened for a job Session is that Session's newest tab, so a code typed next goes to it.
        if (owner?.startsWith(JOB_OWNER_PREFIX) === true) this.#jobTabUse.set(id, this.#now())
        return this.#observePage(page, owner?.startsWith(JOB_OWNER_PREFIX) !== true)
      },
      preparePopup: async (page, owner) => {
        if (owner?.startsWith(JOB_OWNER_PREFIX) !== true) return undefined
        try { await this.#protectJobPage(page) } catch (error: unknown) {
          await page.close().catch((closed: unknown) => { void closed })
          throw error
        }
        return owner
      },
      ...this.#deps.tabStore === undefined ? {} : { store: this.#deps.tabStore, nextId: () => `t-${randomUUID()}` },
    })
    return this.#tabs
  }

  /**
   * Bind a scoped tool call to a trusted owner and tab policy without changing shared defaults.
   * @param session - trusted Session identity supplied by the tool executor.
   * @param guard - enforced action guard for this call.
   * @param run - one restricted tool invocation.
   * @returns the invocation result.
   */
  async runJob<T>(session: string, guard: ActionGuard, run: () => Promise<T>): Promise<T> {
    const owner = JOB_OWNER_PREFIX + session
    this.#jobOwnerUse.set(owner, this.#now())
    this.#jobInFlight.push(owner)
    try {
      return await this.#job.run({ owner, guard }, run)
    } finally {
      this.#jobInFlight.splice(this.#jobInFlight.indexOf(owner), 1)
      this.#jobOwnerUse.set(owner, this.#now())
    }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  /**
   * @param owner - a tab's recorded owner.
   * @returns whether it is a job-apply Session with no call in flight and none for {@link JOB_TAB_IDLE_MS}; one
   * unseen since this process started (a restart ends every turn) counts as idle.
   */
  #jobOwnerIdle(owner: string | null | undefined): boolean {
    if (owner?.startsWith(JOB_OWNER_PREFIX) !== true || this.#jobInFlight.includes(owner)) return false
    const used = this.#jobOwnerUse.get(owner)
    return used === undefined || this.#now() - used >= (this.#deps.jobTabIdleMs ?? JOB_TAB_IDLE_MS)
  }

  /**
   * @param tab - live tab id.
   * @param caller - the scoped owner.
   * @returns whether the caller owns the tab or may take it over from an idle job-apply Session.
   */
  #jobMayUse(tab: string, caller: string): boolean {
    const owner = this.tabs().owner(tab)
    return owner === caller || this.#jobOwnerIdle(owner)
  }

  /**
   * Name the host of the caller's current job tab, for checks that the page matches an approved site.
   * @param session - trusted identity of the calling Session.
   * @param signal - cancellation of the verification request.
   * @returns hostname of the current owned, admitted tab, or null.
   */
  async currentJobHost(session: string, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted()
    const page = await this.#currentJobPage(session)
    return page === null ? null : safeHost(page.url())
  }

  /**
   * Hosts the caller's pages on its current job site link to, so an enterprise ATS can vouch for its employer's mail
   * domain: Tenet's Oracle application step links nowhere, while its posting page on the same host links
   * www.tenethealth.com.
   * @param session - trusted identity of the calling Session.
   * @param signal - cancellation of the verification request.
   * @returns distinct http(s) link hostnames from the main frames of the caller's tabs on its current tab's host, at
   *   most 500 anchors each, current tab first; empty when unknown.
   */
  async currentJobLinkHosts(session: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    const { host: site, pages } = await this.#currentJobSitePages(session)
    const hosts = new Set<string>()
    for (const page of pages) {
      if (signal?.aborted === true) break
      for (const host of await linkHosts(page)) hosts.add(host)
    }
    if (pages.length > 1) this.#log.info('headless-browser: read links of %d tabs on %s for a job-apply Session', pages.length, site)
    return [...hosts]
  }

  /**
   * Hosts of the pages the caller's current job page embeds, so an ATS form inside an employer's careers page can take
   * its vendor's mail: Esri's posting at www.esri.com embeds Greenhouse's application form.
   * @param session - trusted identity of the calling Session.
   * @param signal - cancellation of the verification request.
   * @returns distinct http(s) hostnames of the current page's child frames, in document order; empty when unknown.
   */
  async currentJobFrameHosts(session: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    const page = await this.#currentJobPage(session)
    if (page === null) return []
    const hosts = new Set<string>()
    for (const frame of page.mainFrame().childFrames()) {
      const url = URL.parse(frame.url())
      if (url !== null && (url.protocol === 'https:' || url.protocol === 'http:')) hosts.add(safeHost(url.href))
    }
    return [...hosts]
  }

  /**
   * The active tab is whichever Session acted last; the caller's page is its own most recently used tab.
   * @param session - trusted identity of the calling Session.
   * @returns that tab's live, protected, admitted page, or null.
   */
  async #currentJobPage(session: string): Promise<Page | null> {
    const [tab] = this.#ownedJobTabs(session)
    return tab === undefined ? null : await this.#admittedJobPage(tab)
  }

  /**
   * @param session - trusted identity of the calling Session.
   * @returns the host of the caller's current page, and that page followed by its other live, admitted pages on the
   *   same host; no pages when the caller has no current page.
   */
  async #currentJobSitePages(session: string): Promise<{ readonly host: string; readonly pages: readonly Page[] }> {
    const [current, ...rest] = this.#ownedJobTabs(session)
    const page = current === undefined ? null : await this.#admittedJobPage(current)
    if (page === null) return { host: '', pages: [] }
    const host = safeHost(page.url())
    const pages = [page]
    for (const tab of rest) {
      const other = await this.#admittedJobPage(tab)
      if (other !== null && safeHost(other.url()) === host) pages.push(other)
    }
    return { host, pages }
  }

  /**
   * @param session - trusted identity of the calling Session.
   * @returns ids of the tabs the caller owns, most recently used first, the active tab breaking ties.
   */
  #ownedJobTabs(session: string): string[] {
    const tabs = this.#tabs
    if (tabs === undefined) return []
    const owner = JOB_OWNER_PREFIX + session
    return this.tabsState()
      .filter(entry => tabs.owner(entry.id) === owner)
      .sort((a, b) => this.#jobTabUsedAt(b.id) - this.#jobTabUsedAt(a.id) || Number(b.active) - Number(a.active))
      .map(entry => entry.id)
  }

  /**
   * @param tab - a tab id.
   * @returns when a job-apply call last used the tab, or 0 when none has.
   */
  #jobTabUsedAt(tab: string): number {
    return this.#jobTabUse.get(tab) ?? 0
  }

  /**
   * @param tab - a live tab id.
   * @returns the tab's page while it is open, protected, and on an admitted URL, or null.
   */
  async #admittedJobPage(tab: string): Promise<Page | null> {
    const page = await this.tabs().page(tab)
    return page.isClosed() || !this.#jobPages.has(page) || deniedJobUrl(page.url()) ? null : page
  }

  async #protectJobPage(page: Page, onRefused?: (url: string) => void): Promise<void> {
    // A page retrying a refused subresource (one LinkedIn page asked for "https://invalid" 11k times) logs it once.
    const logged = new Set<string>()
    await protectJobPage(page, (url, closing) => {
      if (closing) onRefused?.(url)
      const host = safeHost(url)
      if (!closing && logged.has(host)) return
      logged.add(host)
      this.#log.warn('headless-browser: %s', new JobNavigationRefused(url).message)
    })
    this.#jobPages.add(page)
  }

  #assertJobUrl(url: string): void {
    if (this.#job.getStore() === undefined || !deniedJobUrl(url)) return
    const error = new JobNavigationRefused(url)
    this.#log.warn('headless-browser: %s', error.message)
    throw error
  }

  #activeGuard(): ActionGuard {
    return this.#job.getStore()?.guard ?? this.#guard
  }

  #assertJobOwner(tab: string | undefined): void {
    const scoped = this.#job.getStore()
    if (scoped === undefined) return
    if (tab === undefined) throw new Error('the tab is not owned by this job-apply Session; name one of its tabs (headless_browser_tabs lists them)')
    const owner = this.tabs().owner(tab)
    if (owner === undefined) {
      throw new Error(`tab ${tab} is closed (DSH restarted, or it sat idle and was closed for another worker); open the posting again`)
    }
    if (owner !== scoped.owner) {
      if (!this.#jobOwnerIdle(owner)) {
        throw new Error('the tab is not owned by this job-apply Session; another job-apply Session is still working in it')
      }
      this.tabs().setOwner(tab, scoped.owner)
      this.#log.info('headless-browser: %s took over idle job-apply tab %s from %s', scoped.owner, tab, owner)
    }
    this.#jobTabUse.set(tab, this.#now())
  }

  /**
   * At the tab cap, close one tab for a job-apply Session, first match wins: an unclaimed blank page, which holds
   * nothing; the least recently used tab of another job-apply Session that has gone idle; then the least recently
   * used side tab of a job-apply Session still working, the caller's own included. One LinkedIn search worker kept
   * seven employer pages open while it worked, and every apply worker was told the strip was full (2026-11-27).
   * A working Session keeps its current tab, every tab it used in the last {@link JOB_TAB_IDLE_MS}, and the opener of
   * any tab it still has; tabs outside job-apply are never closed.
   * @param caller - the scoped owner asking for a slot.
   * @returns whether a slot was freed.
   */
  async #freeJobSlot(caller: string): Promise<boolean> {
    const tabs = this.tabs()
    const open = tabs.state()
    const live = new Set(open.map(tab => tab.id))
    for (const id of this.#jobTabUse.keys()) if (!live.has(id)) this.#jobTabUse.delete(id)
    if (open.length < MAX_TABS) return false
    const rows: SlotRow[] = open
      .map(tab => ({ id: tab.id, url: tab.url, owner: tabs.owner(tab.id), used: this.#jobTabUsedAt(tab.id) }))
      .sort((a, b) => a.used - b.used)
    const blank = rows.find(tab => tab.owner === null && tab.url === 'about:blank')
    const idle = rows.find(tab => tab.owner !== caller && this.#jobOwnerIdle(tab.owner))
    const victim = blank ?? idle ?? await this.#staleJobTab(rows)
    if (victim === undefined) {
      this.#log.info('headless-browser: %d tabs open and none is blank, idle or a stale job-apply side tab; %s gets no slot', open.length, caller)
      return false
    }
    await tabs.close(victim.id)
    this.#jobTabUse.delete(victim.id)
    if (victim === blank) this.#log.info('headless-browser: closed unclaimed blank tab %s to free a slot', victim.id)
    else if (victim === idle) this.#log.info('headless-browser: closed idle job-apply tab %s to free a slot', victim.id)
    else this.#log.info('headless-browser: closed stale side tab %s of working %s to free a slot', victim.id, String(victim.owner))
    return true
  }

  /**
   * @param rows - the open tabs with their owners, least recently used first.
   * @returns the first tab a working job-apply Session has left behind: unused for {@link JOB_TAB_IDLE_MS}, not that
   *   Session's most recently used tab, and not the opener of a tab still open; nothing when no tab qualifies.
   */
  async #staleJobTab(rows: readonly SlotRow[]): Promise<SlotRow | undefined> {
    const tabs = this.tabs()
    const jobRows = rows.filter((row): row is SlotRow & { readonly owner: string } => row.owner?.startsWith(JOB_OWNER_PREFIX) === true)
    const current = new Map<string, SlotRow>()
    for (const row of jobRows) current.set(row.owner, row)
    const openers = new Set<Page>()
    for (const row of rows) {
      const opener = await (await tabs.page(row.id)).opener()
      if (opener !== null) openers.add(opener)
    }
    const before = this.#now() - (this.#deps.jobTabIdleMs ?? JOB_TAB_IDLE_MS)
    for (const row of jobRows) {
      if (row.used > before || current.get(row.owner) === row) continue
      if (!openers.has(await tabs.page(row.id))) return row
    }
    return undefined
  }

  /** At plugin boot, reconcile a previous run's open tabs immediately; otherwise launch on demand. */
  async reconcileTabsOnBoot(): Promise<void> {
    const store = this.#deps.tabStore
    if (store === undefined || !await store.hasOpenTabs() || this.#closed) return
    await this.ensure()
  }

  /**
   * Discover interactive tabs without changing focus or launching a browser.
   * @returns the context's open tabs, or an empty list if none are open.
   */
  async listTabs(): Promise<ListedTab[]> {
    const context = await this.#launching
    if (context === undefined || this.#context !== context) return []
    const tabs = await this.tabs().list(context)
    await this.#deps.tabStore?.flush()
    const scoped = this.#job.getStore()
    // An idle job Session's tabs are listed too: a worker sent to continue a form takes its tab over.
    return scoped === undefined ? tabs : tabs.filter(tab => this.#jobMayUse(tab.id, scoped.owner) && !deniedJobUrl(tab.url))
  }

  /**
   * Activate an existing form tab without replacing a healthy document.
   * @param target - the live tab id or a substring of exactly one live URL.
   * @returns the tab's current metadata and whether it contains form controls.
   */
  async resumeTab(target: ResumeTarget): Promise<ResumedTab> {
    const resolved = this.#jobResumeTarget(target)
    this.#assertJobOwner('tab' in resolved ? resolved.tab : undefined)
    const context = await this.#launching
    if (context === undefined || this.#context !== context) {
      throw new ResumeTabError('no tab is open; reopen the page and refill the form')
    }
    try {
      return await this.tabs().resume(context, resolved, (page) => {
        this.#assertJobUrl(page.url())
        return probeResume(page, this.#navigationMethods.get(page), this.#httpErrors.get(page))
      })
    } finally {
      await this.#deps.tabStore?.flush()
    }
  }

  /**
   * A job Session resumes by URL only among the tabs it may use, so the match cannot land on another worker's form.
   * @param target - the tab id or URL substring the worker gave.
   * @returns the target, with a URL resolved to one tab id inside a job-apply call.
   */
  #jobResumeTarget(target: ResumeTarget): ResumeTarget {
    const scoped = this.#job.getStore()
    if (scoped === undefined || 'tab' in target) return target
    const matches = this.tabsState().filter(tab => tab.url.includes(target.urlSubstring) && this.#jobMayUse(tab.id, scoped.owner))
    const [match] = matches
    if (match === undefined) throw new ResumeTabError('no tab this job-apply Session may use matches that URL; reopen the page and refill the form')
    if (matches.length > 1) throw new ResumeTabError('more than one tab matches that URL; use headless_browser_tabs and give a tab id')
    return { tab: match.id }
  }

  #observePage(page: Page, downloads: boolean): () => void {
    const detachDownloads = downloads ? this.#downloads.attach(page) : undefined
    const isMainNavigation = (request: Request): boolean => {
      if (!request.isNavigationRequest()) return false
      try {
        return request.frame() === page.mainFrame()
      } catch {
        // A popup's first request can precede its frame.
        return false
      }
    }
    const requested = (req: Request): void => {
      if (isMainNavigation(req)) this.#navigationMethods.set(page, req.method())
    }
    const response = (res: Response): void => {
      if (!isMainNavigation(res.request())) return
      if (res.status() >= 400) this.#httpErrors.set(page, res.url())
      else this.#httpErrors.delete(page)
    }
    page.on('request', requested)
    page.on('response', response)
    return () => {
      page.off('request', requested)
      page.off('response', response)
      detachDownloads?.()
    }
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
    this.#assertJobOwner(id)
    const page = await this.tabs().page(id)
    if (this.#job.getStore() !== undefined) {
      if (!this.#jobPages.has(page)) throw new Error('no protected job-apply tab is open')
      this.#assertJobUrl(page.url())
    }
    return page
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
    try {
      await this.#guarded('applying a tab command', async () => {
        await this.tabs().command(message.action, message.tabId, message.url)
      })
    } finally {
      await this.#deps.tabStore?.flush()
    }
  }

  /**
   * Open a URL in the active tab, a named tab, or a new one.
   * @param url - absolute URL; the page reports a relative one as invalid.
   * @param newTab - open a new tab instead of reusing one; a named tab is then ignored.
   * @param allowOrigin - allow the move when the destination is another registrable domain.
   * @param tabId - tab to load the URL in; the active tab when omitted.
   * @param openedBySessionId - the DSH Session opening a new tab or using an unclaimed blank tab.
   * @returns the settled URL, the document title, and the tab it loaded in.
   * @throws ActionRefusedError - when the destination is another site and this call did not allow it.
   * @throws TabNotFoundError - when `tabId` names no open tab.
   */
  async open(url: string, newTab = false, allowOrigin = false, tabId?: string, openedBySessionId?: string): Promise<OpenResult> {
    const named = newTab ? undefined : tabId
    return await this.#guarded('opening the page', async () => {
      this.#assertJobUrl(url)
      const current = newTab && this.#job.getStore() !== undefined ? undefined : await this.page(named)
      const decision = this.#activeGuard().decideNavigation({ action: 'open', url: current?.url() ?? 'about:blank', target: url, allowOrigin })
      if (!decision.allowed) throw new ActionRefusedError(blockedAction(refusalOf(decision)))
      const mark = this.#downloads.mark()
      let opened: { url: string; title: string; tab: string }
      try {
        opened = newTab
          ? await this.#openTab(url, openedBySessionId)
          : await this.#openHere(url, named, openedBySessionId)
      } catch (error: unknown) {
        // A URL that answers with an attachment is a file, not a page: the
        // navigation fails and the download follows. Report the file.
        if (this.#job.getStore() !== undefined || !(error instanceof TabNavigationError) || !isDownloadStarting(error.message)) throw error
        const downloads = await this.#downloads.since(mark, DOWNLOAD_START_WAIT_MS)
        if (downloads.length === 0) throw error
        const page = await this.page(named)
        const tab = named ?? (await this.tabs().active()).id
        this.#log.info('headless-browser: %s was a download, %d file(s) kept', url.split('?')[0], downloads.length)
        return { url: page.url(), title: await page.title(), tab, downloads }
      } finally {
        await this.#deps.tabStore?.flush()
      }
      this.#assertJobUrl(opened.url)
      this.#activeGuard().anchor(opened.url)
      this.#log.info('headless-browser: opened %s in tab %s%s', pageOrigin(opened.url), opened.tab, newTab ? ' (new)' : '')
      return opened
    })
  }

  /**
   * Navigate the active or a named tab and report what settled.
   * @param url - absolute URL to load.
   * @param tabId - tab to navigate; the active tab when omitted.
   * @param openedBySessionId - caller to credit for first use of an unclaimed blank page.
   * @returns the settled URL, the document title, and the tab's id.
   */
  async #openHere(url: string, tabId?: string, openedBySessionId?: string): Promise<{ url: string; title: string; tab: string }> {
    const tab = tabId ?? (await this.tabs().active()).id
    await this.tabs().navigate(url, tab, openedBySessionId)
    const page = await this.page(tab)
    return { url: page.url(), title: await page.title(), tab }
  }

  /**
   * Open a URL in a new tab and report what settled.
   * @param url - absolute URL to load.
   * @param openedBySessionId - the DSH Session that opened the tab, when one did.
   * @returns the new tab's URL, title and id.
   */
  async #openTab(url: string, openedBySessionId?: string): Promise<{ url: string; title: string; tab: string }> {
    const scoped = this.#job.getStore()
    let refused: JobNavigationRefused | undefined
    const prepare = scoped === undefined ? undefined : async (page: Page) => {
      await this.#protectJobPage(page, (url) => { refused = new JobNavigationRefused(url) })
    }
    if (scoped !== undefined) await this.#freeJobSlot(scoped.owner)
    let tab: TabInfo
    try {
      tab = await this.tabs().create(url, scoped?.owner ?? openedBySessionId, prepare)
    } catch (error: unknown) {
      // A denied landing reports only its host; a full tab strip or a page that failed to load says so.
      if (scoped !== undefined) {
        const ownsNone = !this.tabsState().some(open => this.tabs().owner(open.id) === scoped.owner)
        if (refused === undefined && error instanceof TabLimitError && ownsNone) {
          throw new TabLimitError(MAX_TABS, 'every tab belongs to a Session still working; retry in a few minutes. This is browser capacity, not the employer')
        }
        throw refused ?? (error instanceof TabLimitError || error instanceof TabNavigationError ? error : new Error('job-apply navigation failed'))
      }
      throw error
    }
    if (scoped !== undefined) this.#jobTabUse.set(tab.id, this.#now())
    return { url: tab.url, title: tab.title, tab: tab.id }
  }

  /**
   * Close one tab; the last tab is replaced by a blank one so the browser stays open.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the closed id, whether a blank tab replaced it, and the tabs that remain.
   * @throws NoOpenTabError - when no tab is open, so closing cannot start the browser.
   */
  async closeTab(tabId?: string): Promise<ClosedTab> {
    return await this.#guarded('closing a tab', async () => {
      this.#assertJobOwner(tabId)
      if (this.tabsState().length === 0) throw new NoOpenTabError()
      try {
        const scoped = this.#job.getStore()
        const closed = await this.tabs().close(tabId)
        return scoped === undefined ? closed : { ...closed, tabs: closed.tabs.filter(tab => this.#jobMayUse(tab.id, scoped.owner)) }
      } finally {
        await this.#deps.tabStore?.flush()
      }
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
      this.#assertJobUrl(page.url())
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
      this.#assertJobUrl(page.url())
      const scoped = this.#job.getStore()
      if (scoped !== undefined) {
        const url = page.url()
        const data = await page.screenshot({ fullPage, type: 'png' })
        this.#assertJobUrl(page.url())
        if (page.isClosed() || page.url() !== url) throw new Error('The tab moved during screenshot capture.')
        return { path: this.#jobSnapshots.add(scoped.owner, data), url }
      }
      await mkdir(this.#config.snapshotDir, { recursive: true })
      const path = join(this.#config.snapshotDir, `page-${new Date().toISOString().replaceAll(':', '-')}.png`)
      await page.screenshot({ path, fullPage })
      return { path, url: page.url() }
    })
  }

  /**
   * Read back a screenshot this job-apply Session captured.
   * @param session - trusted calling Session.
   * @param id - snapshot identifier returned by the screenshot call.
   * @returns the PNG bytes, or undefined when the id is unknown, evicted, or owned by another Session.
   */
  jobSnapshot(session: string, id: string): Buffer | undefined {
    return this.#jobSnapshots.get(JOB_OWNER_PREFIX + session, id)
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
      this.#assertJobOwner(tabId)
      const tab = tabId ?? (await this.tabs().active()).id
      const page = await this.page(tab)
      this.#assertJobUrl(page.url())
      return await readText({ ...readable(page), missAdvice: async selector => await this.#missAdvice(page, selector) }, tab, request)
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
      this.#assertJobUrl(page.url())
      if (request.point !== undefined) {
        const point = await this.#decideAtPoint(page, request.point, 'click', request.allowOrigin === true, tabId)
        const mark = this.#downloads.mark()
        const popupMark = this.tabs().popupMark()
        const at = request.point
        await this.#clickOn(page, async () => { await page.mouse.click(at.x, at.y) })
        this.#activeGuard().anchor(page.url())
        this.#assertJobUrl(page.url())
        return { url: page.url(), point, ...await this.#openedSince(mark, popupMark) }
      }
      const resolution = await this.#resolve(page, request)
      const target = this.#decideOn('click', resolution, request.allowOrigin === true)
      this.#authorizeTarget(resolution.url, resolution.facts[target.index])
      const mark = this.#downloads.mark()
      const popupMark = this.tabs().popupMark()
      const position = resolution.aim?.(target.index)
      const options = position === undefined ? undefined : { position }
      await this.#clickOn(page, async () => { await resolution.element(target.index).click(options) })
      this.#activeGuard().anchor(page.url())
      this.#assertJobUrl(page.url())
      return { url: page.url(), target, ...await this.#openedSince(mark, popupMark) }
    })
  }

  /**
   * Run one click. A page that closes itself in answer, as a sign-in popup does
   * when it hands back to its opener, took the click: Playwright reports the
   * closed page as a lost target, but the browser and its other tabs are up, so
   * the click succeeded and nothing is relaunched.
   * @param page - the page the click lands on.
   * @param click - the click itself.
   */
  async #clickOn(page: Page, click: () => Promise<void>): Promise<void> {
    try {
      await click()
    } catch (error: unknown) {
      const browserUp = this.#context?.pages().some(open => !open.isClosed()) === true
      if (!page.isClosed() || !browserUp || !isLostContextError(error)) throw error
      this.#log.info('headless-browser: the page closed itself on the click (%s)', firstLine(error))
    }
  }

  /**
   * The files a click started and the windows it opened, waited for together.
   * @param mark - the download marker taken before the click.
   * @param popupMark - the popup marker taken before the click.
   * @returns `downloads` and `popups` fields, each only when there is one.
   */
  async #openedSince(mark: number, popupMark: number): Promise<Pick<ActionOutcome, 'downloads' | 'popups'>> {
    const scoped = this.#job.getStore()
    if (scoped !== undefined) {
      const popups = (await this.tabs().popupsSince(popupMark, CLICK_DOWNLOAD_WAIT_MS))
        .filter(popup => this.tabs().owner(popup.tab) === scoped.owner && !deniedJobUrl(popup.url))
      return popups.length === 0 ? {} : { popups }
    }
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
   * @param options - whether to press Enter in the field once the text is in; a native select ignores it.
   * @returns the page URL after typing and the element or point it acted on.
   * @throws ActionRefusedError - when visibility, a sensitive name, or origin refuses the type.
   */
  async fill(request: TargetRequest, text: string, tabId?: string, options: FillOptions = {}): Promise<ActionOutcome> {
    const enter = options.enter === true
    return await this.#guarded('typing', async () => {
      const page = await this.page(tabId)
      this.#assertJobUrl(page.url())
      if (request.point !== undefined) {
        const point = await this.#decideAtPoint(page, request.point, 'type', request.allowOrigin === true, tabId)
        await page.mouse.click(request.point.x, request.point.y)
        await this.#guardJobFocus(page)
        await page.keyboard.insertText(text)
        if (enter) {
          await this.#guardJobFocus(page)
          await page.keyboard.press('Enter')
          this.#log.info('headless-browser: pressed Enter after typing at (%d, %d)', request.point.x, request.point.y)
        }
        this.#activeGuard().anchor(page.url())
        this.#assertJobUrl(page.url())
        return { url: page.url(), point }
      }
      const resolution = await this.#resolve(page, request)
      const target = this.#decideOn('type', resolution, request.allowOrigin === true)
      this.#authorizeTarget(resolution.url, resolution.facts[target.index])
      const element = resolution.element(target.index)
      if (resolution.facts[target.index]?.tag === 'select') {
        const selected = await this.#choose(element, resolution.ref, text)
        this.#activeGuard().anchor(page.url())
        this.#assertJobUrl(page.url())
        return { url: page.url(), target, selected }
      }
      if (await element.evaluate(isComboboxInput)) {
        const selected = await this.#typeIntoCombobox(page, resolution, element, text, request.allowOrigin === true, enter)
        this.#activeGuard().anchor(page.url())
        this.#assertJobUrl(page.url())
        return { url: page.url(), target, ...selected === undefined ? {} : { selected } }
      }
      if (await element.evaluate(isSpinButton)) {
        // A spin-button segment (Workday's date parts) takes digits from keydown and paints
        // them in a display on top: a click lands on the display and a written value leaves
        // it at "YYYY", so focus the field and send keystrokes.
        await element.focus()
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.press('Backspace')
        await page.keyboard.type(text)
        this.#log.info('headless-browser: typed %d keystroke(s) into spin button %s', text.length, resolution.ref)
      } else {
        await element.fill(text)
      }
      if (enter) {
        await element.press('Enter')
        this.#log.info('headless-browser: pressed Enter in %s after typing', resolution.ref)
      }
      this.#activeGuard().anchor(page.url())
      this.#assertJobUrl(page.url())
      return { url: page.url(), target }
    })
  }

  /**
   * Type into a searchable dropdown the way a person does, then choose the
   * option the text names. A written value never opens react-select's list, so
   * the text goes in as keystrokes; the list it opens is read, and the one
   * option {@link matchOption} picks is clicked after the guard clears it like
   * any click. No list, or no single match, leaves the typed text with the list
   * open for the model to click the option it means. A search box that lists
   * its matches only on Enter (a Workday prompt) gets Enter after the keystrokes.
   * @param page - the tab's page, whose keyboard types.
   * @param resolution - how the input was found: its reference, its document, and where to look up its options.
   * @param element - the combobox input.
   * @param text - the option's text.
   * @param allowOrigin - whether the agent allowed a site change for this action.
   * @param enter - whether to press Enter after the keystrokes, before reading the list.
   * @returns the chosen option's label, or nothing when none was chosen.
   */
  async #typeIntoCombobox(
    page: Page,
    resolution: Resolution,
    element: Actionable,
    text: string,
    allowOrigin: boolean,
    enter: boolean,
  ): Promise<string | undefined> {
    const ref = resolution.ref
    await element.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type(text)
    if (enter) {
      await page.keyboard.press('Enter')
      this.#log.info('headless-browser: pressed Enter in %s after typing', ref)
    }
    let options: readonly SelectOption[] = []
    for (let waited = 0; waited <= COMBOBOX_WAIT_MS && options.length === 0; waited += COMBOBOX_POLL_MS) {
      await page.waitForTimeout(COMBOBOX_POLL_MS)
      options = readSelectOptions(await element.evaluate(readComboboxOptions))
    }
    const index = matchOption(options, text)
    const option = index === undefined ? undefined : options[index]
    if (index === undefined || option === undefined) {
      this.#log.info('headless-browser: %s listed %d option(s) after typing; none chosen', ref, options.length)
      return undefined
    }
    this.#log.info('headless-browser: %s listed %d option(s) after typing; choosing option %d', ref, options.length, index + 1)
    const locator = resolution.scope.locator(`[id=${JSON.stringify(option.value)}]`)
    // A menu that fades or slides in lists its options before a person can see
    // them (Eightfold's Phone Device Type starts at opacity 0): wait for the
    // option to finish appearing, as a person would, then judge it. One that
    // never shows is still refused.
    let facts = readElementFacts(await locator.evaluate(probeElement))
    let settled = 0
    while (settled < OPTION_SETTLE_MS && scoreVisibility(facts).score < VISIBILITY_THRESHOLD) {
      await page.waitForTimeout(COMBOBOX_POLL_MS)
      settled += COMBOBOX_POLL_MS
      facts = readElementFacts(await locator.evaluate(probeElement))
    }
    if (settled > 0) this.#log.info('headless-browser: %s option %d took %d ms to appear', ref, index + 1, settled)
    this.#accept(this.#activeGuard().decideTarget({
      action: 'click',
      url: resolution.url,
      ref: `${ref} option`,
      candidates: [facts],
      allowOrigin,
    }))
    this.#authorizeTarget(resolution.url, facts)
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
      const target = this.#decideOn('type', resolution, false)
      const element = resolution.element(target.index)
      if (field === 'password' && !await element.evaluate(passwordInput)) {
        throw new SecretFieldError(`${resolution.ref} is not a password input (input[type=password]); a saved password is only written into one`)
      }
      if (hostOf(resolution.url) !== host) {
        throw new SecretFieldError(`the field is on ${hostOf(resolution.url)}, not ${host}; a saved credential is only written on its own host`)
      }
      if (this.#job.getStore() === undefined) await element.fill(secret)
      else {
        this.#authorizeTarget(resolution.url, resolution.facts[target.index])
        const pinned: ElementHandle<Element> = 'elementHandle' in element ? await element.elementHandle() : element
        try {
          const frame = await pinned.ownerFrame()
          if (frame === null || hostOf(frame.url()) !== host) throw new SecretFieldError('the credential target moved away from its saved host')
          if (field === 'password' && !await pinned.evaluate(passwordInput)) {
            throw new SecretFieldError('the credential target is no longer a password input')
          }
          await pinned.fill(secret)
        } finally {
          if (pinned !== element) await pinned.dispose()
        }
      }
      this.#log.info('headless-browser: wrote the saved %s for %s into %s', field, host, resolution.ref)
      return { url: page.url(), target }
    })
  }

  /**
   * Attach local files to a file input, or to the file chooser a visible
   * control opens. A file input is usually hidden behind a styled button, so a
   * selector that names an `input[type=file]` is used without the visibility
   * score; a trigger is a click and passes the guard like one, unless it names
   * only file inputs (a label points at the input), which then take the files
   * as a selector's would. The caller has
   * already checked the paths against the upload directories.
   * @param target - the file input selector, or the trigger control.
   * @param paths - absolute paths of the files.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the page URL and what received the files.
   * @throws Error - when the selector names no file input, or the trigger opened no chooser.
   */
  async attachFiles(target: AttachTarget, paths: string[] | UploadPayload[], tabId?: string): Promise<AttachOutcome> {
    return await this.#guarded('attaching files', async () => {
      const page = await this.page(tabId)
      this.#assertJobUrl(page.url())
      if (target.trigger !== undefined) {
        const resolution = await this.#resolve(page, target.trigger)
        const inputs = await fileInputsOf(resolution)
        if (inputs.length > 0 && inputs.length === resolution.facts.length) {
          // The trigger named the hidden file input itself, as SAP SuccessFactors labels its own with "Upload from Device";
          // it takes the files the way a selector-named input does.
          const pick = inputs[target.index ?? 0]
          if (pick === undefined) throw new Error(`${resolution.ref} matches ${String(inputs.length)} file input(s); index ${String(target.index)} is out of range`)
          const input = resolution.element(pick)
          if (paths.length > 1 && !await input.evaluate(node => node instanceof HTMLInputElement && node.multiple)) {
            throw new Error(`${resolution.ref} takes one file; attach the files one call each`)
          }
          if (this.#job.getStore() !== undefined) this.#authorizeTarget(resolution.url, resolution.facts[pick])
          await input.setInputFiles(paths)
          this.#log.info('headless-browser: trigger %s is a file input; attached %d file(s) to it on %s', resolution.ref, paths.length, pageOrigin(page.url()))
          return { url: page.url(), ref: resolution.ref, inputs: inputs.length }
        }
        const choice = this.#decideOn('click', resolution, false)
        this.#authorizeTarget(resolution.url, resolution.facts[choice.index])
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: FILE_CHOOSER_WAIT_MS }),
          resolution.element(choice.index).click(),
        ])
        if (paths.length > 1 && !chooser.isMultiple()) throw new Error(`${resolution.ref} opens a chooser that takes one file; attach the files one call each`)
        if (this.#job.getStore() !== undefined) {
          const input = chooser.element()
          const frame = await input.ownerFrame()
          this.#authorizeTarget(frame?.url() ?? '', readElementFacts(await input.evaluate(probeElement)))
        }
        await chooser.setFiles(paths)
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
      if (this.#job.getStore() !== undefined) {
        this.#authorizeTarget(located?.frame?.url() ?? page.url(), readElementFacts(await input.evaluate(probeElement)))
      }
      await input.setInputFiles(paths)
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
      (at: { x: number; y: number; job: boolean }) => {
        // Follow open shadow roots down, as the probe does, to the element a click there reaches.
        let hit = document.elementFromPoint(at.x, at.y)
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(at.x, at.y)
          if (inner === null || inner === hit) break
          hit = inner
        }
        if (at.job && hit !== null) {
          const control = 'a,button,input,textarea,select,label,[role=button],[role=link],[role=checkbox],[contenteditable=true]'
          let from: Element | null = hit
          while (from !== null) {
            const action: Element | null = from.closest(control)
            if (action instanceof HTMLLabelElement && action.control !== null) return action.control
            if (action !== null) return action
            const root = from.getRootNode()
            from = root instanceof ShadowRoot ? root.host : null
          }
        }
        return hit
      },
      { x: point.x, y: point.y, job: this.#job.getStore() !== undefined },
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
   * The advice a selector miss carries: the elements the page names by the
   * selector's words, each with a selector that matches it, so the model's next
   * call can land without a read. A failure here only costs the advice.
   * @param page - the page the selector missed on.
   * @param selector - the selector that matched nothing.
   * @returns one line for the miss.
   */
  async #missAdvice(page: Page, selector: string): Promise<string> {
    const key = selectorKey(selector)
    if (key === undefined) return missAdvice(undefined, [])
    try {
      const misses = await findNearMisses(page, key)
      this.#log.info('headless-browser: %s matches nothing on %s; the page names %s on %d element(s)%s', selector, pageOrigin(page.url()),
        JSON.stringify(key.text), misses.length, misses.length === 0 ? '' : `: ${misses.map(miss => miss.selector).join(' | ')}`)
      return missAdvice(key, misses)
    } catch (error: unknown) {
      this.#log.debug('headless-browser: looking for what %s meant failed: %s', selector, firstLine(error))
      return missAdvice(undefined, [])
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
      const frame = this.#job.getStore() === undefined ? null : await handle.ownerFrame()
      const url = frame?.url() ?? page.url()
      this.#assertJobUrl(url)
      const facts = readElementFacts(await handle.evaluate(probeElement))
      return { ref: request.axId, facts: [facts], element: () => handle, url, scope: frame ?? page }
    }
    const selector = request.selector
    if (selector === undefined) throw new Error('a guarded action needs a selector, an accessibility id, or a point')
    const located = await locate(page, selector)
    if (located === undefined) throw new SelectorMissError(selector, await this.#missAdvice(page, selector))
    const { locator, count, frame } = located
    this.#assertJobUrl(frame?.url() ?? page.url())
    if (located.waited) this.#log.info('headless-browser: %s appeared on %s within the settle wait', selector, pageOrigin(page.url()))
    if (frame !== undefined) {
      this.#log.info('headless-browser: %s matches nothing on %s; acting in its embedded page %s', selector, pageOrigin(page.url()), pageOrigin(frame.url()))
    }
    const facts: ElementFacts[] = []
    const covers: { readonly facts: ElementFacts; readonly element: Actionable; readonly aim?: ClickPoint }[] = []
    const aims = new Map<number, ClickPoint>()
    for (let index = 0; index < count; index += 1) {
      const candidate = readElementFacts(await locator.nth(index).evaluate(probeElement))
      facts.push(candidate)
      if (candidate.labelAim !== undefined) {
        // Label text partly under its own transparent input is clicked where the text is on top.
        aims.set(index, candidate.labelAim)
        this.#log.info('headless-browser: %s match %d: its label\'s own input covers its centre; clicking the text beside it', selector, index)
      }
      if ((candidate.tag === 'input' || candidate.tag === 'label') && scoreVisibility(candidate).score < VISIBILITY_THRESHOLD) {
        // A checkbox or radio the page draws itself hides the native input; its label or same-name box is what a person clicks.
        const standIn = (await locator.nth(index).evaluateHandle(findToggleStandIn)).asElement()
        if (standIn !== null) {
          const standInFacts = readElementFacts(await standIn.evaluate(probeElement))
          // A part of a click-through label is clicked where the box is, clear of any link inside it.
          const aim = await locator.nth(index).evaluate(findToggleAim) ?? undefined
          this.#log.info('headless-browser: %s match %d is a hidden %s; scoring the %s named %s that stands in for it',
            selector, index, candidate.role ?? 'toggle', standInFacts.tag, JSON.stringify(standInFacts.name))
          if (aim !== undefined) this.#log.info('headless-browser: %s match %d: its stand-in is clicked over the native box', selector, index)
          covers.push({ facts: standInFacts, element: standIn, ...aim === undefined ? {} : { aim } })
          continue
        }
      }
      if (candidate.ariaHidden && scoreVisibility({ ...candidate, ariaHidden: false, occlusion: 1 }).score >= VISIBILITY_THRESHOLD) {
        // Painted text marked aria-hidden (LinkedIn's card titles) is clicked through the element that reads exactly like it;
        // a same-name overlay found below competes with it on score, so Workday's covered buttons still reach theirs.
        const holder = (await locator.nth(index).evaluateHandle(findHiddenTextHolder)).asElement()
        if (holder !== null) {
          const holderFacts = readElementFacts(await holder.evaluate(probeElement))
          this.#log.info('headless-browser: %s match %d is aria-hidden text; scoring the %s named %s that holds it',
            selector, index, holderFacts.role ?? holderFacts.tag, JSON.stringify(holderFacts.name))
          covers.push({ facts: holderFacts, element: holder })
        }
      }
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
      aim: index => index < count ? aims.get(index) : covers[index - count]?.aim,
    }
  }

  /**
   * Report the guard's refusal, or return the element it chose.
   * @param decision - the guard's answer.
   * @returns the chosen element.
   */
  #authorizeTarget(url: string, facts?: ElementFacts): void {
    if (this.#job.getStore() === undefined) return
    this.#assertJobUrl(url)
    // A javascript: link runs the page's own script, as a button does (Tenet's Oracle "Application Questions" link);
    // whatever it then loads meets the network deny list.
    if (facts?.href != null && URL.parse(facts.href)?.protocol !== 'javascript:') this.#assertJobUrl(facts.href)
    // A javascript: form action runs page script the same way: AAIM's contact modal (geco.aaimtrack.com) saves through one.
    if (facts?.formAction != null && URL.parse(facts.formAction)?.protocol !== 'javascript:') {
      this.#assertJobUrl(facts.formAction)
      const decision = this.#activeGuard().decideNavigation({ action: 'open', url, target: facts.formAction, allowOrigin: false })
      if (!decision.allowed) throw new ActionRefusedError(blockedAction(refusalOf(decision)))
    }
  }

  /** Let the guard choose one of a resolved selector's candidates for an action, or refuse. */
  #decideOn(action: TargetDecisionInput['action'], resolution: Resolution, allowOrigin: boolean): TargetChoice {
    return this.#accept(this.#activeGuard().decideTarget({
      action,
      url: resolution.url,
      ref: resolution.ref,
      candidates: resolution.facts,
      allowOrigin,
      ...resolution.staleAxId === undefined ? {} : { staleAxId: resolution.staleAxId },
    }))
  }

  #accept(decision: Decision): TargetChoice {
    if (!decision.allowed || decision.target === undefined) throw new ActionRefusedError(blockedAction(refusalOf(decision)))
    return decision.target
  }

  /**
   * Hit-test a viewport point and let the guard decide an action there.
   * @param page - the page the point is on.
   * @param at - the viewport point the caller named.
   * @param action - the action that would land on it.
   * @param allowOrigin - whether the caller allowed acting outside the page's origin.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the accepted point.
   * @throws ActionRefusedError - when the guard refuses the point.
   */
  async #decideAtPoint(
    page: Page,
    at: { readonly x: number; readonly y: number },
    action: PointDecisionInput['action'],
    allowOrigin: boolean,
    tabId: string | undefined,
  ): Promise<PointChoice> {
    const hit = await this.#hitFacts(page, at)
    if (this.#job.getStore() !== undefined) {
      if (hit?.tag === 'iframe' || hit?.tag === 'frame') throw new Error('Use a selector for controls inside an embedded frame.')
      this.#authorizeTarget(page.url(), hit)
    }
    return this.#acceptPoint(this.#activeGuard().decidePoint({
      action,
      url: page.url(),
      x: at.x,
      y: at.y,
      ...tabId === undefined ? {} : { tabId },
      ...hit === undefined ? {} : { hit },
      allowOrigin,
    }))
  }

  async #guardJobFocus(page: Page): Promise<void> {
    if (this.#job.getStore() === undefined) return
    const url = page.url()
    this.#assertJobUrl(url)
    const handle = await page.evaluateHandle(() => {
      let element = document.activeElement
      while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement
      const editable = element instanceof HTMLElement && element.isContentEditable
        || element instanceof HTMLTextAreaElement && !element.readOnly
        || element instanceof HTMLInputElement && !element.readOnly
          && /^(?:text|search|email|tel|url|password|number)$/u.test(element.type)
      return editable ? element : null
    })
    try {
      const field = handle.asElement()
      if (field === null) throw new Error('The viewport point did not focus an editable field.')
      const hit = readElementFacts(await field.evaluate(probeElement))
      this.#authorizeTarget(url, hit)
      this.#accept(this.#activeGuard().decideTarget({ action: 'type', url, ref: 'focused field', candidates: [hit], allowOrigin: false }))
    } finally { await handle.dispose() }
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
      const page = await this.tabs().createReserved(context, (page) => { this.#background.add(page) })
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
        text: async () => await page.evaluate(() => document.querySelector('body')?.innerText ?? ''),
        close: async () => {
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
    // A launch sets the context and its session id together.
    if (this.#context === undefined || this.#sessionId === undefined) return { launched: false }
    const tabs = this.#tabs?.state() ?? []
    const active = tabs.find(tab => tab.active)
    return {
      launched: true,
      sessionId: this.#sessionId,
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
    this.#jobSnapshots.clear()
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
    await this.#deps.tabStore?.flush()
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
    // `#guarded` checked `#closed` in the same tick, and the relaunch's own
    // `ensure()` refuses once a shutdown began during the wait.
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
    this.#log.info('headless-browser: the browser is back as session %s', this.#sessionId)
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
      if (this.#context !== context) return
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
    if (this.#deps.tabStore !== undefined) {
      const tabs = this.tabs()
      context.on('page', (page) => { tabs.observePage(page) })
      await tabs.reconcile(context)
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
    clearTimeout(timer)
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
      if (selector !== undefined) {
        const found = await selectedText(page, selector)
        if (found !== undefined || !await settle(page, selector)) return found
        return await selectedText(page, selector)
      }
      const target = page.locator('body').first()
      const own = await target.count() === 0 ? undefined : await target.innerText()
      const frames = await formFrames(page)
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
  /** Whether the match appeared only during the settle wait. */
  readonly waited?: boolean
}

/**
 * The text of a selector's first match on the page, or else in the first
 * embedded form page that has one.
 * @param page - the tab's page.
 * @param selector - the model's selector.
 * @returns the text, or nothing when no document matches.
 */
async function selectedText(page: Page, selector: string): Promise<string | undefined> {
  const target = page.locator(selector).first()
  if (await target.count() > 0) return await target.innerText()
  // A selector the page does not match may name a field of an embedded form.
  for (const { frame } of await formFrames(page)) {
    const inner = frame.locator(selector).first()
    if (await inner.count().catch(() => 0) > 0) return await inner.innerText({ timeout: FRAME_READ_TIMEOUT_MS })
  }
  return undefined
}

/**
 * Wait up to {@link MISS_SETTLE_MS} for a selector that matched nothing to
 * attach on the page; it returns as soon as one match does.
 * @param page - the tab's page.
 * @param selector - the selector that matched nothing.
 * @returns whether a match attached in time.
 */
async function settle(page: Page, selector: string): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: 'attached', timeout: MISS_SETTLE_MS })
    return true
  } catch {
    // Nothing attached in time, or the page cannot wait: the caller reports the miss.
    return false
  }
}

/**
 * Find a selector's matches on the page, or else in the first embedded form page
 * that has any: iCIMS renders its whole application inside a same-site iframe,
 * and opening that iframe's address on its own redirects back to the outer page.
 * A selector that matches nothing anywhere gets {@link MISS_SETTLE_MS} to appear
 * on the page first.
 * @param page - the tab's page.
 * @param selector - the model's selector.
 * @returns the matches and the frame they are in, or nothing when no document matches.
 */
async function locate(page: Page, selector: string): Promise<Located | undefined> {
  const found = await locateNow(page, selector)
  if (found !== undefined || !await settle(page, selector)) return found
  const late = await locateNow(page, selector)
  return late === undefined ? undefined : { ...late, waited: true }
}

/**
 * One look for a selector's matches on the page, then in its embedded form pages.
 * @param page - the tab's page.
 * @param selector - the model's selector.
 * @returns the matches and the frame they are in, or nothing when no document matches.
 */
async function locateNow(page: Page, selector: string): Promise<Located | undefined> {
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

/**
 * Whether an element is an explicit ARIA spin button, such as one segment of
 * Workday's date input. Playwright serialises this function.
 * @param element - the field about to be typed into.
 * @returns true for `role="spinbutton"`.
 */
function isSpinButton(element: Element): boolean {
  return element.getAttribute('role') === 'spinbutton'
}

/** A structural probe: selectors test for controls but never inspect or return their values. */
async function probeResume(page: Page, method?: string, httpErrorUrl?: string): Promise<ResumeProbe> {
  const chromiumError = page.url().startsWith('chrome-error:') || (await page.evaluate<string>('document.documentURI')).startsWith('chrome-error:')
  // Chromium's error UI has its own buttons; those are not site form controls.
  // A reload can re-submit a POST. Only retry navigation observed to be a GET.
  if (chromiumError) return { hasForm: false, errorPage: method === 'GET' }
  const counts = await Promise.all(page.frames().map(async (frame) => {
    try {
      return await frame.locator('input:not([type=hidden]), textarea, button, select').count()
    } catch (error: unknown) {
      if (frame.isDetached() && !page.isClosed()) return 0
      throw error
    }
  }))
  const hasForm = counts.some(count => count > 0)
  return { hasForm, errorPage: !hasForm && method === 'GET' && httpErrorUrl === page.url().split('#', 1)[0] }
}
