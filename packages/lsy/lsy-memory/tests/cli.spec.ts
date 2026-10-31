import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAdminCli, runImportCli } from '../src/cli.ts'
import { MemoryStore } from '../src/store.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

const EXPORT = '## 1. Instructions\n[2026-10-20] - secret-free rule\n## 4. Projects\n[2026-10-21] - private project detail\n'

async function run(argv: string[], stdin = EXPORT) {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-memory-cli-'))
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
  return { code, out, err, store: new MemoryStore(join(dir, 'lsy-memory', 'memory.jsonl')), dir }
}

describe('memory-import', () => {
  it('imports stdin into <DSH_HOME>/lsy-memory and prints counts, never text', async () => {
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
    const dir = await mkdtemp(join(tmpdir(), 'lsy-memory-admin-'))
    dirs.push(dir)
    const store = new MemoryStore(join(dir, 'lsy-memory', 'memory.jsonl'))
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
