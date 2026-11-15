/**
 * The Host routes of one take-over view: a page that shows the live frame and
 * forwards input, a status route, and the WebSocket behind the page. Admission
 * is the deployment's own: the page and status use the default required
 * policy, and the live socket additionally requires the owner principal,
 * because taking over a signed-in profile is the owner's authority.
 *
 * @module @deepseek-ai/dsh-headless-browser/routes
 */

import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { WebSocket, WebSocketServer } from 'ws'
import { firstLine } from './error.ts'
import { cdpCommand, decodeClientMessage, type ClientMessage } from './input.ts'
import type { LiveView, Viewer } from './live-view.ts'
import { PAGE_HTML } from './page.ts'
import { LIVE_PATH, PAGE_PATH, STATUS_PATH } from './paths.ts'
import type { HeadlessBrowserSession } from './session.ts'
import type { TakeoverState } from './takeover.ts'

export { LIVE_PATH, PAGE_PATH, STATUS_PATH } from './paths.ts'

/** Largest accepted socket message; the page sends a few hundred bytes at most. */
const MAX_MESSAGE_BYTES = 64 * 1024

const NO_STORE = { 'cache-control': 'no-store' } as const
const PAGE_HEADERS = { ...NO_STORE, 'content-type': 'text/html; charset=utf-8' } as const

/** What the routes act on. */
export interface TakeoverRoutesDeps {
  /** The browser whose page the view shows. */
  readonly browser: HeadlessBrowserSession
  /** Who holds control. */
  readonly takeover: TakeoverState
  /** The shared screencast. */
  readonly view: LiveView
  /** Plugin logger for dropped input and socket failures. */
  readonly log: Context['logger']
}

/**
 * Register the page, the status route, and the live socket.
 * @param server - the deployment's Web server, which applies its own admission.
 * @param deps - the browser, control state, and live view to expose.
 * @returns the disposer that removes every route and closes connected pages.
 */
export function mountTakeoverRoutes(server: WebServer, deps: TakeoverRoutesDeps): () => Promise<void> {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  const stopState = deps.takeover.onChange(view => deps.view.broadcast({ type: 'state', ...view }))
  const removePage = server.register({
    kind: 'exact',
    path: PAGE_PATH,
    resource: () => Promise.resolve(new Response(PAGE_HTML, { headers: PAGE_HEADERS })),
  })
  const removeStatus = server.register({
    kind: 'exact',
    path: STATUS_PATH,
    resource: () => Promise.resolve(statusResponse(deps)),
  })
  const removeLive = server.registerUpgrade({
    path: LIVE_PATH,
    auth: 'required',
    handler: (request, socket, head, peer) => {
      if (peer?.principal.kind !== 'owner') {
        refuse(socket)
        return
      }
      sockets.handleUpgrade(request, socket, head, client => adopt(deps, client))
    },
  })
  return async () => {
    stopState()
    removePage()
    removeStatus()
    removeLive()
    for (const client of sockets.clients) client.terminate()
    await new Promise<void>((resolve) => { sockets.close(() => { resolve() }) })
    await deps.view.close()
  }
}

function statusResponse(deps: TakeoverRoutesDeps): Response {
  return Response.json({
    ...deps.takeover.view(),
    ...deps.browser.status(),
    viewers: deps.view.size,
  }, { headers: NO_STORE })
}

/** Answer an authenticated non-owner on the upgrade before any protocol negotiation. */
function refuse(socket: Duplex): void {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n')
}

/** Wire one accepted browser socket to the live view and the control state. */
function adopt(deps: TakeoverRoutesDeps, client: WebSocket): void {
  const viewer: Viewer = {
    send(text) {
      if (client.readyState === WebSocket.OPEN) client.send(text)
    },
  }
  client.send(JSON.stringify({ type: 'state', ...deps.takeover.view() }))
  const attaching = deps.view.attach(viewer).catch((error: unknown) => {
    // The page opened before Chromium started: say so, then let the page reconnect.
    viewer.send(JSON.stringify({ type: 'error', message: firstLine(error) }))
    client.close(1011, 'browser unavailable')
  })
  client.on('message', (data, binary) => {
    if (binary) return
    void forward(deps, String(data))
  })
  client.on('close', () => { void deps.view.detach(viewer) })
  client.on('error', (error: Error) => { deps.log.warn('headless-browser: take-over socket failed: %s', firstLine(error)) })
  void attaching
}

/**
 * Apply one page message. Control changes always apply; input applies only while
 * the user holds control, so a stray pointer event cannot move the agent's page.
 */
async function forward(deps: TakeoverRoutesDeps, text: string): Promise<void> {
  const message = parseMessage(text)
  if (message === undefined) return
  if (message.type === 'control') {
    if (message.action === 'take') deps.takeover.take(message.reason ?? '')
    else deps.takeover.release()
    return
  }
  if (deps.takeover.holder !== 'human') return
  const command = cdpCommand(message)
  if (command === undefined) return
  try {
    await deps.browser.dispatch(command)
  } catch (error: unknown) {
    deps.log.warn('headless-browser: forwarding input failed: %s', firstLine(error))
  }
}

function parseMessage(text: string): ClientMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    // The page is this socket's only writer; malformed text is dropped, not fatal.
    void error
    return undefined
  }
  return decodeClientMessage(value)
}
