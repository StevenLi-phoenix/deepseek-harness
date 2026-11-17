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
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core'
import type { Config } from './config.ts'
import { firstLine } from './error.ts'
import type { InputCommand, TabInfo, TabMessage } from './input.ts'
import { applyStealth, stealthIdentity, stealthLaunch } from './stealth.ts'
import { BrowserTabs, type ActiveTab, type TabsContext } from './tabs.ts'

/** The browser cannot run, so a tool reports the reason instead of retrying. */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserUnavailableError'
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

/** Launch, navigate, inspect, and close one persistent Chromium with tabs. */
export class HeadlessBrowserSession {
  readonly #config: Config
  readonly #log: Context['logger']
  #context: BrowserContext | undefined
  #launching: Promise<BrowserContext> | undefined
  #closed = false
  #sessionId: string | undefined
  #tabs: BrowserTabs | undefined
  /** Stops watching for pages once the context is gone. */
  #stopStealth: (() => void) | undefined
  readonly #cdps = new WeakMap<Page, CDPSession>()

  /**
   * @param config - profile, viewport, and snapshot settings.
   * @param log - plugin logger for launch and shutdown facts.
   */
  constructor(config: Config, log: Context['logger']) {
    this.#config = config
    this.#log = log
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

  /** The tab model over the persistent context, created on first use. */
  tabs(): BrowserTabs {
    this.#tabs ??= new BrowserTabs({
      context: async () => await this.ensure() as unknown as TabsContext,
      log: this.#log,
    })
    return this.#tabs
  }

  /** The tab strip's state, or an empty list before the browser starts. */
  tabsState(): TabInfo[] {
    return this.#tabs?.state() ?? []
  }

  /** Observe tab and active-tab changes. */
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
    const page = await this.tabs().page(id)
    return page as unknown as Page
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
    const tab: ActiveTab = await this.tabs().active()
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
    await this.tabs().command(message.action, message.tabId, message.url)
  }

  /**
   * Open a URL in the active tab, or in a new one.
   * @param url - absolute URL; the page reports a relative one as invalid.
   * @param newTab - open a new tab instead of reusing the active one.
   * @returns the settled URL and the document title.
   */
  async open(url: string, newTab = false): Promise<{ url: string; title: string }> {
    if (newTab) {
      const tab = await this.tabs().create(url)
      return { url: tab.url, title: tab.title }
    }
    await this.tabs().navigate(url)
    const page = await this.page()
    return { url: page.url(), title: await page.title() }
  }

  /**
   * Save a PNG of one tab for the model to read.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the file path and the page it captured.
   */
  async snapshot(tabId?: string): Promise<{ path: string; url: string }> {
    const page = await this.page(tabId)
    await mkdir(this.#config.snapshotDir, { recursive: true })
    const path = join(this.#config.snapshotDir, `page-${new Date().toISOString().replaceAll(':', '-')}.png`)
    await page.screenshot({ path })
    return { path, url: page.url() }
  }

  /**
   * Click the first element matching a CSS selector in one tab.
   * @param selector - selector the page resolves to one element.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the page URL after the click, which may already be the navigation target.
   */
  async click(selector: string, tabId?: string): Promise<{ url: string }> {
    const page = await this.page(tabId)
    await page.locator(selector).first().click()
    return { url: page.url() }
  }

  /**
   * Replace the editable value of the first element matching a CSS selector in one tab.
   * @param selector - selector for an input, textarea, or contenteditable element.
   * @param text - the value to write.
   * @param tabId - tab id, or nothing for the active tab.
   */
  async fill(selector: string, text: string, tabId?: string): Promise<void> {
    await (await this.page(tabId)).locator(selector).first().fill(text)
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

  /** Close the context and wait for Chromium to exit; later calls stay closed. */
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
    this.#context = undefined
    this.#tabs?.dispose()
    this.#tabs = undefined
    await context?.close()
  }

  async #launch(): Promise<BrowserContext> {
    await mkdir(this.#config.profileDir, { recursive: true })
    // One identity for the whole context: the launch settings, and later the
    // per-page overrides that keep the client hints in step with it.
    const stealth = this.#config.stealth ? stealthIdentity() : undefined
    let context: BrowserContext
    try {
      context = await chromium.launchPersistentContext(this.#config.profileDir, {
        headless: this.#config.headless,
        viewport: { width: this.#config.viewportWidth, height: this.#config.viewportHeight },
        ...stealth === undefined ? {} : stealthLaunch(stealth),
      })
    } catch (error: unknown) {
      throw new BrowserUnavailableError(`the headless browser could not start: ${firstLine(error)}`)
    }
    if (this.#closed) {
      await context.close()
      throw new BrowserUnavailableError('the browser plugin is shutting down')
    }
    if (stealth !== undefined) this.#stopStealth = await applyStealth<Page>(context, this.#log, stealth)
    this.#context = context
    this.#sessionId = randomUUID()
    context.on('close', () => {
      this.#stopStealth?.()
      this.#stopStealth = undefined
      this.#context = undefined
      this.#launching = undefined
      this.#tabs?.dispose()
      this.#tabs = undefined
    })
    this.#log.info('headless-browser: launched session %s with profile %s', this.#sessionId, this.#config.profileDir)
    return context
  }
}
