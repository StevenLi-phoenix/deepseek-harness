/**
 * One persistent Chromium per plugin instance. The profile directory is the
 * browser's own state, so sign-ins survive a host restart; the launch is lazy
 * and single-flight, because the first tool call and the first page view race
 * each other and one Chromium must win.
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
import type { InputCommand } from './input.ts'

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
  /** URL of the shared page while it is open. */
  readonly url?: string
}

/** Launch, navigate, inspect, and close one persistent Chromium. */
export class HeadlessBrowserSession {
  readonly #config: Config
  readonly #log: Context['logger']
  #context: BrowserContext | undefined
  #launching: Promise<BrowserContext> | undefined
  #closed = false
  #sessionId: string | undefined
  #page: Page | undefined
  #cdp: CDPSession | undefined
  #cdpPage: Page | undefined

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

  /**
   * The page the agent and the take-over view share; a closed page is replaced,
   * because a crashed renderer must not strand every later operation.
   * @returns the live page.
   */
  async page(): Promise<Page> {
    const context = await this.ensure()
    const current = this.#page
    if (current !== undefined && !current.isClosed()) return current
    const page = context.pages().find(candidate => !candidate.isClosed()) ?? await context.newPage()
    this.#page = page
    this.#log.info('headless-browser: sharing page %s', page.url())
    return page
  }

  /**
   * The CDP session of the shared page, created once per page.
   * @returns the session that carries both live-view frames and forwarded input.
   */
  async cdp(): Promise<CDPSession> {
    const page = await this.page()
    if (this.#cdp !== undefined && this.#cdpPage === page) return this.#cdp
    const cdp = await page.context().newCDPSession(page)
    this.#cdp = cdp
    this.#cdpPage = page
    return cdp
  }

  /**
   * Perform one input command from the take-over page.
   * @param command - the validated command; `method` selects the CDP operation.
   */
  async dispatch(command: InputCommand): Promise<void> {
    const cdp = await this.cdp()
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
   * Navigate the shared page.
   * @param url - absolute URL; the page reports a relative one as invalid.
   * @returns the settled URL and the document title.
   */
  async open(url: string): Promise<{ url: string; title: string }> {
    const page = await this.page()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return { url: page.url(), title: await page.title() }
  }

  /**
   * Save a PNG of the shared page for the model to read.
   * @returns the file path and the page it captured.
   */
  async snapshot(): Promise<{ path: string; url: string }> {
    const page = await this.page()
    await mkdir(this.#config.snapshotDir, { recursive: true })
    const path = join(this.#config.snapshotDir, `page-${new Date().toISOString().replaceAll(':', '-')}.png`)
    await page.screenshot({ path })
    return { path, url: page.url() }
  }

  /**
   * Click the first element matching a CSS selector.
   * @param selector - selector the page resolves to one element.
   * @returns the page URL after the click, which may already be the navigation target.
   */
  async click(selector: string): Promise<{ url: string }> {
    const page = await this.page()
    await page.locator(selector).first().click()
    return { url: page.url() }
  }

  /**
   * Replace the editable value of the first element matching a CSS selector.
   * @param selector - selector for an input, textarea, or contenteditable element.
   * @param text - the value to write.
   */
  async fill(selector: string, text: string): Promise<void> {
    await (await this.page()).locator(selector).first().fill(text)
  }

  /**
   * What the browser is doing now, without launching it.
   * @returns whether a context is open, its session id, and the shared page URL.
   */
  status(): BrowserStatus {
    if (this.#context === undefined) return { launched: false }
    const page = this.#page
    return {
      launched: true,
      ...this.#sessionId === undefined ? {} : { sessionId: this.#sessionId },
      ...page === undefined || page.isClosed() ? {} : { url: page.url() },
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
    this.#page = undefined
    this.#cdp = undefined
    this.#cdpPage = undefined
    await context?.close()
  }

  async #launch(): Promise<BrowserContext> {
    await mkdir(this.#config.profileDir, { recursive: true })
    let context: BrowserContext
    try {
      context = await chromium.launchPersistentContext(this.#config.profileDir, {
        headless: this.#config.headless,
        viewport: { width: this.#config.viewportWidth, height: this.#config.viewportHeight },
      })
    } catch (error: unknown) {
      throw new BrowserUnavailableError(`the headless browser could not start: ${firstLine(error)}`)
    }
    if (this.#closed) {
      await context.close()
      throw new BrowserUnavailableError('the browser plugin is shutting down')
    }
    this.#context = context
    this.#sessionId = randomUUID()
    context.on('close', () => {
      this.#context = undefined
      this.#launching = undefined
      this.#page = undefined
      this.#cdp = undefined
      this.#cdpPage = undefined
    })
    this.#log.info('headless-browser: launched session %s with profile %s', this.#sessionId, this.#config.profileDir)
    return context
  }
}
