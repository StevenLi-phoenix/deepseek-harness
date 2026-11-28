import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { chromium } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'
import { Config, type JobApplyConfig } from '../src/config.ts'
import type { CredentialVault } from '../src/credentials.ts'
import { ActionGuard, type SecurityEvent } from '../src/guard.ts'
import { deniedJobUrl } from '../src/job-apply-network.ts'
import { JobApplyUploads, mountJobApplyBrowser } from '../src/job-apply.ts'
import { HeadlessBrowserSession, JOB_TAB_IDLE_MS } from '../src/session.ts'
import { MAX_TABS } from '../src/tabs.ts'
import { TakeoverState } from '../src/takeover.ts'
import { registerBrowserTools, type ToolDeps } from '../src/tools.ts'
import { MAX_UPLOAD_FILES } from '../src/uploads.ts'
import type { ElementFacts } from '../src/visibility.ts'

vi.mock('../src/tools.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools.ts')>()
  return { ...actual, registerBrowserTools: vi.fn(actual.registerBrowserTools) }
})

const deny = [
  'https://mail.google.com/', 'https://inbox.google.com/', 'https://drive.google.com/', 'https://docs.google.com/',
  'https://photos.google.com/', 'https://contacts.google.com/', 'https://myaccount.google.com/', 'https://takeout.google.com/',
  'https://passwords.google.com/', 'https://www.gmail.com/', 'https://github.com/', 'https://api.github.com/',
  'https://nyu.edu/', 'https://brightspace.nyu.edu/', 'https://outlook.live.com/', 'https://outlook.office.com/',
  'https://account.microsoft.com/', 'https://appleid.apple.com/', 'https://icloud.com/', 'https://claude.ai/',
  'https://chatgpt.com/', 'https://api.lishuyu.app/', 'https://mcp.lishuyu.app/', 'http://foo.ts.net/', 'https://paypal.com/',
  'https://chase.com/', 'http://localhost/', 'http://127.1/', 'https://192.168.0.1/', 'http://169.254.169.254/',
  'http://[::1]/', 'https://machine.local/', 'file:///tmp/nonpublic', 'chrome://settings/', 'devtools://devtools/', 'data:text/html,test',
  'view-source:https://jobs.example.com/', 'javascript:void(0)', 'https://MAIL.GOOGLE.COM./mail?ignored=value',
]

it.each(deny)('refuses direct job navigation to %s', (url) => { expect(deniedJobUrl(url)).toBe(true) })
it.each(['https://careers.unknown-employer.example/', 'https://shibboleth.nyu.edu/', 'https://accounts.google.com/', 'http://new-ats.example.test/'])('allows an ordinary employer or login at %s', (url) => {
  expect(deniedJobUrl(url)).toBe(false)
})

it('maps the approved PDF sources to their employer-facing names and refuses other files', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-job-upload-'))
  try {
    const pdf = Buffer.from('%PDF-1.7 synthetic')
    const approved = join(root, 'private', 'resume-small.pdf')
    const cover = join(root, 'cover_letters')
    mkdirSync(join(root, 'private'))
    mkdirSync(cover)
    writeFileSync(approved, pdf)
    writeFileSync(join(root, 'private', 'transcript-source.pdf'), pdf)
    writeFileSync(join(root, 'private', 'resume-compact.pdf'), pdf)
    writeFileSync(join(cover, 'letter.pdf'), pdf)
    writeFileSync(join(cover, 'letter.docx'), Buffer.from([80, 75, 3, 4, 0]))
    writeFileSync(join(cover, 'not-a-pdf.pdf'), 'not a PDF')
    symlinkSync(approved, join(cover, 'symlink.pdf'))
    linkSync(join(cover, 'letter.pdf'), join(cover, 'hardlink.pdf'))
    const uploads = new JobApplyUploads({ coverLetterRoot: root, uploadFiles: {
      'Resume.pdf': 'private/resume-small.pdf', 'Transcript.pdf': 'private/transcript-source.pdf', 'Resume_488KB.pdf': 'private/resume-compact.pdf',
    } }, 1, new Context().logger)
    const names = ['Resume.pdf', 'Transcript.pdf', 'Resume_488KB.pdf', 'cover_letters/letter.docx']
    expect((await uploads.resolve(names)).map(file => file.payload?.name)).toEqual(['Resume.pdf', 'Transcript.pdf', 'Resume_488KB.pdf', 'letter.docx'])
    const [resume] = await uploads.resolve(['Resume.pdf'])
    expect(resume).toMatchObject({ path: approved, name: 'Resume.pdf', payload: { name: 'Resume.pdf', buffer: pdf } })
    for (const path of ['~/.ssh/id_rsa', approved, 'resume-small.pdf', 'private/resume-small.pdf', 'cover_letters/../Resume.pdf',
      'cover_letters/hardlink.pdf', 'cover_letters/symlink.pdf', 'cover_letters/not-a-pdf.pdf', 'cover_letters/letter.md']) {
      await expect(uploads.resolve([path])).rejects.toThrow()
    }
  } finally { rmSync(root, { force: true, recursive: true }) }
})

it.skipIf(!existsSync(chromium.executablePath()))('closes a denied popup without exposing it, rejects redirects, and fences other Sessions’ tabs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-job-browser-'))
  const warnings: string[] = []
  let deniedRequests = 0
  let base = ''
  let privatePage = ''
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: privatePage }); res.end(); return }
    res.setHeader('Content-Type', 'text/html')
    if (req.url === '/private') { deniedRequests++; res.end('<title>synthetic private subject</title>synthetic private mail'); return }
    res.end(`<title>Unlisted employer</title><button id="popup" onclick="window.open('${privatePage}')">Open a window</button>
      <label>Search schools<input id="search" onkeydown="if(event.key==='Enter') output.textContent='Search '+this.value"></label>
      <a href="https://www.employer.example/about">About the employer</a><a href="mailto:jobs@employer.example">Mail</a>
      <a id="section" href="javascript:void(0)" onclick="output.textContent='Section'">Application Questions</a>
      <button id="safe" onclick="output.textContent='Allowed'">Review and Submit</button>
      <button id="pay" aria-label="Pay $25 application fee" onclick="output.textContent='Unexpected'">$<span id="icon">!</span></button>
      <label>Password<input id="password" type="password"></label><output id="output"></output>
      <div style="height:2200px"></div>`)

  })
  let browser: HeadlessBrowserSession | undefined
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('test server did not bind')
    base = `http://jobs.example.test:${bound.port}`
    privatePage = `http://mail.google.com:${bound.port}/private`
    browser = new HeadlessBrowserSession(Config({ profileDir: join(root, 'profile'), downloadDir: join(root, 'downloads'), stealth: false } as Config), {
      debug: () => {}, info: () => {}, warn: (format, ...args: unknown[]) => { warnings.push([format, ...args].map(String).join(' ')) },
    }, new ActionGuard(), {
      launch: async (profile, options) => await chromium.launchPersistentContext(profile, { ...options,
        args: ['--host-resolver-rules=MAP *.example.test 127.0.0.1,MAP mail.google.com 127.0.0.1', '--no-proxy-server'],
      }),
      probe: { listProcesses: async () => [] },
    })
    const active = browser
    const guard = () => new ActionGuard({ sensitivePolicy: 'job-apply' })
    const job = <T>(operation: () => Promise<T>) => active.runJob('worker', guard(), operation)
    await expect(job(async () => await active.open(privatePage, true))).rejects.toThrow('navigation_refused: mail.google.com')
    await expect(job(async () => await active.open(`${base}/redirect`, true))).rejects.toThrow('navigation_refused: mail.google.com')
    expect(deniedRequests).toBe(0)
    const opened = await job(async () => await active.open(base, true))
    expect(opened.title).toBe('Unlisted employer')
    expect(await active.currentJobHost('worker')).toBe('jobs.example.test')
    expect(await active.currentJobHost('other')).toBeNull()
    expect(await active.currentJobLinkHosts('worker')).toEqual(['www.employer.example'])
    expect(await active.currentJobLinkHosts('other')).toEqual([])
    await expect(active.runJob('other', new ActionGuard(), async () => await active.read({}, opened.tab))).rejects.toThrow('not owned')
    warnings.length = 0
    const outcome = await job(async () => await active.click({ selector: '#popup' }, opened.tab))
    await vi.waitFor(() => { expect(warnings.join('\n')).toContain('navigation_refused: mail.google.com') })
    expect(outcome.popups).toBeUndefined()
    expect(await job(async () => await active.listTabs())).toEqual([expect.objectContaining({ id: opened.tab, title: 'Unlisted employer' })])
    const context = await active.ensure()
    await vi.waitFor(() => { expect(context.pages().some(page => page.url().includes('/private'))).toBe(false) })
    expect((await job(async () => await active.read({}, opened.tab))).text).not.toContain('synthetic private mail')
    const page = await active.page(opened.tab)
    const point = async (selector: string) => {
      const box = await page.locator(selector).boundingBox()
      if (box === null) throw new Error('fixture element did not render')
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    await job(async () => await active.click({ selector: '#section' }, opened.tab))
    expect(await page.locator('#output').textContent()).toBe('Section')
    const search = await point('#search')
    await job(async () => await active.fill({ point: search }, 'Example', opened.tab, { enter: true }))
    expect(await page.locator('#output').textContent()).toBe('Search Example')
    await job(async () => await active.fill({ selector: '#search' }, 'Named', opened.tab, { enter: true }))
    expect(await page.locator('#output').textContent()).toBe('Search Named')
    const permitted = await point('#safe')
    await job(async () => await active.click({ point: permitted }, opened.tab))
    expect(await page.locator('#output').textContent()).toBe('Allowed')
    const money = await point('#icon')
    await expect(job(async () => await active.click({ point: money }, opened.tab))).rejects.toThrow(/sensitive/i)
    expect(await page.locator('#output').textContent()).toBe('Allowed')
    await expect(active.runJob('other', guard(), async () => await active.click({ point: permitted }, opened.tab))).rejects.toThrow('not owned')
    await job(async () => await active.scroll({ deltaY: 250, ...permitted }, opened.tab))
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    const snapshot = await job(async () => await active.snapshot(opened.tab))
    expect(active.jobSnapshot('worker', snapshot.path)?.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(active.jobSnapshot('other', snapshot.path)).toBeUndefined()
    expect(active.jobSnapshot('worker', '/tmp/other.png')).toBeUndefined()
    const form = { selector: '#password' }
    await job(async () => await active.fillSecret(form, 'fixture-password', 'password', 'jobs.example.test', opened.tab))
    expect(await page.locator('#password').inputValue()).toBe('fixture-password')
    const wrongSite = await job(async () => await active.open(base.replace('jobs.', 'other.'), true))
    await expect(job(async () => await active.fillSecret(form, 'fixture-password', 'password', 'jobs.example.test', wrongSite.tab)))
      .rejects.toThrow(/only written on its own host/)
    expect(await (await active.page(wrongSite.tab)).locator('#password').inputValue()).toBe('')
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    rmSync(root, { force: true, recursive: true })
  }
}, 120_000)

it.skipIf(!existsSync(chromium.executablePath()))('frees a slot from an idle job Session at the tab cap and reports a full strip it cannot free', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-job-tabs-'))
  const infos: string[] = []
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>Posting ${req.url}</title>`) })
  let browser: HeadlessBrowserSession | undefined
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('test server did not bind')
    const base = `http://jobs.example.test:${bound.port}`
    browser = new HeadlessBrowserSession(Config({ profileDir: join(root, 'profile'), downloadDir: join(root, 'downloads'), stealth: false } as Config), {
      debug: () => {}, info: (format, ...args: unknown[]) => { infos.push([format, ...args].map(String).join(' ')) }, warn: () => {},
    }, new ActionGuard(), {
      launch: async (profile, options) => await chromium.launchPersistentContext(profile, { ...options,
        args: ['--host-resolver-rules=MAP *.example.test 127.0.0.1', '--no-proxy-server'],
      }),
      probe: { listProcesses: async () => [] },
      jobTabIdleMs: 0,
    })
    const active = browser
    const as = <T>(session: string, operation: () => Promise<T>) => active.runJob(session, new ActionGuard({ sensitivePolicy: 'job-apply' }), operation)
    // The owner's own tabs, the boot page among them, fill the strip: nothing may be closed for a job Session, and the error says why.
    const ownerTabs: string[] = [(await active.open(`${base}/owner-boot`)).tab]
    for (let n = 0; active.tabs().state().length < MAX_TABS; n++) ownerTabs.push((await active.open(`${base}/owner-${n}`, true)).tab)
    await expect(as('busy', async () => await active.open(`${base}/busy`, true))).rejects.toThrow(/at most 8 tabs/u)
    await active.closeTab(ownerTabs.pop())
    await active.closeTab(ownerTabs.pop())
    const idle = [(await as('idle', async () => await active.open(`${base}/idle-1`, true))).tab]
    idle.push((await as('idle', async () => await active.open(`${base}/idle-2`, true))).tab)
    expect(active.tabs().state()).toHaveLength(MAX_TABS)
    const busy = await as('busy', async () => await active.open(`${base}/busy`, true))
    expect(busy.title).toBe('Posting /busy')
    const left = active.tabs().state().map(tab => tab.id)
    expect(left).not.toContain(idle[0])
    expect(left).toContain(idle[1])
    for (const tab of ownerTabs) expect(left).toContain(tab)
    expect(infos.some(line => line.includes('closed idle job-apply tab') && line.includes(idle[0] ?? 'missing'))).toBe(true)
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    rmSync(root, { force: true, recursive: true })
  }
}, 120_000)

it.skipIf(!existsSync(chromium.executablePath()))('keeps a working Session’s popup at the cap and hands an idle Session’s tabs to the next worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-job-lease-'))
  const infos: string[] = []
  let port = 0
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    if (req.url === '/apply') {
      res.end(`<title>Posting</title><button id="apply" onclick="window.open('http://ats.example.test:${port}/form')">Apply</button>`)
      return
    }
    res.end(`<title>Page ${req.url}</title><input id="email">`)
  })
  let browser: HeadlessBrowserSession | undefined
  let clock = 1_000_000
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('test server did not bind')
    port = bound.port
    const base = `http://jobs.example.test:${port}`
    browser = new HeadlessBrowserSession(Config({ profileDir: join(root, 'profile'), downloadDir: join(root, 'downloads'), stealth: false } as Config), {
      debug: () => {}, info: (format, ...args: unknown[]) => { infos.push([format, ...args].map(String).join(' ')) }, warn: () => {},
    }, new ActionGuard(), {
      launch: async (profile, options) => await chromium.launchPersistentContext(profile, { ...options,
        args: ['--host-resolver-rules=MAP *.example.test 127.0.0.1', '--no-proxy-server'],
      }),
      probe: { listProcesses: async () => [] },
      now: () => clock,
    })
    const active = browser
    const as = <T>(session: string, operation: () => Promise<T>) => active.runJob(session, new ActionGuard({ sensitivePolicy: 'job-apply' }), operation)
    const open = () => active.tabs().state().map(tab => tab.id)
    await active.open(`${base}/owner-boot`)
    for (let n = 0; open().length < MAX_TABS - 2; n++) await active.open(`${base}/owner-${n}`, true)
    const posting = await as('a', async () => await active.open(`${base}/apply`, true))
    const clicked = await as('a', async () => await active.click({ selector: '#apply' }, posting.tab))
    const popup = clicked.popups?.[0]?.tab ?? 'missing'
    expect(open()).toHaveLength(MAX_TABS)
    expect(await active.currentJobHost('a')).toBe('ats.example.test')

    // Worker a just clicked Apply: its popup stays, and b is told the strip is busy rather than to close a tab.
    clock += 1_000
    await expect(as('b', async () => await active.open(`${base}/b`, true))).rejects.toThrow(/at most 8 tabs; every tab belongs to a Session still working/u)
    expect(open()).toContain(popup)
    await expect(as('b', async () => await active.read({}, posting.tab))).rejects.toThrow('still working in it')

    // After a goes quiet, b sent to continue the form lists a's tabs, resumes one by URL and takes it over.
    clock += JOB_TAB_IDLE_MS
    expect((await as('b', async () => await active.listTabs())).map(tab => tab.id).sort()).toEqual([posting.tab, popup].sort())
    expect((await as('b', async () => await active.resumeTab({ urlSubstring: '/form' }))).tab).toBe(popup)
    expect(active.tabs().owner(popup)).toBe('job-apply:b')
    expect(infos.some(line => line.includes('took over idle job-apply tab') && line.includes(popup))).toBe(true)
    expect(await active.currentJobHost('b')).toBe('ats.example.test')
    await expect(as('a', async () => await active.read({}, popup))).rejects.toThrow('still working in it')

    // Once both are quiet, c's open closes the least recently used idle tab, never one of its own.
    clock += JOB_TAB_IDLE_MS
    const c = await as('c', async () => await active.open(`${base}/c`, true))
    expect(c.title).toBe('Page /c')
    expect(open()).not.toContain(posting.tab)
    expect(open()).toContain(popup)
    await expect(as('c', async () => await active.read({}, posting.tab))).rejects.toThrow(/is closed/u)
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    rmSync(root, { force: true, recursive: true })
  }
}, 120_000)

it.skipIf(!existsSync(chromium.executablePath()))('frees a slot from an unclaimed blank tab, then from a working Session’s stale side tabs, keeping its current tab and a popup’s opener', async () => {
  // One LinkedIn search worker kept seven employer pages open while it worked; apply workers found the strip full (2026-11-27).
  const root = mkdtempSync(join(tmpdir(), 'dsh-job-stale-'))
  const infos: string[] = []
  let port = 0
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    if (req.url === '/apply') {
      res.end(`<title>Posting</title><button id="apply" onclick="window.open('http://ats.example.test:${port}/form')">Apply</button>`)
      return
    }
    res.end(`<title>Page ${req.url}</title>`)
  })
  let browser: HeadlessBrowserSession | undefined
  let clock = 1_000_000
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('test server did not bind')
    port = bound.port
    const base = `http://jobs.example.test:${port}`
    browser = new HeadlessBrowserSession(Config({ profileDir: join(root, 'profile'), downloadDir: join(root, 'downloads'), stealth: false } as Config), {
      debug: () => {}, info: (format, ...args: unknown[]) => { infos.push([format, ...args].map(String).join(' ')) }, warn: () => {},
    }, new ActionGuard(), {
      launch: async (profile, options) => await chromium.launchPersistentContext(profile, { ...options,
        args: ['--host-resolver-rules=MAP *.example.test 127.0.0.1', '--no-proxy-server'],
      }),
      probe: { listProcesses: async () => [] },
      now: () => clock,
    })
    const active = browser
    const as = <T>(session: string, operation: () => Promise<T>) => active.runJob(session, new ActionGuard({ sensitivePolicy: 'job-apply' }), operation)
    const open = () => active.tabs().state().map(tab => tab.id)
    // A relaunch leaves the context's first page: blank, and nobody's.
    await active.tabs().page()
    const [first] = active.tabs().state()
    const blank = first?.id ?? 'missing'
    expect(first?.url).toBe('about:blank')
    expect(active.tabs().owner(blank)).toBeNull()
    const posting = await as('scan', async () => await active.open(`${base}/apply`, true))
    const clicked = await as('scan', async () => await active.click({ selector: '#apply' }, posting.tab))
    const popup = clicked.popups?.[0]?.tab ?? 'missing'
    const side: string[] = []
    for (let n = 0; open().length < MAX_TABS - 1; n++) {
      clock += 1_000
      side.push((await as('scan', async () => await active.open(`${base}/side-${String(n)}`, true))).tab)
    }
    clock += 1_000
    const w = await as('w', async () => await active.open(`${base}/w`, true))
    expect(open()).toHaveLength(MAX_TABS)
    expect(side).toHaveLength(4)

    // The unclaimed blank page goes first.
    clock += 1_000
    const b = await as('b', async () => await active.open(`${base}/b`, true))
    expect(open()).not.toContain(blank)
    expect(infos.some(line => line.includes('closed unclaimed blank tab') && line.includes(blank))).toBe(true)

    // Every tab was used within the idle window: the strip is busy.
    clock += 1_000
    await expect(as('c', async () => await active.open(`${base}/c`, true))).rejects.toThrow(/every tab belongs to a Session still working/u)

    // All four keep working; scan works in its popup and its newest side tab and leaves its first side tab behind.
    clock += JOB_TAB_IDLE_MS
    await as('scan', async () => await active.read({}, popup))
    clock += 1_000
    await as('scan', async () => await active.read({}, side[3]))
    await as('w', async () => await active.read({}, w.tab))
    await as('b', async () => await active.read({}, b.tab))
    clock += 1_000
    const c = await as('c', async () => await active.open(`${base}/c`, true))
    expect(c.title).toBe('Page /c')
    expect(open()).not.toContain(side[0])
    for (const tab of [posting.tab, popup, side[1], side[2], side[3], w.tab, b.tab, c.tab]) expect(open()).toContain(tab)
    expect(infos.some(line => line.includes('closed stale side tab') && line.includes(side[0] ?? 'missing') && line.includes('job-apply:scan'))).toBe(true)
    await expect(as('scan', async () => await active.read({}, side[0]))).rejects.toThrow(/is closed/u)

    // The Session that left them gets its own stale side tab back too; the posting that opened its popup stays.
    clock += 1_000
    await as('scan', async () => await active.open(`${base}/side-next`, true))
    expect(open()).not.toContain(side[1])
    expect(open()).toContain(posting.tab)
    expect(open()).toContain(popup)
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    rmSync(root, { force: true, recursive: true })
  }
}, 120_000)

it.skipIf(!existsSync(chromium.executablePath()))('reads employer links from every tab a Session has on its current host, and from no other host', async () => {
  // Tenet's Oracle application step links nowhere; its posting page on the same host links the employer (2026-11-27).
  const root = mkdtempSync(join(tmpdir(), 'dsh-job-links-'))
  const infos: string[] = []
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    if (req.url === '/job/1') { res.end('<title>Posting</title><a href="https://www.employer.example/">Employer</a>'); return }
    if (req.url === '/elsewhere') { res.end('<title>Other site</title><a href="https://www.decoy.example/">Decoy</a>'); return }
    res.end('<title>Confirm your identity</title><input id="email">')
  })
  let browser: HeadlessBrowserSession | undefined
  let clock = 1_000_000
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('test server did not bind')
    const ats = `http://eodr.example.test:${bound.port}`
    browser = new HeadlessBrowserSession(Config({ profileDir: join(root, 'profile'), downloadDir: join(root, 'downloads'), stealth: false } as Config), {
      debug: () => {}, info: (format, ...args: unknown[]) => { infos.push([format, ...args].map(String).join(' ')) }, warn: () => {},
    }, new ActionGuard(), {
      launch: async (profile, options) => await chromium.launchPersistentContext(profile, { ...options,
        args: ['--host-resolver-rules=MAP *.example.test 127.0.0.1', '--no-proxy-server'],
      }),
      probe: { listProcesses: async () => [] },
      now: () => clock,
    })
    const active = browser
    const as = <T>(session: string, operation: () => Promise<T>) => active.runJob(session, new ActionGuard({ sensitivePolicy: 'job-apply' }), operation)
    const apply = await as('a', async () => await active.open(`${ats}/job/1/apply/email`, true))
    expect(await active.currentJobLinkHosts('a')).toEqual([])
    await as('a', async () => await active.open(`${ats}/job/1`, true))
    clock += 1_000
    await as('a', async () => await active.read({}, apply.tab))
    expect(await active.currentJobHost('a')).toBe('eodr.example.test')
    expect(await active.currentJobLinkHosts('a')).toEqual(['www.employer.example'])
    expect(infos).toContain('headless-browser: read links of %d tabs on %s for a job-apply Session 2 eodr.example.test')
    await as('a', async () => await active.open(`http://other.example.test:${bound.port}/elsewhere`, true))
    clock += 1_000
    await as('a', async () => await active.read({}, apply.tab))
    expect(await active.currentJobLinkHosts('a')).toEqual(['www.employer.example'])
    expect(await active.currentJobLinkHosts('b')).toEqual([])
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    rmSync(root, { force: true, recursive: true })
  }
}, 120_000)

it('refuses an upload policy whose names are not exact PDFs mapped under private/ in a canonical root', () => {
  const log = new Context().logger
  for (const config of [
    { coverLetterRoot: '/jobs', uploadFiles: {} },
    { coverLetterRoot: '/jobs', uploadFiles: { 'Resume.docx': 'private/resume.pdf' } },
    { coverLetterRoot: '/jobs', uploadFiles: { 'Resume.pdf': 'public/resume.pdf' } },
    { coverLetterRoot: '/jobs', uploadFiles: { 'Resume.pdf': 'private/resume.txt' } },
    { coverLetterRoot: '/jobs', uploadFiles: { 'Resume.pdf': './private/resume.pdf' } },
    { coverLetterRoot: 'jobs', uploadFiles: { 'Resume.pdf': 'private/resume.pdf' } },
    { coverLetterRoot: '/jobs/../jobs', uploadFiles: { 'Resume.pdf': 'private/resume.pdf' } },
  ] satisfies JobApplyConfig[]) {
    expect(() => new JobApplyUploads(config, 1, log)).toThrow('jobApply requires exact PDF names mapped under private/ in its canonical root')
  }
})

it('refuses an empty or oversized upload list, and an upload directory that is a link', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-job-upload-link-'))
  try {
    mkdirSync(join(root, 'elsewhere'))
    writeFileSync(join(root, 'elsewhere', 'resume.pdf'), '%PDF-1.7 synthetic')
    symlinkSync(join(root, 'elsewhere'), join(root, 'private'))
    const uploads = new JobApplyUploads({ coverLetterRoot: root, uploadFiles: { 'Resume.pdf': 'private/resume.pdf' } }, 1, new Context().logger)
    await expect(uploads.resolve([])).rejects.toThrow('invalid upload count')
    await expect(uploads.resolve(Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => 'Resume.pdf'))).rejects.toThrow('invalid upload count')
    await expect(uploads.resolve(['Resume.pdf'])).rejects.toThrow('the configured upload directory is not a canonical directory')
  } finally { rmSync(root, { force: true, recursive: true }) }
})

/** A target whose name the job-apply guard audits. */
function control(name: string): ElementFacts {
  return {
    name, value: '', href: null, formAction: null, tag: 'button', role: null,
    display: 'inline-block', visibility: 'visible', opacity: 1, pointerEvents: 'auto', ariaHidden: false,
    width: 120, height: 32, viewportFraction: 1, occlusion: 1, clippedBy: 0, clippingFraction: 1,
  }
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const SNAPSHOT = 'job-snapshot:1.png'

/** The run context a scoped tool receives from one Session's agent, or from no agent. */
function execFor(session?: string): ToolRunContext {
  return {
    signal: new AbortController().signal,
    ...session === undefined ? {} : { agent: { session: { id: session } } },
  } as never
}

describe('the job-apply browser scope', () => {
  async function mount(options: { readonly attachments?: boolean; readonly inspect?: (guard: ActionGuard) => void } = {}) {
    const ctx = new Context()
    const definitions = new Map<string, ToolDefinition>()
    const restrict = vi.fn(() => () => {})
    ctx.provide('tools', {
      definitions: () => [{ name: 'headless_browser_cookies' }, { name: 'headless_browser_open' }, { name: 'bash' }],
      restrict,
      register(definition: ToolDefinition) {
        definitions.set(definition.name, definition)
        return () => { definitions.delete(definition.name) }
      },
    } as never)
    const saved: unknown[] = []
    if (options.attachments === true) {
      ctx.provide('attachments', {
        saveImage: async (image: unknown) => {
          saved.push(image)
          return { attachmentId: 'att-1', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 }
        },
      } as never)
    }
    const events: SecurityEvent[] = []
    ctx.on('headless-browser/security', (event) => { events.push(event) })
    const infos: string[] = []
    const warnings: string[] = []
    const errors: unknown[] = []
    const logger = { info: (format: string, ...args: unknown[]) => { infos.push([format, ...args].map(String).join(' ')) },
      warn: (format: string, ...args: unknown[]) => { warnings.push([format, ...args].map(String).join(' ')) },
      error: (error: unknown) => { errors.push(error) }, debug: () => {} }
    const opened: unknown[][] = []
    const browser = {
      currentJobHost: vi.fn(async () => 'jobs.example.test'),
      currentJobLinkHosts: vi.fn(async () => ['www.employer.example']),
      runJob: async (owner: string, guard: ActionGuard, operation: () => Promise<unknown>) => {
        options.inspect?.(guard)
        return { owner, result: await operation() }
      },
      jobSnapshot: (owner: string, id: string) => owner === 'worker' && id === SNAPSHOT ? PNG : undefined,
      open: async (...args: unknown[]) => { opened.push(args); return { url: 'https://jobs.example.test/1', tab: 't1', title: 'Posting' } },
      listTabs: async () => [],
    }
    const fiber = ctx.plugin({
      inject: ['tools'],
      apply: (scope: Context) => {
        Object.defineProperty(scope, 'logger', { value: logger })
        mountJobApplyBrowser(scope, Config({} as Config), { coverLetterRoot: '/jobs/clone', uploadFiles: { 'Resume.pdf': 'private/resume.pdf' } }, {
          browser: browser as never, takeover: new TakeoverState(), credentials: {} as CredentialVault,
        })
      },
    })
    await fiber
    const tool = (name: string): ToolDefinition => {
      const definition = definitions.get(name)
      if (definition === undefined) throw new Error(`the scope registered no ${name}`)
      return definition
    }
    const call = async (name: string, args: unknown, session: string | null = 'worker') => await tool(name).execute(args, execFor(session ?? undefined))
    return { ctx, fiber, definitions, restrict, events, infos, warnings, errors, opened, browser, saved, tool, call }
  }

  it('masks the inherited browser tools and registers only the supported ones, each needing an owned tab but open and tabs', async () => {
    const { definitions, restrict, tool } = await mount()
    expect(restrict).toHaveBeenCalledWith({ deny: ['headless_browser_cookies', 'headless_browser_open'], preserveLocal: true })
    expect([...definitions.keys()].sort()).toEqual([
      'headless_browser_click', 'headless_browser_close', 'headless_browser_credential', 'headless_browser_open', 'headless_browser_read',
      'headless_browser_resume', 'headless_browser_scroll', 'headless_browser_snapshot', 'headless_browser_tabs', 'headless_browser_type',
      'headless_browser_upload', 'read_image',
    ])
    expect(Object.keys(tool('headless_browser_open').parameters['properties'] as object)).toEqual(['url'])
    expect(tool('headless_browser_open').parameters['required']).toEqual(['url'])
    expect(tool('headless_browser_tabs').parameters['required']).toEqual([])
    expect(tool('headless_browser_click').parameters['required']).toEqual(['tab'])
    expect(tool('headless_browser_upload').parameters['properties']).toMatchObject({ files: { description: 'Only Resume.pdf or a cover_letters/<name>.pdf/.docx path.' } })
  })

  it('answers the verification-code tool with the caller’s current host and linked hosts', async () => {
    const { ctx, browser } = await mount()
    const signal = new AbortController().signal
    const jobApply = ctx.get('jobApplyBrowser')
    expect(await jobApply?.currentHost('worker', signal)).toBe('jobs.example.test')
    expect(await jobApply?.linkedHosts('worker', signal)).toEqual(['www.employer.example'])
    expect(jobApply?.registrableDomain('jobs.example.co.uk')).toBe('example.co.uk')
    expect(browser.currentJobHost).toHaveBeenCalledWith('worker', signal)
    expect(browser.currentJobLinkHosts).toHaveBeenCalledWith('worker', signal)
  })

  it('refuses a call without an active Session, and every call once the scope is disposed', async () => {
    const { fiber, call } = await mount({ attachments: true })
    expect(await call('headless_browser_tabs', {}, null)).toEqual({ error: 'job-apply browser requires an active Session' })
    await expect(call('read_image', { file_path: SNAPSHOT }, null)).rejects.toThrow('No retained browser snapshot')
    await fiber.dispose()
    expect(await call('headless_browser_tabs', {})).toEqual({ error: 'job-apply browser requires an active Session' })
    await expect(call('read_image', { file_path: SNAPSHOT })).rejects.toThrow('No retained browser snapshot')
  })

  it('refuses arguments the scoped schema does not name and selectors that chain browser engines', async () => {
    const { call } = await mount()
    const unsupported = { error: 'unsupported job-apply browser arguments' }
    expect(await call('headless_browser_tabs', null)).toEqual(unsupported)
    expect(await call('headless_browser_tabs', 'tabs')).toEqual(unsupported)
    expect(await call('headless_browser_tabs', [])).toEqual(unsupported)
    expect(await call('headless_browser_open', { url: 'https://jobs.example.test/', allowOrigin: true })).toEqual(unsupported)
    const engines = { error: 'job-apply requires a single selector without internal browser engines' }
    expect(await call('headless_browser_click', { tab: 't1', selector: 'form >> button' })).toEqual(engines)
    expect(await call('headless_browser_upload', { tab: 't1', files: ['Resume.pdf'], trigger: 'internal:label="Resume"' })).toEqual(engines)
    expect(await call('headless_browser_credential', { tab: 't1', action: 'fill', selector: '#password', confirmSelector: 'a >> b' })).toEqual(engines)
  })

  it('requires a non-blank owned tab id on every call but open and tabs', async () => {
    const { call } = await mount()
    const missing = { error: 'supply the id of an owned tab' }
    expect(await call('headless_browser_click', { selector: 42 })).toEqual(missing)
    expect(await call('headless_browser_read', { tab: 7 })).toEqual(missing)
    expect(await call('headless_browser_read', { tab: '  ' })).toEqual(missing)
  })

  it('refuses to open a denied URL before the browser sees it, naming only its host', async () => {
    const { call, opened, warnings } = await mount()
    expect(await call('headless_browser_open', { url: 'https://mail.google.com/mail/u/0/#inbox' })).toEqual({ error: 'navigation_refused: mail.google.com' })
    expect(opened).toEqual([])
    expect(warnings).toEqual(['headless-browser: %s navigation_refused: mail.google.com'])
  })

  it('opens every page in a new tab under a job-apply guard that audits the application actions it allows', async () => {
    const url = 'https://jobs.example.test/apply'
    const { call, opened, events, infos } = await mount({
      inspect: (guard) => {
        guard.decideTarget({ action: 'click', url, ref: '#submit', candidates: [control('Submit your application')], allowOrigin: false })
        guard.decideTarget({ action: 'click', url, ref: '#fee', candidates: [control('Pay $25 application fee')], allowOrigin: false })
      },
    })
    expect(await call('headless_browser_open', { url })).toEqual({
      owner: 'worker', result: expect.objectContaining({ url: 'https://jobs.example.test/1', tab: 't1' }) as object,
    })
    expect(opened).toEqual([[url, true, false, undefined, 'worker']])
    expect(events.map(event => [event.kind, event.rule])).toEqual([['allow', 'sensitive-name'], ['refusal', 'sensitive']])
    expect(infos).toEqual(['headless-browser: authorized application action %s on %s click jobs.example.test'])
    expect(await call('headless_browser_tabs', {})).toEqual({ owner: 'worker', result: { tabs: [] } })
  })

  it('shows a Session its own retained snapshot as an attachment marked untrusted, and nothing else', async () => {
    const { call, saved, tool } = await mount({ attachments: true })
    const image = { attachmentId: 'att-1', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 }
    expect(await call('read_image', { file_path: SNAPSHOT })).toEqual({ path: SNAPSHOT, image })
    expect(tool('read_image').output.render({ file_path: SNAPSHOT }, { path: SNAPSHOT, image })).toEqual([
      { type: 'text', text: `Untrusted browser screenshot (${SNAPSHOT})` },
      { type: 'image', attachment: image },
    ])
    expect(saved).toEqual([{ data: PNG, mediaType: 'image/png', name: 'job-snapshot.png' }])
    await expect(call('read_image', { file_path: SNAPSHOT }, 'other')).rejects.toThrow('No retained browser snapshot with that identifier belongs to this Session.')
  })

  it('needs the attachment service to show a snapshot', async () => {
    const { call } = await mount()
    await expect(call('read_image', { file_path: SNAPSHOT })).rejects.toThrow('Snapshot viewing requires the attachment service.')
  })

  it('gives the browser tools no keepalive service and no takeover page', async () => {
    vi.mocked(registerBrowserTools).mockClear()
    await mount()
    const deps: ToolDeps | undefined = vi.mocked(registerBrowserTools).mock.calls[0]?.[1]
    expect(() => deps?.keepalives).toThrow('keepalives are disabled for job applications')
    expect(() => deps?.pageUrl()).toThrow('browser takeover is disabled for job applications')
  })

  it('fails the mount on a browser tool whose parameters name no properties', async () => {
    vi.mocked(registerBrowserTools).mockImplementationOnce((ctx, _deps, register) => {
      register?.(ctx, { ...tabsLike(), parameters: { type: 'object' } })
    })
    await expect(mount()).rejects.toThrow('browser tool has no object properties')
  })
})

/** A browser tool definition the scope supports, for a registration it must refuse. */
function tabsLike(): ToolDefinition {
  return {
    name: 'headless_browser_tabs', description: 'List tabs', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ tabs: [] }),
  }
}
