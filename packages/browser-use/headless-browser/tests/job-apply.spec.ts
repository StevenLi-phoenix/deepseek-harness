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
import { HeadlessBrowserSession } from '../src/session.ts'

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

it('only attaches the two configured PDFs or an unlinked correctly typed cover letter', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-job-upload-'))
  try {
    const pdf = Buffer.from('%PDF-1.7 synthetic')
    const approved = join(root, 'resume.pdf')
    const cover = join(root, 'cover_letters')
    mkdirSync(cover)
    writeFileSync(approved, pdf)
    writeFileSync(join(cover, 'letter.pdf'), pdf)
    writeFileSync(join(cover, 'letter.docx'), Buffer.from([80, 75, 3, 4, 0]))
    writeFileSync(join(cover, 'not-a-pdf.pdf'), 'not a PDF')
    symlinkSync(approved, join(cover, 'symlink.pdf'))
    linkSync(join(cover, 'letter.pdf'), join(cover, 'hardlink.pdf'))
    const uploads = new JobApplyUploads({ uploadDirs: [root], uploadBasenames: ['resume.pdf', 'transcript.pdf'], coverLetterRoot: root }, 1, new Context().logger)
    expect((await uploads.resolve(['resume.pdf', 'cover_letters/letter.docx'])).map(file => file.name)).toEqual(['resume.pdf', 'letter.docx'])
    for (const path of ['~/.ssh/id_rsa', approved, 'cover_letters/../resume.pdf', 'cover_letters/hardlink.pdf', 'cover_letters/symlink.pdf', 'cover_letters/not-a-pdf.pdf', 'cover_letters/letter.md']) {
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
    res.end(`<title>Unlisted employer</title><button id="popup" onclick="window.open('${privatePage}')">Open a window</button>`)
  })
  let browser: HeadlessBrowserSession | undefined
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('test server did not bind')
    base = `http://jobs.example.test:${bound.port}`
    privatePage = `http://mail.google.com:${bound.port}/private`
    browser = new HeadlessBrowserSession(Config({ profileDir: join(root, 'profile'), downloadDir: join(root, 'downloads'), stealth: false } as Config), {
      debug: () => {}, info: () => {}, warn: (format, ...args) => { warnings.push([format, ...args].join(' ')) },
    }, new ActionGuard(), {
      launch: async (profile, options) => await chromium.launchPersistentContext(profile, { ...options,
        args: ['--host-resolver-rules=MAP jobs.example.test 127.0.0.1,MAP mail.google.com 127.0.0.1', '--no-proxy-server'],
      }),
      probe: { listProcesses: async () => [] },
    })
    const active = browser
    const job = <T>(operation: () => Promise<T>) => active.runJob('worker', new ActionGuard(), operation)
    await expect(job(async () => await active.open(privatePage, true))).rejects.toThrow('navigation_refused: mail.google.com')
    await expect(job(async () => await active.open(`${base}/redirect`, true))).rejects.toThrow('navigation_refused: mail.google.com')
    expect(deniedRequests).toBe(0)
    const opened = await job(async () => await active.open(base, true))
    expect(opened.title).toBe('Unlisted employer')
    expect(await active.currentJobHost('worker')).toBe('jobs.example.test')
    expect(await active.currentJobHost('other')).toBeNull()
    await expect(active.runJob('other', new ActionGuard(), async () => await active.read({}, opened.tab))).rejects.toThrow('not owned')
    warnings.length = 0
    const outcome = await job(async () => await active.click({ selector: '#popup' }, opened.tab))
    await vi.waitFor(() => expect(warnings.join('\n')).toContain('navigation_refused: mail.google.com'))
    expect(outcome.popups).toBeUndefined()
    expect(await job(async () => await active.listTabs())).toEqual([expect.objectContaining({ id: opened.tab, title: 'Unlisted employer' })])
    const context = await active.ensure()
    await vi.waitFor(() => expect(context.pages().some(page => page.url().includes('/private'))).toBe(false))
    expect((await job(async () => await active.read({}, opened.tab))).text).not.toContain('synthetic private mail')
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    rmSync(root, { force: true, recursive: true })
  }
}, 25_000)
