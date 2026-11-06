import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DigestRecord, DigestStore } from '../src/digest-storage.ts'
import { memoryStore } from './digest-harness.ts'

const digest = (groupId: string, createdAt: number): Omit<DigestRecord, 'id'> => (
  { groupId, fromCursor: 'c1', toCursor: 'c9', messageCount: 9, text: '摘要', model: 'm', usage: null, rawPath: null, createdAt }
)

describe('DigestStore digests', () => {
  let store: DigestStore
  let close: () => Promise<void>
  beforeEach(async () => { ({ store, close } = await memoryStore()) })
  afterEach(async () => { await close() })

  it('reports the newest digest time of every group that has one', async () => {
    await store.insertDigest(digest('111', 5000))
    await store.insertDigest(digest('111', 9000))
    await store.insertDigest(digest('111', 7000))
    await store.insertDigest(digest('222', 3000))
    expect(store.lastDigestTimes()).toEqual(new Map([['111', 9000], ['222', 3000]]))
  })

  it('reports no times when there are no digests', () => {
    expect(store.lastDigestTimes()).toEqual(new Map())
  })

  it('numbers the next digest after the stored counter, or after the largest id when the counter is unreadable', async () => {
    expect(await store.insertDigest(digest('111', 1))).toBe(1)
    expect(await store.insertDigest(digest('111', 2))).toBe(2)
    await store.setMeta('last-digest-id', 'not a number')
    expect(await store.insertDigest(digest('111', 3))).toBe(3)
  })

  it('deletes digests by group, by date, or by both, and refuses neither', async () => {
    for (const [group, at] of [['111', 1000], ['111', 5000], ['222', 1000], ['222', 5000]] as const) await store.insertDigest(digest(group, at))
    await expect(store.deleteDigests({})).rejects.toThrow('deleteDigests needs a group or a date')
    expect(await store.deleteDigests({ groupId: '111', beforeMs: 3000 })).toBe(1)
    expect(store.digests({ limit: 10 }).map(row => [row.groupId, row.createdAt])).toEqual([['222', 5000], ['111', 5000], ['222', 1000]])
    expect(await store.deleteDigests({ beforeMs: 3000 })).toBe(1)
    expect(await store.deleteDigests({ groupId: '222' })).toBe(1)
    expect(store.digests({ limit: 10 }).map(row => [row.groupId, row.createdAt])).toEqual([['111', 5000]])
  })
})
