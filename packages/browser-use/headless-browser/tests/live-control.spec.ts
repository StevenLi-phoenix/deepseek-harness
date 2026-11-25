/**
 * The hand-over state machine over the live socket: a control message moves
 * `TakeoverState`, every connected viewer hears the change, and input from a
 * viewer reaches the browser only while the user holds it. The browser and the
 * view are scripted here — this covers the route's forwarding and the state
 * machine, not Chromium, which `browser.spec.ts` covers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { cdpCommand, type InputCommand, type TabInfo } from '../src/input.ts'
import { SecurityLog } from '../src/guard.ts'
import type { Viewer } from '../src/live-view.ts'
import { LIVE_PATH, mountTakeoverRoutes, type TakeoverRoutesDeps } from '../src/routes.ts'
import { TakeoverState } from '../src/takeover.ts'

// The real mapping, wrapped so one test can answer with the `undefined` its declared result allows.
vi.mock('../src/input.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/input.ts')>()
  return { ...actual, cdpCommand: vi.fn(actual.cdpCommand) }
})

interface App {
  readonly base: string
  readonly takeover: TakeoverState
  readonly dispatched: InputCommand[]
  readonly tabIds: Array<string | undefined>
  readonly tabCommands: unknown[]
  /** Every viewer the route attached, including ones that left. */
  readonly attached: Viewer[]
  /** How many viewers the route detached. */
  detached(): number
  /** The logger the routes write to. */
  readonly log: Context['logger']
  /** How many times the route asked the view to follow the active tab. */
  refreshes(): number
  /** Replace the tab strip and tell the route, as the browser does when a tab opens, closes, or moves. */
  changeTabs(tabs: TabInfo[]): void
  close(): Promise<void>
}

/** Behavior a test swaps into the scripted browser and view. */
interface BootOptions {
  /** Runs before the view accepts a viewer; a rejection refuses it. */
  readonly attach?: (viewer: Viewer) => Promise<void>
  /** Runs before the browser records a command; a rejection fails it. */
  readonly dispatch?: (command: InputCommand, tabId?: string) => Promise<void>
}

const apps: App[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  vi.restoreAllMocks()
})

function peerOf(ctx: Context): PeerScope {
  const abort = new AbortController()
  return {
    id: 'live-control' as PeerScope['id'],
    ctx,
    principal: { kind: 'owner' },
    signal: abort.signal,
    interactions: 'none',
    async dispose() { abort.abort() },
  }
}

/** Boot the real Web server over a scripted browser and live view. */
async function boot(options: BootOptions = {}): Promise<App> {
  const ctx = new Context()
  ctx.plugin(HttpServer, HttpServer.Config({ host: '127.0.0.1', port: 0 }))
  const owner = peerOf(ctx)
  ctx.on('webserver/authorize', () => ({ kind: 'allow', peer: owner }))
  await new Promise<void>((resolve) => { ctx.inject(['webServer'], () => { resolve() }) })

  const dispatched: InputCommand[] = []
  const tabIds: Array<string | undefined> = []
  const tabCommands: unknown[] = []
  let tabs: TabInfo[] = []
  const tabListeners = new Set<() => void>()
  const browser = {
    async dispatch(command: InputCommand, tabId?: string): Promise<void> {
      await options.dispatch?.(command, tabId)
      dispatched.push(command)
      tabIds.push(tabId)
    },
    async applyTabCommand(message: unknown): Promise<void> { tabCommands.push(message) },
    tabsState: () => tabs,
    onTabsChange(listener: () => void): () => void {
      tabListeners.add(listener)
      return () => { tabListeners.delete(listener) }
    },
    status: () => ({ launched: true, url: 'https://example.com/signin', tabs: 0 }),
  } satisfies TakeoverRoutesDeps['browser']
  const viewers = new Set<Viewer>()
  const attached: Viewer[] = []
  let detached = 0
  let refreshes = 0
  const view = {
    size: 0,
    async attach(viewer: Viewer): Promise<void> {
      attached.push(viewer)
      await options.attach?.(viewer)
      viewers.add(viewer)
    },
    async detach(viewer: Viewer): Promise<void> {
      viewers.delete(viewer)
      detached += 1
    },
    broadcast(message: unknown): void {
      for (const viewer of viewers) viewer.send(JSON.stringify(message))
    },
    async refresh(): Promise<void> { refreshes += 1 },
    async close(): Promise<void> { viewers.clear() },
  } satisfies TakeoverRoutesDeps['view']
  const takeover = new TakeoverState()
  const log = ctx.logger
  const removeRoutes = mountTakeoverRoutes(ctx.webServer, {
    browser,
    takeover,
    view,
    security: new SecurityLog(),
    keepalives: () => [],
    log,
  })
  const port = ctx.webServer.port
  if (port === undefined) throw new Error('the test Web server did not bind a port')
  const app: App = {
    base: `127.0.0.1:${String(port)}`,
    takeover,
    dispatched,
    tabIds,
    tabCommands,
    attached,
    detached: () => detached,
    log,
    refreshes: () => refreshes,
    changeTabs(next) {
      tabs = next
      for (const listener of tabListeners) listener()
    },
    async close() {
      await removeRoutes()
      await ctx.fiber.dispose()
    },
  }
  apps.push(app)
  return app
}

interface LiveSocket {
  readonly socket: WebSocket
  readonly messages: unknown[]
  /** Settles with the close code and reason once the Host closes the socket. */
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>
  send(message: unknown): void
  /** Wait for a message satisfying `match`, then return it. */
  next(match: (message: unknown) => boolean): Promise<unknown>
}

/** Open the live socket as the owner and collect everything the Host sends. */
function openLive(base: string): Promise<LiveSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${base}${LIVE_PATH}`, { headers: { 'x-test-peer': 'owner' } })
    const messages: unknown[] = []
    // A cursor, so a wait never answers with a message an earlier wait already returned.
    let cursor = 0
    const waiters: Array<{ match: (message: unknown) => boolean; resolve: (message: unknown) => void }> = []
    const deliver = (text: string): void => {
      const message: unknown = JSON.parse(text)
      messages.push(message)
      for (const waiter of [...waiters]) {
        if (!waiter.match(message)) continue
        waiters.splice(waiters.indexOf(waiter), 1)
        cursor = messages.length
        waiter.resolve(message)
      }
    }
    const next: LiveSocket['next'] = (match) => {
      for (let index = cursor; index < messages.length; index++) {
        const message = messages[index]
        if (!match(message)) continue
        cursor = index + 1
        return Promise.resolve(message)
      }
      return new Promise((settle, fail) => {
        const timer = setTimeout(() => {
          waiters.splice(waiters.findIndex(waiter => waiter.resolve === deliverLater), 1)
          fail(new Error('the expected message never arrived'))
        }, 5_000)
        const deliverLater = (message: unknown): void => {
          clearTimeout(timer)
          settle(message)
        }
        waiters.push({ match, resolve: deliverLater })
      })
    }
    const closed = new Promise<{ readonly code: number; readonly reason: string }>((settle) => {
      socket.on('close', (code, reason) => { settle({ code, reason: reason.toString('utf8') }) })
    })
    socket.on('message', (data) => { deliver(rawText(data)) })
    socket.on('error', reject)
    socket.on('open', () => {
      resolve({ socket, messages, closed, next, send: (message) => { socket.send(JSON.stringify(message)) } })
    })
  })
}

describe('take-over socket control', () => {
  it('moves control between the agent and the user and forwards input only while the user holds it', async () => {
    const app = await boot()
    const live = await openLive(app.base)
    try {
      // A connecting viewer learns who holds the browser before anything else happens.
      await expect(live.next(isState)).resolves.toEqual({ type: 'state', holder: 'agent', tabs: [] })

      const input = { type: 'mouse', event: 'down', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }
      live.send(input)
      await new Promise(resolve => setTimeout(resolve, 50))
      // The agent holds the browser, so a stray pointer event moves nothing.
      expect(app.dispatched).toEqual([])
      expect(app.takeover.holder).toBe('agent')

      live.send({ type: 'control', action: 'take', reason: 'signing in' })
      await expect(live.next(message => isState(message) && message.holder === 'human'))
        .resolves.toEqual({ type: 'state', holder: 'human', reason: 'signing in', tabs: [] })
      expect(app.takeover.view()).toEqual({ holder: 'human', reason: 'signing in' })

      live.send(input)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(app.dispatched).toEqual([{
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
      }])

      live.send({ type: 'control', action: 'release' })
      await expect(live.next(message => isState(message) && message.holder === 'agent'))
        .resolves.toEqual({ type: 'state', holder: 'agent', tabs: [] })
      expect(app.takeover.view()).toEqual({ holder: 'agent' })

      live.send(input)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(app.dispatched).toHaveLength(1)
    } finally {
      live.socket.close()
    }
  })

  it('forwards a tab operation and its tab id only while the user holds control', async () => {
    const app = await boot()
    const live = await openLive(app.base)
    try {
      await live.next(isState)
      live.send({ type: 'tab', action: 'activate', tabId: 't2' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(app.tabCommands).toEqual([])

      live.send({ type: 'control', action: 'take', reason: 'switching tabs' })
      await live.next(message => isState(message) && message.holder === 'human')
      live.send({ type: 'tab', action: 'activate', tabId: 't2' })
      live.send({ type: 'mouse', tabId: 't2', event: 'down', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 })
      await vi.waitFor(() => { expect(app.tabCommands).toHaveLength(1); expect(app.dispatched).toHaveLength(1) })
      expect(app.tabCommands[0]).toEqual({ type: 'tab', action: 'activate', tabId: 't2' })
      expect(app.tabIds).toEqual(['t2'])
    } finally {
      live.socket.close()
    }
  })

  it('sends the new tab strip to the page and follows the active tab when the tabs change', async () => {
    const app = await boot()
    const live = await openLive(app.base)
    try {
      await live.next(isState)
      const tabs: TabInfo[] = [{ id: 't1', title: 'Inbox', url: 'https://example.com/inbox', loading: false, active: true }]
      app.changeTabs(tabs)
      await expect(live.next(isState)).resolves.toEqual({ type: 'state', holder: 'agent', tabs })
      expect(app.refreshes()).toBe(1)
    } finally {
      live.socket.close()
    }
  })

  it('tells every connected viewer about one control change', async () => {
    const app = await boot()
    const first = await openLive(app.base)
    const second = await openLive(app.base)
    try {
      await Promise.all([first.next(isState), second.next(isState)])
      first.send({ type: 'control', action: 'take', reason: 'paying' })
      await expect(first.next(message => isState(message) && message.holder === 'human')).resolves.toMatchObject({ reason: 'paying' })
      await expect(second.next(message => isState(message) && message.holder === 'human')).resolves.toMatchObject({ reason: 'paying' })
    } finally {
      first.socket.close()
      second.socket.close()
    }
  })
})

describe('take-over socket input', () => {
  it('drops binary frames, malformed text, and unknown messages, and takes control without a stated reason', async () => {
    const app = await boot()
    const changes: unknown[] = []
    app.takeover.onChange((view) => { changes.push(view) })
    const live = await openLive(app.base)
    try {
      await live.next(isState)
      live.socket.send(Buffer.from(JSON.stringify({ type: 'control', action: 'take', reason: 'binary' })), { binary: true })
      live.socket.send('{ not json')
      live.send({ type: 'nonsense', action: 'take' })
      live.send({ type: 'control', action: 'take' })
      // The socket delivers in order, so the first change is the last message's.
      await expect(live.next(message => isState(message) && message.holder === 'human'))
        .resolves.toEqual({ type: 'state', holder: 'human', tabs: [] })
      expect(changes).toEqual([{ holder: 'human' }])
    } finally {
      live.socket.close()
    }
  })

  it('answers the page with the failure when the browser cannot apply its input', async () => {
    const app = await boot({ dispatch: async () => { throw new Error('the tab closed\nprotocol detail') } })
    const warn = vi.spyOn(app.log, 'warn')
    const live = await openLive(app.base)
    try {
      await live.next(isState)
      live.send({ type: 'control', action: 'take', reason: 'typing' })
      await live.next(message => isState(message) && message.holder === 'human')
      live.send({ type: 'text', text: 'hello' })
      await expect(live.next(isError)).resolves.toEqual({ type: 'error', message: 'the tab closed' })
      expect(warn).toHaveBeenCalledWith('headless-browser: forwarding a browser operation failed: %s', 'the tab closed')
      expect(app.dispatched).toEqual([])
    } finally {
      live.socket.close()
    }
  })

  it('forwards nothing for an input message that maps to no browser command', async () => {
    const app = await boot()
    const live = await openLive(app.base)
    try {
      await live.next(isState)
      live.send({ type: 'control', action: 'take', reason: 'typing' })
      await live.next(message => isState(message) && message.holder === 'human')
      vi.mocked(cdpCommand).mockReturnValueOnce(undefined)
      live.send({ type: 'text', text: 'dropped' })
      live.send({ type: 'text', text: 'kept' })
      await vi.waitFor(() => { expect(app.dispatched).toHaveLength(1) })
      expect(app.dispatched).toEqual([{ method: 'Input.insertText', params: { text: 'kept' } }])
    } finally {
      live.socket.close()
    }
  })

  it('tells the page the browser is unavailable and closes the socket when the view cannot attach', async () => {
    const app = await boot({ attach: async () => { throw new Error('Chromium is not installed\nrun playwright-core install') } })
    const live = await openLive(app.base)
    await expect(live.next(isError)).resolves.toEqual({ type: 'error', message: 'Chromium is not installed' })
    await expect(live.closed).resolves.toEqual({ code: 1011, reason: 'browser unavailable' })
  })

  it('drops a message for a page that already closed instead of sending it', async () => {
    const app = await boot()
    const live = await openLive(app.base)
    await live.next(isState)
    const [viewer] = app.attached
    if (viewer === undefined) throw new Error('the route attached no viewer')
    live.socket.close()
    await live.closed
    await vi.waitFor(() => { expect(app.detached()).toBe(1) })
    expect(() => { viewer.send(JSON.stringify({ type: 'state', holder: 'agent', tabs: [] })) }).not.toThrow()
  })

  it('logs a socket failure, such as a message over the size limit, and closes that socket', async () => {
    const app = await boot()
    const warn = vi.spyOn(app.log, 'warn')
    const live = await openLive(app.base)
    await live.next(isState)
    live.socket.send('x'.repeat(65 * 1024))
    await expect(live.closed).resolves.toMatchObject({ code: 1009 })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('headless-browser: take-over socket failed: %s', expect.stringContaining('Max payload size exceeded'))
    })
  })
})

function isError(message: unknown): message is { type: 'error'; message: string } {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'error'
}

function isState(message: unknown): message is { type: 'state'; holder: string; reason?: string } {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'state'
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}
