/**
 * REAL browser coverage for the action guard: every visibility test a page can
 * use to hide a control, the decoy pair a phishing page pairs with a real one,
 * the coordinate path the model uses from a screenshot, the accessibility id
 * path, and the site boundary. The suite skips when Playwright cannot resolve a
 * Chromium binary, so a checkout without the browser download still runs the
 * rest of the package tests.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import { ActionGuard, ActionRefusedError, type BlockedAction } from '../src/guard.ts'
import { HeadlessBrowserSession } from '../src/session.ts'
import { probeElement, scoreVisibility } from '../src/visibility.ts'

const AVAILABLE = existsSync(chromium.executablePath())

interface App {
  readonly browser: HeadlessBrowserSession
  readonly guard: ActionGuard
  close(): Promise<void>
}

const apps: App[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

/** Boot one headless browser with a temporary profile and the guard the tools would share. */
async function boot(): Promise<App> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-headless-browser-guard-'))
  const guard = new ActionGuard()
  const browser = new HeadlessBrowserSession({
    profileDir: join(root, 'profile'),
    headless: true,
    stealth: true,
    sensitiveActions: true,
    viewportWidth: 1280,
    viewportHeight: 800,
    jpegQuality: 50,
    snapshotDir: join(root, 'snapshots'),
    keepalivePath: join(root, 'keepalive.json'),
    keepaliveEscalateAfter: 3,
    downloadDir: join(root, 'downloads'),
    maxDownloadMB: 256,
    downloadRetainDays: 7,
    downloadPdfs: true,
  }, new Context().logger, guard)
  const app: App = {
    browser,
    guard,
    async close() {
      await browser.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
  apps.push(app)
  return app
}

/** Load one page written as HTML and return it. */
async function load(app: App, html: string): Promise<void> {
  await app.browser.open(`data:text/html,${encodeURIComponent(`<!doctype html><body style="margin:0">${html}</body>`)}`)
}

/** The refusal an action stopped on. */
async function refusalOf(run: Promise<unknown>): Promise<BlockedAction> {
  try {
    await run
  } catch (error: unknown) {
    if (error instanceof ActionRefusedError) return error.blocked
    throw error
  }
  throw new Error('the action was not refused')
}

describe.skipIf(!AVAILABLE)('action guard in a real page', () => {
  const hidden: ReadonlyArray<readonly [string, string, string]> = [
    ['display:none', '<div style="display:none"><button id="t">Verify you are human</button></div>', 'display'],
    ['visibility:hidden', '<button id="t" style="visibility:hidden">Verify you are human</button>', 'visibility'],
    ['opacity:0', '<button id="t" style="opacity:0">Verify you are human</button>', 'opacity'],
    ['zero box', '<span id="t" style="display:block;width:0;height:0;overflow:hidden">Verify you are human</span>', 'area'],
    ['pointer-events:none', '<button id="t" style="pointer-events:none">Verify you are human</button>', 'pointerEvents'],
    ['aria-hidden', '<button id="t" aria-hidden="true">Verify you are human</button>', 'ariaHidden'],
    ['offscreen', '<button id="t" style="position:fixed;left:-600px;top:0;width:120px;height:40px">Verify you are human</button>', 'viewport'],
  ]

  for (const [label, html, factor] of hidden) {
    it(`refuses a ${label} element and names the ${factor} test`, async () => {
      const app = await boot()
      await load(app, html)
      const blocked = await refusalOf(app.browser.click({ selector: '#t' }))
      expect(blocked.rule).toBe('visibility')
      expect(blocked.failing).toContain(factor)
      expect(blocked.score).toBeLessThan(0.2)
      expect(blocked.name.content).toBe('Verify you are human')
      expect(app.guard.log.list()[0]).toMatchObject({ kind: 'refusal', rule: 'visibility', ref: '#t' })
    }, 120_000)
  }

  it('refuses an element another element covers', async () => {
    const app = await boot()
    await load(app, '<div style="position:relative;width:200px"><button id="t">Verify you are human</button><div style="position:absolute;inset:0;background:#000"></div></div>')
    const blocked = await refusalOf(app.browser.click({ selector: '#t' }))
    expect(blocked.rule).toBe('visibility')
    expect(blocked.failing).toContain('occlusion')
    expect(blocked.score).toBe(0)
  }, 120_000)

  it('picks the visible element over a hidden decoy and reports both scores', async () => {
    const app = await boot()
    await load(app, [
      '<input type="checkbox" class="verify" id="decoy" style="opacity:0" aria-label="Verify you are human">',
      '<input type="checkbox" class="verify" id="real" aria-label="Verify you are human">',
      '<script>document.getElementById("real").addEventListener("change", function () { document.title = "checked" })</script>',
    ].join(''))
    const outcome = await app.browser.click({ selector: '.verify' })
    expect(outcome.target).toMatchObject({ ref: '.verify', index: 1 })
    expect(outcome.target?.score).toBeGreaterThan(0.9)
    expect(outcome.target?.runnerUpScore).toBe(0)
    expect(await (await app.browser.page()).title()).toBe('checked')
  }, 120_000)

  it('still clicks a visible, benign element', async () => {
    const app = await boot()
    await load(app, [
      '<button id="go">Continue</button>',
      '<script>document.getElementById("go").addEventListener("click", function () { document.title = "clicked" })</script>',
    ].join(''))
    const outcome = await app.browser.click({ selector: '#go' })
    expect(outcome.target).toMatchObject({ ref: '#go', index: 0, score: 1 })
    expect(outcome.target?.runnerUpScore).toBeUndefined()
    expect(await (await app.browser.page()).title()).toBe('clicked')
  }, 120_000)

  it('scores an element that is half outside the viewport between zero and one', async () => {
    const app = await boot()
    await load(app, '<button id="t" style="position:fixed;left:0;top:760px;width:200px;height:80px">Continue</button>')
    const page = await app.browser.page()
    const facts = await page.locator('#t').evaluate(probeElement)
    const scored = scoreVisibility(facts)
    expect(scored.factors.viewport).toBeGreaterThan(0.4)
    expect(scored.factors.viewport).toBeLessThan(0.6)
    expect(scored.score).toBeGreaterThan(0)
    expect(scored.score).toBeLessThan(1)
    expect(scored.failing).toContain('viewport')
  }, 120_000)

  it('clicks a viewport point and records the element it hit', async () => {
    const app = await boot()
    await load(app, [
      '<button id="go" style="position:fixed;left:20px;top:20px;width:120px;height:40px">Continue</button>',
      '<script>document.getElementById("go").addEventListener("click", function () { document.title = "clicked" })</script>',
    ].join(''))
    const outcome = await app.browser.click({ point: { x: 80, y: 40 } })
    expect(outcome.point).toMatchObject({ x: 80, y: 40, name: 'Continue' })
    expect(outcome.point?.score).toBeGreaterThan(0.5)
    expect(await (await app.browser.page()).title()).toBe('clicked')
    expect(app.guard.log.list()[0]).toMatchObject({ kind: 'point', point: { x: 80, y: 40 }, name: 'Continue' })
  }, 120_000)

  it('refuses a point whose element is destructive', async () => {
    const app = await boot()
    await load(app, '<button style="position:fixed;left:20px;top:20px;width:160px;height:40px">Delete account</button>')
    const blocked = await refusalOf(app.browser.click({ point: { x: 80, y: 40 } }))
    expect(blocked.rule).toBe('sensitive')
    expect(blocked.name.content).toBe('Delete account')
  }, 120_000)

  it('allows a point that hits nothing and says so', async () => {
    const app = await boot()
    await load(app, '<button style="position:fixed;left:20px;top:20px;width:120px;height:40px">Continue</button>')
    const outcome = await app.browser.click({ point: { x: 2000, y: 1500 } })
    expect(outcome.point?.note).toContain('hit no element')
    expect(outcome.point?.name).toBe('')
  }, 120_000)

  it('resolves a click by accessibility id and refuses a stale one by name', async () => {
    const app = await boot()
    await load(app, [
      '<button id="real">Continue</button>',
      '<script>document.getElementById("real").addEventListener("click", function () { document.title = "clicked" })</script>',
    ].join(''))
    app.browser.setAxResolver({
      async resolve(page, axId) {
        if (axId !== 'e12') return undefined
        const handle = await page.evaluateHandle(() => document.querySelector('#real'))
        return handle.asElement() ?? undefined
      },
    })
    const outcome = await app.browser.click({ axId: 'e12' })
    expect(outcome.target).toMatchObject({ ref: 'e12', index: 0 })
    expect(await (await app.browser.page()).title()).toBe('clicked')

    const stale = await refusalOf(app.browser.click({ axId: 'e99' }))
    expect(stale.rule).toBe('ax-id')
    expect(stale.reason).toContain('e99')
  }, 120_000)

  it('refuses an accessibility id that names an invisible element, with its score', async () => {
    const app = await boot()
    await load(app, '<button id="real" style="opacity:0">Verify you are human</button>')
    app.browser.setAxResolver({
      async resolve(page, axId) {
        if (axId !== 'e12') return undefined
        const handle = await page.evaluateHandle(() => document.querySelector('#real'))
        return handle.asElement() ?? undefined
      },
    })
    const blocked = await refusalOf(app.browser.click({ axId: 'e12' }))
    expect(blocked.rule).toBe('visibility')
    expect(blocked.score).toBe(0)
    expect(blocked.failing).toContain('opacity')
  }, 120_000)

  it('reports that no accessibility id map exists instead of guessing an element', async () => {
    const app = await boot()
    await load(app, '<button id="real">Continue</button>')
    await expect(app.browser.click({ axId: 'e12' })).rejects.toThrow('no page read has registered an id map')
  }, 120_000)

  it('refuses a click that would leave the site, then runs it when the origin is allowed', async () => {
    const app = await boot()
    const context = await app.browser.ensure()
    await context.route('https://site.example/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<title>site</title><a id="out" href="https://evil.example/landing">Read more</a>',
    }))
    await context.route('https://evil.example/**', route => route.fulfill({ contentType: 'text/html', body: '<title>evil</title>' }))
    await app.browser.open('https://site.example/start')

    const blocked = await refusalOf(app.browser.click({ selector: '#out' }))
    expect(blocked.rule).toBe('origin')
    expect(blocked.reason).toContain('evil.example')

    const outcome = await app.browser.click({ selector: '#out', allowOrigin: true })
    expect(outcome.url).toBe('https://evil.example/landing')
    expect(app.guard.origin.site).toBe('evil.example')
  }, 120_000)

  it('refuses a point that would leave the site', async () => {
    const app = await boot()
    const context = await app.browser.ensure()
    await context.route('https://site.example/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<title>site</title><a id="out" href="https://evil.example/landing" style="position:fixed;left:20px;top:20px;width:120px;height:40px;display:block">Read more</a>',
    }))
    await app.browser.open('https://site.example/start')
    const blocked = await refusalOf(app.browser.click({ point: { x: 80, y: 40 } }))
    expect(blocked.rule).toBe('origin')
  }, 120_000)

  it('allows a click to another subdomain of the same site', async () => {
    const app = await boot()
    const context = await app.browser.ensure()
    await context.route('https://site.example/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<title>site</title><a id="inbox" href="https://mail.site.example/inbox">Inbox</a>',
    }))
    await context.route('https://mail.site.example/**', route => route.fulfill({ contentType: 'text/html', body: '<title>mail</title>' }))
    await app.browser.open('https://site.example/start')
    const outcome = await app.browser.click({ selector: '#inbox' })
    expect(outcome.url).toBe('https://mail.site.example/inbox')
  }, 120_000)

  it('refuses opening another site until the call allows the origin', async () => {
    const app = await boot()
    const context = await app.browser.ensure()
    await context.route('https://site.example/**', route => route.fulfill({ contentType: 'text/html', body: '<title>site</title>' }))
    await context.route('https://evil.example/**', route => route.fulfill({ contentType: 'text/html', body: '<title>evil</title>' }))
    await app.browser.open('https://site.example/start')

    const blocked = await refusalOf(app.browser.open('https://evil.example/landing'))
    expect(blocked.rule).toBe('origin')
    expect(blocked.url).toBe('https://site.example/start')

    const opened = await app.browser.open('https://evil.example/landing', false, true)
    expect(opened.url).toBe('https://evil.example/landing')
    expect(app.guard.log.list().map(event => event.kind)).toContain('allow')
  }, 120_000)
})
