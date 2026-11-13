import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkNote, MAX_NOTE_CHARS } from '../src/pii.ts'
import { MAX_NOTES_PER_GROUP, type DigestStore } from '../src/digest-storage.ts'
import { memoryStore } from './digest-harness.ts'

describe('group note filter', () => {
  const ok = (text: string, names: string[] = []) => checkNote(text, names)

  it('accepts a short note about topics, slang, and mood', () => {
    expect(ok('常聊显卡和装机，爱用「炼丹」指训练')).toEqual({ ok: true, text: '常聊显卡和装机，爱用「炼丹」指训练' })
    expect(ok('  气氛轻松，爱发表情包  ')).toMatchObject({ ok: true, text: '气氛轻松，爱发表情包' })
  })

  it.each([
    ['a QQ number', '管理员是 123456789'],
    ['a phone number', '联系 13812345678'],
    ['an email', '写信到 someone@example.com'],
    ['an @mention', '经常 @小明 讨论'],
    ['a member alias', '群友#a3f9 懂这个'],
    ['an address', '聚会在北京市海淀区'],
    ['a street number', '在中关村大街12号'],
    ['a school', '多是清华大学的同学'],
    ['an organisation', '很多人在字节跳动有限公司'],
  ])('refuses %s', (_name, text) => {
    const verdict = ok(text)
    expect(verdict.ok).toBe(false)
    expect(verdict).toMatchObject({ reason: expect.stringContaining('') as string })
  })

  it('refuses a member name or card the group has shown, even inside another word', () => {
    expect(ok('老王总在凌晨发言', ['老王', '小李'])).toMatchObject({ ok: false })
    expect(ok('小李的猫很出名', ['老王', '小李'])).toMatchObject({ ok: false })
    expect(ok('讨论群内的猫', ['老王', '小李'])).toMatchObject({ ok: true })
  })

  it('ignores one-character names, which would match almost anything', () => {
    expect(ok('爱聊猫', ['猫', '的'])).toMatchObject({ ok: true })
  })

  it('refuses an empty, multi-line, or over-long note', () => {
    expect(ok('   ')).toMatchObject({ ok: false })
    expect(ok('第一行\n第二行')).toMatchObject({ ok: false })
    expect(ok('字'.repeat(MAX_NOTE_CHARS + 1))).toMatchObject({ ok: false })
    expect(ok('字'.repeat(MAX_NOTE_CHARS))).toMatchObject({ ok: true })
  })
})

describe('group notes in the digest storage', () => {
  let store: DigestStore
  let close: () => Promise<void>
  beforeEach(async () => { ({ store, close } = await memoryStore()) })
  afterEach(async () => { await close() })

  it('keeps notes per group, oldest first, with ids the model can name', async () => {
    const a = await store.addNote('g1', '常聊显卡', 10)
    const b = await store.addNote('g1', '爱用表情包', 20)
    await store.addNote('g2', '另一个群', 30)
    expect(store.notes('g1').map(note => [note.id, note.text])).toEqual([[a, '常聊显卡'], [b, '爱用表情包']])
    expect(store.notes('g2')).toHaveLength(1)
  })

  it('does not add the same note twice, and stops at the cap', async () => {
    expect(await store.addNote('g1', '常聊显卡', 1)).toBeDefined()
    expect(await store.addNote('g1', '常聊显卡', 2)).toBeUndefined()
    for (let i = 1; i < MAX_NOTES_PER_GROUP; i += 1) await store.addNote('g1', `话题${i}`, i)
    expect(store.notes('g1')).toHaveLength(MAX_NOTES_PER_GROUP)
    expect(await store.addNote('g1', '第三十一条', 99)).toBeUndefined()
  })

  it('removes a note by id, by "#id", or by its exact text, only inside its own group', async () => {
    const a = (await store.addNote('g1', '常聊显卡', 1))!
    await store.addNote('g1', '爱用表情包', 2)
    const c = (await store.addNote('g1', '黑话炼丹', 3))!
    expect(await store.removeNote('g1', String(a))).toBe(true)
    expect(await store.removeNote('g1', `#${c}`)).toBe(true)
    expect(await store.removeNote('g1', '爱用表情包')).toBe(true)
    expect(await store.removeNote('g1', '爱用表情包')).toBe(false)
    const other = (await store.addNote('g2', '别组', 4))!
    expect(await store.removeNote('g1', String(other))).toBe(false)
    expect(store.notes('g2')).toHaveLength(1)
  })

  it('never reuses the id of a removed note, so a model that named #3 cannot hit another note', async () => {
    const first = (await store.addNote('g1', '甲', 1))!
    await store.removeNote('g1', String(first))
    const second = (await store.addNote('g1', '乙', 2))!
    expect(second).toBeGreaterThan(first)
  })
})
