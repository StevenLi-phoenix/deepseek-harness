/**
 * REAL browser coverage of the form steps: a saved password lands only in a
 * password input on its own host, and files reach a hidden file input or the
 * chooser a styled button opens. Skips cleanly when Playwright has no Chromium
 * for this machine.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import { HeadlessBrowserSession, SecretFieldError } from '../src/session.ts'

const AVAILABLE = existsSync(chromium.executablePath())

const FORM = `<!doctype html><title>signup</title><body>
<label>Email <input id="email" type="email"></label>
<label>Password <input id="password" type="password"></label>
<label>Confirm <input id="confirm" type="password"></label>
<label>Not a password <input id="name" type="text" placeholder="password"></label>
<label class="upload" for="resume">Upload résumé <input id="resume" type="file" style="display:none"></label>
<input id="many" type="file" multiple style="opacity:0;position:absolute;width:1px;height:1px">
<button id="chooser" type="button">Attach transcript</button>
<p id="shown"></p>
<script>
  const picker = document.createElement('input'); picker.type = 'file'; picker.id = 'picker'
  document.getElementById('chooser').addEventListener('click', () => picker.click())
  const show = () => { document.getElementById('shown').textContent = [...document.querySelectorAll('input[type=file]'), picker].map(i => i.id + ':' + [...i.files].map(f => f.name + '/' + f.size).join('+')).join(' ') }
  for (const i of [...document.querySelectorAll('input[type=file]'), picker]) i.addEventListener('change', show)
</script>`

interface App {
  readonly base: string
  readonly browser: HeadlessBrowserSession
  readonly files: string
  close(): Promise<void>
}

const apps: App[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

async function boot(): Promise<App> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-forms-live-'))
  const files = join(root, 'uploads')
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(FORM)
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
    uploadDirs: [files],
    maxUploadMB: 25,
  }, ctx.logger)
  mkdirSync(files)
  writeFileSync(join(files, 'resume.pdf'), 'resume-bytes')
  writeFileSync(join(files, 'transcript.pdf'), 'transcript')
  const app: App = {
    base: `http://127.0.0.1:${String(port)}`,
    browser,
    files,
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

async function value(app: App, selector: string): Promise<string> {
  const page = await app.browser.page()
  return await page.locator(selector).inputValue()
}

describe.skipIf(!AVAILABLE)('form steps in a real page', () => {
  it('writes a secret into a password input on its own host and refuses a text box or another host', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/signup`)
    expect(await app.browser.pageUrl()).toBe(`${app.base}/signup`)
    await app.browser.fillSecret({ selector: '#password' }, 'S3cret!pass-Word', 'password', '127.0.0.1')
    await app.browser.fillSecret({ selector: '#email' }, 'cv@example.com', 'username', '127.0.0.1')
    expect(await value(app, '#password')).toBe('S3cret!pass-Word')
    expect(await value(app, '#email')).toBe('cv@example.com')
    await expect(app.browser.fillSecret({ selector: '#name' }, 'S3cret!pass-Word', 'password', '127.0.0.1')).rejects.toThrow(SecretFieldError)
    expect(await value(app, '#name')).toBe('')
    await expect(app.browser.fillSecret({ selector: '#confirm' }, 'S3cret!pass-Word', 'password', 'jobs.example.com')).rejects.toThrow(/not jobs\.example\.com/u)
    expect(await value(app, '#confirm')).toBe('')
    await expect(app.browser.fillSecret({ point: { x: 10, y: 10 } }, 'x', 'password', '127.0.0.1')).rejects.toThrow(/never a point/u)
  }, 120_000)

  it('attaches a file to a hidden file input, several to a multiple input, and one through a chooser button', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    const resume = join(app.files, 'resume.pdf')
    const transcript = join(app.files, 'transcript.pdf')
    expect(await app.browser.attachFiles({ selector: '#resume' }, [resume])).toMatchObject({ ref: '#resume', inputs: 1 })
    expect(await app.browser.attachFiles({ selector: 'input[type=file]', index: 1 }, [resume, transcript])).toMatchObject({ inputs: 2 })
    const viaChooser = await app.browser.attachFiles({ trigger: { selector: '#chooser' } }, [transcript])
    expect(viaChooser.target?.name).toBe('Attach transcript')
    const page = await app.browser.page()
    expect(await page.locator('#shown').textContent()).toBe('resume:resume.pdf/12 many:resume.pdf/12+transcript.pdf/10 picker:transcript.pdf/10')
    await expect(app.browser.attachFiles({ selector: '#email' }, [resume])).rejects.toThrow(/matches no input\[type=file\]/u)
    await expect(app.browser.attachFiles({ selector: '#resume' }, [resume, transcript])).rejects.toThrow(/takes one file/u)
  }, 120_000)
})
