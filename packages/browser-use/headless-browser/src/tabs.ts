/**
 * Tabs over one persistent Chromium context. The agent and the take-over page
 * both work on the active tab unless they name another; the screencast follows
 * only the active one. A tab is a Playwright page with a stable id, a title, a
 * URL, and a loading flag, and every change is reported to whoever draws the
 * tab strip.
 *
 * A window a page opens itself — a "Continue with Google" sign-in, a link with
 * `target=_blank` — becomes a tab too, and the active one, as in a desktop
 * browser; when it closes, its opener is active again.
 *
 * The context is the browser's own state, so a tab close never closes it: the
 * last tab is replaced by a blank one before the old page goes away. New tabs
 * stop at a hard cap, and every navigation has its own deadline, so one stuck
 * site cannot leave the take-over view waiting forever.
 *
 * @module @deepseek-ai/dsh-headless-browser/tabs
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TabObservation, TabStore } from './tab-store.ts'
import { firstLine } from './error.ts'
import type { TabAction, TabInfo } from './input.ts'

/** Largest number of tabs one browser keeps open. */
export const MAX_TABS = 8
/** Deadline for one navigation, so a silent site does not hold the tab forever. */
export const NAVIGATION_TIMEOUT_MS = 20_000

/** The page operations this module needs; a Playwright `Page` satisfies them. */
export interface TabsPage {
  url(): string
  title(): Promise<string>
  isClosed(): boolean
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>
  goBack(options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>
  goForward(options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>
  reload(options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>
  bringToFront(): Promise<void>
  close(): Promise<void>
  on(event: TabsPageEvent, listener: () => void): unknown
  on(event: 'popup', listener: (popup: this) => void): unknown
  on(event: 'framenavigated', listener: (frame: NavigationFrame) => void): unknown
  off(event: TabsPageEvent, listener: () => void): unknown
  off(event: 'popup', listener: (popup: this) => void): unknown
  off(event: 'framenavigated', listener: (frame: NavigationFrame) => void): unknown
}

/** Page events whose payload the tab manager ignores; a popup's payload is the new page. */
export type TabsPageEvent = 'close' | 'domcontentloaded' | 'load'

/** Only top-level navigation changes a tab's last-navigation timestamp. */
interface NavigationFrame { parentFrame(): object | null }

/**
 * The context operations this module needs; a Playwright `BrowserContext` satisfies them
 * with its own `Page` type, so the pages the manager hands back keep that type.
 */
export interface TabsContext<Page extends TabsPage = TabsPage> {
  pages(): readonly Page[]
  newPage(): Promise<Page>
}

/** A tab operation named a tab that is not open. */
export class TabNotFoundError extends Error {
  constructor(id: string) {
    super(`no tab named ${id}; use the active tab or open a new one`)
    this.name = 'TabNotFoundError'
  }
}

/** The browser is at its tab cap; the caller must close one first. */
export class TabLimitError extends Error {
  constructor(max: number) {
    super(`the browser allows at most ${max} tabs; close one with headless_browser_close before opening another`)
    this.name = 'TabLimitError'
  }
}

/** A navigation did not settle within its deadline or was refused by Chromium. */
export class TabNavigationError extends Error {
  constructor(url: string, detail: string) {
    super(`opening ${url} failed: ${detail}`)
    this.name = 'TabNavigationError'
  }
}

/** One open tab, as the manager keeps it. */
export interface Tab<Page extends TabsPage = TabsPage> {
  readonly id: string
  readonly page: Page
  readonly openedAt: string
  lastNavigatedAt: string
  openedBySessionId: string | null
  title: string
  url: string
  loading: boolean
  /** Set while this manager closes the page, so the close event is not handled twice. */
  closing: boolean
  /** The tab whose page opened this one as a popup. */
  openerId?: string
  /** Remove this tab's page listeners. */
  detach?: () => void
}

/** What the tab manager needs to open pages and report failures. */
export interface TabsOptions<Page extends TabsPage = TabsPage> {
  /** Resolve the persistent context, launching it when needed. */
  readonly context: () => Promise<TabsContext<Page>>
  /** Plugin logger for page events that failed to settle. */
  readonly log: Pick<Context['logger'], 'info' | 'warn'>
  /** Most tabs kept open; defaults to {@link MAX_TABS}. */
  readonly maxTabs?: number
  /** Per-navigation deadline; defaults to {@link NAVIGATION_TIMEOUT_MS}. */
  readonly navigationTimeoutMs?: number
  /**
   * Pages that belong to another owner — a keepalive's offscreen page — and are
   * never adopted as a tab, so they cannot spend one of the tab slots.
   */
  readonly reserved?: (page: Page) => boolean
  /**
   * Called for every page the manager adopts; the returned function runs when
   * the tab lets the page go. The session uses it to keep the page's downloads.
   */
  readonly onAdopt?: (page: Page, owner: string | null) => () => void
  /** Protect a popup before exposing it; returns its inherited owner, if any. */
  readonly preparePopup?: (page: Page, owner: string | null) => Promise<string | undefined>
  /** Stable IDs must not be reused after a browser restart when the ledger is enabled. */
  readonly nextId?: () => string
  /** Where the context records its tab metadata. */
  readonly store?: TabStore
}

/** Public discovery metadata for one interactive page. */
export type ListedTab = Omit<TabObservation, 'openedBySessionId'> & { readonly active: boolean }

/** Exactly one way to locate an already-open tab. */
export type ResumeTarget = { readonly tab: string } | { readonly urlSubstring: string }

/** An absent or ambiguous tab cannot be resumed. */
export class ResumeTabError extends Error {
  override readonly name = 'ResumeTabError'
}

/** What a document probe saw without reading page contents or form values. */
export interface ResumeProbe {
  readonly hasForm: boolean
  readonly errorPage: boolean
}

/** The active tab and the presence of form controls after a resume. */
export type ResumedTab = Pick<ListedTab, 'url' | 'title'> & { readonly tab: string; readonly hasForm: boolean }

/** What the active tab and its CDP session are, for the screencast. */
export interface ActiveTab<Page extends TabsPage = TabsPage> {
  readonly id: string
  readonly page: Page
}

/** What one tab close left behind. */
export interface ClosedTab {
  /** Id of the tab that closed. */
  readonly closed: string
  /** Whether a blank tab replaced the last tab, keeping the browser open. */
  readonly replaced: boolean
  /** Tabs still open, in opening order. */
  readonly tabs: TabInfo[]
}

/** A window a page opened, as a click reports it. */
export interface PopupTab {
  /** Tab id to pass to later calls. */
  readonly tab: string
  /** The tab that opened it. */
  readonly opener: string
  /** Its URL when reported; a popup that has not navigated yet shows about:blank. */
  readonly url: string
}

/**
 * Tabs of one persistent browser context. `Page` is the context's own page type,
 * so a Playwright context gets Playwright pages back and a test context its fakes.
 */
export class BrowserTabs<Page extends TabsPage = TabsPage> {
  readonly #options: TabsOptions<Page>
  readonly #maxTabs: number
  readonly #navigationTimeoutMs: number
  /** Open tabs in opening order: a Map keeps insertion order, and a removal leaves the rest in place. */
  readonly #tabs = new Map<string, Tab<Page>>()
  readonly #listeners = new Set<() => void>()
  #activeId: string | undefined
  #sequence = 0
  readonly #pendingPopups = new WeakSet<Page>()
  #queue: Promise<unknown> = Promise.resolve()
  #disposed = false
  /** Popups adopted so far, newest last, numbered from 1. */
  readonly #popups: { readonly seq: number; readonly id: string; readonly opener: string }[] = []
  #popupSeq = 0
  readonly #popupWaiters = new Set<() => void>()

  /**
   * @param options - context resolver, logger, tab cap, and navigation deadline.
   */
  constructor(options: TabsOptions<Page>) {
    this.#options = options
    this.#maxTabs = options.maxTabs ?? MAX_TABS
    this.#navigationTimeoutMs = options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS
  }

  /**
   * The tab strip's state.
   * @returns every open tab in opening order, with its title, URL, loading flag, and whether it is active.
   */
  state(): TabInfo[] {
    return [...this.#tabs.values()].map(tab => this.#info(tab))
  }

  /**
   * Adopt existing interactive pages, then reconcile the last ledger.
   * @param context - the newly opened browser context.
   */
  async reconcile(context: TabsContext<Page>): Promise<void> {
    this.#adoptPages(context)
    await this.#options.store?.reconcile([...this.#tabs.keys()])
  }

  /**
   * Adopt externally-created pages after explicit opens and popup handlers have claimed theirs.
   * @param page - the new page the context reported.
   */
  observePage(page: Page): void {
    void this.#run(() => {
      if (this.#pendingPopups.has(page) || !this.#canAdopt(page)) return
      const tab = this.#adopt(page)
      this.#activeId ??= tab.id
      this.#emit()
    }).catch((error: unknown) => {
      this.#options.log.warn('headless-browser: observing a tab failed: %s', firstLine(error))
    })
  }

  /**
   * Register an offscreen page on the same queue before discovery can adopt it.
   * @param context - the context that owns the page.
   * @param reserve - register the page as offscreen before the next queued operation.
   * @returns the new offscreen page.
   */
  async createReserved(context: TabsContext<Page>, reserve: (page: Page) => void): Promise<Page> {
    return await this.#run(async () => {
      const page = await context.newPage()
      reserve(page)
      return page
    })
  }

  /**
   * List current tabs without selecting one or inspecting document contents.
   * @param context - the live context whose pages the list reconciles.
   * @returns live tab metadata in adoption order.
   */
  async list(context: TabsContext<Page>): Promise<ListedTab[]> {
    return await this.#run(async () => {
      this.#adoptPages(context)
      await Promise.all([...this.#tabs.values()].map(tab => this.#refresh(tab)))
      return [...this.#tabs.values()].filter(tab => !tab.page.isClosed()).map(tab => ({
        id: tab.id, url: tab.url, title: tab.title, openedAt: tab.openedAt,
        lastNavigatedAt: tab.lastNavigatedAt, active: tab.id === this.#activeId,
      }))
    })
  }

  /**
   * Activate and inspect a live page; reload only browser blank/error documents.
   * @param context - the live context that owns the page.
   * @param target - existing tab id or unique URL substring.
   * @param probe - inspect the document without reading form values.
   * @returns metadata and form-control presence for the reactivated tab.
   */
  async resume(context: TabsContext<Page>, target: ResumeTarget, probe: (page: Page) => Promise<ResumeProbe>): Promise<ResumedTab> {
    return await this.#run(async () => {
      this.#adoptPages(context)
      const matches = [...this.#tabs.values()].filter(tab => !tab.page.isClosed() &&
        ('tab' in target ? tab.id === target.tab : tab.page.url().includes(target.urlSubstring)))
      const tab = matches[0]
      if (tab === undefined) throw new ResumeTabError('that tab is no longer open; list tabs with headless_browser_tabs, or reopen the page and refill the form')
      if (matches.length > 1) throw new ResumeTabError('more than one tab matches that URL; use headless_browser_tabs and give a tab id')
      try {
        await tab.page.bringToFront()
        this.#activeId = tab.id
        this.#emit()
        const inspectedUrl = tab.page.url()
        let inspected = await probe(tab.page)
        if (!inspected.hasForm && inspectedUrl === tab.page.url()
          && (inspectedUrl === 'about:blank' || inspected.errorPage)) {
          await this.#navigateBy(tab, page => page.reload({ waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs }))
          inspected = await probe(tab.page)
        }
        await this.#refresh(tab)
        if (!tab.page.isClosed()) return { tab: tab.id, url: tab.url, title: tab.title, hasForm: inspected.hasForm }
      } catch (error: unknown) {
        if (!tab.page.isClosed()) throw error
      }
      throw new ResumeTabError('that tab closed during resume; reopen the page and refill the form')
    })
  }

  /**
   * Observe every tab and active-tab change.
   * @param listener - called after each change; it reads the new state from {@link state}.
   * @returns how to stop listening.
   */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * The active tab, adopting the context's first page or opening a blank one.
   * @returns the tab every default operation acts on.
   */
  async active(): Promise<ActiveTab<Page>> {
    return this.#run(async () => {
      const tab = await this.#ensureActive()
      return { id: tab.id, page: tab.page }
    })
  }

  /** @param id - live tab id. @returns the trusted owner recorded for this tab. */
  owner(id: string): string | null | undefined {
    const tab = this.#tabs.get(id)
    return tab === undefined || tab.page.isClosed() ? undefined : tab.openedBySessionId
  }

  /**
   * A page by tab id, or the active tab's page when no id is named.
   * @param id - tab id, or nothing for the active tab.
   * @returns the page this operation acts on.
   * @throws TabNotFoundError - when the id names no open tab.
   */
  async page(id?: string): Promise<Page> {
    return this.#run(async () => {
      return id === undefined ? (await this.#ensureActive()).page : this.#resolve(id).page
    })
  }

  /**
   * Open a tab, optionally navigating it.
   * @param url - absolute URL to load; nothing opens a blank tab.
   * @param openedBySessionId - the DSH Session opening the tab, if any.
   * @param prepare - when present, require a fresh page and configure it before navigating.
   * @returns the new tab's state.
   * @throws TabLimitError - when the browser already has the maximum tabs.
   * @throws TabNavigationError - when the new tab's first navigation fails.
   */
  async create(url?: string, openedBySessionId?: string, prepare?: (page: Page, id: string) => Promise<void>): Promise<TabInfo> {
    return this.#run(async () => {
      if (this.#tabs.size >= this.#maxTabs) throw new TabLimitError(this.#maxTabs)
      const context = await this.#options.context()
      const page = prepare === undefined && this.#tabs.size === 0 ? await this.#firstPage(context) : await context.newPage()
      const tab = this.#adopt(page, openedBySessionId)
      this.#activeId = tab.id
      await page.bringToFront()
      try {
        await prepare?.(page, tab.id)
        if (url !== undefined) await this.#navigateTab(tab, url)
      } catch (error: unknown) {
        if (prepare !== undefined) await page.close().catch((closed: unknown) => { void closed })
        throw error
      }
      this.#emit()
      return this.#info(tab)
    })
  }

  /**
   * Close a tab; the last tab is replaced so the browser stays open.
   * @param id - tab id, or nothing for the active tab.
   * @returns the closed id, whether a blank tab replaced it, and the tabs that remain.
   */
  async close(id?: string): Promise<ClosedTab> {
    return await this.#run(async () => {
      const tab = id === undefined ? await this.#ensureActive() : this.#resolve(id)
      const index = this.#position(tab)
      const replaced = this.#tabs.size === 1
      tab.closing = true
      let replacement: Tab<Page> | undefined
      if (replaced) {
        const context = await this.#options.context()
        replacement = this.#adopt(await context.newPage())
        this.#activeId = replacement.id
        await replacement.page.bringToFront()
      }
      try {
        await tab.page.close()
      } catch (error: unknown) {
        tab.closing = false
        this.#options.log.warn('headless-browser: closing tab %s failed: %s', tab.id, firstLine(error))
        throw error
      }
      this.#remove(tab)
      if (replacement === undefined && this.#activeId === tab.id) {
        const opener = tab.openerId === undefined ? undefined : this.#tabs.get(tab.openerId)
        this.#activeId = opener?.id ?? this.#idAt(index)
      }
      this.#emit()
      return { closed: tab.id, replaced, tabs: this.state() }
    })
  }

  /**
   * Make one tab the one the screencast follows.
   * @param id - tab id.
   */
  async activate(id: string): Promise<void> {
    await this.#run(async () => {
      const tab = this.#resolve(id)
      this.#activeId = tab.id
      await tab.page.bringToFront()
      this.#emit()
    })
  }

  /**
   * Navigate one tab to an absolute URL.
   * @param url - absolute URL with an http, https, data, or about scheme.
   * @param id - tab id, or nothing for the active tab.
   * @param sessionId - Session to credit for first use of an unclaimed blank page.
   */
  async navigate(url: string, id?: string, sessionId?: string): Promise<void> {
    await this.#run(async () => {
      const tab = id === undefined ? await this.#ensureActive() : this.#resolve(id)
      if (sessionId !== undefined && tab.openedBySessionId === null && tab.url === 'about:blank') {
        tab.openedBySessionId = sessionId
        this.#options.store?.see(tab)
      }
      await this.#navigateTab(tab, url)
    })
  }

  /**
   * Go back in one tab's history, within the navigation deadline.
   * @param id - tab id, or nothing for the active tab.
   * @throws TabNavigationError - when the navigation fails or misses its deadline.
   */
  async back(id?: string): Promise<void> {
    await this.#step(id, page => page.goBack({ waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs }))
  }

  /**
   * Go forward in one tab's history, within the navigation deadline.
   * @param id - tab id, or nothing for the active tab.
   * @throws TabNavigationError - when the navigation fails or misses its deadline.
   */
  async forward(id?: string): Promise<void> {
    await this.#step(id, page => page.goForward({ waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs }))
  }

  /**
   * Reload one tab, within the navigation deadline.
   * @param id - tab id, or nothing for the active tab.
   * @throws TabNavigationError - when the reload fails or misses its deadline.
   */
  async reload(id?: string): Promise<void> {
    await this.#step(id, page => page.reload({ waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs }))
  }

  /**
   * Apply one tab command from the take-over page.
   * @param action - the operation the page asked for.
   * @param tabId - the tab, or nothing for the active tab.
   * @param url - the navigation target, when the action needs one.
   */
  async command(action: TabAction, tabId?: string, url?: string): Promise<void> {
    switch (action) {
      case 'new': await this.create(url); return
      case 'close': await this.close(tabId); return
      case 'activate': await this.activate(tabId ?? (await this.active()).id); return
      case 'navigate': await this.navigate(url ?? '', tabId); return
      case 'back': await this.back(tabId); return
      case 'forward': await this.forward(tabId); return
      case 'reload': await this.reload(tabId); return
      /* v8 ignore next -- the union is closed and every action returns above. */
      default: return
    }
  }

  /**
   * A marker for {@link popupsSince}, taken before an action that may open a window.
   * @returns the sequence number of the newest popup adopted so far; 0 before any.
   */
  popupMark(): number {
    return this.#popupSeq
  }

  /**
   * The windows pages opened after a marker that are still open.
   * @param mark - a value {@link popupMark} returned.
   * @param waitMs - how long to wait for one when none has opened; 0 does not wait.
   * @returns the popups, oldest first.
   */
  async popupsSince(mark: number, waitMs: number): Promise<PopupTab[]> {
    if (this.#popupSeq === mark && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          this.#popupWaiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, waitMs)
        this.#popupWaiters.add(done)
      })
    }
    // A popup is adopted on the tab queue; let an adoption already queued finish.
    await this.#run(async () => {})
    const open: PopupTab[] = []
    for (const popup of this.#popups) {
      const tab = this.#tabs.get(popup.id)
      if (popup.seq > mark && tab !== undefined) open.push({ tab: popup.id, opener: popup.opener, url: tab.url })
    }
    return open
  }

  /** Stop reporting page events; the session's context close closes the pages. */
  dispose(): void {
    this.#disposed = true
    for (const tab of this.#tabs.values()) this.#detach(tab)
    this.#tabs.clear()
    this.#activeId = undefined
    this.#listeners.clear()
    for (const waiter of [...this.#popupWaiters]) waiter()
  }

  async #step(id: string | undefined, run: (page: Page) => Promise<unknown>): Promise<void> {
    await this.#run(async () => {
      const tab = id === undefined ? await this.#ensureActive() : this.#resolve(id)
      await this.#navigateBy(tab, run)
    })
  }

  async #navigateTab(tab: Tab<Page>, url: string): Promise<void> {
    const target = absoluteUrl(url)
    await this.#navigateBy(tab, page => page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs }), target)
  }

  async #navigateBy(tab: Tab<Page>, run: (page: Page) => Promise<unknown>, target = tab.url): Promise<void> {
    tab.loading = true
    this.#emit()
    try {
      // Back/forward can return null without moving; real navigations also emit framenavigated.
      const response = await run(tab.page)
      if (response !== null) this.#recordNavigation(tab)
    } catch (error: unknown) {
      throw new TabNavigationError(target, firstLine(error))
    } finally {
      tab.loading = false
      await this.#refresh(tab)
      this.#emit()
    }
  }

  async #ensureActive(): Promise<Tab<Page>> {
    // The active id names an open tab whenever one is open, so no tab here means none is open.
    const current = this.#activeId === undefined ? undefined : this.#tabs.get(this.#activeId)
    if (current !== undefined) return current
    const context = await this.#options.context()
    // A context launch may have adopted its startup pages while ensure was pending.
    const adopted = this.#activeId === undefined ? undefined : this.#tabs.get(this.#activeId)
    if (adopted !== undefined) return adopted
    const tab = this.#adopt(await this.#firstPage(context))
    this.#activeId = tab.id
    await tab.page.bringToFront()
    this.#emit()
    return tab
  }

  async #firstPage(context: TabsContext<Page>): Promise<Page> {
    const reusable = context.pages().find(page => !page.isClosed()
      && !this.#hasPage(page)
      && !(this.#options.reserved?.(page) ?? false))
    return reusable ?? await context.newPage()
  }

  #hasPage(page: Page): boolean {
    for (const tab of this.#tabs.values()) if (tab.page === page) return true
    return false
  }

  #canAdopt(page: Page): boolean {
    return !this.#disposed && !page.isClosed() && !this.#hasPage(page) && !(this.#options.reserved?.(page) ?? false)
  }

  #adoptPages(context: TabsContext<Page>): void {
    let changed = false
    for (const page of context.pages()) {
      if (this.#pendingPopups.has(page) || !this.#canAdopt(page)) continue
      const tab = this.#adopt(page)
      this.#activeId ??= tab.id
      changed = true
    }
    if (changed) this.#emit()
  }

  #adopt(page: Page, openedBySessionId: string | null = null): Tab<Page> {
    const id = this.#options.nextId?.() ?? `t${String(++this.#sequence)}`
    const openedAt = new Date().toISOString()
    const tab: Tab<Page> = {
      id,
      page,
      title: '',
      url: page.url(),
      openedAt,
      lastNavigatedAt: openedAt,
      openedBySessionId,
      loading: false,
      closing: false,
    }
    this.#tabs.set(id, tab)
    const onLoad = (): void => { this.#settle(tab) }
    const onNavigation = (frame?: NavigationFrame): void => {
      if (frame === undefined || frame.parentFrame() === null) this.#navigated(tab)
    }
    const onClose = (): void => { void this.#closed(tab) }
    const onPopup = (popup: Page): void => {
      this.#pendingPopups.add(popup)
      void this.#popup(tab, popup)
    }
    page.on('domcontentloaded', onLoad)
    page.on('load', onLoad)
    page.on('framenavigated', onNavigation)
    page.on('close', onClose)
    page.on('popup', onPopup)
    const detachAdopt = this.#options.onAdopt?.(page, openedBySessionId)
    tab.detach = () => {
      detachAdopt?.()
      page.off('domcontentloaded', onLoad)
      page.off('load', onLoad)
      page.off('framenavigated', onNavigation)
      page.off('close', onClose)
      page.off('popup', onPopup)
    }
    this.#options.store?.see(tab)
    void this.#refresh(tab)
    return tab
  }

  #detach(tab: Tab<Page>): void {
    tab.detach?.()
  }

  /**
   * Adopt a window a tab's page opened, and make it the active tab. A popup is
   * adopted even at the tab cap: the site opened it, and a window nobody can
   * reach would leave its sign-in or consent step unanswerable.
   */
  async #popup(opener: Tab<Page>, popup: Page): Promise<void> {
    try {
      await this.#run(async () => {
        if (this.#disposed || popup.isClosed() || this.#hasPage(popup) || (this.#options.reserved?.(popup) ?? false)) return
        const owner = await this.#options.preparePopup?.(popup, opener.openedBySessionId)
        if (popup.isClosed()) return
        const tab = this.#adopt(popup, owner)
        tab.openerId = opener.id
        this.#activeId = tab.id
        this.#popups.push({ seq: ++this.#popupSeq, id: tab.id, opener: opener.id })
        if (this.#popups.length > this.#maxTabs * 4) this.#popups.splice(0, this.#popups.length - this.#maxTabs * 4)
        if (this.#tabs.size > this.#maxTabs) {
          this.#options.log.warn('headless-browser: %s opened popup %s past the %d-tab cap', opener.id, tab.id, this.#maxTabs)
        } else {
          this.#options.log.info('headless-browser: %s opened popup %s (%s)', opener.id, tab.id, popup.url())
        }
        await popup.bringToFront()
        this.#emit()
      })
    } catch (error: unknown) {
      // Nobody awaits this handler; a popup that closed mid-adoption is simply gone.
      this.#options.log.warn('headless-browser: adopting a popup of %s failed: %s', opener.id, firstLine(error))
    }
    this.#pendingPopups.delete(popup)
    for (const waiter of [...this.#popupWaiters]) waiter()
  }

  #settle(tab: Tab<Page>): void {
    if (tab.closing || !this.#tabs.has(tab.id)) return
    tab.loading = false
    void this.#refresh(tab)
  }

  #navigated(tab: Tab<Page>): void {
    if (tab.closing || !this.#tabs.has(tab.id)) return
    this.#recordNavigation(tab)
    this.#emit()
    void this.#refresh(tab)
  }

  #recordNavigation(tab: Tab<Page>): void {
    if (!this.#tabs.has(tab.id)) return
    tab.url = tab.page.url()
    tab.lastNavigatedAt = new Date().toISOString()
    this.#options.store?.see(tab)
  }

  async #closed(tab: Tab<Page>): Promise<void> {
    if (tab.closing || !this.#tabs.has(tab.id)) return
    try {
      await this.#run(async () => {
        if (!this.#tabs.has(tab.id)) return
        const index = this.#position(tab)
        this.#remove(tab)
        // A page closed by the site itself must not leave the browser with no tab
        // or its tools with no page; replace it exactly as an explicit close would.
        if (this.#tabs.size === 0) {
          const context = await this.#options.context()
          const replacement = this.#adopt(await context.newPage())
          this.#activeId = replacement.id
        } else if (this.#activeId === tab.id) {
          // A sign-in popup closes itself when it is done; its opener carries on.
          const opener = tab.openerId === undefined ? undefined : this.#tabs.get(tab.openerId)
          this.#activeId = opener?.id ?? this.#idAt(index)
          if (opener !== undefined) {
            this.#options.log.info('headless-browser: popup %s closed; back on %s', tab.id, opener.id)
            await opener.page.bringToFront()
          }
        }
        this.#emit()
      })
    } catch (error: unknown) {
      // Nobody awaits this handler: a browser that died takes the replacement
      // page with it, and the session relaunches on the next operation. Letting
      // the rejection escape would end the process instead.
      this.#options.log.warn('headless-browser: replacing the closed tab %s failed: %s', tab.id, firstLine(error))
      this.#emit()
    }
  }

  async #refresh(tab: Tab<Page>): Promise<void> {
    if (!this.#tabs.has(tab.id)) return
    const url = tab.page.url()
    let title = tab.title
    try {
      title = await tab.page.title()
    } catch (error: unknown) {
      // A page that closed mid-read keeps the title it had; the close handler removes it.
      void error
    }
    // A newer navigation superseded the asynchronous title read.
    if (!this.#tabs.has(tab.id) || url !== tab.page.url()) return
    const changedUrl = tab.url !== url
    if (changedUrl) this.#recordNavigation(tab)
    if (!changedUrl && tab.title === title) return
    tab.title = title
    this.#options.store?.see(tab)
    this.#emit()
  }

  #remove(tab: Tab<Page>): void {
    this.#detach(tab)
    this.#tabs.delete(tab.id)
    this.#options.store?.closed(tab.id, new Date().toISOString())
  }

  /** Where one tab sits in the opening order. */
  #position(tab: Tab<Page>): number {
    return [...this.#tabs.keys()].indexOf(tab.id)
  }

  /** The tab now at one position of the opening order, or the last tab when the position is past the end. */
  #idAt(index: number): string | undefined {
    const ids = [...this.#tabs.keys()]
    return ids[Math.min(index, ids.length - 1)]
  }

  #resolve(id: string): Tab<Page> {
    const tab = this.#tabs.get(id)
    if (tab === undefined) throw new TabNotFoundError(id)
    return tab
  }

  #info(tab: Tab<Page>): TabInfo {
    return { id: tab.id, title: tab.title, url: tab.url, loading: tab.loading, active: tab.id === this.#activeId }
  }

  #emit(): void {
    if (this.#disposed) return
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error: unknown) {
        this.#options.log.warn('headless-browser: tab listener failed: %s', firstLine(error))
      }
    }
  }

  #run<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation)
    this.#queue = next.then(() => undefined, () => undefined)
    return next
  }
}

/** Validate and return an absolute URL the browser may load. */
function absoluteUrl(value: string): string {
  const text = value.trim()
  if (text === '') throw new TabNavigationError(value, 'the address is empty')
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch (error: unknown) {
    void error
    throw new TabNavigationError(value, 'the address is not an absolute URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:'
    && parsed.protocol !== 'data:' && parsed.protocol !== 'about:') {
    throw new TabNavigationError(value, `the ${parsed.protocol} scheme is not supported here`)
  }
  return text
}
