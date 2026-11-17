/**
 * The model-facing tools: which ones exist, what each one forwards to the
 * browser, and the refusals a call gets back instead of a page.
 */

import { Context } from '@deepseek-ai/cordis'
import { assertSupportedJsonSchema, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { SelectorMissError, type ReadRequest, type ReadResult } from '../src/read.ts'
import { TabNotFoundError } from '../src/tabs.ts'
import { TakeoverState } from '../src/takeover.ts'
import { registerBrowserTools, type ToolBrowser } from '../src/tools.ts'

/** The read result the fake browser answers with. */
const READ: ReadResult = {
  header: 'text of t1 (https://example.com/assignments): page 1 of 1, characters 1-12 of 12',
  text: '01 作业',
  total: 12,
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
    click: async () => ({ url: 'https://example.com/' }),
    fill: async () => {},
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
  it('registers the three page reads, the two page actions, and the two control tools', () => {
    const tools = bench(fakeBrowser())
    expect([...tools.definitions.keys()]).toEqual([
      'headless_browser_open',
      'headless_browser_snapshot',
      'headless_browser_read',
      'headless_browser_click',
      'headless_browser_type',
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
})

describe('reading through the tool', () => {
  it('returns the window and forwards the selector, offset, limit, and tab', async () => {
    const read = vi.fn(async (_request: ReadRequest, _tab?: string) => READ)
    const tools = bench(fakeBrowser({ read }))
    const value = await tools.call('headless_browser_read', { selector: '#rows', offset: 40, limit: 12, tab: 't2' })
    expect(read).toHaveBeenCalledWith({ selector: '#rows', offset: 40, limit: 12 }, 't2')
    expect(value).toEqual(READ)
    const definition = definitionOf(tools, 'headless_browser_read')
    expect(definition.output.render({}, value as never)).toEqual([{ type: 'text', text: JSON.stringify(READ) }])
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
    expect(await tools.call('headless_browser_snapshot', {})).toEqual({ path: '/tmp/page.png', url: 'https://example.com/' })
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
      .toEqual({ path: '/tmp/page.png', url: 'https://example.com/' })
  })
})

describe('page actions and control', () => {
  it('forwards open, click, and type to the browser', async () => {
    const open = vi.fn(async (_url: string, _newTab?: boolean) => ({ url: 'https://example.com/', title: 'Example' }))
    const click = vi.fn(async (_selector: string, _tab?: string) => ({ url: 'https://example.com/next' }))
    const fill = vi.fn(async (_selector: string, _text: string, _tab?: string) => {})
    const tools = bench(fakeBrowser({ open, click, fill }))
    expect(await tools.call('headless_browser_open', { url: 'https://example.com/', newTab: true }))
      .toEqual({ url: 'https://example.com/', title: 'Example' })
    expect(open).toHaveBeenCalledWith('https://example.com/', true)
    expect(await tools.call('headless_browser_click', { selector: 'a.next', tab: 't2' }))
      .toEqual({ clicked: 'a.next', url: 'https://example.com/next' })
    expect(click).toHaveBeenCalledWith('a.next', 't2')
    expect(await tools.call('headless_browser_type', { selector: '#q', text: '作业' })).toEqual({ typed: '#q' })
    expect(fill).toHaveBeenCalledWith('#q', '作业', undefined)
  })

  it('refuses a page action while the user holds the page, and hands back after it', async () => {
    const click = vi.fn(async () => ({ url: 'https://example.com/' }))
    const tools = bench(fakeBrowser({ click }))
    tools.takeover.take('')
    expect(await tools.call('headless_browser_click', { selector: '#x' })).toEqual({
      error: 'the user holds the browser; call headless_browser_hand_back when they are done',
    })
    expect(click).not.toHaveBeenCalled()
    expect(await tools.call('headless_browser_hand_back', {})).toEqual({ holder: 'agent' })
    expect(await tools.call('headless_browser_click', { selector: '#x' })).toEqual({ clicked: '#x', url: 'https://example.com/' })
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
