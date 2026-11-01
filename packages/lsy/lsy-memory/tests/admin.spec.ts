import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planPurge, purgeConfirmed, purgeToken, reviewWrite, rollbackConfirmed, rollbackToken } from '../src/admin.ts'
import { MemoryError, MemoryStore } from '../src/store.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

async function store(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-memory-admin-'))
  dirs.push(dir)
  return new MemoryStore(join(dir, 'memory.jsonl'), () => '2026-10-24')
}

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error: unknown) {
    return error instanceof MemoryError ? error.code : String(error)
  }
  return 'ok'
}

describe('reviewWrite', () => {
  it('approves, discards, and reverts through the store, stamping who answered', async () => {
    const memory = await store()
    const kept = await memory.savePending({ text: 'rule one', category: 'instructions' }, { source: 'tainted-turn', session: 's1', origin: 'peer:web_fetch' })
    const dropped = await memory.savePending({ text: 'rule two', category: 'instructions' }, { source: 'tainted-turn', session: 's1' })
    expect(await reviewWrite(memory, 'approve', kept.id, 'settings')).toEqual({ op: 'approve', id: kept.id, outcome: 'kept' })
    expect(await reviewWrite(memory, 'discard', dropped.id, 'settings')).toEqual({ op: 'discard', id: dropped.id, outcome: 'dropped' })
    const [entry] = await memory.list()
    expect(entry).toMatchObject({ id: kept.id, source: 'owner-confirmed', origin: 'settings via peer:web_fetch' })
    expect(await reviewWrite(memory, 'revert', kept.id, 'settings')).toMatchObject({ outcome: 'removed' })
    expect(await memory.list()).toEqual([])
    expect(await code(reviewWrite(memory, 'approve', dropped.id, 'settings'))).toBe('not_found')
  })
})

describe('rollback token', () => {
  async function planted(): Promise<{ memory: MemoryStore; id: string }> {
    const memory = await store()
    const { entry } = await memory.save({ text: 'planted', category: 'instructions' }, { session: 'bad' })
    return { memory, id: entry.id }
  }

  it('applies only the preview it was issued for', async () => {
    const { memory, id } = await planted()
    const filter = { session: 'bad' }
    const token = rollbackToken(filter, await memory.rollback(filter, { dryRun: true }))
    const done = await rollbackConfirmed(memory, filter, token)
    expect(done).toMatchObject({ matched: 1, removed: 1, ids: [id] })
    expect(await memory.list()).toEqual([])
  })

  it('refuses a token from another filter, or after the store changed', async () => {
    const { memory } = await planted()
    const filter = { session: 'bad' }
    const token = rollbackToken(filter, await memory.rollback(filter, { dryRun: true }))
    expect(await code(rollbackConfirmed(memory, { session: 'other' }, token))).toBe('stale_preview')
    await memory.save({ text: 'another planted', category: 'instructions' }, { session: 'bad' })
    expect(await code(rollbackConfirmed(memory, filter, token))).toBe('stale_preview')
    expect((await memory.list()).map(entry => entry.text)).toEqual(['planted', 'another planted'])
  })

  it('re-checks under the lock, so a change between check and write is refused', async () => {
    const { memory } = await planted()
    const preview = await memory.rollback({ session: 'bad' }, { dryRun: true })
    await memory.save({ text: 'late', category: 'projects' })
    await expect(memory.rollback({ session: 'bad' }, { expect: now => now.state === preview.state })).rejects.toMatchObject({ code: 'stale_preview' })
    expect((await memory.list()).map(entry => entry.text)).toEqual(['planted', 'late'])
  })
})

describe('purge token', () => {
  it('previews without writing, then erases exactly what was previewed', async () => {
    const memory = await store()
    const secret = (await memory.save({ text: 'private thing', category: 'identity' })).entry
    const plans = await planPurge(memory, [secret.id])
    expect(plans[0]).toMatchObject({ id: secret.id, entry: { text: 'private thing' }, planned: { entries: 1 } })
    expect((await memory.list()).map(entry => entry.id)).toEqual([secret.id])
    const done = await purgeConfirmed(memory, [secret.id], purgeToken(plans))
    expect(done[0]?.planned.entries).toBe(1)
    expect(await memory.list()).toEqual([])
    expect(await memory.history()).toEqual([])
  })

  it('refuses a token once the entry or its traces changed', async () => {
    const memory = await store()
    const secret = (await memory.save({ text: 'private thing', category: 'identity' })).entry
    const token = purgeToken(await planPurge(memory, [secret.id]))
    await memory.save({ id: secret.id, text: 'private thing v2', category: 'identity' })
    expect(await code(purgeConfirmed(memory, [secret.id], token))).toBe('stale_preview')
    expect(await memory.list()).toHaveLength(1)
  })
})
