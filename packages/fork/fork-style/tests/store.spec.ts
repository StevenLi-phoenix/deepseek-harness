import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sampleId, StyleError, StyleStore, type Candidate } from '../src/store.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

async function open(limits: Partial<{ maxActive: number; maxOwner: number; maxPending: number; maxTombstones: number }> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fork-style-store-'))
  dirs.push(dir)
  let tick = 0
  const now = () => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++))
  const file = join(dir, 'style', 'samples.jsonl')
  return { file, store: new StyleStore(file, { maxActive: 4, maxOwner: 2, maxPending: 2, maxTombstones: 100, ...limits }, now) }
}

const qq = (reply: string, prompt = '在吗'): Candidate => ({ source: 'qq-group', at: 1000, prompt, reply })
const owner = (reply: string): Candidate => ({ source: 'owner-bili', at: 1, prompt: '更新了', reply })

describe('StyleStore', () => {
  it('stores candidates active, newest first, in a private file', async () => {
    const { store, file } = await open()
    const result = await store.ingest([qq('在'), qq('不在')], 'optional')
    expect(result).toMatchObject({ duplicate: 0, removed: 0, retired: 0 })
    expect(result.added.map(record => record.reply)).toEqual(['在', '不在'])
    expect((await store.live()).every(record => record.status === 'active')).toBe(true)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(sampleId('在吗', '在')).toMatch(/^[0-9a-f]{12}$/u)
  })

  it('caps the active samples, pinning the owner\'s own up to their cap (earlier candidates preferred), and retires the rest as ids only', async () => {
    const { store, file } = await open()
    await store.ingest([owner('一'), owner('二'), owner('三')], 'optional')
    await store.ingest([qq('a'), qq('b'), qq('c')], 'optional')
    const live = await store.live()
    expect(live.filter(record => record.source === 'owner-bili').map(record => record.reply)).toEqual(['一', '二'])
    expect(live).toHaveLength(4)
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain('"三"')
    expect((await store.all()).filter(record => record.status === 'retired')).toHaveLength(2)
  })

  it('never brings a removed or retired sample back, and counts it', async () => {
    const { store } = await open()
    const [first] = (await store.ingest([qq('在')], 'optional')).added
    const removed = await store.remove(first!.id)
    expect(removed.reply).toBe('在')
    expect(await store.live()).toEqual([])
    const again = await store.ingest([qq('在'), qq(' 在 ')], 'optional')
    expect(again).toMatchObject({ added: [], removed: 2 })
    await expect(store.remove(first!.id)).rejects.toBeInstanceOf(StyleError)
  })

  it('holds strangers\' samples as pending under review, keeps the owner\'s active, and keeps on request', async () => {
    const { store } = await open()
    await store.ingest([qq('在'), owner('刚剪完')], 'required')
    const live = await store.live()
    expect(live.find(record => record.reply === '在')?.status).toBe('pending')
    expect(live.find(record => record.reply === '刚剪完')?.status).toBe('active')
    const pending = live.find(record => record.status === 'pending')!
    expect((await store.keep(pending.id)).status).toBe('active')
    await expect(store.keep(pending.id)).rejects.toThrow(/no pending sample/u)
  })

  it('adds the owner\'s typed line with limits, and a deleted typed line can be typed again', async () => {
    const { store } = await open()
    const record = await store.addManual({ reply: ' 会的. 绝对会的 ' }, 60)
    expect(record).toMatchObject({ source: 'owner-manual', status: 'active', reply: '会的. 绝对会的' })
    expect(record.prompt).toBeUndefined()
    await expect(store.addManual({ reply: '' }, 60)).rejects.toThrow(/reply is empty/u)
    await expect(store.addManual({ reply: 'x'.repeat(61) }, 60)).rejects.toThrow(/longer than 60/u)
    await expect(store.addManual({ reply: 3 }, 60)).rejects.toThrow(/must be text/u)
    await store.remove(record.id)
    expect((await store.addManual({ reply: '会的. 绝对会的' }, 60)).status).toBe('active')
  })

  it('retires strangers\' samples by age and leaves the owner\'s', async () => {
    const { store } = await open()
    await store.ingest([{ source: 'qq-group', at: 100, prompt: '旧', reply: '旧的' }, { source: 'owner-bili', at: 100, prompt: '旧', reply: '我的' }, qq('新')], 'optional')
    expect(await store.expire(50)).toBe(0)
    expect(await store.expire(200)).toBe(1)
    expect((await store.live()).map(record => record.reply).toSorted()).toEqual(['我的', '新'])
  })

  it('skips a damaged line and keeps the rest', async () => {
    const { store, file } = await open()
    await store.ingest([qq('在')], 'optional')
    await writeFile(file, `${await readFile(file, 'utf8')}{torn\n{"id":"nothex","source":"qq-group","status":"active","addedAt":"x","reply":"y"}\n`)
    expect((await store.live()).map(record => record.reply)).toEqual(['在'])
  })

  it('serializes concurrent writers on one file', async () => {
    const { store } = await open({ maxActive: 50 })
    await Promise.all(Array.from({ length: 10 }, async (_, index) => await store.ingest([qq(`第${String(index)}句`)], 'optional')))
    expect(await store.live()).toHaveLength(10)
  })
})
