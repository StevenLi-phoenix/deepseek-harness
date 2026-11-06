import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NotesStore, type NotesLimits } from '../src/notes.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

async function open(limits: Partial<NotesLimits> = {}, clock = { at: 1_000_000 }) {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-style-notes-'))
  dirs.push(dir)
  const file = join(dir, 'notes.json')
  const store = new NotesStore(file, { maxMemes: 10, maxTraits: 10, expireDays: 30, maxVersions: 3, ...limits }, () => clock.at)
  return { dir, file, clock, store }
}

describe('NotesStore', () => {
  it('starts empty when the file is absent or is not JSON, and fails on any other read error', async () => {
    const { store, file } = await open()
    expect(await store.notes()).toEqual([])
    await writeFile(file, '{torn')
    expect(await store.notes()).toEqual([])
    expect(await store.cards()).toEqual([])
    await rm(file)
    await mkdir(file)
    await expect(store.notes()).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('keeps writing after one write failed', async () => {
    const { store, file } = await open()
    await mkdir(file)
    await expect(store.block('梗')).rejects.toMatchObject({ code: 'EISDIR' })
    await rm(file, { recursive: true })
    await store.block('梗')
    expect([...await store.blocked()]).toEqual(['梗'])
  })

  it('reads back only well-formed notes, blocked terms, and card versions', async () => {
    const { store, file } = await open()
    const good = { id: 'm1', kind: 'meme', term: '梗', example: '例', source: 'web', firstSeen: 1, lastSeen: 1_000_000 }
    await writeFile(file, JSON.stringify({
      notes: [good, { ...good, id: 'x', kind: 'idiom' }, { ...good, id: 'y', source: 'wechat' }, { ...good, id: 'z', lastSeen: 'now' }, { ...good, id: 'w', term: 5 }, { ...good, id: 'v', example: null }],
      blocked: ['坏', 5],
      cards: [{ version: 1, card: '甲', author: 'agent', reason: 'r', at: 1 }, { version: 'two', card: '乙' }, { version: 3, card: 5 }],
    }))
    expect((await store.notes()).map(note => note.id)).toEqual(['m1'])
    expect([...await store.blocked()]).toEqual(['坏'])
    expect((await store.cards()).map(card => card.version)).toEqual([1])
    await writeFile(file, JSON.stringify({ notes: 'none', blocked: 'none', cards: 'none' }))
    expect(await store.notes()).toEqual([])
    expect([...await store.blocked()]).toEqual([])
  })

  it('refreshes only the memes whose term showed up again and leaves the rest as they were', async () => {
    const { store, clock } = await open()
    await store.note({ kind: 'meme', term: '典中典', meaning: '经典', example: '典中典', source: 'qq' })
    await store.note({ kind: 'meme', term: '别的梗', meaning: '别的', example: '别的梗', source: 'qq' })
    await store.note({ kind: 'trait', term: '典中典', example: '典中典', source: 'qq' })
    clock.at += 5000
    expect(await store.touch(new Set(['典中典']))).toBe(1)
    const byKey = new Map((await store.notes()).map(note => [`${note.kind}:${note.term}`, note.lastSeen]))
    expect(byKey.get('meme:典中典')).toBe(1_005_000)
    expect(byKey.get('meme:别的梗')).toBe(1_000_000)
    expect(byKey.get('trait:典中典')).toBe(1_000_000)
    expect(await store.touch(new Set(['没有']))).toBe(0)
  })

  it('refuses to drop the current version or one that is not there, and drops a past one', async () => {
    const { store } = await open({ maxVersions: 5 })
    await store.setCard({ card: '甲', author: 'agent', reason: 'a' })
    await store.setCard({ card: '乙', author: 'owner', reason: 'b' })
    expect(await store.dropVersion(2)).toBe(false)
    expect(await store.dropVersion(9)).toBe(false)
    expect(await store.dropVersion(1)).toBe(true)
    expect((await store.cards()).map(card => card.version)).toEqual([2])
  })

  it('keeps only the newest card versions and numbers on from the last one', async () => {
    const { store } = await open({ maxVersions: 2 })
    for (const card of ['一', '二', '三']) await store.setCard({ card, author: 'agent', reason: card })
    expect((await store.cards()).map(card => [card.version, card.card])).toEqual([[2, '二'], [3, '三']])
  })

  it('removes a note by id, blocks its term, and reports nothing for an unknown id', async () => {
    const { store } = await open()
    await store.note({ kind: 'trait', term: '嘴硬', example: '才不是', source: 'bili' })
    const [stored] = await store.notes()
    expect(await store.remove('nope')).toBeUndefined()
    expect((await store.remove(stored!.id))?.term).toBe('嘴硬')
    expect(await store.note({ kind: 'trait', term: '嘴硬', example: '才不是', source: 'bili' })).toBe('blocked')
  })
})
