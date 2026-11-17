/**
 * The model-facing tools: which ones exist, what each one forwards to the
 * browser, and the refusals a call gets back instead of a page.
 */

import { Context } from '@deepseek-ai/cordis'
import { assertSupportedJsonSchema, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { TabInfo } from '../src/input.ts'
import type { ActionOutcome } from '../src/session.ts'
import { SelectorMissError, type ReadRequest, type ReadResult } from '../src/read.ts'
import type { ScrollRequest, ScrollResult } from '../src/scroll.ts'
import { NoOpenTabError } from '../src/session.ts'
import { TabNotFoundError, type ClosedTab } from '../src/tabs.ts'
import { TakeoverState } from '../src/takeover.ts'
import { registerBrowserTools, type ToolBrowser } from '../src/tools.ts'

/** The read result the fake browser answers with. */
const READ: ReadResult = {
  header: 'text of t1 (https://example.com/assignments): page 1 of 1, characters 1-12 of 12',
  text: '01 作业',
  total: 12,
  url: 'https://example.com/assignments',
}

/** The page-derived wrapper a read window arrives in. */
const READ_WRAPPED = {
  header: READ.header,
  text: { untrusted: 'https://example.com', content: READ.text },
  total: READ.total,
}

/** A click or type that landed on a visible element. */
const HIT: ActionOutcome = {
  url: 'https://example.com/next',
  target: { ref: 'a.next', index: 0, name: 'Next', score: 1 },
}

/** Two open tabs, as the close result reports them. */
const TABS: TabInfo[] = [
  { id: 't1', title: 'first', url: 'https://example.com/one', loading: false, active: false },
  { id: 't2', title: 'second', url: 'https://example.com/two', loading: false, active: true },
]

/** The scroll result the fake browser answers with. */
const SCROLLED: ScrollResult = {
  x: 400,
  y: 300,
  scrollX: 0,
  scrollY: 500,
  pageHeight: 3_000,
  viewportHeight: 600,
  atTop: false,
  atBottom: false,
}

/**
 * The execution context a tool body receives; none of these tools reads it.
 * The executor mints its branded identity, so a direct body call passes none.
 */
const EXEC = {
  signal: new AbortController().signal,
  deferContext: () => {},
  concludeTurn: () => {},
} as never

/** A browser whose operations answer with fixed values unless a test replaces one. */
function fakeBrowser(overrides: Partial<ToolBrowser> = {}): ToolBrowser {
  return {
    open: async () => ({ url: 'https://example.com/', title: 'Example' }),
    snapshot: async () => ({ path: '/tmp/page.png', url: 'https://example.com/' }),
    read: async () => READ,
    click: async () => HIT,
    fill: async () => HIT,
    scroll: async () => SCROLLED,
    closeTab: async (tabId?: string): Promise<ClosedTab> => ({
      closed: tabId ?? 't2',
      replaced: false,
      tabs: TABS.filter(tab => tab.id !== (tabId ?? 't2')),
    }),
    ...overrides,
  }
}

interface Bench {
  /** Registered definitions by tool name. */
  readonly definitions: Map<string, ToolDefinition>
  /** Control state the tools consult before acting on the page. */
  readonly takeover: TakeoverState
  /** Run one registered tool body and return its canonical value. */
  readonly call: (name: string, args: object) => Promise<unknown>
}

/** Register the tools into a Context whose `tools` service records them, as the Host does. */
function bench(browser: ToolBrowser): Bench {
  const definitions = new Map<string, ToolDefinition>()
  const ctx = new Context()
  ctx.provide('tools', {
    register(definition: ToolDefinition) {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    },
  })
  const takeover = new TakeoverState()
  registerBrowserTools(ctx, { browser, takeover, pageUrl: () => 'http://127.0.0.1:3081/headless-browser' })
  return {
    definitions,
    takeover,
    async call(name, args) {
      const definition = definitions.get(name)
      if (definition === undefined) throw new Error(`no tool named ${name}`)
      return await definition.execute(args, EXEC)
    },
  }
}

/** One tool definition, which registration must have added. */
function definitionOf(bench: Bench, name: string): ToolDefinition {
  const definition = bench.definitions.get(name)
  if (definition === undefined) throw new Error(`no tool named ${name}`)
  return definition
}

describe('tool registration', () => {
  it('registers the six page tools, the two tab tools, and the two control tools', () => {
    const tools = bench(fakeBrowser())
    expect([...tools.definitions.keys()]).toEqual([
      'headless_browser_open',
      'headless_browser_snapshot',
      'headless_browser_read',
      'headless_browser_click',
      'headless_browser_type',
      'headless_browser_scroll',
      'headless_browser_close',
      'headless_browser_hand_over',
      'headless_browser_hand_back',
    ])
    for (const definition of tools.definitions.values()) {
      expect(definition.description.length).toBeGreaterThan(20)
      expect(() => { assertSupportedJsonSchema(definition.output.schema) }).not.toThrow()
      expect(definition.presentCall?.({ url: 'https://example.com/', selector: '#rows', text: 'x', reason: 'sign in' }))
        .toMatchObject({ card: 'generic' })
    }
  })

  it('declares the read arguments as optional and the full-page flag as a boolean', () => {
    const tools = bench(fakeBrowser())
    const read = definitionOf(tools, 'headless_browser_read')
    expect(read.parameters).toMatchObject({
      type: 'object',
      properties: {
        tab: { type: 'string' },
        selector: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
    })
    expect(read.parameters).not.toHaveProperty('required')
    expect(definitionOf(tools, 'headless_browser_snapshot').parameters)
      .toMatchObject({ properties: { tab: { type: 'string' }, fullPage: { type: 'boolean' } } })
    expect(read.presentCall?.({ selector: '#rows' })).toMatchObject({ title: 'Read #rows', kind: 'read' })
    expect(read.presentCall?.({})).toMatchObject({ title: 'Read the page text', kind: 'read' })
  })

  it('declares the scroll distance, edge, and point, and the optional close tab', () => {
    const tools = bench(fakeBrowser())
    const scroll = definitionOf(tools, 'headless_browser_scroll')
    expect(scroll.parameters).toMatchObject({
      type: 'object',
      properties: {
        tab: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        deltaY: { type: 'number' },
        to: { type: 'string', enum: ['top', 'bottom'] },
      },
    })
    expect(scroll.parameters).not.toHaveProperty('required')
    const success = scroll.output.schema.oneOf?.[0]
    expect(success?.type).toBe('object')
    expect(success?.required).toEqual(expect.arrayContaining([
      'x', 'y', 'scrollX', 'scrollY', 'pageHeight', 'viewportHeight', 'atTop', 'atBottom',
    ]))
    const close = definitionOf(tools, 'headless_browser_close')
    expect(close.parameters).toMatchObject({ type: 'object', properties: { tab: { type: 'string' } } })
    expect(close.parameters).not.toHaveProperty('required')
  })
})

describe('reading through the tool', () => {
  it('returns the window and forwards the selector, offset, limit, and tab', async () => {
    const read = vi.fn(async (_request: ReadRequest, _tab?: string) => READ)
    const tools = bench(fakeBrowser({ read }))
    const value = await tools.call('headless_browser_read', { selector: '#rows', offset: 40, limit: 12, tab: 't2' })
    expect(read).toHaveBeenCalledWith({ selector: '#rows', offset: 40, limit: 12 }, 't2')
    expect(value).toEqual(READ_WRAPPED)
    const definition = definitionOf(tools, 'headless_browser_read')
    expect(definition.output.render({}, value as never)).toEqual([{ type: 'text', text: JSON.stringify(READ_WRAPPED) }])
  })

  it('reads the active tab and the whole body when the call names neither', async () => {
    const read = vi.fn(async () => READ)
    const tools = bench(fakeBrowser({ read }))
    await tools.call('headless_browser_read', {})
    expect(read).toHaveBeenCalledWith({}, undefined)
  })

  it('refuses to read while the user holds the page', async () => {
    const read = vi.fn(async () => READ)
    const tools = bench(fakeBrowser({ read }))
    tools.takeover.take('signing in')
    expect(await tools.call('headless_browser_read', {})).toEqual({
      error: 'the user holds the browser (signing in); call headless_browser_hand_back when they are done',
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps a refusal from the page state readable on its own', async () => {
    const missingTab = bench(fakeBrowser({ read: async () => { throw new TabNotFoundError('t9') } }))
    expect(await missingTab.call('headless_browser_read', { tab: 't9' })).toEqual({
      error: 'no tab named t9; use the active tab or open a new one',
    })
    const missed = bench(fakeBrowser({ read: async () => { throw new SelectorMissError('#missing') } }))
    expect(await missed.call('headless_browser_read', { selector: '#missing' })).toEqual({
      error: 'no element matches #missing; check the selector or read the whole page',
    })
  })

  it('names the action when a read fails for any other reason', async () => {
    const tools = bench(fakeBrowser({ read: async () => { throw new Error('Target page closed\ndetail') } }))
    expect(await tools.call('headless_browser_read', { tab: 't3' })).toEqual({
      error: 'reading t3 failed: Target page closed',
    })
  })
})

describe('screenshots through the tool', () => {
  it('forwards the full-page flag and the tab', async () => {
    const snapshot = vi.fn(async (_tab?: string, _fullPage?: boolean) => ({ path: '/tmp/page.png', url: 'https://example.com/' }))
    const tools = bench(fakeBrowser({ snapshot }))
    expect(await tools.call('headless_browser_snapshot', {})).toEqual({
      path: '/tmp/page.png',
      page: { untrusted: 'https://example.com', content: 'https://example.com/' },
    })
    expect(snapshot).toHaveBeenLastCalledWith(undefined, false)
    await tools.call('headless_browser_snapshot', { tab: 't2', fullPage: true })
    expect(snapshot).toHaveBeenLastCalledWith('t2', true)
    const definition = definitionOf(tools, 'headless_browser_snapshot')
    expect(definition.presentCall?.({ fullPage: true })).toMatchObject({ title: 'Screenshot the whole page' })
    expect(definition.presentCall?.({})).toMatchObject({ title: 'Screenshot the browser' })
  })

  it('still answers while the user holds the page', async () => {
    const tools = bench(fakeBrowser())
    tools.takeover.take('paying')
    expect(await tools.call('headless_browser_snapshot', { fullPage: true }))
      .toEqual({ path: '/tmp/page.png', page: { untrusted: 'https://example.com', content: 'https://example.com/' } })
  })
})

describe('closing tabs through the tool', () => {
  it('closes the active tab when no tab is named and returns the remaining tabs', async () => {
    const closeTab = vi.fn(async (): Promise<ClosedTab> => ({ closed: 't2', replaced: false, tabs: [TABS[0]!] }))
    const tools = bench(fakeBrowser({ closeTab }))
    const value = await tools.call('headless_browser_close', {})
    expect(closeTab).toHaveBeenCalledWith(undefined)
    expect(value).toMatchObject({ closed: 't2', replaced: false })
    expect((value as { tabs: TabInfo[] }).tabs).toEqual([TABS[0]])
  })

  it('closes the named tab and reports the blank replacement of the last one', async () => {
    const blank: TabInfo = { id: 't3', title: '', url: 'about:blank', loading: false, active: true }
    const closeTab = vi.fn(async (): Promise<ClosedTab> => ({ closed: 't2', replaced: true, tabs: [blank] }))
    const tools = bench(fakeBrowser({ closeTab }))
    expect(await tools.call('headless_browser_close', { tab: 't2' }))
      .toEqual({ closed: 't2', replaced: true, tabs: [blank] })
    expect(closeTab).toHaveBeenCalledWith('t2')
  })

  it('reports that there is no tab to close instead of opening a browser', async () => {
    const closeTab = vi.fn(async (): Promise<ClosedTab> => { throw new NoOpenTabError() })
    const tools = bench(fakeBrowser({ closeTab }))
    expect(await tools.call('headless_browser_close', {})).toEqual({
      error: 'no tab is open; call headless_browser_open before closing one',
    })
  })

  it('refuses to close while the user holds the page', async () => {
    const closeTab = vi.fn(async (): Promise<ClosedTab> => ({ closed: 't2', replaced: false, tabs: [TABS[0]!] }))
    const tools = bench(fakeBrowser({ closeTab }))
    tools.takeover.take('finishing the checkout')
    expect(await tools.call('headless_browser_close', {})).toEqual({
      error: 'the user holds the browser (finishing the checkout); call headless_browser_hand_back when they are done',
    })
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('names the action when a close fails for any other reason', async () => {
    const tools = bench(fakeBrowser({ closeTab: async () => { throw new Error('the page is gone') } }))
    expect(await tools.call('headless_browser_close', { tab: 't2' })).toEqual({
      error: 'closing tab t2 failed: the page is gone',
    })
  })
})

describe('scrolling through the tool', () => {
  it('passes a delta scroll and its tab to the browser', async () => {
    const scroll = vi.fn(async (_request: ScrollRequest, _tab?: string) => SCROLLED)
    const tools = bench(fakeBrowser({ scroll }))
    expect(await tools.call('headless_browser_scroll', { tab: 't2', deltaY: 500 })).toEqual(SCROLLED)
    expect(scroll).toHaveBeenCalledWith({ deltaY: 500 }, 't2')
  })

  it('passes an edge scroll with the element point to the browser', async () => {
    const scroll = vi.fn(async (_request: ScrollRequest, _tab?: string) => SCROLLED)
    const tools = bench(fakeBrowser({ scroll }))
    await tools.call('headless_browser_scroll', { x: 30, y: 40, to: 'bottom' })
    expect(scroll).toHaveBeenCalledWith({ x: 30, y: 40, to: 'bottom' }, undefined)
  })

  it('refuses a scroll request that names neither a distance nor an edge, or both', async () => {
    const tools = bench(fakeBrowser())
    expect(await tools.call('headless_browser_scroll', {})).toEqual({
      error: 'give either deltaY (pixels to scroll) or to ("top" or "bottom")',
    })
    expect(await tools.call('headless_browser_scroll', { deltaY: 100, to: 'top' })).toEqual({
      error: 'give either deltaY (pixels to scroll) or to ("top" or "bottom")',
    })
  })

  it('refuses a half-named point, a negative point, and an oversized distance', async () => {
    const tools = bench(fakeBrowser())
    expect(await tools.call('headless_browser_scroll', { x: 10, deltaY: 100 })).toEqual({
      error: 'give both x and y, or neither',
    })
    expect(await tools.call('headless_browser_scroll', { x: -1, y: 10, deltaY: 100 })).toEqual({
      error: 'x and y must not be negative',
    })
    expect(await tools.call('headless_browser_scroll', { deltaY: 100_001 })).toEqual({
      error: 'deltaY must be within ±100000 pixels',
    })
  })

  it('refuses to scroll while the user holds the page', async () => {
    const scroll = vi.fn(async () => SCROLLED)
    const tools = bench(fakeBrowser({ scroll }))
    tools.takeover.take('reading the invoice')
    expect(await tools.call('headless_browser_scroll', { deltaY: 200 })).toEqual({
      error: 'the user holds the browser (reading the invoice); call headless_browser_hand_back when they are done',
    })
    expect(scroll).not.toHaveBeenCalled()
  })
})

describe('page actions and control', () => {
  it('forwards open, click, and type to the browser and wraps page data', async () => {
    const open = vi.fn(async (_url: string, _newTab?: boolean, _allowOrigin?: boolean) => ({ url: 'https://example.com/', title: 'Example' }))
    const click = vi.fn(async (_request: unknown, _tab?: string) => HIT)
    const fill = vi.fn(async (_request: unknown, _text: string, _tab?: string) => HIT)
    const tools = bench(fakeBrowser({ open, click, fill }))
    expect(await tools.call('headless_browser_open', { url: 'https://example.com/', newTab: true }))
      .toEqual({ url: 'https://example.com/', title: { untrusted: 'https://example.com', content: 'Example' } })
    expect(open).toHaveBeenCalledWith('https://example.com/', true, false)
    expect(await tools.call('headless_browser_click', { selector: 'a.next', tab: 't2', allowOrigin: true }))
      .toEqual({
        clicked: 'a.next',
        url: 'https://example.com/next',
        target: { ref: 'a.next', index: 0, name: { untrusted: 'https://example.com', content: 'Next' }, score: 1 },
      })
    expect(click).toHaveBeenCalledWith({ selector: 'a.next', allowOrigin: true }, 't2')
    expect(await tools.call('headless_browser_type', { selector: '#q', text: '作业' })).toEqual({
      typed: 'a.next',
      url: 'https://example.com/next',
      target: { ref: 'a.next', index: 0, name: { untrusted: 'https://example.com', content: 'Next' }, score: 1 },
    })
    expect(fill).toHaveBeenCalledWith({ selector: '#q' }, '作业', undefined)
  })

  it('refuses a page action while the user holds the page, and hands back after it', async () => {
    const click = vi.fn(async () => HIT)
    const tools = bench(fakeBrowser({ click }))
    tools.takeover.take('')
    expect(await tools.call('headless_browser_click', { selector: '#x' })).toEqual({
      error: 'the user holds the browser; call headless_browser_hand_back when they are done',
    })
    expect(click).not.toHaveBeenCalled()
    expect(await tools.call('headless_browser_hand_back', {})).toEqual({ holder: 'agent' })
    expect(await tools.call('headless_browser_click', { selector: '#x' })).toMatchObject({ clicked: 'a.next' })
  })

  it('hands the page over with its URL and a reason, and refuses an empty reason', async () => {
    const tools = bench(fakeBrowser())
    expect(await tools.call('headless_browser_hand_over', { reason: 'sign in' })).toEqual({
      url: 'http://127.0.0.1:3081/headless-browser',
      holder: 'human',
      reason: 'sign in',
    })
    expect(tools.takeover.holder).toBe('human')
    expect(await tools.call('headless_browser_hand_over', { reason: '   ' })).toEqual({ error: 'reason must not be empty' })
  })
})
