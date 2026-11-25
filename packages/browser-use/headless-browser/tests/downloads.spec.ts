/**
 * Keeping downloads: the file name a site suggests cannot leave the download
 * directory, a finished file lands owner-only under a unique name, a file over
 * the cap or a failed download is reported instead of kept, old files age out,
 * and the profile's own preferences say PDFs download and nothing prompts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_TIMEOUT_MS, DownloadStore, ensureDownloadPrefs, isDownloadStarting, plainUrl, safeFileName, type DownloadLike } from '../src/downloads.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-downloads-'))
  roots.push(root)
  return root
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
}

/** A Playwright download whose file already sits at `temp`. */
interface FakeOptions {
  name?: string
  url?: string
  bytes?: number
  path?: string | null
  failure?: string
  /** The browser never finishes the file, and refuses the cancel. */
  stalled?: boolean
  /** Deleting the browser's own copy fails, as it does after the browser closed. */
  deleteFails?: boolean
}

function fakeDownload(root: string, options: FakeOptions = {}): DownloadLike & { deleted: boolean; cancelled: boolean } {
  const temp = join(root, `temp-${String(Math.random()).slice(2)}`)
  writeFileSync(temp, Buffer.alloc(options.bytes ?? 5, 'x'))
  const state = { deleted: false, cancelled: false }
  return {
    get deleted() { return state.deleted },
    get cancelled() { return state.cancelled },
    url: () => options.url ?? 'https://example.com/files/a.pdf?token=secret',
    suggestedFilename: () => options.name ?? 'a.pdf',
    path: async () => {
      if (options.stalled === true) return await new Promise<never>(() => {})
      return options.path === undefined ? temp : options.path
    },
    saveAs: async (dest: string) => { writeFileSync(dest, readFileSync(temp)) },
    delete: async () => {
      state.deleted = true
      if (options.deleteFails === true) throw new Error('Target page, context or browser has been closed')
    },
    cancel: async () => {
      state.cancelled = true
      if (options.stalled === true) throw new Error('the download is gone')
    },
    failure: async () => options.failure ?? null,
  }
}

/** A page that lets a test fire its download listeners. */
function fakePage() {
  type Listener = (...args: never[]) => void
  const listeners = new Set<Listener>()
  return {
    listeners,
    on: (_event: string, listener: Listener) => { listeners.add(listener) },
    off: (_event: string, listener: Listener) => { listeners.delete(listener) },
    fire(download: DownloadLike) { for (const listener of listeners) (listener as (download: DownloadLike) => void)(download) },
  }
}

function store(root: string, overrides: Partial<ConstructorParameters<typeof DownloadStore>[0]> = {}) {
  return new DownloadStore({ dir: join(root, 'kept'), maxBytes: 1024, retainMs: 0, log: logger(), ...overrides })
}

describe('safeFileName', () => {
  it('keeps one path segment with no leading dot, control character, or separator', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('..\\..\\evil.exe')).toBe('evil.exe')
    expect(safeFileName('.hidden')).toBe('hidden')
    expect(safeFileName('a\u0000b\nc.pdf')).toBe('a_b_c.pdf')
    expect(safeFileName('作业 1.pdf')).toBe('作业 1.pdf')
    expect(safeFileName('')).toBe('download')
    expect(safeFileName('///')).toBe('download')
  })

  it('cuts a long name but keeps the extension', () => {
    const name = safeFileName(`${'a'.repeat(300)}.pdf`)
    expect(name.length).toBeLessThanOrEqual(120)
    expect(name.endsWith('.pdf')).toBe(true)
  })

  it('cuts a long name without an extension, or with one too long to be one, to the length limit', () => {
    expect(safeFileName('a'.repeat(300))).toBe('a'.repeat(120))
    const name = safeFileName(`${'a'.repeat(200)}.${'b'.repeat(20)}`)
    expect(name).toHaveLength(120)
    expect(name).toBe('a'.repeat(120))
  })

  it('keeps the segment after the last separator even when the name spans lines', () => {
    expect(safeFileName('reports\nq3/summary.pdf')).toBe('summary.pdf')
    expect(safeFileName('a\\b/c\\d.txt')).toBe('d.txt')
  })
})

describe('plainUrl and isDownloadStarting', () => {
  it('drops the query and fragment, which carry signed tokens', () => {
    expect(plainUrl('https://example.com/a/b.pdf?token=secret#x')).toBe('https://example.com/a/b.pdf')
    expect(plainUrl('not a url')).toBe('unparseable-url')
  })

  it('recognises the navigation error of a download', () => {
    expect(isDownloadStarting('page.goto: Download is starting')).toBe(true)
    expect(isDownloadStarting('page.goto: net::ERR_NAME_NOT_RESOLVED')).toBe(false)
  })
})

describe('DownloadStore', () => {
  it('copies a finished download into the directory, owner-only, and reports it', async () => {
    const root = tempRoot()
    const kept = store(root)
    const page = fakePage()
    kept.attach(page)
    const download = fakeDownload(root, { name: '../x.pdf', bytes: 40 })
    const mark = kept.mark()
    page.fire(download)
    const [record] = await kept.since(mark, 0)
    expect(record).toMatchObject({ seq: 1, filename: 'x.pdf', bytes: 40, url: 'https://example.com/files/a.pdf' })
    expect(record?.path?.startsWith(join(root, 'kept'))).toBe(true)
    expect(record?.path?.endsWith('-x.pdf')).toBe(true)
    expect(statSync(record!.path!).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'kept')).mode & 0o777).toBe(0o700)
    expect(download.deleted).toBe(true)
    expect(await kept.recent(10, 0)).toHaveLength(1)
  })

  it('waits for a download that starts inside the wait, and returns nothing when none does', async () => {
    const root = tempRoot()
    const kept = store(root)
    const page = fakePage()
    kept.attach(page)
    expect(await kept.since(kept.mark(), 30)).toEqual([])
    const mark = kept.mark()
    const pending = kept.since(mark, 2_000)
    page.fire(fakeDownload(root))
    expect(await pending).toHaveLength(1)
  })

  it('reports a file over the cap as failed and deletes it', async () => {
    const root = tempRoot()
    const kept = store(root, { maxBytes: 10 })
    const page = fakePage()
    kept.attach(page)
    const download = fakeDownload(root, { bytes: 11 })
    const mark = kept.mark()
    page.fire(download)
    const [record] = await kept.since(mark, 0)
    expect(record?.path).toBeUndefined()
    expect(record?.error).toContain('over the 10-byte limit')
    expect(download.deleted).toBe(true)
    expect(existsSync(join(root, 'kept'))).toBe(false)
  })

  it('reports a download the browser could not finish', async () => {
    const root = tempRoot()
    const kept = store(root)
    const page = fakePage()
    kept.attach(page)
    const mark = kept.mark()
    page.fire(fakeDownload(root, { path: null, failure: 'canceled' }))
    expect((await kept.since(mark, 0))[0]).toMatchObject({ error: 'canceled' })
  })

  it('waits for the next download when none is in flight, and lists nothing when none starts', async () => {
    const root = tempRoot()
    const kept = store(root)
    const page = fakePage()
    kept.attach(page)
    expect(await kept.recent(10, 30)).toEqual([])
    const pending = kept.recent(10, 2_000)
    page.fire(fakeDownload(root, { name: 'late.pdf' }))
    expect((await pending).map(record => record.filename)).toEqual(['late.pdf'])
  })

  it('remembers only the newest fifty downloads', async () => {
    const root = tempRoot()
    const kept = store(root)
    const page = fakePage()
    kept.attach(page)
    for (let index = 1; index <= 51; index += 1) {
      const mark = kept.mark()
      page.fire(fakeDownload(root, { name: `f${String(index)}.pdf` }))
      await kept.since(mark, 0)
    }
    const records = await kept.recent(100, 0)
    expect(records).toHaveLength(50)
    expect(records[0]?.filename).toBe('f2.pdf')
    expect(records.at(-1)?.filename).toBe('f51.pdf')
  })

  it('keeps a file and reports an oversized one even when the browser cannot delete its own copy', async () => {
    const root = tempRoot()
    const kept = store(root, { maxBytes: 10 })
    const page = fakePage()
    kept.attach(page)
    const mark = kept.mark()
    page.fire(fakeDownload(root, { bytes: 4, deleteFails: true }))
    page.fire(fakeDownload(root, { bytes: 11, deleteFails: true }))
    const records = await kept.since(mark, 0)
    const small = records.find(record => record.seq === 1)
    expect(small?.bytes).toBe(4)
    expect(existsSync(small!.path!)).toBe(true)
    expect(records.find(record => record.seq === 2)?.error).toContain('over the 10-byte limit')
  })

  it('cancels a download that does not finish in time and reports it as failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const root = tempRoot()
      const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
      const kept = new DownloadStore({ dir: join(root, 'kept'), maxBytes: 1024, retainMs: 0, log })
      const page = fakePage()
      kept.attach(page)
      const download = fakeDownload(root, { stalled: true })
      const mark = kept.mark()
      page.fire(download)
      const pending = kept.since(mark, 0)
      await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS)
      const [record] = await pending
      expect(record?.error).toBe(`the download did not finish within ${String(DOWNLOAD_TIMEOUT_MS / 1000)}s and was cancelled`)
      expect(download.cancelled).toBe(true)
      expect(log.warn).toHaveBeenCalledWith('headless-browser: download #%d from %s failed: %s', 1, 'https://example.com/files/a.pdf', record?.error)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a download the browser dropped without saying why', async () => {
    const root = tempRoot()
    const kept = store(root)
    const page = fakePage()
    kept.attach(page)
    const mark = kept.mark()
    page.fire(fakeDownload(root, { path: null }))
    expect((await kept.since(mark, 0))[0]).toMatchObject({ error: 'the browser reported no file' })
  })

  it('stops listening when the tab lets the page go', () => {
    const kept = store(tempRoot())
    const page = fakePage()
    const detach = kept.attach(page)
    expect(page.listeners.size).toBe(1)
    detach()
    expect(page.listeners.size).toBe(0)
  })

  it('removes files older than the retention and keeps newer ones', async () => {
    const root = tempRoot()
    const dir = join(root, 'kept')
    mkdirSync(dir)
    const old = join(dir, 'old.pdf')
    const fresh = join(dir, 'fresh.pdf')
    writeFileSync(old, 'x')
    writeFileSync(fresh, 'x')
    const longAgo = new Date(Date.now() - 10 * 86_400_000)
    utimesSync(old, longAgo, longAgo)
    const kept = store(root, { retainMs: 7 * 86_400_000 })
    const page = fakePage()
    kept.attach(page)
    const mark = kept.mark()
    page.fire(fakeDownload(root))
    await kept.since(mark, 0)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('saves the first download into a directory that pruning finds missing', async () => {
    const root = tempRoot()
    const kept = store(root, { retainMs: 7 * 86_400_000 })
    const page = fakePage()
    kept.attach(page)
    const mark = kept.mark()
    page.fire(fakeDownload(root))
    const [record] = await kept.since(mark, 0)
    expect(record?.path?.startsWith(join(root, 'kept'))).toBe(true)
  })

  it('logs an entry it cannot read while pruning and keeps the download', async () => {
    const root = tempRoot()
    const dir = join(root, 'kept')
    mkdirSync(dir)
    const broken = join(dir, 'broken.pdf')
    symlinkSync(join(dir, 'nowhere'), broken)
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
    const kept = new DownloadStore({ dir, maxBytes: 1024, retainMs: 7 * 86_400_000, log })
    const page = fakePage()
    kept.attach(page)
    const mark = kept.mark()
    page.fire(fakeDownload(root))
    const [record] = await kept.since(mark, 0)
    expect(record?.path).toBeDefined()
    expect(log.warn).toHaveBeenCalledWith('headless-browser: pruning %s failed: %s', broken, expect.stringContaining('ENOENT'))
    expect(log.info).not.toHaveBeenCalledWith('headless-browser: removed %d downloads older than %d days', expect.anything(), expect.anything())
  })
})

describe('ensureDownloadPrefs', () => {
  it('creates the preferences of a new profile and leaves other settings of an old one', async () => {
    const root = tempRoot()
    expect(await ensureDownloadPrefs(root, true, logger())).toBe(true)
    const path = join(root, 'Default', 'Preferences')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      download: { prompt_for_download: false },
      plugins: { always_open_pdf_externally: true },
    })
    writeFileSync(path, JSON.stringify({ intl: { selected_languages: 'en' }, download: { default_directory: '/x', prompt_for_download: true } }))
    expect(await ensureDownloadPrefs(root, true, logger())).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      intl: { selected_languages: 'en' },
      download: { default_directory: '/x', prompt_for_download: false },
      plugins: { always_open_pdf_externally: true },
    })
    expect(await ensureDownloadPrefs(root, true, logger())).toBe(false)
  })

  it('turns the PDF setting off when the config asks, and never overwrites a file that is not JSON', async () => {
    const root = tempRoot()
    await ensureDownloadPrefs(root, true, logger())
    expect(await ensureDownloadPrefs(root, false, logger())).toBe(true)
    const prefs = JSON.parse(readFileSync(join(root, 'Default', 'Preferences'), 'utf8')) as { plugins: { always_open_pdf_externally: boolean } }
    expect(prefs.plugins.always_open_pdf_externally).toBe(false)
    const broken = tempRoot()
    mkdirSync(join(broken, 'Default'))
    writeFileSync(join(broken, 'Default', 'Preferences'), '{not json')
    const log = logger()
    expect(await ensureDownloadPrefs(broken, true, log)).toBe(false)
    expect(readFileSync(join(broken, 'Default', 'Preferences'), 'utf8')).toBe('{not json')
  })

  it('never overwrites preferences that are JSON but not an object', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'Default'))
    writeFileSync(join(root, 'Default', 'Preferences'), '[1,2]')
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
    expect(await ensureDownloadPrefs(root, true, log)).toBe(false)
    expect(readFileSync(join(root, 'Default', 'Preferences'), 'utf8')).toBe('[1,2]')
    expect(log.warn).toHaveBeenCalledWith('headless-browser: leaving the profile preferences alone, they do not read as JSON: %s', 'not a JSON object')
  })
})
