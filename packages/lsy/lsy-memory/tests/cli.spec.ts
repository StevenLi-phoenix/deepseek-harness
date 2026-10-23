import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runImportCli } from '../src/cli.ts'
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
