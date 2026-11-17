/**
 * The hand-over state machine over the live socket: a control message moves
 * `TakeoverState`, every connected viewer hears the change, and input from a
 * viewer reaches the browser only while the user holds it. The browser and the
 * view are scripted here — this covers the route's forwarding and the state
 * machine, not Chromium, which `browser.spec.ts` covers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { InputCommand } from '../src/input.ts'
import { SecurityLog } from '../src/guard.ts'
import type { LiveView, Viewer } from '../src/live-view.ts'
import { LIVE_PATH, mountTakeoverRoutes } from '../src/routes.ts'
import type { HeadlessBrowserSession } from '../src/session.ts'
import { TakeoverState } from '../src/takeover.ts'

interface App {
  readonly base: string
  readonly takeover: TakeoverState
  readonly dispatched: InputCommand[]
  readonly tabIds: Array<string | undefined>
  readonly tabCommands: unknown[]
  close(): Promise<void>
}

const apps: App[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
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
async function boot(): Promise<App> {
  const ctx = new Context()
  ctx.plugin(HttpServer, HttpServer.Config({ host: '127.0.0.1', port: 0 }))
  const owner = peerOf(ctx)
  ctx.on('webserver/authorize', () => ({ kind: 'allow', peer: owner }))
  await new Promise<void>((resolve) => { ctx.inject(['webServer'], () => { resolve() }) })

  const dispatched: InputCommand[] = []
  const tabIds: Array<string | undefined> = []
  const tabCommands: unknown[] = []
  const browser = {
    async dispatch(command: InputCommand, tabId?: string): Promise<unknown> {
      dispatched.push(command)
      tabIds.push(tabId)
      return undefined
    },
    async applyTabCommand(message: unknown): Promise<void> { tabCommands.push(message) },
    tabsState: () => [],
    onTabsChange: () => () => {},
    status: () => ({ launched: true, url: 'https://example.com/signin', tabs: 0 }),
  } as unknown as HeadlessBrowserSession
  const viewers = new Set<Viewer>()
  const view = {
    size: 0,
    async attach(viewer: Viewer): Promise<() => void> {
      viewers.add(viewer)
      return () => { viewers.delete(viewer) }
    },
    async detach(viewer: Viewer): Promise<void> { viewers.delete(viewer) },
    broadcast(message: unknown): void {
      for (const viewer of viewers) viewer.send(JSON.stringify(message))
    },
    async refresh(): Promise<void> {},
    async close(): Promise<void> { viewers.clear() },
  } as unknown as LiveView
  const takeover = new TakeoverState()
  const removeRoutes = mountTakeoverRoutes(ctx.webServer, {
    browser,
    takeover,
    view,
    security: new SecurityLog(),
    keepalives: () => [],
    log: ctx.logger,
  })
  const port = ctx.webServer.port
  if (port === undefined) throw new Error('the test Web server did not bind a port')
  const app: App = {
    base: `127.0.0.1:${String(port)}`,
    takeover,
    dispatched,
    tabIds,
    tabCommands,
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
    socket.on('message', (data) => { deliver(String(data)) })
    socket.on('error', reject)
    socket.on('open', () => {
      resolve({ socket, messages, next, send: (message) => { socket.send(JSON.stringify(message)) } })
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

function isState(message: unknown): message is { type: 'state'; holder: string; reason?: string } {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'state'
}
