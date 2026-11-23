/**
 * REAL browser coverage of downloads: a headless Chromium meets a local server
 * whose paths answer an attachment, an inline PDF, and a page with a download
 * link, and every one of them ends as a kept, owner-only file with the right
 * bytes, a record the tools report, and no save dialog. Skips cleanly when
 * Playwright has no Chromium for this machine.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/config.ts'
import { HeadlessBrowserSession } from '../src/session.ts'

const AVAILABLE = existsSync(chromium.executablePath())

/** A tiny valid-looking PDF body; the test only compares bytes. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')

interface App {
  readonly base: string
  readonly browser: HeadlessBrowserSession
  readonly downloadDir: string
  close(): Promise<void>
}

const apps: App[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

async function boot(overrides: Partial<Config> = {}): Promise<App> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-downloads-live-'))
  const server: Server = createServer((request, response) => {
    if (request.url === '/att.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="../att one.pdf"' })
      response.end(PDF)
    } else if (request.url === '/inline.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' })
      response.end(PDF)
    } else if (request.url === '/big.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.alloc(2 * 1024 * 1024, 1))
    } else if (request.url === '/links') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<title>links</title><a id="dl" href="/att.pdf">get</a> <a id="plain" href="#x">stay</a>'
        + '<button id="blob" onclick="const a=document.createElement(\'a\');a.href=window.URL.createObjectURL(new Blob([\'hi\'],{type:\'text/plain\'}));a.download=\'blob.txt\';document.body.append(a);a.click()">blob</button>')
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  const ctx = new Context()
  const downloadDir = join(root, 'downloads')
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
    downloadDir,
    maxDownloadMB: 256,
    downloadRetainDays: 7,
    downloadPdfs: true,
    ...overrides,
  }, ctx.logger)
  const app: App = {
    base: `http://127.0.0.1:${String(port)}`,
    browser,
    downloadDir,
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

describe.skipIf(!AVAILABLE)('headless browser downloads', () => {
  it('keeps a Content-Disposition attachment that open reaches, under a safe name, owner-only', async () => {
    const app = await boot()
    const opened = await app.browser.open(`${app.base}/att.pdf`)
    expect(opened.downloads).toHaveLength(1)
    const [file] = opened.downloads!
    expect(file).toMatchObject({ filename: 'att one.pdf', bytes: PDF.length, url: `${app.base}/att.pdf` })
    expect(file?.path?.startsWith(app.downloadDir)).toBe(true)
    expect(readFileSync(file!.path!).equals(PDF)).toBe(true)
    expect(statSync(file!.path!).mode & 0o777).toBe(0o600)
    expect(await app.browser.downloads(10, 0)).toHaveLength(1)
  }, 120_000)

  it('turns an inline PDF into a file, because the headless viewer shows the model nothing', async () => {
    const app = await boot()
    const opened = await app.browser.open(`${app.base}/inline.pdf`)
    expect(opened.downloads).toHaveLength(1)
    expect(readFileSync(opened.downloads![0]!.path!).equals(PDF)).toBe(true)
  }, 120_000)

  it('keeps the file of a click on a download link and of a script download without a gesture', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/links`)
    const clicked = await app.browser.click({ selector: '#dl' })
    expect(clicked.downloads).toHaveLength(1)
    expect(readFileSync(clicked.downloads![0]!.path!).equals(PDF)).toBe(true)
    const scripted = await app.browser.click({ selector: '#blob' })
    expect(scripted.downloads).toHaveLength(1)
    expect(readFileSync(scripted.downloads![0]!.path!, 'utf8')).toBe('hi')
    const plain = await app.browser.click({ selector: '#plain' })
    expect(plain.downloads).toBeUndefined()
    expect((await app.browser.downloads(10, 0)).map(file => file.filename)).toEqual(['att one.pdf', 'blob.txt'])
  }, 120_000)

  it('reports a file over the size cap as failed and keeps nothing', async () => {
    const app = await boot({ maxDownloadMB: 1 })
    const opened = await app.browser.open(`${app.base}/big.bin`)
    expect(opened.downloads).toHaveLength(1)
    expect(opened.downloads![0]!.path).toBeUndefined()
    expect(opened.downloads![0]!.error).toContain('over the 1048576-byte limit')
    expect(existsSync(app.downloadDir)).toBe(false)
  }, 120_000)

  it('still fails a navigation that is not a download', async () => {
    const app = await boot()
    await expect(app.browser.open(`${app.base}/missing`)).rejects.toThrow(/ERR_HTTP_RESPONSE_CODE_FAILURE/u)
    expect(await app.browser.downloads(10, 0)).toEqual([])
  }, 120_000)
})
