/**
 * Tabs over one persistent Chromium context. The agent and the take-over page
 * both work on the active tab unless they name another; the screencast follows
 * only the active one. A tab is a Playwright page with a stable id, a title, a
 * URL, and a loading flag, and every change is reported to whoever draws the
 * tab strip.
 *
 * The context is the browser's own state, so a tab close never closes it: the
 * last tab is replaced by a blank one before the old page goes away. New tabs
 * stop at a hard cap, and every navigation has its own deadline, so one stuck
 * site cannot leave the take-over view waiting forever.
 *
 * @module @deepseek-ai/dsh-headless-browser/tabs
 */

import type { Context } from '@deepseek-ai/cordis'
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
  on(event: string, listener: (...args: never[]) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
}

/** The context operations this module needs; a Playwright `BrowserContext` satisfies them. */
export interface TabsContext {
  pages(): readonly TabsPage[]
  newPage(): Promise<TabsPage>
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
    super(`the browser allows at most ${max} tabs; close one before opening another`)
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
export interface Tab {
  readonly id: string
  readonly page: TabsPage
  title: string
  url: string
  loading: boolean
  /** Set while this manager closes the page, so the close event is not handled twice. */
  closing: boolean
  /** Remove this tab's page listeners. */
  detach?: () => void
}

/** What the tab manager needs to open pages and report failures. */
export interface TabsOptions {
  /** Resolve the persistent context, launching it when needed. */
  readonly context: () => Promise<TabsContext>
  /** Plugin logger for page events that failed to settle. */
  readonly log: Context['logger']
  /** Most tabs kept open; defaults to {@link MAX_TABS}. */
  readonly maxTabs?: number
  /** Per-navigation deadline; defaults to {@link NAVIGATION_TIMEOUT_MS}. */
  readonly navigationTimeoutMs?: number
}

/** What the active tab and its CDP session are, for the screencast. */
export interface ActiveTab {
  readonly id: string
  readonly page: TabsPage
}

/** Tabs of one persistent browser context. */
export class BrowserTabs {
  readonly #options: TabsOptions
  readonly #maxTabs: number
  readonly #navigationTimeoutMs: number
  readonly #tabs = new Map<string, Tab>()
  readonly #order: string[] = []
  readonly #listeners = new Set<() => void>()
  #activeId: string | undefined
  #sequence = 0
  #queue: Promise<unknown> = Promise.resolve()
  #disposed = false

  /**
   * @param options - context resolver, logger, tab cap, and navigation deadline.
   */
  constructor(options: TabsOptions) {
    this.#options = options
    this.#maxTabs = options.maxTabs ?? MAX_TABS
    this.#navigationTimeoutMs = options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS
  }

  /** The tab strip's state, in opening order. */
  state(): TabInfo[] {
    return this.#order.map((id) => {
      const tab = this.#tabs.get(id)
      /* v8 ignore next -- the order and map are updated together. */
      if (tab === undefined) throw new Error(`tab ${id} is missing from its order`)
      return {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        loading: tab.loading,
        active: id === this.#activeId,
      }
    })
  }

  /** Observe every tab and active-tab change. */
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
  async active(): Promise<ActiveTab> {
    return this.#run(async () => {
      const tab = await this.#ensureActive()
      return { id: tab.id, page: tab.page }
    })
  }

  /**
   * A page by tab id, or the active tab's page when no id is named.
   * @param id - tab id, or nothing for the active tab.
   * @returns the page this operation acts on.
   * @throws TabNotFoundError - when the id names no open tab.
   */
  async page(id?: string): Promise<TabsPage> {
    return this.#run(async () => {
      if (id !== undefined) {
        const tab = this.#tabs.get(id)
        if (tab === undefined) throw new TabNotFoundError(id)
        return tab.page
      }
      return (await this.#ensureActive()).page
    })
  }

  /**
   * Open a tab, optionally navigating it.
   * @param url - absolute URL to load; nothing opens a blank tab.
   * @returns the new tab's state.
   * @throws TabLimitError - when the browser already has the maximum tabs.
   * @throws TabNavigationError - when the new tab's first navigation fails.
   */
  async create(url?: string): Promise<TabInfo> {
    return this.#run(async () => {
      if (this.#tabs.size >= this.#maxTabs) throw new TabLimitError(this.#maxTabs)
      const context = await this.#options.context()
      const page = this.#tabs.size === 0 ? await this.#firstPage(context) : await context.newPage()
      const tab = this.#adopt(page)
      this.#activeId = tab.id
      await page.bringToFront()
      if (url !== undefined) await this.#navigateTab(tab, url)
      this.#emit()
      return this.#info(tab)
    })
  }

  /**
   * Close a tab; the last tab is replaced so the browser stays open.
   * @param id - tab id, or nothing for the active tab.
   */
  async close(id?: string): Promise<void> {
    await this.#run(async () => {
      const tab = id === undefined && this.#activeId === undefined ? await this.#ensureActive() : this.#resolve(id)
      const index = this.#order.indexOf(tab.id)
      tab.closing = true
      let replacement: Tab | undefined
      if (this.#tabs.size === 1) {
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
        const next = this.#order[Math.min(index, this.#order.length - 1)]
        this.#activeId = next
      }
      this.#emit()
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
   */
  async navigate(url: string, id?: string): Promise<void> {
    await this.#run(async () => {
      const tab = id === undefined && this.#activeId === undefined ? await this.#ensureActive() : this.#resolve(id)
      await this.#navigateTab(tab, url)
    })
  }

  /** Go back in one tab's history. */
  async back(id?: string): Promise<void> {
    await this.#step(id, page => page.goBack({ waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs }))
  }

  /** Go forward in one tab's history. */
  async forward(id?: string): Promise<void> {
    await this.#step(id, page => page.goForward({ waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs }))
  }

  /** Reload one tab. */
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

  /** Stop reporting page events; the session's context close closes the pages. */
  dispose(): void {
    this.#disposed = true
    for (const tab of this.#tabs.values()) this.#detach(tab)
    this.#tabs.clear()
    this.#order.length = 0
    this.#activeId = undefined
    this.#listeners.clear()
  }

  async #step(id: string | undefined, run: (page: TabsPage) => Promise<unknown>): Promise<void> {
    await this.#run(async () => {
      const tab = id === undefined && this.#activeId === undefined ? await this.#ensureActive() : this.#resolve(id)
      tab.loading = true
      this.#emit()
      try {
        await run(tab.page)
        tab.loading = false
        await this.#refresh(tab)
      } catch (error: unknown) {
        tab.loading = false
        await this.#refresh(tab)
        throw new TabNavigationError(tab.url, firstLine(error))
      }
      this.#emit()
    })
  }

  async #navigateTab(tab: Tab, url: string): Promise<void> {
    const target = absoluteUrl(url)
    tab.loading = true
    this.#emit()
    try {
      await tab.page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs })
      tab.loading = false
      await this.#refresh(tab)
    } catch (error: unknown) {
      tab.loading = false
      await this.#refresh(tab)
      throw new TabNavigationError(target, firstLine(error))
    }
    this.#emit()
  }

  async #ensureActive(): Promise<Tab> {
    const current = this.#activeId === undefined ? undefined : this.#tabs.get(this.#activeId)
    if (current !== undefined) return current
    const first = this.#order.map(id => this.#tabs.get(id)).find(tab => tab !== undefined)
    if (first !== undefined) {
      this.#activeId = first.id
      return first
    }
    const context = await this.#options.context()
    const tab = this.#adopt(await this.#firstPage(context))
    this.#activeId = tab.id
    await tab.page.bringToFront()
    this.#emit()
    return tab
  }

  async #firstPage(context: TabsContext): Promise<TabsPage> {
    const reusable = context.pages().find(page => !page.isClosed() && !this.#hasPage(page))
    return reusable ?? await context.newPage()
  }

  #hasPage(page: TabsPage): boolean {
    for (const tab of this.#tabs.values()) if (tab.page === page) return true
    return false
  }

  #adopt(page: TabsPage): Tab {
    const id = `t${String(++this.#sequence)}`
    const tab: Tab = {
      id,
      page,
      title: '',
      url: page.url(),
      loading: false,
      closing: false,
    }
    this.#tabs.set(id, tab)
    this.#order.push(id)
    const onLoad = (): void => { this.#settle(tab) }
    const onNavigation = (): void => { this.#navigated(tab) }
    const onClose = (): void => { void this.#closed(tab) }
    page.on('domcontentloaded', onLoad)
    page.on('load', onLoad)
    page.on('framenavigated', onNavigation)
    page.on('close', onClose)
    tab.detach = () => {
      page.off('domcontentloaded', onLoad)
      page.off('load', onLoad)
      page.off('framenavigated', onNavigation)
      page.off('close', onClose)
    }
    void this.#refresh(tab)
    return tab
  }

  #detach(tab: Tab): void {
    tab.detach?.()
  }

  #settle(tab: Tab): void {
    if (tab.closing || !this.#tabs.has(tab.id)) return
    tab.loading = false
    void this.#refresh(tab)
  }

  #navigated(tab: Tab): void {
    if (tab.closing || !this.#tabs.has(tab.id)) return
    tab.url = tab.page.url()
    this.#emit()
    void this.#refresh(tab)
  }

  async #closed(tab: Tab): Promise<void> {
    if (tab.closing || !this.#tabs.has(tab.id)) return
    await this.#run(async () => {
      if (!this.#tabs.has(tab.id)) return
      const index = this.#order.indexOf(tab.id)
      this.#remove(tab)
      // A page closed by the site itself must not leave the browser with no tab
      // or its tools with no page; replace it exactly as an explicit close would.
      if (this.#tabs.size === 0) {
        const context = await this.#options.context()
        const replacement = this.#adopt(await context.newPage())
        this.#activeId = replacement.id
      } else if (this.#activeId === tab.id) {
        this.#activeId = this.#order[Math.min(index, this.#order.length - 1)]
      }
      this.#emit()
    })
  }

  async #refresh(tab: Tab): Promise<void> {
    if (!this.#tabs.has(tab.id)) return
    const url = tab.page.url()
    let title = tab.title
    try {
      title = await tab.page.title()
    } catch (error: unknown) {
      // A page that closed mid-read keeps the title it had; the close handler removes it.
      void error
    }
    if (!this.#tabs.has(tab.id)) return
    if (tab.url === url && tab.title === title) return
    tab.url = url
    tab.title = title
    this.#emit()
  }

  #remove(tab: Tab): void {
    this.#detach(tab)
    this.#tabs.delete(tab.id)
    const index = this.#order.indexOf(tab.id)
    if (index >= 0) this.#order.splice(index, 1)
  }

  #resolve(id?: string): Tab {
    if (id === undefined) {
      const active = this.#activeId === undefined ? undefined : this.#tabs.get(this.#activeId)
      if (active === undefined) throw new TabNotFoundError('active')
      return active
    }
    const tab = this.#tabs.get(id)
    if (tab === undefined) throw new TabNotFoundError(id)
    return tab
  }

  #info(tab: Tab): TabInfo {
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

  #run<T>(operation: () => Promise<T>): Promise<T> {
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
