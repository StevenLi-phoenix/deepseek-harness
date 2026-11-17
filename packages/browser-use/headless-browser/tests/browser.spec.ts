/**
 * REAL browser coverage: a headless Chromium launches with a temporary profile,
 * the take-over socket receives a live frame of a `data:` page, and a pointer
 * click forwarded through the socket reaches the page. Page text comes from the
 * real DOM, including rows far below the viewport, and a full-page screenshot
 * is taller than the viewport. The suite skips cleanly when Playwright cannot
 * resolve a Chromium binary for this machine, so a checkout without the browser
 * download still runs the rest of the package tests.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromium, type Page } from 'playwright-core'
import { WebSocket } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { MAX_IMAGE_EDGE } from '../src/inspect.ts'
import { LiveView } from '../src/live-view.ts'
import { SelectorMissError } from '../src/read.ts'
import { LIVE_PATH, mountTakeoverRoutes } from '../src/routes.ts'
import { HeadlessBrowserSession } from '../src/session.ts'
import { TakeoverState } from '../src/takeover.ts'

const AVAILABLE = existsSync(chromium.executablePath())

/** A page whose title changes when its body is clicked, so input forwarding is observable. */
const DATA_PAGE = `data:text/html,${encodeURIComponent([
  '<!doctype html><title>before</title>',
  '<body style="margin:0;height:100vh">',
  '<script>document.body.addEventListener("click", function () {',
  'document.title = "after"; document.body.style.background = "#ff0000" })</script>',
  '</body>',
].join(''))}`

/**
 * A page taller than the viewport: 120 rows of assignment text and a trailing
 * block, so everything after the first rows sits below the fold.
 */
const TALL_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent([
  '<!doctype html><title>assignments</title>',
  '<body style="margin:0;font:16px/1.5 sans-serif">',
  '<ul id="rows">',
  ...Array.from({ length: 120 }, (_, index) => `<li>第${String(index + 1)}行 作业 😀</li>`),
  '</ul>',
  '<div style="height:3000px">tail</div>',
  '</body>',
].join(''))}`

/** Width and height of a PNG, read from its IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(16, 24)
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) }
}

interface BrowserApp {
  readonly base: string
  readonly browser: HeadlessBrowserSession
  close(): Promise<void>
}

const apps: BrowserApp[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

function peerOf(ctx: Context): PeerScope {
  const abort = new AbortController()
  return {
    id: 'live-view' as PeerScope['id'],
    ctx,
    principal: { kind: 'owner' },
    signal: abort.signal,
    interactions: 'none',
    async dispose() { abort.abort() },
  }
}

/** Boot the real Web server and the take-over routes around one headless browser. */
async function boot(): Promise<BrowserApp> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-headless-browser-live-'))
  const ctx = new Context()
  ctx.plugin(HttpServer, HttpServer.Config({ host: '127.0.0.1', port: 0 }))
  const owner = peerOf(ctx)
  ctx.on('webserver/authorize', () => ({ kind: 'allow', peer: owner }))
  await new Promise<void>((resolve) => { ctx.inject(['webServer'], () => { resolve() }) })
  const browser = new HeadlessBrowserSession({
    profileDir: join(root, 'profile'),
    headless: true,
    stealth: true,
    viewportWidth: 1280,
    viewportHeight: 800,
    jpegQuality: 50,
    snapshotDir: join(root, 'snapshots'),
  }, ctx.logger)
  const takeover = new TakeoverState()
  const view = new LiveView(() => browser.castTarget(), { jpegQuality: 50, maxWidth: 1280, maxHeight: 800 }, ctx.logger)
  const removeRoutes = mountTakeoverRoutes(ctx.webServer, { browser, takeover, view, log: ctx.logger })
  const port = ctx.webServer.port
  if (port === undefined) throw new Error('the test Web server did not bind a port')
  const app: BrowserApp = {
    base: `127.0.0.1:${String(port)}`,
    browser,
    async close() {
      await removeRoutes()
      await browser.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
  apps.push(app)
  return app
}

/** Poll until a condition holds; the browser's own timing decides how long. */
async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('the condition did not hold before the deadline')
}

interface LiveSocket {
  readonly socket: WebSocket
  readonly messages: unknown[]
}

/** Open the live socket as the owner and collect everything the Host sends. */
function openLive(base: string): Promise<LiveSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${base}${LIVE_PATH}`, { headers: { 'x-test-peer': 'owner' } })
    const messages: unknown[] = []
    socket.on('message', (data) => { messages.push(JSON.parse(String(data))) })
    socket.on('open', () => { resolve({ socket, messages }) })
    socket.on('error', reject)
  })
}

function isFrame(message: unknown): message is { type: 'frame'; tabId: string; data: string; metadata: { deviceWidth: number; deviceHeight: number } } {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'frame'
}

describe.skipIf(!AVAILABLE)('headless browser live view', () => {
  it('opens a second tab, follows it with the screencast, and switches back without closing the context', async () => {
    const app = await boot()
    await app.browser.open(DATA_PAGE)
    const first = app.browser.tabsState()[0]!
    await app.browser.open('data:text/html,<title>second</title><body>second', true)
    const second = app.browser.tabsState().find(tab => tab.active)
    expect(second).toMatchObject({ title: 'second' })
    expect(second?.id).not.toBe(first.id)

    const { socket, messages } = await openLive(app.base)
    try {
      await eventually(() => messages.some(message => (message as { type?: unknown }).type === 'state'
        && ((message as { tabs?: unknown[] }).tabs?.length ?? 0) === 2))
      await eventually(() => messages.some(message => isFrame(message) && message.tabId === second?.id))

      await app.browser.tabs().activate(first.id)
      await eventually(() => messages.some(message => isFrame(message) && message.tabId === first.id))
      expect(app.browser.status().launched).toBe(true)
      expect(app.browser.tabsState()).toHaveLength(2)

      await app.browser.tabs().close(second!.id)
      expect(app.browser.tabsState()).toHaveLength(1)
      expect(app.browser.status().launched).toBe(true)
    } finally {
      socket.close()
    }
  }, 120_000)

  it('closes the active tab, then a named one, and leaves a blank tab after the last', async () => {
    const app = await boot()
    await app.browser.open(DATA_PAGE)
    const first = app.browser.tabsState()[0]!
    await app.browser.open('data:text/html,<title>second</title><body>second', true)
    const second = app.browser.tabsState().find(tab => tab.active)!

    const active = await app.browser.closeTab()
    expect(active).toMatchObject({ closed: second.id, replaced: false })
    expect(active.tabs.map(tab => tab.id)).toEqual([first.id])
    expect(active.tabs[0]?.active).toBe(true)

    const last = await app.browser.closeTab(first.id)
    expect(last).toMatchObject({ closed: first.id, replaced: true })
    expect(last.tabs).toHaveLength(1)
    expect(last.tabs[0]?.url).toBe('about:blank')
    expect(last.tabs[0]?.active).toBe(true)
    expect(app.browser.status().launched).toBe(true)
    expect(app.browser.status().tabs).toBe(1)
  }, 120_000)

  it('scrolls by a delta and to both edges, and a follow-up read and snapshot see the position', async () => {
    const app = await boot()
    await app.browser.open(TALL_PAGE)
    const page = await app.browser.page()
    expect(await page.evaluate(() => window.scrollY)).toBe(0)

    const delta = await app.browser.scroll({ deltaY: 900 })
    expect(delta).toMatchObject({ scrollX: 0, scrollY: 900, viewportHeight: 800, atTop: false, atBottom: false })
    expect(delta.pageHeight).toBeGreaterThan(3_000)
    expect(await page.evaluate(() => window.scrollY)).toBe(900)

    const bottom = await app.browser.scroll({ to: 'bottom' })
    expect(bottom.atBottom).toBe(true)
    expect(bottom.scrollY + bottom.viewportHeight).toBeGreaterThanOrEqual(bottom.pageHeight - 1)
    const snapshot = await app.browser.snapshot()
    expect(existsSync(snapshot.path)).toBe(true)
    expect(await page.evaluate(() => window.scrollY)).toBe(bottom.scrollY)

    const read = await app.browser.scroll({ deltaY: 0 })
    expect(read.scrollY).toBe(bottom.scrollY)
    expect(read.atBottom).toBe(true)

    const top = await app.browser.scroll({ to: 'top' })
    expect(top).toMatchObject({ scrollY: 0, atTop: true, atBottom: false })
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  }, 120_000)

  it('streams a frame of a data: page and forwards a click while the user holds control', async () => {
    const app = await boot()
    await app.browser.open(DATA_PAGE)
    const { socket, messages } = await openLive(app.base)
    try {
      await eventually(() => messages.some(message => (message as { type?: unknown }).type === 'state'))
      socket.send(JSON.stringify({ type: 'control', action: 'take', reason: 'test' }))
      await eventually(() => messages.some(isFrame))
      const frame = messages.find(isFrame)
      expect(frame?.data.length).toBeGreaterThan(1_000)
      expect(frame?.tabId).toMatch(/^t[0-9]+$/u)
      expect(frame?.metadata.deviceWidth).toBe(1280)
      expect(frame?.metadata.deviceHeight).toBe(800)

      const page: Page = await app.browser.page()
      expect(await page.title()).toBe('before')
      socket.send(JSON.stringify({ type: 'mouse', event: 'down', x: 100, y: 100, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }))
      socket.send(JSON.stringify({ type: 'mouse', event: 'up', x: 100, y: 100, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 }))
      await eventually(async () => await page.title() === 'after')
      // The click repaints the page, so an acknowledged stream produces another frame.
      await eventually(() => messages.filter(isFrame).length > 1)

      // The served page is the human's end of the same stream: a separate
      // browser opens it, so the shared page stays the visible tab of its own
      // Chromium, and the page must connect, paint a frame, and run cleanly.
      const human = await chromium.launch({ headless: true })
      try {
        const takeOver = await (await human.newContext()).newPage()
        const pageErrors: string[] = []
        takeOver.on('pageerror', (error) => { pageErrors.push(error.message) })
        await takeOver.goto(`http://${app.base}/headless-browser`)
        await takeOver.waitForFunction(() => {
          const image = document.querySelector('#frame')
          return image instanceof HTMLImageElement && image.src.startsWith('data:image/jpeg')
        })
        expect(pageErrors).toEqual([])
      } finally {
        await human.close()
      }
    } finally {
      socket.close()
    }
  }, 120_000)

  it('reads rows below the fold and captures the whole page when asked', async () => {
    const app = await boot()
    await app.browser.open(TALL_PAGE)
    const whole = await app.browser.read({})
    expect(whole.total).toBeGreaterThan(1_000)
    expect(whole.header).toContain('text of t1 (data:text/html;charset=utf-8,')
    expect(whole.header).toMatch(/page 1 of \d+, characters 1-/u)
    // Row 120 sits roughly seven viewports below the fold, and its text is there.
    expect(whole.text).toContain('第120行 作业 😀')
    expect(whole.text).toContain('tail')

    const window = await app.browser.read({ limit: 10 })
    expect([...window.text]).toHaveLength(10)
    expect(window.text.startsWith('第1行 作业 😀')).toBe(true)
    expect(window.nextOffset).toBe(10)
    expect(whole.text.startsWith(window.text)).toBe(true)

    const rows = await app.browser.read({ selector: '#rows' })
    expect(rows.text.startsWith('第1行 作业 😀')).toBe(true)
    expect(rows.text).toContain('第120行 作业 😀')
    expect(rows.text).not.toContain('tail')
    await expect(app.browser.read({ selector: '#missing' })).rejects.toBeInstanceOf(SelectorMissError)

    const tall = app.browser.tabsState()[0]!
    const viewport = pngSize((await app.browser.snapshot(tall.id)).path)
    const shot = await app.browser.snapshot(tall.id, true)
    const full = pngSize(shot.path)
    expect(viewport).toEqual({ width: 1280, height: 800 })
    // The whole page is captured, and a tall one is scaled down to stay bounded.
    expect(full.height).toBeGreaterThan(viewport.height)
    expect(Math.max(full.width, full.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE)
    expect(shot.downscaled).toBe(true)
    expect({ width: shot.width, height: shot.height }).toEqual(full)

    await app.browser.open('data:text/html;charset=utf-8,<title>second</title><body>второй список', true)
    const second = app.browser.tabsState().find(tab => tab.active)!
    const other = await app.browser.read({}, second.id)
    expect(other.header).toContain(`text of ${second.id} `)
    expect(other.text).toBe('второй список')
  }, 120_000)
})
