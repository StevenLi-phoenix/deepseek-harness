/**
 * Route admission through the deployment's own Web server: the take-over page,
 * its status, and its live socket are reachable only by an admitted peer, and
 * the live socket additionally requires the owner principal.
 */

import { connect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import HttpServer, { type WebAuthRequest } from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { SecurityLog } from '../src/guard.ts'
import { LiveView } from '../src/live-view.ts'
import { LIVE_PATH, PAGE_PATH, STATUS_PATH, mountTakeoverRoutes } from '../src/routes.ts'
import { HeadlessBrowserSession } from '../src/session.ts'
import { TakeoverState } from '../src/takeover.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    readonly testGuest: { readonly kind: 'test-guest' }
  }
}

interface App {
  readonly ctx: Context
  readonly base: string
  readonly profileDir: string
  close(): Promise<void>
}

const apps: App[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

function headerOf(headers: WebAuthRequest['headers'], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : value?.[0]
}

function peerOf(ctx: Context, id: string, principal: PeerScope['principal']): PeerScope {
  const abort = new AbortController()
  return {
    id: id as PeerScope['id'],
    ctx,
    principal,
    signal: abort.signal,
    interactions: 'none',
    async dispose() { abort.abort() },
  }
}

/** Boot the real Web server, admit two test identities, and mount the take-over routes. */
async function boot(): Promise<App> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-headless-browser-routes-'))
  const profileDir = join(root, 'profile')
  const ctx = new Context()
  ctx.plugin(HttpServer, HttpServer.Config({ host: '127.0.0.1', port: 0 }))
  const owner = peerOf(ctx, 'route-owner', { kind: 'owner' })
  const guest = peerOf(ctx, 'route-guest', { kind: 'test-guest' })
  ctx.on('webserver/authorize', (request) => {
    const admitted = headerOf(request.headers, 'x-test-peer')
    if (admitted === 'owner') return { kind: 'allow', peer: owner }
    if (admitted === 'guest') return { kind: 'allow', peer: guest }
    return { kind: 'deny', status: 401 }
  })
  await new Promise<void>((resolve) => { ctx.inject(['webServer'], () => { resolve() }) })
  const browser = new HeadlessBrowserSession({
    profileDir,
    headless: true,
    stealth: true,
    sensitiveActions: true,
    viewportWidth: 800,
    viewportHeight: 600,
    jpegQuality: 50,
    snapshotDir: join(root, 'snapshots'),
    keepalivePath: join(root, 'keepalive.json'),
    keepaliveEscalateAfter: 3,
  }, ctx.logger)
  const takeover = new TakeoverState()
  const view = new LiveView(() => browser.castTarget(), { jpegQuality: 50, maxWidth: 800, maxHeight: 600 }, ctx.logger)
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
    ctx,
    base: `http://127.0.0.1:${String(port)}`,
    profileDir,
    async close() {
      await removeRoutes()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
  apps.push(app)
  return app
}

/** Send one raw upgrade request and resolve the bytes the server answers before closing. */
function upgrade(port: number, path: string, headers: Readonly<Record<string, string>> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let text = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('the upgrade request was not answered'))
    }, 5_000)
    socket.on('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '', '',
      ].join('\r\n'))
    })
    socket.on('data', (chunk: Buffer) => { text += chunk.toString('latin1') })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(text)
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('take-over routes', () => {
  it('refuses the page, the status, and the live socket without an admitted peer', async () => {
    const app = await boot()
    const page = await fetch(`${app.base}${PAGE_PATH}`)
    expect(page.status).toBe(401)
    expect(page.headers.get('cache-control')).toBe('no-store')
    const status = await fetch(`${app.base}${STATUS_PATH}`)
    expect(status.status).toBe(401)
    const socket = await upgrade(Number(new URL(app.base).port), LIVE_PATH)
    expect(socket).toMatch(/^HTTP\/1\.1 401 /u)
    expect(socket).not.toContain('101 Switching Protocols')
  })

  it('serves the page to the owner with the live-view script and no-store', async () => {
    const app = await boot()
    const response = await fetch(`${app.base}${PAGE_PATH}`, { headers: { 'x-test-peer': 'owner' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('id="frame"')
    expect(html).toContain(LIVE_PATH)
  })

  it('reports the control state without launching the browser', async () => {
    const app = await boot()
    const response = await fetch(`${app.base}${STATUS_PATH}`, { headers: { 'x-test-peer': 'owner' } })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ holder: 'agent', launched: false, viewers: 0, security: { events: [], dropped: 0 }, keepalive: [] })
  })

  it('refuses an admitted peer that is not the owner on the live socket', async () => {
    const app = await boot()
    const socket = await upgrade(Number(new URL(app.base).port), LIVE_PATH, { 'x-test-peer': 'guest' })
    expect(socket).toMatch(/^HTTP\/1\.1 403 /u)
    expect(socket).not.toContain('101 Switching Protocols')
  })
})
