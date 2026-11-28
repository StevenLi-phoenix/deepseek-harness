import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { chromium } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { ActionGuard } from '../src/guard.ts'
import { deniedJobUrl } from '../src/job-apply-network.ts'
import { JobApplyUploads } from '../src/job-apply.ts'
import { HeadlessBrowserSession, JOB_TAB_IDLE_MS } from '../src/session.ts'
import { MAX_TABS } from '../src/tabs.ts'

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
}, 25_000)

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
    // The owner's own tabs fill the strip: nothing may be closed for a job Session, and the error says why.
    const ownerTabs: string[] = []
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
}, 25_000)

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
}, 25_000)
