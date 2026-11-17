/**
 * The model-facing browser tools. Each one asks the control state before it
 * touches the page, so an agent that handed the browser to the user is refused
 * with the user's reason instead of competing for the same page.
 *
 * @module @deepseek-ai/dsh-headless-browser/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { firstLine } from './error.ts'
import { DEFAULT_READ_LIMIT, MAX_READ_LIMIT, SelectorMissError, type ReadRequest, type ReadResult } from './read.ts'
import { BrowserUnavailableError } from './session.ts'
import { TabNotFoundError } from './tabs.ts'
import { UserHoldsBrowserError, type TakeoverState } from './takeover.ts'

/** The browser operations the tools call; the session class in `session.ts` satisfies them. */
export interface ToolBrowser {
  open(url: string, newTab?: boolean): Promise<{ url: string; title: string }>
  snapshot(tabId?: string, fullPage?: boolean): Promise<{ path: string; url: string }>
  read(request: ReadRequest, tabId?: string): Promise<ReadResult>
  click(selector: string, tabId?: string): Promise<{ url: string }>
  fill(selector: string, text: string, tabId?: string): Promise<void>
}

/** What the tools act on. */
export interface ToolDeps {
  /** The persistent browser. */
  readonly browser: ToolBrowser
  /** Who holds control. */
  readonly takeover: TakeoverState
  /** Absolute URL of the take-over page, read when a tool result needs it. */
  readonly pageUrl: () => string
}

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { error: { type: 'string', required: true } },
} as const

const renderJson = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

/**
 * Run one tool body, turning expected failures into a result the model can read.
 * A page-state refusal keeps its own message, which already names the fix; an
 * unexpected failure is prefixed with the action that produced it.
 * @param action - short description used in an unexpected failure message.
 * @param run - the browser operation.
 */
async function attempt<T>(action: string, run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run()
  } catch (error: unknown) {
    if (error instanceof UserHoldsBrowserError || error instanceof BrowserUnavailableError
      || error instanceof TabNotFoundError || error instanceof SelectorMissError) {
      return { error: error.message }
    }
    if (error instanceof Error) return { error: `${action} failed: ${firstLine(error)}` }
    throw error
  }
}

/**
 * Run one agent action after proving the agent still holds control.
 * @param deps - tools dependencies carrying the control state.
 * @param action - short description used in a failure message.
 * @param run - the browser operation.
 */
async function acting<T>(deps: ToolDeps, action: string, run: () => Promise<T>): Promise<T | { error: string }> {
  return attempt(action, () => {
    deps.takeover.assertAgent()
    return run()
  })
}

/**
 * Register `headless_browser_open`, `_snapshot`, `_read`, `_click`, `_type`,
 * `_hand_over`, and `_hand_back`.
 * @param ctx - the mounting scope's context.
 * @param deps - the browser, the control state, and the take-over page URL.
 */
export function registerBrowserTools(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'headless_browser_open',
    description: 'Open a URL in the headless browser and return the page title.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL, including the scheme.' },
      newTab: { type: 'boolean', description: 'Open a new tab instead of reusing the active one.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { url: { type: 'string', required: true }, title: { type: 'string', required: true } },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderJson,
    },
    execute: (args: { url: string; newTab?: boolean }) =>
      acting(deps, `opening ${args.url}`, () => deps.browser.open(args.url, args.newTab === true)),
    presentCall: args => ({ card: 'generic', title: `Open ${args.url}`, kind: 'execute', rawInput: args.url }),
  }))

  ctx.tools.register(defineTool({
    name: 'headless_browser_snapshot',
    description: 'Save a PNG screenshot of the headless browser page and return its path.',
    parameters: {
      tab: { type: 'string', description: 'Tab id to snapshot; the active tab when omitted.' },
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the viewport.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { path: { type: 'string', required: true }, url: { type: 'string', required: true } },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderJson,
    },
    // A screenshot reads the page without acting on it, so it stays available
    // while the user holds control.
    execute: (args: { tab?: string; fullPage?: boolean }) =>
      attempt('taking a screenshot', () => deps.browser.snapshot(args.tab, args.fullPage === true)),
    presentCall: args => ({
      card: 'generic',
      title: args.fullPage === true ? 'Screenshot the whole page' : 'Screenshot the browser',
      kind: 'other',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'headless_browser_read',
    description: 'Read the text of a page in the headless browser, one character range at a time, instead of its pixels.',
    parameters: {
      tab: { type: 'string', description: 'Tab id to read; the active tab when omitted.' },
      selector: { type: 'string', description: 'CSS selector whose first match is read; omit to read the document body.' },
      offset: { type: 'integer', description: 'Characters to skip from the start of the text; 0 when omitted.' },
      limit: { type: 'integer', description: `Characters to return; ${DEFAULT_READ_LIMIT} when omitted, at most ${MAX_READ_LIMIT}.` },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              header: { type: 'string', required: true },
              text: { type: 'string', required: true },
              total: { type: 'integer', required: true },
              nextOffset: { type: 'integer' },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderJson,
    },
    // Reading is part of the agent's browse-and-act loop, so a page the user
    // holds refuses it exactly like click and type.
    execute: (args: { tab?: string; selector?: string; offset?: number; limit?: number }) =>
      acting(deps, `reading ${args.tab ?? 'the active tab'}`, () => deps.browser.read({
        ...args.selector === undefined ? {} : { selector: args.selector },
        ...args.offset === undefined ? {} : { offset: args.offset },
        ...args.limit === undefined ? {} : { limit: args.limit },
      }, args.tab)),
    presentCall: args => ({ card: 'generic', title: `Read ${args.selector ?? 'the page text'}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'headless_browser_click',
    description: 'Click the first element that matches a CSS selector.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector; the first match is clicked.' },
      tab: { type: 'string', description: 'Tab id to click in; the active tab when omitted.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { clicked: { type: 'string', required: true }, url: { type: 'string', required: true } },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderJson,
    },
    execute: async (args: { selector: string; tab?: string }) => acting(deps, `clicking ${args.selector}`, async () => {
      const { url } = await deps.browser.click(args.selector, args.tab)
      return { clicked: args.selector, url }
    }),
    presentCall: args => ({ card: 'generic', title: `Click ${args.selector}`, kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'headless_browser_type',
    description: 'Replace the value of the first element that matches a CSS selector with text.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector for an input, textarea, or contenteditable element.' },
      text: { type: 'string', required: true, description: 'Text written into the element; an empty string clears it.' },
      tab: { type: 'string', description: 'Tab id to type in; the active tab when omitted.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { typed: { type: 'string', required: true } },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderJson,
    },
    execute: async (args: { selector: string; text: string; tab?: string }) => acting(deps, `typing into ${args.selector}`, async () => {
      await deps.browser.fill(args.selector, args.text, args.tab)
      return { typed: args.selector }
    }),
    presentCall: args => ({ card: 'generic', title: `Type into ${args.selector}`, kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'headless_browser_hand_over',
    description: 'Give the user control of the browser and return the page URL where they take over.',
    parameters: {
      reason: { type: 'string', required: true, description: 'What the user is needed for, for example "sign in to your account".' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              url: { type: 'string', required: true },
              holder: { type: 'string', required: true },
              reason: { type: 'string', required: true },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderJson,
    },
    execute: async (args: { reason: string }) => {
      const reason = args.reason.trim()
      if (reason === '') return { error: 'reason must not be empty' }
      deps.takeover.take(reason)
      return { url: deps.pageUrl(), holder: deps.takeover.holder, reason }
    },
    presentCall: args => ({ card: 'generic', title: `Hand over: ${args.reason}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'headless_browser_hand_back',
    description: 'Take control of the browser back from the user.',
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { holder: { type: 'string', required: true } },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderJson,
    },
    execute: async () => {
      deps.takeover.release()
      return { holder: deps.takeover.holder }
    },
    presentCall: () => ({ card: 'generic', title: 'Take control back', kind: 'other' }),
  }))
}
