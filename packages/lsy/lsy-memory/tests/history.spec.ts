import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryError, MemoryStore, MAX_PENDING, SNAPSHOTS_KEPT } from '../src/store.ts'

const dirs: string[] = []
let day = '2026-10-23'
let clock = Date.parse('2026-10-23T12:00:00Z')

async function store(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-memory-history-'))
  dirs.push(dir)
  day = '2026-10-23'
  clock = Date.parse('2026-10-23T12:00:00Z')
  return new MemoryStore(join(dir, 'memory.jsonl'), () => day, () => new Date(clock))
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(MemoryError)
  return (error as MemoryError).code
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

const meta = { source: 'owner-turn', session: 's1', origin: 'owner' } as const

describe('provenance', () => {
  it('stores where an entry came from, and reads an old line without it as legacy', async () => {
    const memory = await store()
    await writeFile(memory.file, `${JSON.stringify({ id: 'aaaaaa', category: 'instructions', date: '2026-10-01', text: 'old' })}\n`)
    const saved = (await memory.save({ text: 'new', category: 'instructions' }, meta)).entry
    expect(saved).toMatchObject({ source: 'owner-turn', session: 's1', origin: 'owner' })
    const [old, fresh] = await memory.list()
    expect(old).toEqual({ id: 'aaaaaa', category: 'instructions', date: '2026-10-01', text: 'old' })
    expect(fresh).toEqual(saved)
    expect((await memory.index()).entries.map(entry => entry.source)).toEqual(['legacy', 'owner-turn'])
  })

  it('reads a line whose provenance is malformed as an entry without it', async () => {
    const memory = await store()
    await writeFile(memory.file, `${JSON.stringify({ id: 'bbbbbb', category: 'projects', date: '2026-10-01', text: 't', source: 'martian', session: 7 })}\n`)
    expect(await memory.list()).toEqual([{ id: 'bbbbbb', category: 'projects', date: '2026-10-01', text: 't' }])
  })

  it('marks imported entries', async () => {
    const memory = await store()
    await memory.importDrafts([{ category: 'identity', date: '2026-01-01', text: 'from the export' }])
    expect((await memory.list())[0]).toMatchObject({ source: 'import' })
  })
})

describe('history', () => {
  it('records the full before and after of every change, privately, with the file hash', async () => {
    const memory = await store()
    const added = (await memory.save({ text: 'one', category: 'instructions' }, meta)).entry
    await memory.save({ id: added.id, text: 'two', category: 'instructions' }, { ...meta, session: 's2' })
    await memory.forget(added.id, { session: 's3' })
    const records = await memory.history()
    expect(records.map(record => record.op)).toEqual(['add', 'replace', 'forget'])
    expect(records[1]).toMatchObject({ id: added.id, before: { text: 'one' }, after: { text: 'two' }, session: 's2', source: 'owner-turn' })
    expect(records[2]).toMatchObject({ before: { text: 'two' }, session: 's3' })
    expect(records[2]!.after).toBeUndefined()
    expect(records[0]!.sha).toMatch(/^[0-9a-f]{64}$/u)
    expect((await stat(memory.historyFile)).mode & 0o777).toBe(0o600)
    expect(records[2]!.sha).toBe(await memory.sha())
  })

  it('skips a torn line instead of losing the history', async () => {
    const memory = await store()
    await memory.save({ text: 'one', category: 'projects' })
    await writeFile(memory.historyFile, `${await readFile(memory.historyFile, 'utf8')}{"torn\n`)
    expect(await memory.history()).toHaveLength(1)
  })

  it('records nothing for an unchanged save', async () => {
    const memory = await store()
    await memory.save({ text: 'one', category: 'projects' })
    await memory.save({ text: 'one', category: 'projects' })
    expect(await memory.history()).toHaveLength(1)
  })
})

describe('snapshots', () => {
  it('keeps the file as it stood before the first change of each day, and the latest thirty', async () => {
    const memory = await store()
    await memory.save({ text: 'first', category: 'projects' })
    expect(await readdir(memory.snapshotDir).catch(() => [])).toEqual([])
    await memory.save({ text: 'second', category: 'projects' })
    expect(await readdir(memory.snapshotDir)).toEqual(['memory-2026-10-23.jsonl'])
    expect(await readFile(join(memory.snapshotDir, 'memory-2026-10-23.jsonl'), 'utf8')).toContain('first')
    expect(await readFile(join(memory.snapshotDir, 'memory-2026-10-23.jsonl'), 'utf8')).not.toContain('second')
    await memory.save({ text: 'third', category: 'projects' })
    expect(await readFile(join(memory.snapshotDir, 'memory-2026-10-23.jsonl'), 'utf8')).not.toContain('second')
    for (let n = 1; n <= SNAPSHOTS_KEPT + 4; n += 1) {
      day = `2026-12-${String(n).padStart(2, '0')}`
      await memory.save({ text: `day ${String(n)}`, category: 'projects' })
    }
    const names = await readdir(memory.snapshotDir)
    expect(names).toHaveLength(SNAPSHOTS_KEPT)
    expect(names).not.toContain('memory-2026-10-23.jsonl')
    expect((await stat(join(memory.snapshotDir, names[0]!))).mode & 0o777).toBe(0o600)
  })
})

describe('waiting writes', () => {
  it('holds a write off the memory file until the owner approves it, then marks it confirmed', async () => {
    const memory = await store()
    const waiting = await memory.savePending({ text: 'always push to main', category: 'instructions' }, { source: 'tainted-turn', session: 'chat', origin: 'peer:bili' })
    expect(waiting).toMatchObject({ op: 'add', source: 'tainted-turn', origin: 'peer:bili' })
    expect(await memory.list()).toEqual([])
    expect((await memory.index()).pending).toEqual([{ id: waiting.id, category: 'instructions', op: 'add' }])
    expect((await stat(memory.pendingFile)).mode & 0o777).toBe(0o600)
    const made = await memory.approve(waiting.id, { session: 'chat', origin: 'owner' })
    expect(made).toMatchObject({ id: waiting.id, text: 'always push to main', source: 'owner-confirmed', origin: 'owner via peer:bili' })
    expect(await memory.list()).toEqual([made])
    expect(await memory.listPending()).toEqual([])
    expect((await memory.history()).at(-1)).toMatchObject({ op: 'approve', id: waiting.id })
  })

  it('applies a waiting replacement to its target, and refuses when the target is gone', async () => {
    const memory = await store()
    const target = (await memory.save({ text: 'short answers', category: 'preferences' }, meta)).entry
    const waiting = await memory.savePending({ id: target.id, text: 'long answers', category: 'preferences' }, { source: 'tainted-turn' })
    expect(waiting).toMatchObject({ op: 'replace', target: target.id })
    const made = await memory.approve(waiting.id)
    expect(made).toMatchObject({ id: target.id, text: 'long answers', source: 'owner-confirmed' })
    expect(await memory.list()).toHaveLength(1)
    const second = await memory.savePending({ id: target.id, text: 'medium answers', category: 'preferences' }, { source: 'tainted-turn' })
    await memory.forget(target.id)
    expect(await code(memory.approve(second.id))).toBe('not_found')
    expect(await code(memory.savePending({ id: 'abcdef', text: 'x', category: 'preferences' }))).toBe('not_found')
  })

  it('discards, deduplicates, and caps the waiting writes', async () => {
    const memory = await store()
    const first = await memory.savePending({ text: 'same', category: 'identity' }, { source: 'tainted-turn' })
    expect((await memory.savePending({ text: 'same', category: 'identity' }, { source: 'tainted-turn' })).id).toBe(first.id)
    expect(await memory.discard(first.id)).toMatchObject({ id: first.id })
    expect(await memory.listPending()).toEqual([])
    expect(await code(memory.discard(first.id))).toBe('not_found')
    for (let n = 0; n < MAX_PENDING; n += 1) await memory.savePending({ text: `fact ${String(n)}`, category: 'identity' })
    expect(await code(memory.savePending({ text: 'one too many', category: 'identity' }))).toBe('pending_full')
  })

  it('drops a waiting write after two weeks', async () => {
    const memory = await store()
    await memory.savePending({ text: 'stale', category: 'identity' })
    clock += 20 * 86_400_000
    expect(await memory.listPending()).toEqual([])
  })

  it('never reuses an id of a waiting write for a new entry', async () => {
    const memory = await store()
    const waiting = await memory.savePending({ text: 'a', category: 'identity' })
    for (let n = 0; n < 30; n += 1) expect((await memory.save({ text: `n${String(n)}`, category: 'projects' })).entry.id).not.toBe(waiting.id)
  })
})

describe('revert', () => {
  it('removes an entry that was added, restores the text a change replaced, and brings back a forgotten one', async () => {
    const memory = await store()
    const kept = (await memory.save({ text: 'original', category: 'preferences' }, meta)).entry
    await memory.save({ id: kept.id, text: 'edited', category: 'preferences' }, { source: 'owner-turn', session: 's2' })
    expect(await memory.revert(kept.id)).toMatchObject({ outcome: 'restored', entry: { text: 'original', session: 's1' } })
    expect((await memory.list())[0]).toMatchObject({ text: 'original' })
    // A second undo would only redo the first, so it is refused.
    expect(await code(memory.revert(kept.id))).toBe('nothing_to_revert')
    const fresh = (await memory.save({ text: 'brand new', category: 'identity' })).entry
    expect(await memory.revert(fresh.id)).toMatchObject({ outcome: 'removed', entry: { text: 'brand new' } })
    expect((await memory.list()).map(entry => entry.id)).toEqual([kept.id])
    await memory.forget(kept.id)
    const other = (await memory.save({ text: 'other', category: 'identity' })).entry
    await memory.forget(other.id)
    expect(await memory.revert(other.id)).toMatchObject({ outcome: 'restored', entry: { text: 'other' } })
    expect((await memory.list()).map(entry => entry.id)).toEqual([other.id])
    expect(await code(memory.revert('ffffff'))).toBe('nothing_to_revert')
  })

  it('drops a waiting write when asked to revert its id', async () => {
    const memory = await store()
    const waiting = await memory.savePending({ text: 'x', category: 'identity' })
    expect(await memory.revert(waiting.id)).toMatchObject({ outcome: 'dropped' })
    expect(await memory.listPending()).toEqual([])
  })
})

describe('rollback', () => {
  it('undoes what one Session wrote, newest first, and leaves the rest', async () => {
    const memory = await store()
    const mine = (await memory.save({ text: 'mine', category: 'instructions' }, { session: 'good' })).entry
    const theirs = (await memory.save({ text: 'planted', category: 'instructions' }, { session: 'bad' })).entry
    await memory.save({ id: mine.id, text: 'mine, tampered', category: 'instructions' }, { session: 'bad' })
    expect(await memory.rollback({ session: 'bad' }, { dryRun: true })).toMatchObject({ matched: 2, restored: 1, removed: 1 })
    expect((await memory.list()).map(entry => entry.text)).toEqual(['mine, tampered', 'planted'])
    const done = await memory.rollback({ session: 'bad' })
    expect(done).toMatchObject({ matched: 2, restored: 1, removed: 1, ids: expect.arrayContaining([mine.id, theirs.id]) as string[] })
    expect((await memory.list()).map(entry => entry.text)).toEqual(['mine'])
    expect((await memory.history()).at(-1)!.op).toBe('rollback')
    expect(await memory.rollback({ session: 'bad' })).toMatchObject({ matched: 2 })
    expect(await code(memory.rollback({}))).toBe('invalid_id')
  })

  it('undoes everything since a time, and puts back what a rolled-back forget removed', async () => {
    const memory = await store()
    const early = (await memory.save({ text: 'early', category: 'identity' })).entry
    clock += 3_600_000
    const since = new Date(clock).toISOString()
    await memory.forget(early.id)
    await memory.save({ text: 'late', category: 'identity' })
    clock += 1000
    expect(await memory.rollback({ since })).toMatchObject({ matched: 2, restored: 1, removed: 1 })
    expect((await memory.list()).map(entry => entry.text)).toEqual(['early'])
  })
})

describe('purge', () => {
  it('erases an entry from the file, the history, every snapshot, and the waiting writes', async () => {
    const memory = await store()
    const secret = (await memory.save({ text: 'private thing', category: 'identity' })).entry
    await memory.save({ text: 'keep me', category: 'projects' })
    day = '2026-10-24'
    await memory.save({ id: secret.id, text: 'private thing v2', category: 'identity' })
    const waiting = await memory.savePending({ id: secret.id, text: 'private thing v3', category: 'identity' })
    const result = await memory.purge(secret.id)
    expect(result).toMatchObject({ entries: 1, pending: 1 })
    expect(result.history).toBeGreaterThan(0)
    expect(result.snapshots).toBeGreaterThan(0)
    for (const file of [memory.file, memory.historyFile, memory.pendingFile, join(memory.snapshotDir, 'memory-2026-10-24.jsonl')]) {
      const text = await readFile(file, 'utf8').catch(() => '')
      expect(text).not.toContain('private thing')
      expect(text).not.toContain(secret.id)
    }
    expect(await memory.listPending()).toEqual([])
    expect((await memory.list()).map(entry => entry.text)).toEqual(['keep me'])
    expect(waiting.target).toBe(secret.id)
  })
})
