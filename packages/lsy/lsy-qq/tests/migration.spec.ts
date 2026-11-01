import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QqStore } from '../src/store.ts'
import { LegacyDigestStateDto } from '../src/protocol.ts'
import { bootRecorder, shutdown } from './recorder-harness.ts'
import { memoryStore } from './digest-harness.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsy-qq-migration-')) })
afterEach(async () => {
  await shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/** A data directory as the in-process plugin left it: messages, digests, notes, a resident Session, a salt, an outage notice. */
function oldDataDir(): string {
  const dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })
  new QqStore(join(dataDir, 'qq.db')).close()
  const db = new DatabaseSync(join(dataDir, 'qq.db'))
  db.exec(`
    INSERT INTO digests (group_id, from_row, to_row, message_count, text, model, usage, raw_path, created_at) VALUES
      ('123456789', 1, 40, 40, '第一份摘要', 'm1', '{"in":1}', '/old/raw/1.md', 1000),
      ('123456789', 41, 60, 20, '第二份摘要', 'm1', NULL, NULL, 2000),
      ('987654321', 1, 9, 9, '别的群', 'm2', NULL, NULL, 1500);
    INSERT INTO group_notes (group_id, text, created_at) VALUES ('123456789', '常聊显卡', 10), ('123456789', '爱用表情包', 20);
    INSERT INTO group_sessions (group_id, session_id, created_at, generation) VALUES ('123456789', 'digest-7', 500, 3);
    INSERT INTO meta (key, value) VALUES ('alias-salt', 'old-salt-uuid');
  `)
  db.close()
  writeFileSync(join(dataDir, 'outage-notice.json'), JSON.stringify({ lastNoticeAt: 4242 }))
  return dataDir
}

describe('taking over the digest state the recorder holds', () => {
  it('reports the old digests, notes, Sessions, salt, and notice through the legacy endpoint\'s schema', async () => {
    oldDataDir()
    const h = await bootRecorder({ dir, config: false })
    const legacy = LegacyDigestStateDto.parse(h.recorder.legacyState())
    expect(legacy.digests.map(d => [d.groupId, d.fromCursor, d.toCursor, d.messageCount, d.text])).toEqual([
      ['123456789', 'c1', 'c40', 40, '第一份摘要'], ['123456789', 'c41', 'c60', 20, '第二份摘要'], ['987654321', 'c1', 'c9', 9, '别的群'],
    ])
    expect(legacy.notes.map(n => n.text)).toEqual(['常聊显卡', '爱用表情包'])
    expect(legacy.groupSessions).toEqual([{ groupId: '123456789', sessionId: 'digest-7', createdAt: 500, generation: 3 }])
    expect(legacy.aliasSalt).toBe('old-salt-uuid')
    expect(legacy.outageNoticeAt).toBe(4242)
  })

  it('imports it into DSH\'s own storage, and importing again changes nothing', async () => {
    oldDataDir()
    const h = await bootRecorder({ dir, config: false })
    const { store, close } = await memoryStore()
    expect(store.imported).toBe(false)
    const first = await store.importLegacy(h.recorder.legacyState(), 9000)
    expect(first).toEqual({ imported: true, digests: 3, notes: 2, sessions: 1 })
    expect(store.digests({ groupId: '123456789', limit: 9 }).map(d => d.text)).toEqual(['第二份摘要', '第一份摘要'])
    expect(store.digestedUpTo('123456789')).toBe('c60')
    expect(store.notes('123456789').map(n => n.text)).toEqual(['常聊显卡', '爱用表情包'])
    expect(store.groupSession('123456789')).toEqual({ sessionId: 'digest-7', createdAt: 500, generation: 3 })
    expect(store.isResidentSession('digest-7')).toBe(true)
    expect(store.salt()).toBe('old-salt-uuid')
    expect(store.getMeta('outage-notice-at')).toBe('4242')
    expect(store.getMeta('legacy-imported-at')).toBe('9000')
    const again = await store.importLegacy({ ...h.recorder.legacyState(), digests: [], notes: [] }, 9999)
    expect(again).toEqual({ imported: false, digests: 0, notes: 0, sessions: 0 })
    expect(store.digests({ limit: 99 })).toHaveLength(3)
    expect(store.notes('123456789')).toHaveLength(2)
    expect(store.getMeta('legacy-imported-at')).toBe('9000')
    // A digest made after the import gets a fresh id, and a removed note's id is not reused.
    const next = await store.insertDigest({ groupId: '123456789', fromCursor: 'c61', toCursor: 'c70', messageCount: 10, text: '新', model: 'm', usage: null, rawPath: null, createdAt: 10_000 })
    expect(next).toBe(4)
    await close()
  })

  it('finishes a run that crashed half way by repeating it with the same records, and survives a restart of the storage', async () => {
    oldDataDir()
    const h = await bootRecorder({ dir, config: false })
    const pool = new MemoryMediaPool()
    const one = await memoryStore(pool)
    // The crash: some records landed, the marker did not.
    pool.failNextWrites = 0
    await one.store.importLegacy({ ...h.recorder.legacyState(), aliasSalt: null, outageNoticeAt: null, groupSessions: [] }, 1)
    const stampless = (await memoryStore(pool))
    expect(stampless.store.digests({ limit: 99 })).toHaveLength(3)
    await stampless.close()
    await one.close()
    const two = await memoryStore(pool)
    expect(two.store.imported).toBe(true)
    expect(await two.store.importLegacy(h.recorder.legacyState(), 2)).toMatchObject({ imported: false })
    expect(two.store.digests({ limit: 99 })).toHaveLength(3)
    await two.close()
  })

  it('leaves the old tables where they are, so rolling the plugin back finds its state', async () => {
    oldDataDir()
    const h = await bootRecorder({ dir, config: false })
    const { store, close } = await memoryStore()
    await store.importLegacy(h.recorder.legacyState(), 1)
    await store.deleteDigests({ groupId: '123456789' })
    expect(h.recorder.legacyState().digests).toHaveLength(3)
    expect(h.recorder.legacyState().notes).toHaveLength(2)
    await close()
  })

  it('reports an empty state for a data directory that never held digests', async () => {
    const h = await bootRecorder({ dir, config: false })
    expect(h.recorder.legacyState()).toEqual({ digests: [], notes: [], groupSessions: [], aliasSalt: null, outageNoticeAt: null })
  })
})
