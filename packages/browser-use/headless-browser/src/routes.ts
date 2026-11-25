/**
 * The Host routes of one take-over view: a page that shows the live frame and
 * forwards input, a status route, and the WebSocket behind the page. Admission
 * is the deployment's own: the page and status use the default required
 * policy, and the live socket additionally requires the owner principal,
 * because taking over a signed-in profile is the owner's authority.
 *
 * The socket speaks protocol v2: `state` carries the tab strip, `frame` names
 * the tab it belongs to, and input messages may name a tab. A v1 page that
 * sends no tab id still works and acts on the active tab.
 *
 * @module @deepseek-ai/dsh-headless-browser/routes
 */

import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { WebSocket, WebSocketServer } from 'ws'
import type { CredentialVault } from './credentials.ts'
import { firstLine } from './error.ts'
import type { SecurityLog } from './guard.ts'
import { cdpCommand, decodeClientMessage, type ClientMessage } from './input.ts'
import type { KeepaliveStatus } from './keepalive.ts'
import type { LiveView, Viewer } from './live-view.ts'
import { PAGE_HTML } from './page.ts'
import { CREDENTIALS_CSV_PATH, CREDENTIALS_PATH, LIVE_PATH, PAGE_PATH, STATUS_PATH } from './paths.ts'
import type { HeadlessBrowserSession } from './session.ts'
import type { TakeoverState } from './takeover.ts'

export { CREDENTIALS_CSV_PATH, CREDENTIALS_PATH, LIVE_PATH, PAGE_PATH, STATUS_PATH } from './paths.ts'

/** Largest accepted socket message; the page sends a few hundred bytes at most. */
const MAX_MESSAGE_BYTES = 64 * 1024

const NO_STORE = { 'cache-control': 'no-store' } as const
const PAGE_HEADERS = { ...NO_STORE, 'content-type': 'text/html; charset=utf-8' } as const

/** What the routes act on. */
export interface TakeoverRoutesDeps {
  /** The browser whose tabs the view shows. */
  readonly browser: HeadlessBrowserSession
  /** Who holds control. */
  readonly takeover: TakeoverState
  /** The shared screencast. */
  readonly view: LiveView
  /** Guard decisions, so the status route can report refusals and drifts. */
  readonly security: SecurityLog
  /** Session keepalives, with their state and retry schedule. */
  readonly keepalives: () => KeepaliveStatus[]
  /** Plugin logger for dropped input and socket failures. */
  readonly log: Context['logger']
  /** The saved site accounts; only the owner principal reads them. */
  readonly credentials?: Pick<CredentialVault, 'list' | 'exportCsv'>
}

/**
 * Register the page, the status route, and the live socket.
 * @param server - the deployment's Web server, which applies its own admission.
 * @param deps - the browser, control state, and live view to expose.
 * @returns the disposer that removes every route and closes connected pages.
 */
export function mountTakeoverRoutes(server: WebServer, deps: TakeoverRoutesDeps): () => Promise<void> {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  const stopState = deps.takeover.onChange(() => { broadcastState(deps) })
  const stopTabs = deps.browser.onTabsChange(() => {
    broadcastState(deps)
    void deps.view.refresh()
  })
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
  const credentials = deps.credentials
  const removeCredentials = credentials === undefined ? () => {} : server.register({
    kind: 'exact',
    path: CREDENTIALS_PATH,
    auth: 'required',
    resource: async (_request, peer) => {
      if (peer?.principal.kind !== 'owner') return ownerOnly()
      return Response.json({ accounts: await credentials.list(), export: CREDENTIALS_CSV_PATH }, { headers: NO_STORE })
    },
  })
  const removeCredentialsCsv = credentials === undefined ? () => {} : server.register({
    kind: 'exact',
    path: CREDENTIALS_CSV_PATH,
    auth: 'required',
    resource: async (_request, peer) => {
      if (peer?.principal.kind !== 'owner') return ownerOnly()
      deps.log.info('headless-browser: the owner exported the saved site passwords')
      return new Response(await credentials.exportCsv(), {
        headers: {
          ...NO_STORE,
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="dsh-site-passwords.csv"',
        },
      })
    },
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
    stopTabs()
    removePage()
    removeStatus()
    removeCredentials()
    removeCredentialsCsv()
    removeLive()
    for (const client of sockets.clients) client.terminate()
    await new Promise<void>((resolve) => { sockets.close(() => { resolve() }) })
    await deps.view.close()
  }
}

/** The answer a signed-in non-owner gets from an owner-only route. */
function ownerOnly(): Response {
  return Response.json({ error: 'only the owner reads saved site accounts' }, { status: 403, headers: NO_STORE })
}

function statusResponse(deps: TakeoverRoutesDeps): Response {
  return Response.json({
    ...deps.takeover.view(),
    ...deps.browser.status(),
    viewers: deps.view.size,
    security: deps.security.view(),
    keepalive: deps.keepalives(),
  }, { headers: NO_STORE })
}

/** The state message every viewer receives: holder plus the whole tab strip. */
function stateMessage(deps: TakeoverRoutesDeps): unknown {
  return { type: 'state', ...deps.takeover.view(), tabs: deps.browser.tabsState() }
}

/** Tell every open viewer what the browser and its holder look like now. */
function broadcastState(deps: TakeoverRoutesDeps): void {
  deps.view.broadcast(stateMessage(deps))
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
  client.send(JSON.stringify(stateMessage(deps)))
  const attaching = deps.view.attach(viewer).catch((error: unknown) => {
    // The page opened before Chromium started: say so, then let the page reconnect.
    viewer.send(JSON.stringify({ type: 'error', message: firstLine(error) }))
    client.close(1011, 'browser unavailable')
  })
  client.on('message', (data, binary) => {
    if (binary) return
    void forward(deps, String(data), text => viewer.send(text))
  })
  client.on('close', () => { void deps.view.detach(viewer) })
  client.on('error', (error: Error) => { deps.log.warn('headless-browser: take-over socket failed: %s', firstLine(error)) })
  void attaching
}

/**
 * Apply one page message. Control changes always apply; browser chrome and
 * input apply only while the user holds control, so a stray pointer event or
 * tab switch cannot move the agent's page.
 */
async function forward(deps: TakeoverRoutesDeps, text: string, reply: (text: string) => void): Promise<void> {
  const message = parseMessage(text)
  if (message === undefined) return
  if (message.type === 'control') {
    if (message.action === 'take') deps.takeover.take(message.reason ?? '')
    else deps.takeover.release()
    return
  }
  if (deps.takeover.holder !== 'human') return
  try {
    if (message.type === 'tab') {
      await deps.browser.applyTabCommand(message)
      broadcastState(deps)
      return
    }
    const command = cdpCommand(message)
    if (command === undefined) return
    await deps.browser.dispatch(command, message.tabId)
  } catch (error: unknown) {
    deps.log.warn('headless-browser: forwarding a browser operation failed: %s', firstLine(error))
    reply(JSON.stringify({ type: 'error', message: firstLine(error) }))
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
