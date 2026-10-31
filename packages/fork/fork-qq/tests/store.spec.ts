import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QqStore, type NewMessage } from '../src/store.ts'

let store: QqStore
beforeEach(() => { store = new QqStore(':memory:') })
afterEach(() => { store.close() })

function message(overrides: Partial<NewMessage> = {}): NewMessage {
  return { groupId: 'g1', messageId: 'm1', at: 1_000, userId: 'u1', nickname: '昵称', card: '名片', role: 'member', text: '大家好', kinds: ['text'], ...overrides }
}

describe('QqStore messages', () => {
  it('records a message once per group and QQ message id', () => {
    const first = store.insertMessage(message(), [{ kind: 'image', url: 'https://x/y.jpg' }], 5)
    expect(first).toBe(1)
    expect(store.insertMessage(message({ text: 'changed' }), [], 5)).toBeUndefined()
    expect(store.insertMessage(message({ groupId: 'g2' }), [], 5)).toBeGreaterThan(1)
    expect(store.recent('g1', { limit: 10 })).toHaveLength(1)
    expect(store.recent('g1', { limit: 10 })[0]!.text).toBe('大家好')
    expect(store.mediaOf(1)).toMatchObject([{ kind: 'image', url: 'https://x/y.jpg', localPath: null }])
    expect(store.hasMessage('g1', 'm1')).toBe(true)
    expect(store.hasMessage('g1', 'nope')).toBe(false)
  })

  it('returns recent messages oldest first, within the window, by one user if asked', () => {
    for (let i = 1; i <= 5; i += 1) store.insertMessage(message({ messageId: `m${i}`, at: i * 1000, userId: i % 2 === 0 ? 'even' : 'odd', text: `消息${i}` }), [], 0)
    expect(store.recent('g1', { limit: 3 }).map(m => m.text)).toEqual(['消息3', '消息4', '消息5'])
    expect(store.recent('g1', { sinceMs: 3000, limit: 10 }).map(m => m.text)).toEqual(['消息3', '消息4', '消息5'])
    expect(store.recent('g1', { limit: 10, userId: 'even' }).map(m => m.text)).toEqual(['消息2', '消息4'])
  })

  it('searches Chinese and English text by substring, with a LIKE fallback under three characters', () => {
    store.insertMessage(message({ messageId: 'a', at: 1, text: '今天讨论 Kubernetes 的部署问题' }), [], 0)
    store.insertMessage(message({ messageId: 'b', at: 2, text: '周末去爬山吗', groupId: 'g2' }), [], 0)
    expect(store.search('部署问题', { limit: 10 }).map(m => m.messageId)).toEqual(['a'])
    expect(store.search('kubernetes', { limit: 10 }).map(m => m.messageId)).toEqual(['a'])
    expect(store.search('爬山', { limit: 10 }).map(m => m.messageId)).toEqual(['b'])
    expect(store.search('爬山', { limit: 10, groupId: 'g1' })).toEqual([])
    expect(store.search('50%', { limit: 10 })).toEqual([])
    expect(store.search('   ', { limit: 10 })).toEqual([])
    // A quote character in the query is data, not FTS syntax.
    expect(store.search('"AND OR', { limit: 10 })).toEqual([])
  })

  it('keeps the search index current when words are appended to a message', () => {
    const id = store.insertMessage(message({ text: '[语音]' }), [], 0)!
    store.appendText(id, ' 转写:明天下午三点开会')
    expect(store.search('下午三点开会', { limit: 5 }).map(m => m.id)).toEqual([id])
  })

  it('drops what a recalled message said, its media, and its search entry, and reports its files', () => {
    const id = store.insertMessage(message({ text: '撤回前的秘密内容', raw: '[{"type":"text"}]' }), [{ kind: 'image' }], 0)!
    const media = store.mediaOf(id)[0]!
    store.setMediaFile(media.id, { localPath: '/data/media/a.jpg', sha256: 'abc', bytes: 10 })
    expect(store.recall('g1', 'm1')).toEqual(['/data/media/a.jpg'])
    expect(store.mediaOf(id)).toEqual([])
    expect(store.search('秘密内容', { limit: 5 })).toEqual([])
    expect(store.recent('g1', { limit: 5 })).toEqual([])
    expect(store.recall('g1', 'unknown')).toBeUndefined()
    // The row stays, so a late duplicate of the same message cannot bring the text back.
    expect(store.insertMessage(message({ text: '撤回前的秘密内容' }), [], 0)).toBeUndefined()
  })

  it('lists groups with counts and digest times', () => {
    store.upsertGroup({ groupId: 'g1', name: '技术群', memberCount: 80 }, 1)
    store.upsertGroup({ groupId: 'g1', name: '技术交流群', memberCount: 81 }, 2)
    store.insertMessage(message({ messageId: 'a', at: 10 }), [], 0)
    store.insertMessage(message({ messageId: 'b', at: 20 }), [], 0)
    store.insertDigest({ groupId: 'g1', fromRow: 1, toRow: 2, messageCount: 2, text: '摘要', model: 'm', createdAt: 99 })
    expect(store.groups()).toEqual([{ groupId: 'g1', name: '技术交流群', memberCount: 81, updatedAt: 2 }])
    expect(store.groupName('g1')).toBe('技术交流群')
    expect(store.stats()).toEqual([{ groupId: 'g1', messages: 2, firstAt: 10, lastAt: 20, lastDigestAt: 99 }])
  })
})

describe('QqStore retention and deletion', () => {
  it('prunes messages older than a cutoff with their media and search entries, and lists their files', () => {
    const old = store.insertMessage(message({ messageId: 'old', at: 100, text: '很久以前的讨论内容' }), [{ kind: 'image' }], 0)!
    store.insertMessage(message({ messageId: 'new', at: 9000, text: '最近的讨论内容' }), [], 0)
    store.setMediaFile(store.mediaOf(old)[0]!.id, { localPath: '/m/old.jpg', sha256: 'a', bytes: 1 })
    expect(store.pruneMessages(5000)).toEqual({ messages: 1, files: ['/m/old.jpg'] })
    expect(store.search('很久以前', { limit: 5 })).toEqual([])
    expect(store.search('最近的', { limit: 5 })).toHaveLength(1)
    expect(store.mediaOf(old)).toEqual([])
    expect(store.pruneMessages(5000)).toEqual({ messages: 0, files: [] })
  })

  it('deletes digests by group or by date, never all at once by accident, and caps a group', () => {
    for (let i = 1; i <= 4; i += 1) store.insertDigest({ groupId: 'g1', fromRow: i, toRow: i, messageCount: 1, text: `d${i}`, model: 'm', createdAt: i * 100 })
    store.insertDigest({ groupId: 'g2', fromRow: 1, toRow: 1, messageCount: 1, text: 'other', model: 'm', createdAt: 50 })
    expect(() => store.deleteDigests({})).toThrow('needs a group or a date')
    expect(store.capDigests('g1', 3)).toBe(1)
    expect(store.digests({ groupId: 'g1', limit: 9 }).map(d => d.text)).toEqual(['d4', 'd3', 'd2'])
    expect(store.deleteDigests({ groupId: 'g1', beforeMs: 250 })).toBe(1)
    expect(store.deleteDigests({ beforeMs: 1000 })).toBe(3)
    expect(store.digests({ limit: 9 })).toEqual([])
  })
})

describe('QqStore media, digests, and meta', () => {
  it('tracks downloaded bytes and finds media past retention', () => {
    const old = store.insertMessage(message({ messageId: 'old', at: 100 }), [{ kind: 'image' }], 0)!
    const fresh = store.insertMessage(message({ messageId: 'new', at: 9000 }), [{ kind: 'image' }], 0)!
    store.setMediaFile(store.mediaOf(old)[0]!.id, { localPath: '/m/old.jpg', sha256: 'a', bytes: 100 })
    store.setMediaFile(store.mediaOf(fresh)[0]!.id, { localPath: '/m/new.jpg', sha256: 'b', bytes: 50 })
    expect(store.mediaBytes()).toBe(150)
    const expired = store.expiredMedia(5000)
    expect(expired.map(item => item.localPath)).toEqual(['/m/old.jpg'])
    store.clearMediaFile(expired[0]!.id)
    expect(store.mediaBytes()).toBe(50)
    store.setMediaError(store.mediaOf(fresh)[0]!.id, 'x'.repeat(500))
    expect(store.mediaOf(fresh)[0]!.error).toHaveLength(300)
    store.setTranscript(store.mediaOf(fresh)[0]!.id, '转写')
    expect(store.mediaOf(fresh)[0]!.transcript).toBe('转写')
  })

  it('returns digests newest first and remembers how far digesting got', () => {
    for (let i = 1; i <= 3; i += 1) store.insertMessage(message({ messageId: `m${i}`, at: i }), [], 0)
    expect(store.digestedUpTo('g1')).toBe(0)
    store.insertDigest({ groupId: 'g1', fromRow: 1, toRow: 2, messageCount: 2, text: 'one', model: 'm', usage: '{"in":1}', rawPath: '/raw/1', createdAt: 100 })
    store.insertDigest({ groupId: 'g1', fromRow: 3, toRow: 3, messageCount: 1, text: 'two', model: 'm', createdAt: 200 })
    store.insertDigest({ groupId: 'g2', fromRow: 1, toRow: 1, messageCount: 1, text: 'other', model: 'm', createdAt: 300 })
    expect(store.digests({ groupId: 'g1', limit: 5 }).map(d => d.text)).toEqual(['two', 'one'])
    expect(store.digests({ sinceMs: 150, limit: 5 }).map(d => d.text)).toEqual(['other', 'two'])
    expect(store.digestedUpTo('g1')).toBe(3)
    expect(store.lastDigestAt('g1')).toBe(200)
    expect(store.after('g1', 2, 10).map(m => m.messageId)).toEqual(['m3'])
    expect(store.lastRow('g1')).toBe(3)
    expect(store.lastRow('none')).toBe(0)
  })

  it('stores small settings', () => {
    expect(store.getMeta('x')).toBeUndefined()
    store.setMeta('x', '1')
    store.setMeta('x', '2')
    expect(store.getMeta('x')).toBe('2')
  })
})
