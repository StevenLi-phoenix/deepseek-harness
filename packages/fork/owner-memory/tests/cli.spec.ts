import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAdminCli, runImportCli } from '../src/cli.ts'
import { readAll } from '../src/cli-io.ts'
import { MemoryStore } from '../src/store.ts'

const dirs: string[] = []

const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')
const argvBefore = process.argv

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.argv = argvBefore
  if (stdinDescriptor !== undefined) Object.defineProperty(process, 'stdin', stdinDescriptor)
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

const EXPORT = '## 1. Instructions\n[2026-10-20] - secret-free rule\n## 4. Projects\n[2026-10-21] - private project detail\n'

async function run(argv: string[], stdin = EXPORT) {
  const dir = await mkdtemp(join(tmpdir(), 'owner-memory-cli-'))
  dirs.push(dir)
  const out: string[] = []
  const err: string[] = []
  const code = await runImportCli({
    argv,
    env: { DSH_HOME: dir },
    stdin: (async function * () { yield stdin })(),
    stdout: line => out.push(line),
    stderr: line => err.push(line),
  })
  return { code, out, err, store: new MemoryStore(join(dir, 'owner-memory', 'memory.jsonl')), dir }
}

describe('memory-import', () => {
  it('imports stdin into <DSH_HOME>/owner-memory and prints counts, never text', async () => {
    const { code, out, store } = await run([])
    expect(code).toBe(0)
    expect(out[0]).toBe('memory-import: 2 entries in the export (instructions 1, preferences 0, identity 0, career 0, projects 1)')
    expect(out[1]).toMatch(/^memory-import: added 2, already present 0; .*memory\.jsonl holds 2$/u)
    expect(out.join('\n')).not.toContain('private project detail')
    expect((await store.list()).map(entry => entry.date)).toEqual(['2026-10-20', '2026-10-21'])
  })

  it('reads a file argument and writes nothing on --dry-run', async () => {
    const { dir } = await run(['--dry-run'])
    const source = join(dir, 'export.md')
    await writeFile(source, EXPORT)
    const { code, out, store } = await run(['--dry-run', source], '')
    expect(code).toBe(0)
    expect(out).toHaveLength(1)
    expect(await store.list()).toEqual([])
  })

  it('fails on an export without entries or with bad arguments', async () => {
    expect((await run([], 'nothing here')).code).toBe(1)
    expect((await run(['--bogus'])).code).toBe(2)
  })
})

describe('memory-admin', () => {
  async function admin(argv: string[], dir: string) {
    const out: string[] = []
    const err: string[] = []
    const code = await runAdminCli({ argv, env: { DSH_HOME: dir }, stdout: line => out.push(line), stderr: line => err.push(line) })
    return { code, out, err }
  }

  async function seeded() {
    const dir = await mkdtemp(join(tmpdir(), 'owner-memory-admin-'))
    dirs.push(dir)
    const store = new MemoryStore(join(dir, 'owner-memory', 'memory.jsonl'))
    const kept = (await store.save({ text: 'private rule text', category: 'instructions' }, { source: 'owner-turn', session: 'good' })).entry
    const planted = (await store.save({ text: 'planted secret text', category: 'identity' }, { source: 'tainted-turn', session: 'bad' })).entry
    const waiting = await store.savePending({ text: 'waiting private text', category: 'preferences' }, { source: 'tainted-turn', session: 'bad' })
    return { dir, store, kept, planted, waiting }
  }

  it('lists ids, categories, and sources, never text', async () => {
    const { dir, kept, planted, waiting } = await seeded()
    const { code, out } = await admin(['ids'], dir)
    expect(code).toBe(0)
    expect(out).toEqual([
      `${kept.id} instructions owner-turn`, `${planted.id} identity tainted-turn`, `${waiting.id} preferences pending-add`,
      'memory-admin: 2 entries, 1 waiting',
    ])
    expect(out.join('\n')).not.toContain('private')
  })

  it('lists recent changes newest first, with the text opening, to find the id of a notice', async () => {
    const { dir, kept, planted, waiting } = await seeded()
    const { code, out } = await admin(['recent', '--limit', '5'], dir)
    expect(code).toBe(0)
    expect(out[0]).toMatch(new RegExp(`^waiting add ${waiting.id} preferences tainted-turn .*waiting private text$`, 'u'))
    expect(out[1]).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+ add ${planted.id} identity tainted-turn .*planted secret text$`, 'u'))
    expect(out[2]).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+ add ${kept.id} instructions owner-turn .*private rule text$`, 'u'))
    expect(out).toHaveLength(3)
    expect((await admin(['recent', '--limit', '1'], dir)).out).toHaveLength(1)
  })

  it('shows one entry in full with its history', async () => {
    const { dir, kept } = await seeded()
    const { code, out } = await admin(['show', kept.id], dir)
    expect(code).toBe(0)
    expect(out[0]).toBe(`${kept.id} instructions owner-turn ${kept.date}`)
    expect(out[1]).toBe('private rule text')
    expect(out.slice(2).join('\n')).toMatch(/add owner-turn/u)
    expect((await admin(['show', 'ffffff'], dir)).code).toBe(1)
    expect((await admin(['show'], dir)).code).toBe(2)
  })

  it('approves, discards, and reverts by id', async () => {
    const { dir, store, planted, waiting } = await seeded()
    expect((await admin(['approve', waiting.id], dir)).code).toBe(0)
    expect((await store.list()).map(entry => entry.id)).toContain(waiting.id)
    expect((await admin(['revert', planted.id], dir)).out).toEqual([`memory-admin: revert ${planted.id} done`])
    expect((await store.list()).map(entry => entry.id)).not.toContain(planted.id)
    expect((await admin(['discard', 'ffffff'], dir)).code).toBe(1)
  })

  it('stamps the history of what it does with its own origin, so a review shows who undid what', async () => {
    const { dir, store, planted } = await seeded()
    await admin(['revert', planted.id], dir)
    const record = (await store.history()).at(-1)!
    expect(record).toMatchObject({ op: 'revert', id: planted.id, origin: 'memory-admin' })
  })

  it('rolls back a Session and erases an entry with every trace', async () => {
    const { dir, store, kept, planted } = await seeded()
    const dry = await admin(['rollback', '--session', 'bad', '--dry-run'], dir)
    expect(dry.out[0]).toBe(`memory-admin: rollback (dry run): 1 change(s) matched, 0 restored, 1 removed; ids ${planted.id}`)
    expect(await store.list()).toHaveLength(2)
    expect((await admin(['rollback', '--session', 'bad'], dir)).out[0]).toContain('1 removed')
    expect((await store.list()).map(entry => entry.id)).toEqual([kept.id])
    const purged = await admin(['forget', '--purge', kept.id], dir)
    expect(purged.out[0]).toMatch(/^memory-admin: purged .*: 1 entry, \d+ history, \d+ snapshot, 0 waiting$/u)
    expect(await store.list()).toEqual([])
  })

  it('mutes the safety notices for 30 minutes, reports the state, and unmutes', async () => {
    const { dir } = await seeded()
    expect((await admin(['notices', 'status'], dir)).out).toEqual(['memory-admin: safety notices are on'])
    expect((await admin(['notices', 'mute'], dir)).out).toEqual(['memory-admin: safety notices muted for 30 minutes (run `notices mute` again to extend, `notices unmute` to end)'])
    expect((await stat(join(dir, 'notices.muted'))).isFile()).toBe(true)
    expect((await admin(['notices', 'status'], dir)).out[0]).toMatch(/^memory-admin: safety notices are muted, \d+ minutes left$/u)
    expect((await admin(['notices', 'unmute'], dir)).out).toEqual(['memory-admin: safety notices are on'])
    expect((await admin(['notices', 'unmute'], dir)).code).toBe(0)
    expect((await admin(['notices'], dir)).code).toBe(2)
  })

  it('refuses bad arguments', async () => {
    const { dir } = await seeded()
    expect((await admin([], dir)).code).toBe(2)
    expect((await admin(['rollback'], dir)).code).toBe(2)
    expect((await admin(['forget', 'abcdef'], dir)).code).toBe(2)
    expect((await admin(['approve'], dir)).code).toBe(2)
    expect((await admin(['--bogus'], dir)).code).toBe(2)
  })
})

describe('process defaults', () => {
  function captured(): { out: string[]; err: string[] } {
    const out: string[] = []
    const err: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err.push(String(chunk)); return true })
    return { out, err }
  }

  function stdinOf(text: string): void {
    Object.defineProperty(process, 'stdin', { value: (async function * () { yield text })(), configurable: true })
  }

  it('reads Buffer chunks as well as strings when reading a stream to its end', async () => {
    expect(await readAll((async function * () { yield Buffer.from('né'); yield 'w' })())).toBe('néw')
  })

  it('writes to the process streams, reads process.argv and process.stdin when no streams are injected', async () => {
    const { out, err } = captured()
    const dir = await mkdtemp(join(tmpdir(), 'owner-memory-cli-'))
    dirs.push(dir)
    process.argv = ['node', 'memory-import', '--dry-run']
    stdinOf(EXPORT)
    expect(await runImportCli({ env: { DSH_HOME: dir } })).toBe(0)
    expect(out).toEqual(['memory-import: 2 entries in the export (instructions 1, preferences 0, identity 0, career 0, projects 1)\n'])
    process.argv = ['node', 'memory-import', '--bogus']
    expect(await runImportCli({ env: { DSH_HOME: dir } })).toBe(2)
    expect(err.join('')).toMatch(/^usage: memory-import/u)
    process.argv = ['node', 'memory-admin', 'ids']
    expect(await runAdminCli({ env: { DSH_HOME: dir } })).toBe(0)
    expect(out.at(-1)).toBe('memory-admin: 0 entries, 0 waiting\n')
    process.argv = ['node', 'memory-admin']
    expect(await runAdminCli({ env: { DSH_HOME: dir } })).toBe(2)
  })

  it('reads the memory-admin notices mute file under the process DSH_HOME when no env is injected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owner-memory-cli-'))
    dirs.push(dir)
    vi.stubEnv('DSH_HOME', dir)
    const out: string[] = []
    expect(await runAdminCli({ argv: ['notices', 'mute'], stdout: line => out.push(line), stderr: line => out.push(line) })).toBe(0)
    expect((await stat(join(dir, 'notices.muted'))).isFile()).toBe(true)
  })
})

describe('memory-import options and faults', () => {
  it('writes to the file named by --file, and refuses --file without a value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owner-memory-cli-'))
    dirs.push(dir)
    const file = join(dir, 'custom', 'memory.jsonl')
    const out: string[] = []
    const err: string[] = []
    const io = {
      stdin: (async function * () { yield EXPORT })(),
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    }
    expect(await runImportCli({ ...io, argv: ['--file', file] })).toBe(0)
    expect((await new MemoryStore(file).list()).map(entry => entry.date)).toEqual(['2026-10-20', '2026-10-21'])
    expect(await runImportCli({ ...io, argv: ['--file'] })).toBe(2)
    expect(err).toHaveLength(1)
  })

  it('reports an export file that cannot be read, and a stream that fails with something that is not an Error', async () => {
    const err: string[] = []
    const dir = await mkdtemp(join(tmpdir(), 'owner-memory-cli-'))
    dirs.push(dir)
    const io = { env: { DSH_HOME: dir }, stdout: () => {}, stderr: (line: string) => err.push(line) }
    expect(await runImportCli({ ...io, argv: [join(dir, 'missing.md')] })).toBe(1)
    expect(err[0]).toMatch(/^memory-import: ENOENT/u)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the case under test.
    const failing: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject('stream broke') }) }
    expect(await runImportCli({ ...io, argv: [], stdin: failing })).toBe(1)
    expect(err[1]).toBe('memory-import: stream broke')
  })
})

describe('memory-admin output and faults', () => {
  async function admin(argv: string[], dir: string, extra: { stdin?: string; file?: string } = {}) {
    const out: string[] = []
    const err: string[] = []
    const code = await runAdminCli({
      argv: extra.file === undefined ? argv : [...argv, '--file', extra.file],
      env: { DSH_HOME: dir },
      ...extra.stdin === undefined ? {} : { stdin: (async function * () { yield extra.stdin as string })() },
      stdout: line => out.push(line),
      stderr: line => err.push(line),
    })
    return { code, out, err }
  }

  async function home(): Promise<{ dir: string; store: MemoryStore }> {
    const dir = await mkdtemp(join(tmpdir(), 'owner-memory-admin-'))
    dirs.push(dir)
    return { dir, store: new MemoryStore(join(dir, 'owner-memory', 'memory.jsonl')) }
  }

  it('cuts a long text in `recent` to its opening and shows legacy placeholders for a record without meta', async () => {
    const { dir, store } = await home()
    const long = `${'word '.repeat(30)}end`
    const saved = (await store.save({ text: long, category: 'identity' })).entry
    await store.forget(saved.id)
    await writeFile(store.historyFile, `${await readFile(store.historyFile, 'utf8')}${JSON.stringify({ at: '2026-10-23T00:00:00.000Z', op: 'forget', id: 'ffffff', sha: 'x' })}\n`)
    const waiting = await store.savePending({ text: 'waits', category: 'career' })
    const { out } = await admin(['recent', '--limit', '10'], dir)
    expect(out[0]).toBe(`waiting add ${waiting.id} career legacy ${waiting.date} waits`)
    expect(out[1]).toBe('2026-10-23T00:00:00.000Z forget ffffff - legacy - ')
    expect(out[2]).toMatch(new RegExp(`^\\S+ forget ${saved.id} identity legacy - word word word .*…$`, 'u'))
    expect(out[2]!.split(' - ')[1]).toHaveLength(61)
  })

  it('shows a waiting write marked as waiting, with a history line that has no meta', async () => {
    const { dir, store } = await home()
    const entry = (await store.save({ text: 'plain', category: 'identity' })).entry
    const waiting = await store.savePending({ text: 'later', category: 'career' })
    const shown = await admin(['show', waiting.id], dir)
    expect(shown.out).toEqual([`${waiting.id} career legacy ${waiting.date} (waiting)`, 'later'])
    const full = await admin(['show', entry.id], dir)
    expect(full.out[0]).toBe(`${entry.id} identity legacy ${entry.date}`)
    expect(full.out[2]).toMatch(/^\S+ add legacy - session -$/u)
  })

  it('rolls back by time alone, by Session and time, and says so when nothing matched', async () => {
    const { dir, store } = await home()
    await store.save({ text: 'by a session', category: 'identity' }, { session: 's1' })
    const since = await admin(['rollback', '--since', '2000-01-01T00:00:00Z', '--dry-run'], dir)
    expect(since.out[0]).toMatch(/^memory-admin: rollback \(dry run\): 1 change\(s\) matched, 0 restored, 1 removed; ids [0-9a-f]{6}$/u)
    const both = await admin(['rollback', '--session', 's1', '--since', '2000-01-01T00:00:00Z'], dir)
    expect(both.out[0]).toContain('1 removed')
    const none = await admin(['rollback', '--session', 'nobody'], dir)
    expect(none.out).toEqual(['memory-admin: rollback: 0 change(s) matched, 0 restored, 0 removed; ids -'])
  })

  it('refuses a feedback list scope it does not know, and a feedback payload that is not an object', async () => {
    const { dir } = await home()
    expect((await admin(['feedback', 'list', '--scope', 'main'], dir)).code).toBe(2)
    const scalar = await admin(['feedback', 'add'], dir, { stdin: '42' })
    expect(scalar.code).toBe(1)
    expect(scalar.err).toEqual(['memory-admin: feedback add needs one JSON object on stdin'])
    const nothing = await admin(['feedback', 'add'], dir, { stdin: 'null' })
    expect(nothing.code).toBe(1)
  })

  it('keeps feedback beside the --file memory file, and reads feedback JSON from process.stdin by default', async () => {
    const { dir } = await home()
    const file = join(dir, 'elsewhere', 'memory.jsonl')
    await mkdir(join(dir, 'elsewhere'))
    const payload = JSON.stringify({ scope: 'up', verdict: 'keep', kind: 'comment', text: 'nice', ref: 'r9' })
    Object.defineProperty(process, 'stdin', { value: (async function * () { yield payload })(), configurable: true })
    const out: string[] = []
    expect(await runAdminCli({ argv: ['feedback', 'add', '--file', file], env: { DSH_HOME: dir }, stdout: line => out.push(line), stderr: () => {} })).toBe(0)
    expect((await readFile(join(dir, 'elsewhere', 'feedback.jsonl'), 'utf8'))).toContain('nice')
    expect((await admin(['feedback', 'list'], dir, { file })).out).toHaveLength(1)
  })

  it('reports a failure that is not an Error with its text', async () => {
    const { dir } = await home()
    const code = await runAdminCli({ argv: ['ids'], env: { DSH_HOME: dir }, stdout: () => { throw 'pipe broke' }, stderr: () => {} })
    expect(code).toBe(1)
    const err: string[] = []
    await mkdir(join(dir, 'owner-memory', 'memory.jsonl'), { recursive: true })
    expect(await runAdminCli({ argv: ['ids'], env: { DSH_HOME: dir }, stdout: () => {}, stderr: line => err.push(line) })).toBe(1)
    expect(err[0]).toMatch(/^memory-admin: EISDIR/u)
  })
})
