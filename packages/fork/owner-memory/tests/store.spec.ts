import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultMemoryFile, localDate, MAX_ENTRIES, MemoryError, MemoryStore } from '../src/store.ts'

const dirs: string[] = []

async function store(today = '2026-10-23'): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), 'owner-memory-'))
  dirs.push(dir)
  return new MemoryStore(join(dir, 'nested', 'memory.jsonl'), () => today)
}

async function refused(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(MemoryError)
  return (error as MemoryError).code
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

describe('MemoryStore', () => {
  it('reads a missing file as empty and creates it private on the first save', async () => {
    const memory = await store()
    expect(await memory.list()).toEqual([])
    const { entry, outcome } = await memory.save({ text: '  likes   dry\nhumor ', category: 'preferences' })
    expect(outcome).toBe('added')
    expect(entry).toMatchObject({ category: 'preferences', date: '2026-10-23', text: 'likes dry humor' })
    expect(entry.id).toMatch(/^[0-9a-f]{6}$/u)
    expect(await memory.list()).toEqual([entry])
    expect((await stat(memory.file)).mode & 0o777).toBe(0o600)
    expect(await readFile(memory.file, 'utf8')).toBe(`${JSON.stringify(entry)}\n`)
  })

  it('returns the existing entry instead of saving the same fact twice', async () => {
    const memory = await store()
    const first = await memory.save({ text: 'Uses pnpm', category: 'instructions' })
    const second = await memory.save({ text: 'Uses  pnpm', category: 'instructions' })
    expect(second).toEqual({ entry: first.entry, outcome: 'unchanged' })
    expect(await memory.list()).toHaveLength(1)
  })

  it('replaces an entry in place, restamping its date', async () => {
    const memory = await store()
    const kept = (await memory.save({ text: 'first', category: 'identity' })).entry
    const changed = (await memory.save({ text: 'second', category: 'identity' })).entry
    const later = new MemoryStore(memory.file, () => '2026-11-01')
    const result = await later.save({ id: kept.id, text: 'first, corrected', category: 'career' })
    expect(result).toEqual({ outcome: 'replaced', entry: { id: kept.id, category: 'career', date: '2026-11-01', text: 'first, corrected' } })
    expect((await memory.list()).map(entry => entry.id)).toEqual([kept.id, changed.id])
  })

  it('forgets by id and refuses unknown or malformed ids', async () => {
    const memory = await store()
    const entry = (await memory.save({ text: 'temporary', category: 'projects' })).entry
    expect(await memory.forget(entry.id)).toEqual(entry)
    expect(await memory.list()).toEqual([])
    expect(await refused(memory.forget(entry.id))).toBe('not_found')
    expect(await refused(memory.forget('../etc'))).toBe('invalid_id')
    expect(await refused(memory.save({ id: 'zzzzzz', text: 'x', category: 'projects' }))).toBe('invalid_id')
  })

  it('validates text and category before touching the file', async () => {
    const memory = await store()
    expect(await refused(memory.save({ text: ' \n ', category: 'identity' }))).toBe('invalid_text')
    expect(await refused(memory.save({ text: 42, category: 'identity' }))).toBe('invalid_text')
    expect(await refused(memory.save({ text: 'x'.repeat(2001), category: 'identity' }))).toBe('invalid_text')
    expect(await refused(memory.save({ text: 'ok', category: 'secrets' }))).toBe('invalid_category')
    await expect(stat(memory.file)).rejects.toThrow()
  })

  it('keeps every write when Sessions save concurrently', async () => {
    const memory = await store()
    const other = new MemoryStore(memory.file, () => '2026-10-23')
    await Promise.all(Array.from({ length: 20 }, async (_, index) =>
      await (index % 2 === 0 ? memory : other).save({ text: `fact ${String(index)}`, category: 'projects' })))
    const entries = await memory.list()
    expect(entries).toHaveLength(20)
    expect(new Set(entries.map(entry => entry.id)).size).toBe(20)
  })

  it('refuses to rewrite a file with a line it cannot read', async () => {
    const memory = await store()
    await memory.save({ text: 'kept', category: 'identity' })
    await writeFile(memory.file, `${await readFile(memory.file, 'utf8')}not json\n`)
    expect(await refused(memory.list())).toBe('corrupt')
    expect(await refused(memory.save({ text: 'new', category: 'identity' }))).toBe('corrupt')
    expect(await readFile(memory.file, 'utf8')).toContain('not json')
  })

  it('stops adding at the entry cap', async () => {
    const memory = await store()
    await memory.importDrafts(Array.from({ length: MAX_ENTRIES }, (_, index) => ({ category: 'projects' as const, date: '2026-01-01', text: `p${String(index)}` })))
    expect(await refused(memory.save({ text: 'one more', category: 'projects' }))).toBe('full')
  })

  it('imports drafts with their dates and skips ones already present', async () => {
    const memory = await store()
    await memory.save({ text: 'already here', category: 'career' })
    const result = await memory.importDrafts([
      { category: 'career', date: '2026-09-01', text: 'already here' },
      { category: 'identity', date: '2026-09-02', text: 'new fact' },
    ])
    expect(result).toEqual({ added: 1, duplicates: 1 })
    expect((await memory.list()).at(-1)).toMatchObject({ category: 'identity', date: '2026-09-02', text: 'new fact' })
    expect(await memory.importDrafts([{ category: 'identity', date: '2026-09-02', text: 'new fact' }])).toEqual({ added: 0, duplicates: 1 })
  })

  it('searches any term case-insensitively, most terms first, then newest', async () => {
    const memory = await store()
    await memory.importDrafts([
      { category: 'identity', date: '2026-01-01', text: 'Roommate is Lin Kehan' },
      { category: 'identity', date: '2026-05-01', text: 'Lease renewal with 室友 pending' },
      { category: 'projects', date: '2026-03-01', text: 'Roomly rental app with roommate matching and lease compare' },
      { category: 'career', date: '2026-02-01', text: 'Bank internship' },
    ])
    const hits = await memory.search('ROOMMATE lease', { limit: 10 })
    expect(hits.entries.map(entry => entry.text)).toEqual([
      'Roomly rental app with roommate matching and lease compare',
      'Lease renewal with 室友 pending',
      'Roommate is Lin Kehan',
    ])
    expect((await memory.search('室友', { limit: 10 })).entries).toHaveLength(1)
    const scoped = await memory.search('', { category: 'identity', limit: 1 })
    expect(scoped).toEqual({ entries: [expect.objectContaining({ date: '2026-05-01' })], more: 1 })
    const [first] = await memory.list()
    expect((await memory.search(first?.id ?? '', { limit: 5 })).entries).toEqual([first])
  })
})

describe('MemoryStore.merge', () => {
  async function three(): Promise<{ memory: MemoryStore; short: string; long: string; other: string }> {
    const memory = await store()
    const short = (await memory.save({ text: 'Thesis is on RL', category: 'projects' })).entry
    const long = (await memory.save({ text: 'Thesis is on offline RL for robot grasping', category: 'projects' })).entry
    const other = (await memory.save({ text: 'Likes dry humor', category: 'preferences' })).entry
    return { memory, short: short.id, long: long.id, other: other.id }
  }

  it('keeps the longest entry under the merged text and removes the others, leaving unrelated entries alone', async () => {
    const { memory, short, long, other } = await three()
    const { entry, removed } = await memory.merge({ ids: [short, long], text: 'Thesis: offline RL', category: 'projects' })
    expect(entry).toMatchObject({ id: long, text: 'Thesis: offline RL', category: 'projects' })
    expect(removed.map(item => item.id)).toEqual([short])
    expect((await memory.list()).map(item => item.id).toSorted()).toEqual([long, other].toSorted())
  })

  it('keeps the entry it is told to keep, and the longest when that id is not among the merged ones', async () => {
    const { memory, short, long } = await three()
    const chosen = await memory.merge({ ids: [short, long], text: 'Thesis on RL', category: 'projects', keep: short })
    expect(chosen.entry.id).toBe(short)
    expect(chosen.removed.map(item => item.id)).toEqual([long])
    const again = await three()
    const fallback = await again.memory.merge({ ids: [again.short, again.long], text: 'Thesis on RL', category: 'projects', keep: again.other })
    expect(fallback.entry.id).toBe(again.long)
  })

  it('keeps the first of equally long entries', async () => {
    const memory = await store()
    const first = (await memory.save({ text: 'alpha one', category: 'projects' })).entry
    const second = (await memory.save({ text: 'alpha two', category: 'projects' })).entry
    const { entry } = await memory.merge({ ids: [first.id, second.id], text: 'alpha', category: 'projects' })
    expect(entry.id).toBe(first.id)
  })

  it('refuses ids that are not a list, fewer than two distinct ones, or not entry ids', async () => {
    const { memory, short } = await three()
    expect(await refused(memory.merge({ ids: short, text: 'x', category: 'projects' }))).toBe('invalid_id')
    expect(await refused(memory.merge({ ids: [short, short], text: 'x', category: 'projects' }))).toBe('invalid_id')
    expect(await refused(memory.merge({ ids: [short, 'not-an-id'], text: 'x', category: 'projects' }))).toBe('invalid_id')
    expect(await memory.list()).toHaveLength(3)
  })

  it('refuses an id with no entry, and a merge the expectation rejects, writing nothing', async () => {
    const { memory, short, long } = await three()
    expect(await refused(memory.merge({ ids: [short, 'ffffff'], text: 'x', category: 'projects' }))).toBe('not_found')
    expect(await refused(memory.merge({ ids: [short, long], text: 'x', category: 'projects' }, undefined, { expect: () => false }))).toBe('stale_preview')
    expect(await memory.list()).toHaveLength(3)
  })
})

describe('paths and dates', () => {
  it('defaults to <DSH_HOME>/owner-memory/memory.jsonl', () => {
    expect(defaultMemoryFile({ DSH_HOME: '/srv/dsh' })).toBe('/srv/dsh/owner-memory/memory.jsonl')
  })

  it('stamps the local calendar date', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})
