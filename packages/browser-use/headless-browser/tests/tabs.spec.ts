/**
 * The tab state machine over a scripted context: ids, titles, URLs, the active
 * tab, the hard cap, per-tab navigation failures, and the rule that closing a
 * tab — even the last one — never closes the browser. Chromium's own behavior
 * is covered by `browser.spec.ts`; this suite keeps the model deterministic.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TabStore } from '../src/tab-store.ts'
import { BrowserTabs, MAX_TABS, ResumeTabError, TabLimitError, TabNavigationError, TabNotFoundError, type TabsContext, type TabsPage } from '../src/tabs.ts'

const LOG = {
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
} satisfies Pick<Context['logger'], 'debug' | 'error' | 'info' | 'warn'>

/** A page that settles synchronously and reports load events the way Playwright does. */
class FakePage implements TabsPage {
  closed = false
  #url = 'about:blank'
  #title = ''
  #listeners = new Map<string, Set<(...args: never[]) => void>>()
  /** Set to make the next navigation reject, as a timeout or a refused URL would. */
  failNextNavigation: string | undefined
  /** Set to make the next history step reject. */
  failNextStep: string | undefined
  /** Set to make the next close reject, as a page of a browser that went away does. */
  failNextClose: string | undefined
  /** Set to make every title read reject, as a page that closed mid-read does. */
  failTitle = false
  /** Set to make bringing the page to the front reject. */
  failFront = false
  /** Set to hold every navigation until it resolves. */
  navigationGate: Promise<void> | undefined
  /** Set to hold every title read until it resolves. */
  titleGate: Promise<void> | undefined
  /** Events the page fires while it closes, before its own close event. */
  closingEvents: string[] = []

  url(): string { return this.#url }
  async title(): Promise<string> {
    await this.titleGate
    if (this.failTitle) throw new Error('Target page, context or browser has been closed')
    return this.#title
  }
  isClosed(): boolean { return this.closed }
  /** Change the URL before the browser's navigation event reaches the manager. */
  moveSilently(url: string): void {
    this.#url = url
    this.#title = /<title>(.*?)<\/title>/iu.exec(decodeURIComponent(url))?.[1] ?? ''
  }
  async goto(url: string): Promise<unknown> {
    await this.navigationGate
    if (this.failNextNavigation !== undefined) {
      const detail = this.failNextNavigation
      this.failNextNavigation = undefined
      throw new Error(detail)
    }
    this.moveSilently(url)
    this.emit('framenavigated')
    this.emit('domcontentloaded')
    this.emit('load')
    return null
  }
  async goBack(): Promise<unknown> { return this.#step() }
  async goForward(): Promise<unknown> { return this.#step() }
  async reload(): Promise<unknown> { this.emit('load'); return null }
  async bringToFront(): Promise<void> {
    if (this.failFront) throw new Error('Target page, context or browser has been closed')
  }
  async close(): Promise<void> {
    if (this.failNextClose !== undefined) {
      const detail = this.failNextClose
      this.failNextClose = undefined
      throw new Error(detail)
    }
    for (const event of this.closingEvents) this.emit(event)
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
  /** Open a window from this page, the way `window.open` reaches Playwright's `popup` event. */
  openPopup(popup: FakePage): void {
    for (const listener of [...this.#listeners.get('popup') ?? []]) (listener as (popup: FakePage) => void)(popup)
  }
  async #step(): Promise<unknown> {
    if (this.failNextStep !== undefined) {
      const detail = this.failNextStep
      this.failNextStep = undefined
      throw new Error(detail)
    }
    this.emit('load')
    return null
  }
}

/** The fake context: pages are created on demand and never disappear with the context. */
class FakeContext implements TabsContext {
  readonly open: FakePage[] = []
  closed = false
  /** Set to make every page creation fail, the way a browser that went away answers. */
  failNewPage = false
  onPage?: (page: FakePage) => void
  pages(): readonly FakePage[] { return this.open }
  async newPage(): Promise<FakePage> {
    if (this.failNewPage) throw new Error('browserContext.newPage: Target page, context or browser has been closed')
    const page = new FakePage()
    this.open.push(page)
    this.onPage?.(page)
    return page
  }
}

function dataPage(title: string): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title><body>${title}`)}`
}

async function boot(): Promise<{ context: FakeContext; tabs: BrowserTabs }> {
  const context = new FakeContext()
  const tabs = new BrowserTabs({ context: async () => context, log: LOG })
  return { context, tabs }
}

describe('browser tabs', () => {
  it('creates tabs with ids, opens each URL, and moves the active tab', async () => {
    const { tabs } = await boot()
    const first = await tabs.create(dataPage('first'))
    const second = await tabs.create(dataPage('second'))
    expect(first).toMatchObject({ id: 't1', active: true, loading: false, title: 'first' })
    expect(second).toMatchObject({ id: 't2', active: true, title: 'second' })
    expect(tabs.state().map(tab => [tab.id, tab.active])).toEqual([['t1', false], ['t2', true]])

    await tabs.activate(first.id)
    expect(tabs.state().map(tab => [tab.id, tab.active])).toEqual([['t1', true], ['t2', false]])
    expect((await tabs.active()).id).toBe('t1')
  })

  it('never adopts a page another owner reserved, so an offscreen page spends no tab slot', async () => {
    const context = new FakeContext()
    const keepalive = await context.newPage()
    const ordinary = await context.newPage()
    const tabs = new BrowserTabs({
      context: async () => context,
      log: LOG,
      reserved: page => page === keepalive,
    })
    const first = await tabs.create(dataPage('first'))
    expect(first.id).toBe('t1')
    expect((await tabs.active()).page).toBe(ordinary)
    expect(context.pages()).toContain(keepalive)
    expect(tabs.state()).toHaveLength(1)
  })

  it('adopts outside pages once, preserving focus and leaving reserved pages off the strip', async () => {
    const context = new FakeContext()
    const reserved = new WeakSet<FakePage>()
    const tabs = new BrowserTabs({ context: async () => context, log: LOG, reserved: page => reserved.has(page) })
    context.onPage = (page) => { tabs.observePage(page) }

    const offscreen = await tabs.createReserved(context, (page) => { reserved.add(page) })
    const first = await context.newPage()
    await context.newPage()
    tabs.observePage(first)
    await tabs.popupsSince(0, 0)

    expect(tabs.state().map(tab => [tab.id, tab.active])).toEqual([['t1', true], ['t2', false]])
    expect((await tabs.active()).page).toBe(first)
    expect(offscreen.isClosed()).toBe(false)
  })

  it('reports a failed outside-page adoption and still observes the next page', async () => {
    const context = new FakeContext()
    const nextId = vi.fn(() => 't1').mockImplementationOnce(() => { throw new Error('could not allocate tab ID') })
    const tabs = new BrowserTabs({ context: async () => context, log: LOG, nextId })
    context.onPage = (page) => { tabs.observePage(page) }

    await context.newPage()
    const second = await context.newPage()
    await tabs.popupsSince(0, 0)

    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: observing a tab failed: %s', 'could not allocate tab ID')
    expect(tabs.state().map(tab => tab.id)).toEqual(['t1'])
    expect((await tabs.active()).page).toBe(second)
  })

  it('lists the live URL and title even if the navigation event has not reached the tab', async () => {
    const { context, tabs } = await boot()
    await tabs.create()
    const url = dataPage('new address')
    context.open[0]!.moveSilently(url)

    expect(await tabs.list(context)).toMatchObject([{ id: 't1', url, title: 'new address', active: true }])
    expect(tabs.state()[0]?.url).toBe(url)
  })

  it('reports loading while a navigation runs and settles it afterwards', async () => {
    const { tabs } = await boot()
    const tab = await tabs.create()
    const seen: boolean[] = []
    tabs.onChange(() => {
      const current = tabs.state().find(entry => entry.id === tab.id)
      if (current !== undefined) seen.push(current.loading)
    })
    await tabs.navigate(dataPage('loaded'))
    expect(seen).toContain(true)
    expect(seen.at(-1)).toBe(false)
    expect(tabs.state()[0]).toMatchObject({ title: 'loaded', loading: false })
  })

  it('names the close tool when the tab cap refuses another tab', async () => {
    const { tabs } = await boot()
    for (let index = 0; index < MAX_TABS; index++) await tabs.create(dataPage(`page-${String(index)}`))
    await expect(tabs.create(dataPage('one-too-many'))).rejects.toBeInstanceOf(TabLimitError)
    await expect(tabs.create()).rejects.toThrow(/at most 8 tabs; close one with headless_browser_close before opening another/u)
    expect(tabs.state()).toHaveLength(MAX_TABS)
  })

  it('closes a named tab, then the active one, and keeps a blank tab after the last one', async () => {
    const { context, tabs } = await boot()
    const first = await tabs.create(dataPage('first'))
    const second = await tabs.create(dataPage('second'))
    const named = await tabs.close(second.id)
    expect(named).toMatchObject({ closed: second.id, replaced: false })
    expect(named.tabs.map(tab => tab.id)).toEqual([first.id])
    expect(named.tabs[0]?.active).toBe(true)
    expect(context.closed).toBe(false)

    const third = await tabs.create(dataPage('third'))
    await tabs.activate(first.id)
    const active = await tabs.close()
    expect(active).toMatchObject({ closed: first.id, replaced: false })
    expect(active.tabs.map(tab => tab.id)).toEqual([third.id])
    expect(active.tabs[0]?.active).toBe(true)

    const last = await tabs.close(third.id)
    expect(last).toMatchObject({ closed: third.id, replaced: true })
    expect(last.tabs).toHaveLength(1)
    expect(last.tabs[0]?.id).not.toBe(third.id)
    expect(last.tabs[0]?.url).toBe('about:blank')
    expect(last.tabs[0]?.active).toBe(true)
    expect(context.open.filter(page => !page.isClosed())).toHaveLength(1)
  })

  it('replaces a tab the page closed by itself', async () => {
    const { context, tabs } = await boot()
    const only = await tabs.create(dataPage('only'))
    const page = context.open[0]!
    await page.close()
    await vi.waitFor(() => { expect(tabs.state()).toHaveLength(1) })
    expect(tabs.state()[0]?.id).not.toBe(only.id)
    expect(tabs.state()[0]?.url).toBe('about:blank')
  })

  it('names a missing tab and refuses an unsupported address', async () => {
    const { tabs } = await boot()
    await expect(tabs.page('t99')).rejects.toBeInstanceOf(TabNotFoundError)
    await expect(tabs.navigate('javascript:alert(1)')).rejects.toBeInstanceOf(TabNavigationError)
    await expect(tabs.navigate('not a url')).rejects.toThrow(/not an absolute URL/u)
  })

  it('turns a navigation failure into a settled tab and a named error', async () => {
    const { context, tabs } = await boot()
    const tab = await tabs.create()
    const page = context.open[0] as FakePage
    page.failNextNavigation = 'net::ERR_TIMED_OUT'
    await expect(tabs.navigate('https://example.com', tab.id)).rejects.toThrow(/ERR_TIMED_OUT/u)
    expect(tabs.state()[0]?.loading).toBe(false)
  })

  it('applies the page\'s tab commands by name, and defaults to the active tab', async () => {
    const { tabs } = await boot()
    await tabs.command('new', undefined, dataPage('one'))
    await tabs.command('new', undefined, dataPage('two'))
    const [one, two] = tabs.state()
    await tabs.command('activate', one!.id)
    await tabs.command('reload')
    await tabs.command('close', two!.id)
    expect(tabs.state()).toHaveLength(1)
    expect(tabs.state()[0]?.active).toBe(true)
  })

  it('closes the context\'s own first page when no tab was opened yet, and keeps a blank tab in its place', async () => {
    const { context, tabs } = await boot()
    const restored = new FakePage()
    context.open.push(restored)
    const closed = await tabs.close()
    expect(closed).toMatchObject({ closed: 't1', replaced: true })
    expect(closed.tabs.map(tab => [tab.id, tab.active])).toEqual([['t2', true]])
    expect(restored.closed).toBe(true)
  })

  it('keeps a tab whose page refuses to close, reports why, and closes it on the next try', async () => {
    const { context, tabs } = await boot()
    await tabs.create(dataPage('one'))
    await tabs.create(dataPage('two'))
    const page = context.open[1]!
    page.failNextClose = 'Target closed'
    await expect(tabs.close('t2')).rejects.toThrow('Target closed')
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: closing tab %s failed: %s', 't2', 'Target closed')
    expect(tabs.state().map(tab => tab.id)).toEqual(['t1', 't2'])
    expect(await tabs.close('t2')).toMatchObject({ closed: 't2', replaced: false })
  })

  it('steps back and forward, opening a tab when none is open, and names the address of a refused step', async () => {
    const { context, tabs } = await boot()
    await tabs.back()
    expect(tabs.state().map(tab => tab.id)).toEqual(['t1'])
    await tabs.command('forward')
    await tabs.command('back', 't1')
    context.open[0]!.failNextStep = 'net::ERR_ABORTED'
    const failure = await tabs.forward('t1').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TabNavigationError)
    expect(String(failure)).toContain('opening about:blank failed: net::ERR_ABORTED')
    expect(tabs.state()[0]?.loading).toBe(false)
  })

  it('activates the active tab and navigates it by command, and refuses a navigation without an address', async () => {
    const { tabs } = await boot()
    await tabs.command('new', undefined, dataPage('one'))
    await tabs.command('activate')
    await tabs.command('navigate', undefined, dataPage('two'))
    expect(tabs.state()).toMatchObject([{ id: 't1', title: 'two', active: true }])
    await expect(tabs.command('navigate')).rejects.toThrow(/the address is empty/u)
  })

  it('names a tab that is not open for every operation that takes a tab id', async () => {
    const { tabs } = await boot()
    await tabs.create()
    await expect(tabs.activate('t9')).rejects.toBeInstanceOf(TabNotFoundError)
    await expect(tabs.close('t9')).rejects.toBeInstanceOf(TabNotFoundError)
    await expect(tabs.navigate(dataPage('x'), 't9')).rejects.toBeInstanceOf(TabNotFoundError)
    await expect(tabs.back('t9')).rejects.toBeInstanceOf(TabNotFoundError)
  })

  it('keeps telling the other listeners when one throws, and stops telling one that unsubscribed', async () => {
    const { tabs } = await boot()
    let changes = 0
    let unsubscribed = 0
    tabs.onChange(() => { throw new Error('the strip is gone') })
    tabs.onChange(() => { changes += 1 })
    const stop = tabs.onChange(() => { unsubscribed += 1 })
    stop()
    await tabs.page()
    expect(changes).toBeGreaterThan(0)
    expect(unsubscribed).toBe(0)
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: tab listener failed: %s', 'the strip is gone')
  })

  it('reports a last tab the site closed that the browser could not replace, and keeps no tab', async () => {
    const { context, tabs } = await boot()
    await tabs.create()
    context.failNewPage = true
    await context.open[0]!.close()
    await vi.waitFor(() => {
      expect(LOG.warn).toHaveBeenCalledWith('headless-browser: replacing the closed tab %s failed: %s', 't1', expect.stringContaining('has been closed'))
    })
    expect(tabs.state()).toEqual([])
  })

  it('keeps the last title of a page whose title cannot be read', async () => {
    const { context, tabs } = await boot()
    const page = new FakePage()
    page.failTitle = true
    context.open.push(page)
    await tabs.create(dataPage('unreadable'))
    expect(tabs.state()).toMatchObject([{ title: '', url: dataPage('unreadable'), loading: false }])
  })

  it('reports nothing about a tab the browser let go while it navigated or read its title', async () => {
    const { context, tabs } = await boot()
    const navigation = Promise.withResolvers<undefined>()
    await tabs.create()
    let changes = 0
    tabs.onChange(() => { changes += 1 })
    vi.spyOn(context.open[0]!, 'goto').mockImplementationOnce(async () => {
      await navigation.promise
      return {} // A committed navigation response arriving after disposal.
    })
    const navigating = tabs.navigate(dataPage('late'))
    await vi.waitFor(() => { expect(tabs.state()[0]?.loading).toBe(true) })
    tabs.dispose()
    navigation.resolve(undefined)
    await navigating
    expect(changes).toBe(1)
    expect(tabs.state()).toEqual([])

    const next = await boot()
    const title = Promise.withResolvers<undefined>()
    const slow = new FakePage()
    slow.titleGate = title.promise
    next.context.open.push(slow)
    await next.tabs.create()
    next.tabs.dispose()
    title.resolve(undefined)
    await next.tabs.popupsSince(next.tabs.popupMark(), 0)
    expect(next.tabs.state()).toEqual([])
  })

  it('drops a self-close queued behind an explicit close of the same tab', async () => {
    const { context, tabs } = await boot()
    await tabs.create(dataPage('one'))
    await tabs.create(dataPage('two'))
    const navigation = Promise.withResolvers<undefined>()
    context.open[0]!.navigationGate = navigation.promise
    const navigating = tabs.navigate(dataPage('three'), 't1')
    const closing = tabs.close('t2')
    // The site closes the window while the explicit close still waits its turn.
    context.open[1]!.emit('close')
    navigation.resolve(undefined)
    await navigating
    expect(await closing).toMatchObject({ closed: 't2', replaced: false })
    await tabs.popupsSince(tabs.popupMark(), 0)
    expect(tabs.state().map(tab => tab.id)).toEqual(['t1'])
    expect(context.open).toHaveLength(2)
  })

  it('keeps the active tab when another closes itself, and moves to the next tab when the active one does', async () => {
    const { context, tabs } = await boot()
    await tabs.create(dataPage('one'))
    await tabs.create(dataPage('two'))
    await tabs.create(dataPage('three'))
    await tabs.activate('t1')
    await context.open[1]!.close()
    await vi.waitFor(() => { expect(tabs.state().map(tab => tab.id)).toEqual(['t1', 't3']) })
    expect(tabs.state().find(tab => tab.active)?.id).toBe('t1')
    await context.open[0]!.close()
    await vi.waitFor(() => { expect(tabs.state().map(tab => [tab.id, tab.active])).toEqual([['t3', true]]) })
  })

  it('ignores the page events a tab fires while it is being closed', async () => {
    const { context, tabs } = await boot()
    await tabs.create(dataPage('one'))
    await tabs.create(dataPage('two'))
    context.open[1]!.closingEvents = ['load', 'framenavigated']
    let changes = 0
    tabs.onChange(() => { changes += 1 })
    await tabs.close('t2')
    expect(changes).toBe(1)
  })
})

describe('resuming tabs', () => {
  it.each([['about:blank', 1], ['about:blank#section', 0]])('reloads only the exact blank document (%s)', async (url, reloads) => {
    const { context, tabs } = await boot()
    const { id } = await tabs.create(url)
    const page = context.open[0]!
    const reload = vi.spyOn(page, 'reload')
    const probe = vi.fn().mockResolvedValue({ hasForm: false, errorPage: false })

    await expect(tabs.resume(context, { tab: id }, probe)).resolves.toMatchObject({ tab: id, url, hasForm: false })
    expect(reload).toHaveBeenCalledTimes(reloads)
    expect(probe).toHaveBeenCalledTimes(1 + reloads)
  })

  it('does not reload a document the user navigated to during the error probe', async () => {
    const { context, tabs } = await boot()
    const { id } = await tabs.create(dataPage('error page'))
    const page = context.open[0]!
    const reload = vi.spyOn(page, 'reload')
    const newUrl = dataPage('new page')
    const probe = vi.fn(async () => {
      await page.goto(newUrl)
      return { hasForm: false, errorPage: true }
    })

    await expect(tabs.resume(context, { tab: id }, probe)).resolves.toMatchObject({ tab: id, url: newUrl, title: 'new page' })
    expect(reload).not.toHaveBeenCalled()
  })

  it('tells the user to reopen the tab when it closes during the probe', async () => {
    const { context, tabs } = await boot()
    const { id } = await tabs.create(dataPage('form'))
    const resuming = tabs.resume(context, { tab: id }, async (page) => {
      await page.close()
      throw new Error('probe lost the page')
    })

    await expect(resuming).rejects.toThrow(ResumeTabError)
    await expect(resuming).rejects.toThrow('that tab closed during resume; reopen the page and refill the form')
    await tabs.popupsSince(0, 0)
    expect(tabs.state().map(tab => tab.id)).not.toContain(id)
  })

  it('reports a probe failure unchanged when the tab is still live', async () => {
    const { context, tabs } = await boot()
    const { id } = await tabs.create(dataPage('form'))
    const failure = new Error('could not inspect the page')
    const probe = vi.fn().mockRejectedValue(failure)

    await expect(tabs.resume(context, { tab: id }, probe)).rejects.toBe(failure)
    expect(tabs.state()[0]).toMatchObject({ id, active: true })
  })

  it('does not report a successful resume when the tab closes while its title is refreshed', async () => {
    const { context, tabs } = await boot()
    const { id } = await tabs.create(dataPage('form'))
    const page = context.open[0]!
    const readingTitle = Promise.withResolvers<undefined>()
    const tabClosed = Promise.withResolvers<undefined>()
    vi.spyOn(page, 'title').mockImplementationOnce(async () => {
      readingTitle.resolve(undefined)
      await tabClosed.promise
      throw new Error('title read lost the page')
    })
    const probe = vi.fn().mockResolvedValue({ hasForm: true, errorPage: false })
    const resuming = tabs.resume(context, { tab: id }, probe)

    await readingTitle.promise
    await page.close()
    tabClosed.resolve(undefined)
    await expect(resuming).rejects.toThrow(ResumeTabError)
  })
})

describe('popups', () => {
  it('adopts a window a page opens as the active tab and returns to its opener when it closes itself', async () => {
    const { context, tabs } = await boot()
    const opener = await tabs.create(dataPage('apply'))
    await tabs.create(dataPage('other'))
    await tabs.activate(opener.id)
    const mark = tabs.popupMark()
    const popup = new FakePage()
    await popup.goto('https://accounts.google.com/o/oauth2/auth')
    context.open.push(popup)
    context.open[0]!.emit('popup', popup as never)
    expect(await tabs.popupsSince(mark, 50)).toEqual([{ tab: 't3', opener: 't1', url: 'https://accounts.google.com/o/oauth2/auth' }])
    expect(tabs.state().map(tab => [tab.id, tab.active])).toEqual([['t1', false], ['t2', false], ['t3', true]])
    await popup.close()
    await tabs.popupsSince(mark, 0)
    expect(tabs.state().map(tab => [tab.id, tab.active])).toEqual([['t1', true], ['t2', false]])
    expect(await tabs.popupsSince(mark, 0)).toEqual([])
  })

  it('does not attribute a browser-created popup to the Session that opened its parent tab', async () => {
    const context = new FakeContext()
    const store = new TabStore('unused-tabs.json', new Context().logger)
    const see = vi.spyOn(store, 'see').mockImplementation(() => undefined)
    const tabs = new BrowserTabs({ context: async () => context, log: LOG, store })
    const opener = await tabs.create(dataPage('opener'), 'opening-session')
    context.open[0]!.openPopup(new FakePage())

    const [popup] = await tabs.popupsSince(0, 0)
    expect(popup?.opener).toBe(opener.id)
    expect(see).toHaveBeenCalledWith(expect.objectContaining({ id: opener.id, openedBySessionId: 'opening-session' }))
    expect(see).toHaveBeenCalledWith(expect.objectContaining({ id: popup?.tab, openedBySessionId: null }))
  })

  it('waits briefly and reports nothing when no window opened, and adopts a popup past the tab cap', async () => {
    const context = new FakeContext()
    const tabs = new BrowserTabs({ context: async () => context, log: LOG, maxTabs: 1 })
    await tabs.create(dataPage('only'))
    const mark = tabs.popupMark()
    const started = Date.now()
    expect(await tabs.popupsSince(mark, 40)).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    const popup = new FakePage()
    context.open[0]!.emit('popup', popup as never)
    expect((await tabs.popupsSince(mark, 50)).map(entry => entry.tab)).toEqual(['t2'])
    await tabs.close('t2')
    expect(tabs.state().map(tab => [tab.id, tab.active])).toEqual([['t1', true]])
  })

  it('adopts a window once, and never one that already closed or that arrives after the browser went away', async () => {
    const { context, tabs } = await boot()
    await tabs.create(dataPage('opener'))
    const opener = context.open[0]!
    const popup = new FakePage()
    opener.openPopup(popup)
    opener.openPopup(popup)
    const gone = new FakePage()
    gone.closed = true
    opener.openPopup(gone)
    expect((await tabs.popupsSince(0, 0)).map(entry => entry.tab)).toEqual(['t2'])
    expect(tabs.state()).toHaveLength(2)
    tabs.dispose()
    opener.openPopup(new FakePage())
    expect(await tabs.popupsSince(0, 0)).toEqual([])
  })

  it('reports only the newest popups once a page opened more than four per tab slot', async () => {
    const context = new FakeContext()
    const tabs = new BrowserTabs({ context: async () => context, log: LOG, maxTabs: 1 })
    await tabs.create(dataPage('opener'))
    for (let index = 0; index < 5; index += 1) context.open[0]!.openPopup(new FakePage())
    expect((await tabs.popupsSince(0, 0)).map(entry => entry.tab)).toEqual(['t3', 't4', 't5', 't6'])
    expect(tabs.state()).toHaveLength(6)
  })

  it('reports a popup it could not bring forward, and still wakes the click that waits for one', async () => {
    const { context, tabs } = await boot()
    await tabs.create(dataPage('opener'))
    const mark = tabs.popupMark()
    const waiting = tabs.popupsSince(mark, 60_000)
    const popup = new FakePage()
    popup.failFront = true
    context.open[0]!.openPopup(popup)
    expect((await waiting).map(entry => entry.tab)).toEqual(['t2'])
    expect(LOG.warn).toHaveBeenCalledWith('headless-browser: adopting a popup of %s failed: %s', 't1', 'Target page, context or browser has been closed')
  })

  it('stops waiting for a popup when the browser goes away', async () => {
    const { tabs } = await boot()
    await tabs.create()
    const waiting = tabs.popupsSince(tabs.popupMark(), 60_000)
    tabs.dispose()
    expect(await waiting).toEqual([])
  })
})
