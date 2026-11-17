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
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { chromium, type BrowserContext, type CDPSession, type ConsoleMessage, type Page } from 'playwright-core'
import { AX_ID_ATTRIBUTE, PageAxIds, StaleAxIdError, UnknownAxIdError, parseAxId } from './ax-ids.ts'
import type { Config } from './config.ts'
import { firstLine } from './error.ts'
import type { InputCommand, TabInfo, TabMessage } from './input.ts'
import {
  formatAxTree, pngSize, shapeEval, truncate,
  LOOK_DIGEST_CHARS, LOOK_DIGEST_NODES, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS,
  type AxNode, type AxRead, type EvalReport, type ImageSize,
} from './inspect.ts'
import { readText, type ReadPage, type ReadRequest, type ReadResult } from './read.ts'
import { cdpScrollChannel, scrollPage, type ScrollRequest, type ScrollResult } from './scroll.ts'
import { applyStealth, stealthIdentity, stealthLaunch } from './stealth.ts'
import { BrowserTabs, type ActiveTab, type ClosedTab, type TabsContext } from './tabs.ts'

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

/** The element an acting tool targets: a CSS selector, or an id an accessibility read printed. */
export type BrowserTarget = { readonly selector: string } | { readonly axId: string }

/** How one accessibility read is scoped. */
export interface AxReadOptions {
  /** Read only this element's subtree; the whole page when omitted. */
  readonly selector?: string
  /** Most nodes printed; the text ends with an `N more nodes` line past it. */
  readonly maxNodes?: number
}

/** How one `look` call is shaped. */
export interface LookOptions {
  /** Capture the whole scrollable page instead of the viewport. */
  readonly fullPage?: boolean
  /** Include the accessibility digest; on unless this is false. */
  readonly text?: boolean
}

/** How one capture is shaped. */
export interface CaptureOptions {
  /** Capture the whole scrollable page instead of the viewport. */
  readonly fullPage?: boolean
}

/** One captured page: the file, the bytes, and how much of the page they show. */
export interface Capture {
  /** Absolute path of the written PNG. */
  readonly path: string
  /** Page URL when the capture settled. */
  readonly url: string
  /** Width of the image actually returned. */
  readonly width: number
  /** Height of the image actually returned. */
  readonly height: number
  /** Whether the capture covered the whole scrollable page. */
  readonly fullPage: boolean
  /** Capture scale below one when a large page had to be shrunk to stay bounded. */
  readonly scale: number
  /** Whether the returned image is smaller than the page it shows. */
  readonly downscaled: boolean
  /** The PNG bytes, the same image the path holds. */
  readonly data: Uint8Array
}

/** The accessibility digest `look` returns beside its screenshot, bounded. */
export interface LookDigest {
  /** The capped accessibility text. */
  readonly text: string
  /** Nodes printed. */
  readonly nodes: number
  /** Printed nodes whose role is interactive, each with an id. */
  readonly interactive: number
  /** Nodes the node cap left out. */
  readonly omitted: number
  /** Whether the character cap shortened the text. */
  readonly truncated: boolean
}

/** What one `look` call returns: the picture, and what the page reads as. */
export interface LookReport extends Capture {
  /** The accessibility digest, unless the call turned it off. */
  readonly digest?: LookDigest
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
  /** Accessibility ids per page; a navigation drops the page's mapping. */
  readonly #axIds = new WeakMap<Page, PageAxIds>()
  /** Browser-wide id counter, so an id from one tab never names a node in another. */
  #axSequence = 0

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
   * Close one tab; the last tab is replaced by a blank one so the browser stays open.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the closed id, whether a blank tab replaced it, and the tabs that remain.
   * @throws NoOpenTabError - when no tab is open, so closing cannot start the browser.
   */
  async closeTab(tabId?: string): Promise<ClosedTab> {
    if (this.tabsState().length === 0) throw new NoOpenTabError()
    return await this.tabs().close(tabId)
  }

  /**
   * Scroll one tab by a vertical distance or to an edge, without evaluating page script.
   * @param request - distance or edge, and the point whose element receives the wheel.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the resulting scroll position, page height, and whether an edge was reached.
   */
  async scroll(request: ScrollRequest, tabId?: string): Promise<ScrollResult> {
    const page = await this.page(tabId)
    const cdp = await this.cdp(tabId)
    const size = page.viewportSize() ?? { width: this.#config.viewportWidth, height: this.#config.viewportHeight }
    return await scrollPage(cdpScrollChannel(cdp), request, size)
  }

  /**
   * Scroll one element into view, named by an id an accessibility read printed.
   * @param axId - the id the read printed.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns where the page ended up, framed like a wheel scroll.
   */
  async scrollTo(axId: string, tabId?: string): Promise<ScrollResult> {
    const page = await this.page(tabId)
    const cdp = await this.cdp(tabId)
    const selector = await this.#locatorSelector({ axId }, page, cdp)
    const locator = page.locator(selector).first()
    await locator.scrollIntoViewIfNeeded()
    const position = await cdpScrollChannel(cdp).position()
    const box = await locator.boundingBox()
    const size = page.viewportSize() ?? { width: this.#config.viewportWidth, height: this.#config.viewportHeight }
    return {
      x: Math.round(box === null ? size.width / 2 : box.x + box.width / 2),
      y: Math.round(box === null ? size.height / 2 : box.y + box.height / 2),
      ...position,
      atTop: position.scrollY <= 1,
      atBottom: position.scrollY + position.viewportHeight >= position.pageHeight - 1,
    }
  }

  /**
   * Capture one tab as a PNG the model can look at, bounded so a long page is
   * scaled down instead of returning an enormous image.
   * @param tabId - tab id, or nothing for the active tab.
   * @param fullPage - capture the whole scrollable page instead of the viewport.
   * @returns the file, the image bytes, and the size actually captured.
   */
  async snapshot(tabId?: string, fullPage = false): Promise<Capture> {
    const page = await this.page(tabId)
    const cdp = await this.cdp(tabId)
    return await this.#capture(page, cdp, fullPage, 'page')
  }

  /**
   * Capture one tab with CDP, so the whole page can be clipped and scaled in one
   * operation, and write the PNG where the take-over view and the owner can find it.
   * @param page - the page to capture.
   * @param cdp - that page's CDP session.
   * @param fullPage - capture the whole scrollable page.
   * @param prefix - filename prefix, which tells a screenshot from a look.
   * @returns the file, the image bytes, and the size actually captured.
   */
  async #capture(page: Page, cdp: CDPSession, fullPage: boolean, prefix: string): Promise<Capture> {
    const natural = fullPage ? await this.#contentSize(cdp) : this.#viewportSize(page)
    const scale = Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(natural.width, natural.height),
      Math.sqrt(MAX_IMAGE_PIXELS / (natural.width * natural.height)),
    )
    const clip = { x: 0, y: 0, width: natural.width, height: natural.height, scale }
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
      clip,
    })
    const data = Buffer.from(shot.data, 'base64')
    const size = pngSize(data) ?? { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) }
    await mkdir(this.#config.snapshotDir, { recursive: true })
    const stamp = new Date().toISOString().replaceAll(':', '-')
    const path = join(this.#config.snapshotDir, `${prefix}-${stamp}-${randomUUID().slice(0, 8)}.png`)
    await writeFile(path, data)
    return {
      path,
      url: page.url(),
      width: size.width,
      height: size.height,
      fullPage,
      scale,
      downscaled: size.width < natural.width || size.height < natural.height,
      data,
    }
  }

  /**
   * The scrollable size of one page, in CSS pixels.
   * @param cdp - the page's CDP session.
   * @returns the size a full-page capture covers.
   */
  async #contentSize(cdp: CDPSession): Promise<ImageSize> {
    const metrics = await cdp.send('Page.getLayoutMetrics')
    const size = metrics.cssContentSize ?? metrics.contentSize
    return { width: Math.max(1, Math.ceil(size.width)), height: Math.max(1, Math.ceil(size.height)) }
  }

  /**
   * The viewport of one page, in CSS pixels.
   * @param page - the page about to be captured.
   * @returns the size a viewport capture covers.
   */
  #viewportSize(page: Page): ImageSize {
    const viewport = page.viewportSize()
    if (viewport !== null) return { width: viewport.width, height: viewport.height }
    return { width: this.#config.viewportWidth, height: this.#config.viewportHeight }
  }

  /**
   * Evaluate one expression in one tab and report what the page did with it.
   * The expression runs in the page's own world with the page's own credentials;
   * whatever it returns and whatever the page logs is page content, quoted as
   * the page produced it.
   * @param expression - JavaScript evaluated as one expression, so statements need an IIFE.
   * @param awaitPromise - wait for a returned promise before reading the result.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the JSON text of the result, and the diagnostics from the page.
   */
  async evaluate(expression: string, awaitPromise: boolean, tabId?: string): Promise<EvalReport> {
    const page = await this.page(tabId)
    const cdp = await this.cdp(tabId)
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    const onConsole = (message: ConsoleMessage): void => {
      if (message.type() !== 'error' && message.type() !== 'assert') return
      consoleErrors.push(message.text())
    }
    // An expression may also fail off the evaluated task itself; the page's own
    // error event is where that surfaces.
    const onPageError = (error: Error): void => { pageErrors.push(error.message) }
    page.on('console', onConsole)
    page.on('pageerror', onPageError)
    try {
      const response = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
      })
      // Console output the same task queued can land just after the response.
      await new Promise(resolve => setTimeout(resolve, 25))
      const details = response.exceptionDetails
      const thrown = details === undefined ? [] : [details.exception?.description ?? details.text]
      return shapeEval({
        url: page.url(),
        result: response.result,
        exceptions: [...thrown, ...pageErrors],
        consoleErrors,
      })
    } finally {
      page.off('console', onConsole)
      page.off('pageerror', onPageError)
    }
  }

  /**
   * Read the page as its accessibility tree sees it, with a stable id printed
   * beside every node an agent can act on.
   * @param options - the subtree to read and the node cap.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the indented text, its counts, and the page URL.
   */
  async ax(options: AxReadOptions, tabId?: string): Promise<AxRead> {
    const page = await this.page(tabId)
    const cdp = await this.cdp(tabId)
    const nodes: readonly AxNode[] = options.selector === undefined
      ? (await cdp.send('Accessibility.getFullAXTree')).nodes
      : await this.#scopedAxNodes(cdp, options.selector)
    const ids = this.#axIdsFor(page)
    const shaped = formatAxTree(nodes, {
      ...options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes },
      idOf: backendDOMNodeId => ids.idFor(backendDOMNodeId),
    })
    return { url: page.url(), ...shaped }
  }

  /**
   * Capture one tab and read the same page in one call, so an agent that wants
   * to see and understand a page does not spend two round-trips on it.
   * @param options - full-page capture, and whether the digest is wanted.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the picture, its size, and the bounded accessibility digest.
   */
  async look(options: LookOptions, tabId?: string): Promise<LookReport> {
    const page = await this.page(tabId)
    const cdp = await this.cdp(tabId)
    const capture = await this.#capture(page, cdp, options.fullPage === true, 'look')
    if (options.text === false) return capture
    const read = await this.ax({ maxNodes: LOOK_DIGEST_NODES }, tabId)
    const digest = truncate(read.text, LOOK_DIGEST_CHARS)
    return {
      ...capture,
      digest: {
        text: digest.text,
        nodes: read.nodes,
        interactive: read.interactive,
        omitted: read.omitted,
        truncated: digest.truncated,
      },
    }
  }

  /**
   * Read one tab's text, cut to a character window.
   * @param request - the selector and the character window.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the window, the whole text's length, and the header line.
   * @throws SelectorMissError - when the selector matches no element.
   */
  async read(request: ReadRequest, tabId?: string): Promise<ReadResult> {
    const tab = tabId ?? (await this.tabs().active()).id
    const page = await this.page(tab)
    return await readText(readable(page), tab, request)
  }

  /**
   * Click the element one target names in one tab.
   * @param tabId - tab id, or nothing for the active tab.
   * @returns the page URL after the click, which may already be the navigation target.
   */
  async click(target: BrowserTarget, tabId?: string): Promise<{ url: string }> {
    const page = await this.page(tabId)
    const cdp = await this.cdp(tabId)
    const selector = await this.#locatorSelector(target, page, cdp)
    await page.locator(selector).first().click()
    return { url: page.url() }
  }

  /**
   * Replace the editable value of the element one target names in one tab.
   * @param target - a CSS selector, or an id an accessibility read printed.
   * @param text - the value to write.
   * @param tabId - tab id, or nothing for the active tab.
   */
  async fill(target: BrowserTarget, text: string, tabId?: string): Promise<void> {
    const page = await this.page(tabId)
    const cdp = await this.cdp(tabId)
    const selector = await this.#locatorSelector(target, page, cdp)
    await page.locator(selector).first().fill(text)
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

  /**
   * The ids of one page, allocated on its first accessibility read.
   * @param page - the page an accessibility read or an action names.
   * @returns the page's id map, dropped when the document is replaced.
   */
  #axIdsFor(page: Page): PageAxIds {
    const existing = this.#axIds.get(page)
    if (existing !== undefined) return existing
    const ids = new PageAxIds(() => {
      this.#axSequence += 1
      return `e${String(this.#axSequence)}`
    })
    this.#axIds.set(page, ids)
    // A navigation replaces the document, and the DOM node behind every id
    // printed from the old one; a stale id must not resolve into the new page.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) ids.invalidate()
    })
    return ids
  }

  /**
   * Resolve one acting target to a selector a locator can use.
   * @param target - the selector, or the id an accessibility read printed.
   * @param page - the page the action acts on.
   * @param cdp - that page's CDP session.
   * @returns a selector matching the element the model named.
   * @throws UnknownAxIdError - when no read printed that id.
   * @throws StaleAxIdError - when the id's element is gone from this document.
   */
  async #locatorSelector(target: BrowserTarget, page: Page, cdp: CDPSession): Promise<string> {
    if ('selector' in target) return target.selector
    const backendDOMNodeId = this.#axIdsFor(page).nodeFor(target.axId)
    if (backendDOMNodeId === undefined) throw this.#axIdRefusal(target.axId)
    await this.#tagAxNode(cdp, backendDOMNodeId, target.axId)
    const selector = `[${AX_ID_ATTRIBUTE}="${target.axId}"]`
    // The node can be replaced between the read and the action; a locator that
    // matches nothing must fail here, naming the id, instead of clicking a node
    // that merely came next.
    if (await page.locator(selector).count() === 0) throw new StaleAxIdError(target.axId)
    return selector
  }

  /**
   * Mark one element with its printed id, so a locator finds exactly that node.
   * @param cdp - the page's CDP session.
   * @param backendDOMNodeId - the DOM node behind the accessibility node.
   * @param axId - the id to write onto the element.
   * @throws StaleAxIdError - when the document no longer holds that node.
   */
  async #tagAxNode(cdp: CDPSession, backendDOMNodeId: number, axId: string): Promise<void> {
    let objectId: string | undefined
    try {
      const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: backendDOMNodeId })
      objectId = resolved.object.objectId
    } catch (error: unknown) {
      throw new StaleAxIdError(axId, firstLine(error))
    }
    if (objectId === undefined) throw new StaleAxIdError(axId)
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function (name, value) { this.setAttribute(name, value); return true }',
      arguments: [{ value: AX_ID_ATTRIBUTE }, { value: axId }],
      returnByValue: true,
    })
  }

  /**
   * Refuse an id that names no node of this page.
   * @param axId - the id a tool call carried.
   * @returns the refusal, distinguishing an id never printed from one whose page is gone.
   */
  #axIdRefusal(axId: string): StaleAxIdError | UnknownAxIdError {
    const issued = parseAxId(axId)
    // Within the browser's count means some page printed it: another tab, or a
    // document that has since been replaced.
    if (issued !== undefined && issued <= this.#axSequence) return new StaleAxIdError(axId)
    return new UnknownAxIdError(axId)
  }

  /**
   * Read one element's accessibility subtree.
   * @param cdp - the tab's CDP session.
   * @param selector - CSS selector for the subtree root.
   * @returns that subtree's nodes, in document order.
   */
  async #scopedAxNodes(cdp: CDPSession, selector: string): Promise<readonly AxNode[]> {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const found = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (Number(found.nodeId) === 0) throw new Error(`no element matches ${selector}`)
    const described = await cdp.send('DOM.describeNode', { nodeId: found.nodeId, depth: 0 })
    const backendDOMNodeId = Number(described.node.backendNodeId)
    const { nodes } = await cdp.send('Accessibility.getFullAXTree')
    const matches = nodes.filter(node => node.backendDOMNodeId === backendDOMNodeId)
    const scoped = matches.find(node => node.ignored !== true) ?? matches[0]
    if (scoped === undefined) throw new Error(`the element matching ${selector} is not in the page's accessibility tree`)
    const byId = new Map(nodes.map(node => [node.nodeId, node] as const))
    const kept: AxNode[] = []
    const visit = (node: AxNode): void => {
      kept.push(node)
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId)
        if (child !== undefined) visit(child)
      }
    }
    visit(scoped)
    return kept
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
      return await target.count() === 0 ? undefined : await target.innerText()
    },
  }
}
