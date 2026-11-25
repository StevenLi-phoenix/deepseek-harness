/**
 * The tab state machine over a scripted context: ids, titles, URLs, the active
 * tab, the hard cap, per-tab navigation failures, and the rule that closing a
 * tab — even the last one — never closes the browser. Chromium's own behavior
 * is covered by `browser.spec.ts`; this suite keeps the model deterministic.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserTabs, MAX_TABS, TabLimitError, TabNavigationError, TabNotFoundError, type TabsContext, type TabsPage } from '../src/tabs.ts'

const LOG = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Context['logger']

/** A page that settles synchronously and reports load events the way Playwright does. */
class FakePage implements TabsPage {
  closed = false
  #url = 'about:blank'
  #title = ''
  #listeners = new Map<string, Set<(...args: never[]) => void>>()
  /** Set to make the next navigation reject, as a timeout or a refused URL would. */
  failNextNavigation: string | undefined

  url(): string { return this.#url }
  async title(): Promise<string> { return this.#title }
  isClosed(): boolean { return this.closed }
  async goto(url: string): Promise<unknown> {
    if (this.failNextNavigation !== undefined) {
      const detail = this.failNextNavigation
      this.failNextNavigation = undefined
      throw new Error(detail)
    }
    this.#url = url
    this.#title = /<title>(.*?)<\/title>/iu.exec(decodeURIComponent(url))?.[1] ?? ''
    this.emit('framenavigated')
    this.emit('domcontentloaded')
    this.emit('load')
    return null
  }
  async goBack(): Promise<unknown> { this.emit('load'); return null }
  async goForward(): Promise<unknown> { this.emit('load'); return null }
  async reload(): Promise<unknown> { this.emit('load'); return null }
  async bringToFront(): Promise<void> {}
  async close(): Promise<void> {
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
}

/** The fake context: pages are created on demand and never disappear with the context. */
class FakeContext implements TabsContext {
  readonly open: FakePage[] = []
  closed = false
  pages(): readonly TabsPage[] { return this.open }
  async newPage(): Promise<TabsPage> {
    const page = new FakePage()
    this.open.push(page)
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
})
