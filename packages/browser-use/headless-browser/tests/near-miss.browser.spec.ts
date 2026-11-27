/**
 * REAL browser coverage of a selector miss: the advice names the element the
 * selector meant (a link it called a button, a Workday menu item it called an
 * option, the field next to a question), a step that draws late is waited for,
 * and a read that misses carries the same advice. Skips cleanly when Playwright
 * has no Chromium for this machine.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import { ActionGuard } from '../src/guard.ts'
import { SelectorMissError } from '../src/read.ts'
import { HeadlessBrowserSession } from '../src/session.ts'

const AVAILABLE = existsSync(chromium.executablePath())

const PAGE = `<!doctype html><title>Apply</title><body>
<a id="apply" href="#form" style="display:inline-block;padding:8px">Apply Now</a>
<ul role="listbox"><div data-automation-id="promptOption" style="padding:4px" onclick="document.getElementById('shown').textContent = 'NY'">New York</div></ul>
<div class="field"><div>Please provide your current zip code</div><input id="zip" style="width:120px"></div>
<button type="button" style="display:none">Hidden Thing</button>
<p id="shown"></p>
<script>
  setTimeout(() => {
    const late = document.createElement('button'); late.id = 'late'; late.textContent = 'Continue'
    late.onclick = () => { document.getElementById('shown').textContent = 'continued' }
    document.body.append(late)
  }, 600)
</script>`

interface App {
  readonly base: string
  readonly browser: HeadlessBrowserSession
  close(): Promise<void>
}

const apps: App[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

async function boot(): Promise<App> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-near-miss-live-'))
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  const ctx = new Context()
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
    credentialsPath: join(root, 'credentials.json'),
    uploadDirs: [root],
    maxUploadMB: 25,
  }, ctx.logger, new ActionGuard({ sensitiveActions: true }))
  const app: App = {
    base: `http://127.0.0.1:${String(port)}`,
    browser,
    async close() {
      await browser.close()
      await ctx.fiber.dispose()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      rmSync(root, { recursive: true, force: true })
    },
  }
  apps.push(app)
  return app
}

describe.skipIf(!AVAILABLE)('a selector miss in a real page', () => {
  it('names the element the selector meant, with a selector that lands', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    await expect(app.browser.click({ selector: 'role=button[name=\'Apply Now\']' }))
      .rejects.toThrow('no element matches role=button[name=\'Apply Now\']; the page names "Apply Now" on role=link[name="Apply Now"] (<a>)')
    await expect(app.browser.click({ selector: '[role=option]:text-is(\'New York\')' }))
      .rejects.toThrow('the page names "New York" on text="New York" (<div>)')
    await app.browser.click({ selector: 'text="New York"' })
    expect((await app.browser.read({ selector: '#shown' })).text).toBe('NY')
    await expect(app.browser.fill({ selector: 'role=textbox[name=/Please provide your current zip code/]' }, '11201'))
      .rejects.toThrow('text="Please provide your current zip code" (<div>, its field is #zip)')
    // A role selector skips hidden elements, so the advice says the one it names is hidden.
    await expect(app.browser.click({ selector: 'role=button[name=\'Hidden Thing\']' }))
      .rejects.toThrow('(<button>, hidden)')
  }, 120_000)

  it('says when nothing carries the words, and keeps the old advice for a structural selector', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    await expect(app.browser.click({ selector: 'button:has-text(\'Withdraw application\')' }))
      .rejects.toThrow('nothing on the page is named "Withdraw application" either, so the step may not have loaded; read the page before retrying')
    await expect(app.browser.click({ selector: 'input[type=email]' }))
      .rejects.toThrow('no element matches input[type=email]; check the selector or read the whole page')
  }, 120_000)

  it('waits for a step that draws after the call, and advises a read that misses', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    await app.browser.click({ selector: '#late' })
    expect((await app.browser.read({ selector: '#shown' })).text).toBe('continued')
    const missed = await app.browser.read({ selector: 'role=button[name=\'Apply Now\']' }).catch((error: unknown) => error)
    expect(missed).toBeInstanceOf(SelectorMissError)
    expect((missed as Error).message).toContain('role=link[name="Apply Now"] (<a>)')
  }, 120_000)
})
