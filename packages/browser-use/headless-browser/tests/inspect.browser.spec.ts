/**
 * REAL browser coverage for the reading and acting tools: one headless Chromium
 * launches with a temporary profile, an eval reports what the page returned and
 * what it complained about, an accessibility read prints ids that a later click
 * and type resolve, the ids die when the page navigates, and a look returns a
 * bounded picture together with the digest of the same page. The suite skips
 * when Playwright cannot resolve a Chromium binary for this machine.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromium, type Page } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, pngSize } from '../src/inspect.ts'
import { HeadlessBrowserSession } from '../src/session.ts'

const AVAILABLE = existsSync(chromium.executablePath())

/** A form page whose button changes the title, so an action by id is observable. */
const FORM_PAGE = `data:text/html,${encodeURIComponent([
  '<!doctype html><title>form</title>',
  '<h1>Sign in</h1>',
  '<form id="signin">',
  '<label for="email">Email</label><input id="email">',
  '<label><input id="remember" type="checkbox" checked> Remember me</label>',
  '<a href="#help">Help</a>',
  '<button id="go" type="button" onclick="document.title=\'clicked\'">Sign in</button>',
  '</form>',
  '<p>Signed out.</p>',
].join(''))}`

/** A page six viewports tall, so a full-page capture has to be scaled down. */
const TALL_PAGE = `data:text/html,${encodeURIComponent([
  '<!doctype html><title>tall</title>',
  '<body style="margin:0">',
  '<button style="margin-top:8px">Tall button</button>',
  '<div style="height:6000px;background:linear-gradient(#fff,#000)"></div>',
  '</body>',
].join(''))}`

interface App {
  readonly browser: HeadlessBrowserSession
  close(): Promise<void>
}

const apps: App[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async app => await app.close()))
})

/** Start one browser with a throwaway profile. */
async function boot(): Promise<App> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-headless-browser-inspect-'))
  const ctx = new Context()
  const browser = new HeadlessBrowserSession({
    profileDir: join(root, 'profile'),
    headless: true,
    stealth: true,
    viewportWidth: 800,
    viewportHeight: 600,
    jpegQuality: 50,
    snapshotDir: join(root, 'snapshots'),
  }, ctx.logger)
  const app: App = {
    browser,
    async close() {
      await browser.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
  apps.push(app)
  return app
}

/** Read the id an accessibility line printed, failing when the line is absent. */
function idOf(text: string, pattern: RegExp): string {
  const match = pattern.exec(text)
  if (match?.[1] === undefined) throw new Error(`no line matching ${String(pattern)} in:\n${text}`)
  return match[1]
}

describe.skipIf(!AVAILABLE)('reading and acting through the page', () => {
  it('evaluates an expression, quotes its exceptions, and caps a long result', async () => {
    const { browser } = await boot()
    await browser.open(FORM_PAGE)

    const sum = await browser.evaluate('1 + 1', false)
    expect(sum.result).toBe('2')
    expect(sum.truncated).toBe(false)
    expect(sum.url).toContain('data:text/html')

    const awaited = await browser.evaluate('Promise.resolve(41).then(value => value + 1)', true)
    expect(awaited.result).toBe('42')

    const failed = await browser.evaluate('(function () { console.error("boom", 7); throw new Error("nope") })()', false)
    expect(failed.exceptions[0]).toContain('Error: nope')
    // The stack is what the page produced, not a paraphrase of it.
    expect(failed.exceptions[0]).toContain('at <anonymous>')
    expect(failed.consoleErrors.join(' ')).toContain('boom')

    const long = await browser.evaluate('"x".repeat(20000)', false)
    expect(long.truncated).toBe(true)
    expect(long.characters).toBe(20002)
    expect(long.result).toContain('… [truncated:')

    // The expression runs in the tab the call names, not only the active one.
    const first = browser.tabsState()[0]
    if (first === undefined) throw new Error('the first tab is missing')
    await browser.open('data:text/html,<title>second</title>', true)
    expect((await browser.evaluate('document.title', false, first.id)).result).toBe('"form"')
  }, 120_000)

  it('prints an accessibility tree whose ids stay stable and act', async () => {
    const app = await boot()
    await app.browser.open(FORM_PAGE)
    const read = await app.browser.ax({})
    expect(read.text).toContain('heading "Sign in"')
    expect(read.text).toMatch(/e\d+ textbox "Email"/u)
    expect(read.text).toMatch(/e\d+ checkbox "Remember me" \[checked\]/u)
    expect(read.text).toMatch(/e\d+ link "Help"/u)
    expect(read.interactive).toBeGreaterThanOrEqual(3)
    expect(read.omitted).toBe(0)

    // A second read prints the same id for the same element.
    const again = await app.browser.ax({})
    expect(again.text).toBe(read.text)

    // The cap reports the nodes it left out on one line.
    const capped = await app.browser.ax({ maxNodes: 2 })
    expect(capped.nodes).toBe(2)
    expect(capped.omitted).toBeGreaterThan(0)
    expect(capped.text.split('\n').at(-1)).toBe(`… ${String(capped.omitted)} more nodes`)

    // A scoped read shows that element's subtree only.
    const scoped = await app.browser.ax({ selector: '#signin' })
    expect(scoped.text).toMatch(/e\d+ button "Sign in"/u)
    expect(scoped.text).not.toContain('Signed out')

    // Ids belong to the page, not to the read: a capture in between changes nothing.
    await app.browser.snapshot()
    await app.browser.click({ axId: idOf(read.text, /(e\d+) button "Sign in"/u) })
    const page: Page = await app.browser.page()
    expect(await page.title()).toBe('clicked')

    await app.browser.fill({ axId: idOf(read.text, /(e\d+) textbox "Email"/u) }, 'kit@example.test')
    expect(await page.locator('#email').inputValue()).toBe('kit@example.test')
  }, 120_000)

  it('refuses a stale id after navigation and an id no read printed', async () => {
    const app = await boot()
    await app.browser.open(FORM_PAGE)
    const read = await app.browser.ax({})
    const buttonId = idOf(read.text, /(e\d+) button "Sign in"/u)

    await app.browser.open('data:text/html,<title>next</title><button>Next</button>')
    await expect(app.browser.click({ axId: buttonId })).rejects.toThrow(`axId ${buttonId} no longer names an element on this page`)
    await expect(app.browser.fill({ axId: buttonId }, 'x')).rejects.toThrow('read the page again with headless_browser_ax')
    await expect(app.browser.click({ axId: 'e9999' })).rejects.toThrow('no element has axId e9999')

    // The new document hands out ids of its own, past the old ones.
    const fresh = await app.browser.ax({})
    const nextId = idOf(fresh.text, /(e\d+) button "Next"/u)
    expect(nextId).not.toBe(buttonId)
    await app.browser.click({ axId: nextId })
  }, 120_000)

  it('returns a bounded picture and the digest of the same page in one look', async () => {
    const app = await boot()
    await app.browser.open(TALL_PAGE)

    const look = await app.browser.look({ fullPage: true })
    expect(existsSync(look.path)).toBe(true)
    expect(look.fullPage).toBe(true)
    expect(look.digest?.text).toMatch(/e\d+ button "Tall button"/u)

    const size = pngSize(new Uint8Array(readFileSync(look.path)))
    expect(size).toEqual({ width: look.width, height: look.height })
    // The six-viewport page is captured whole and scaled down to stay bounded.
    expect(look.height).toBeGreaterThan(600)
    expect(Math.max(look.width, look.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE)
    expect(look.width * look.height).toBeLessThanOrEqual(MAX_IMAGE_PIXELS)
    expect(look.downscaled).toBe(true)
    expect(look.scale).toBeLessThan(1)

    // The stand-alone capture reports the same bound.
    const shot = await app.browser.snapshot(undefined, true)
    expect(shot.downscaled).toBe(true)
    expect(Math.max(shot.width, shot.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE)

    // Without the digest the picture is still returned, and a viewport capture is native size.
    const view = await app.browser.look({ text: false })
    expect(view.digest).toBeUndefined()
    expect(view.fullPage).toBe(false)
    expect({ width: view.width, height: view.height }).toEqual({ width: 800, height: 600 })
    expect(view.downscaled).toBe(false)
  }, 120_000)
})
