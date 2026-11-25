/**
 * The plugin entry mounted in a real Context: the model tools it registers, the
 * take-over routes it adds beside a Web server, the page link a composition
 * without one gets, the failures it logs instead of throwing, and that
 * disposing the plugin removes every registration and the browser's
 * process-exit hook. Only the exit-hook case launches Chromium; it skips when
 * Playwright cannot resolve a Chromium binary for this machine.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright-core'
import { WebSocket, type RawData } from 'ws'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import Tools from '@deepseek-ai/dsh-tools'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { Config } from '../src/config.ts'
import type { SecurityEvent } from '../src/guard.ts'
import * as headlessBrowser from '../src/index.ts'
import { KeepaliveService, type KeepaliveEvent } from '../src/keepalive.ts'
import { CREDENTIALS_PATH, LIVE_PATH, PAGE_PATH, STATUS_PATH } from '../src/paths.ts'
import { HeadlessBrowserSession } from '../src/session.ts'

const AVAILABLE = existsSync(chromium.executablePath())

/** Every tool the plugin registers, in registration order. */
const TOOL_NAMES = [
  'headless_browser_open',
  'headless_browser_snapshot',
  'headless_browser_downloads',
  'headless_browser_read',
  'headless_browser_click',
  'headless_browser_type',
  'headless_browser_scroll',
  'headless_browser_close',
  'headless_browser_hand_over',
  'headless_browser_hand_back',
  'headless_browser_cookies',
  'headless_browser_keepalive',
  'headless_browser_upload',
  'headless_browser_credential',
]

/**
 * The run context a tool body receives; none of these tools reads it.
 * The executor mints its branded identity, so a direct body call passes none.
 */
const EXEC = {
  signal: new AbortController().signal,
  deferContext: () => {},
  concludeTurn: () => {},
} as never

interface Mounted {
  readonly ctx: Context
  readonly root: string
  /** The plugin's own fiber; disposing it is what an HMR reload does. */
  readonly fiber: Fiber
  /** Arguments of every warning the plugin logged. */
  readonly warnings: unknown[][]
  /** Every `headless-browser/security` event the plugin emitted. */
  readonly security: SecurityEvent[]
  /** Every `headless-browser/keepalive` event the plugin emitted. */
  readonly keepalive: KeepaliveEvent[]
  /** Origin of the Web server, when one was mounted. */
  readonly origin?: string
  /** Names of the tools the registry holds, in registration order. */
  toolNames(): string[]
  /** Run one registered tool body. */
  call(name: string, args: object): Promise<unknown>
}

interface MountOptions {
  /** Mount the deployment's Web server first. */
  readonly web: boolean
  /** Fields that differ from the temporary-directory defaults, given that directory. */
  readonly config?: (root: string) => Partial<Config>
  /** Hand `apply` the config as given instead of resolving it through the plugin's `Config` schema. */
  readonly resolved?: boolean
  /** Prepare the temporary directory before the plugin mounts. */
  readonly prepare?: (root: string) => void
}

const mounted: Mounted[] = []

afterEach(async () => {
  for (const app of mounted.splice(0)) {
    await app.ctx.fiber.dispose()
    rmSync(app.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function peerOf(ctx: Context): PeerScope {
  const abort = new AbortController()
  return {
    id: 'headless-browser-plugin' as PeerScope['id'],
    ctx,
    principal: { kind: 'owner' },
    signal: abort.signal,
    interactions: 'none',
    async dispose() { abort.abort() },
  }
}

/** A complete config whose every path sits in one temporary directory. */
function configAt(root: string, overrides: Partial<Config>): Config {
  return {
    profileDir: join(root, 'profile'),
    headless: true,
    stealth: false,
    sensitiveActions: true,
    viewportWidth: 800,
    viewportHeight: 600,
    jpegQuality: 50,
    snapshotDir: join(root, 'snapshots'),
    keepalivePath: join(root, 'keepalive.json'),
    keepaliveEscalateAfter: 3,
    downloadDir: join(root, 'downloads'),
    maxDownloadMB: 256,
    downloadRetainDays: 7,
    downloadPdfs: true,
    credentialsPath: join(root, 'credentials.json'),
    uploadDirs: [join(root, 'uploads')],
    maxUploadMB: 25,
    ...overrides,
  }
}

/** Open the live socket as the owner and collect every message until the Host closes it. */
function liveUntilClosed(origin: string): Promise<{ readonly messages: unknown[]; readonly code: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}${LIVE_PATH}`)
    const messages: unknown[] = []
    socket.on('message', (data: RawData) => { messages.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8'))) })
    socket.on('close', (code) => { resolve({ messages, code }) })
    socket.on('error', reject)
  })
}

/** Mount the plugin into the real tool registry, beside the real Web server when asked. */
async function mount(options: MountOptions): Promise<Mounted> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-headless-browser-plugin-'))
  options.prepare?.(root)
  const ctx = new Context()
  const warnings: unknown[][] = []
  ctx.logger.exporter({ export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
  const security: SecurityEvent[] = []
  ctx.on('headless-browser/security', (event) => { security.push(event) })
  const keepalive: KeepaliveEvent[] = []
  ctx.on('headless-browser/keepalive', (event) => { keepalive.push(event) })
  let origin: string | undefined
  if (options.web) {
    ctx.plugin(HttpServer, HttpServer.Config({ host: '127.0.0.1', port: 0 }))
    const owner = peerOf(ctx)
    ctx.on('webserver/authorize', () => ({ kind: 'allow', peer: owner }))
    await new Promise<void>((resolve) => { ctx.inject(['webServer'], () => { resolve() }) })
    origin = ctx.webServer.getOrigin()
  }
  // The registry describes its tools to the system prompt; no prompt is built here.
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(Tools)
  const config = configAt(root, options.config?.(root) ?? {})
  const fiber = options.resolved === true
    ? await ctx.plugin({ name: headlessBrowser.name, inject: headlessBrowser.inject, apply: headlessBrowser.apply }, config)
    : await ctx.plugin(headlessBrowser, config)
  const app: Mounted = {
    ctx,
    root,
    fiber,
    warnings,
    security,
    keepalive,
    ...origin === undefined ? {} : { origin },
    toolNames: () => ctx.tools.definitions().map(definition => definition.name),
    async call(name, args) {
      const definition = ctx.tools.get(name)
      if (definition === undefined) throw new Error(`no tool named ${name}`)
      return await definition.execute(args, EXEC)
    },
  }
  mounted.push(app)
  return app
}

/** The origin of a mount that has a Web server. */
function originOf(app: Mounted): string {
  if (app.origin === undefined) throw new Error('this mount has no Web server')
  return app.origin
}

describe('headless-browser plugin', () => {
  it('registers the model tools and the take-over routes, and removes both when the plugin is disposed', async () => {
    const exitListeners = process.listenerCount('exit')
    const app = await mount({ web: true, config: () => ({ keepaliveExpect: { k1: [{ expectText: 'Inbox' }] } }) })
    const origin = originOf(app)
    expect(app.toolNames()).toEqual(TOOL_NAMES)
    await vi.waitFor(() => { expect(statSync(join(app.root, 'uploads')).mode & 0o777).toBe(0o700) }, { timeout: 10_000 })

    const page = await fetch(`${origin}${PAGE_PATH}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const status = await fetch(`${origin}${STATUS_PATH}`)
    await expect(status.json()).resolves.toEqual({ holder: 'agent', launched: false, viewers: 0, security: { events: [], dropped: 0 }, keepalive: [] })
    expect((await fetch(`${origin}${CREDENTIALS_PATH}`)).status).toBe(200)
    expect(await app.call('headless_browser_hand_over', { reason: 'sign in' }))
      .toEqual({ url: `${origin}${PAGE_PATH}`, holder: 'human', reason: 'sign in' })

    await app.fiber.dispose()
    expect(app.toolNames()).toEqual([])
    expect((await fetch(`${origin}${PAGE_PATH}`)).status).toBe(404)
    expect((await fetch(`${origin}${STATUS_PATH}`)).status).toBe(404)
    expect((await fetch(`${origin}${CREDENTIALS_PATH}`)).status).toBe(404)
    expect(process.listenerCount('exit')).toBe(exitListeners)
    expect(app.warnings).toEqual([])
  })

  it('gives a composition without a Web server the browser tools and the bare page path to hand over to', async () => {
    const app = await mount({ web: false, resolved: true, config: () => ({ uploadDirs: [] }) })
    expect(app.toolNames()).toEqual(TOOL_NAMES)
    expect(await app.call('headless_browser_hand_over', { reason: 'sign in' }))
      .toEqual({ url: PAGE_PATH, holder: 'human', reason: 'sign in' })
    await app.fiber.dispose()
    expect(app.toolNames()).toEqual([])
    expect(readdirSync(app.root)).toEqual([])
  })

  it('logs an upload directory it cannot create, keepalives it cannot arm, and a re-arm that failed after a relaunch', async () => {
    vi.spyOn(KeepaliveService.prototype, 'load').mockRejectedValueOnce(new Error('the keepalive file is locked'))
    const onRelaunch = vi.spyOn(HeadlessBrowserSession.prototype, 'onRelaunch')
    const app = await mount({
      web: false,
      prepare: (root) => { writeFileSync(join(root, 'file'), '') },
      config: root => ({ uploadDirs: [join(root, 'file', 'uploads')] }),
    })
    vi.spyOn(KeepaliveService.prototype, 'rearm').mockRejectedValueOnce(new Error('the new context is gone'))
    const relaunched = onRelaunch.mock.calls[0]?.[0]
    expect(relaunched).toBeDefined()
    relaunched?.()
    await vi.waitFor(() => {
      expect(app.warnings).toEqual(expect.arrayContaining([
        ['headless-browser: creating the upload directory %s failed: %s', join(app.root, 'file', 'uploads'), expect.any(String)],
        ['headless-browser: arming the keepalives failed: %s', 'the keepalive file is locked'],
        ['headless-browser: re-arming the keepalives after a recovery failed: %s', 'the new context is gone'],
      ]))
    }, { timeout: 10_000 })
  })

  it('hands the live page and the keepalive visits to the plugin browser, and reports a browser that cannot start', async () => {
    const castTarget = vi.spyOn(HeadlessBrowserSession.prototype, 'castTarget').mockRejectedValue(new Error('the browser could not start'))
    const keepalivePage = vi.spyOn(HeadlessBrowserSession.prototype, 'keepalivePage').mockRejectedValue(new Error('the browser could not start'))
    const app = await mount({ web: true })

    const live = await liveUntilClosed(originOf(app))
    expect(castTarget).toHaveBeenCalled()
    expect(live.code).toBe(1011)
    expect(live.messages).toContainEqual({ type: 'error', message: 'the browser could not start' })

    const added = await app.call('headless_browser_keepalive', { action: 'add', url: 'https://example.com/' }) as { keepalive: { id: string } }
    await app.call('headless_browser_keepalive', { action: 'check', id: added.keepalive.id })
    expect(keepalivePage).toHaveBeenCalled()
    expect(app.keepalive).toContainEqual(expect.objectContaining({
      kind: 'error',
      id: added.keepalive.id,
      url: 'https://example.com/',
      state: 'error',
    }))
  })

  it.skipIf(!AVAILABLE)('installs the exit hook with the first launch, publishes guard decisions, and removes the hook on dispose', async () => {
    const before = process.listeners('exit')
    const once = vi.spyOn(process, 'once')
    const app = await mount({ web: true })
    const origin = originOf(app)
    expect(await app.call('headless_browser_open', { url: 'data:text/html,<title>plugin</title><body style="margin:0;height:100vh">' }))
      .toMatchObject({ title: { content: 'plugin' } })
    const hooks = once.mock.calls.filter(([event]) => event === 'exit').map(([, listener]) => listener)
    expect(hooks).toHaveLength(1)
    expect(process.listeners('exit')).toEqual(expect.arrayContaining(hooks))

    expect(await app.call('headless_browser_click', { x: 20, y: 20 })).toMatchObject({ clicked: 'point (20, 20)' })
    expect(app.security).toEqual([expect.objectContaining({ kind: 'point', action: 'click', ref: 'point (20, 20)' })])
    const status = await (await fetch(`${origin}${STATUS_PATH}`)).json() as { launched: boolean; security: { events: unknown[] } }
    expect(status).toMatchObject({ launched: true, security: { events: [expect.objectContaining({ kind: 'point' })] } })

    await app.fiber.dispose()
    expect(app.toolNames()).toEqual([])
    for (const hook of hooks) expect(process.listeners('exit')).not.toContain(hook)
    // Playwright drops its own exit handler once the browser process has exited.
    await vi.waitFor(() => { expect(process.listeners('exit')).toEqual(before) }, { timeout: 10_000 })
  }, 120_000)
})
