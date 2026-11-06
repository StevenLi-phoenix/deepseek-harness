import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { originFrom, sampleId, StyleError, StyleStore, type Candidate } from '../src/store.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

async function open(limits: Partial<{ maxActive: number; maxOwner: number; maxPending: number; maxTombstones: number }> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-style-store-'))
  dirs.push(dir)
  let tick = 0
  const now = () => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++))
  const file = join(dir, 'style', 'samples.jsonl')
  return { file, store: new StyleStore(file, { maxActive: 4, maxOwner: 2, maxPending: 2, maxTombstones: 100, ...limits }, now) }
}

const QQ = { platform: 'qq', groups: 1, speakers: 2, days: 1 } as const
const BILI = { platform: 'bili', groups: 1, speakers: 2, days: 1 } as const
const qq = (reply: string, prompt = '在吗'): Candidate => ({ source: 'qq', origin: QQ, at: 1000, prompt, reply })
const owner = (reply: string): Candidate => ({ source: 'bili', owner: true, origin: BILI, at: 1, prompt: '更新了', reply })

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

  it('reads the first release\'s records (old source names, no origin) and drops a line the owner typed', async () => {
    const { store, file } = await open()
    const row = (id: string, source: string, reply: string) => JSON.stringify({ id, source, status: 'active', addedAt: '2026-11-01T00:00:00.000Z', prompt: '在吗', reply })
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      row('aaaaaaaaaaaa', 'qq-group', '在'), row('bbbbbbbbbbbb', 'bili-viewer', '刚醒'), row('cccccccccccc', 'owner-bili', '刚剪完'),
      row('dddddddddddd', 'owner-manual', '会的'),
    ].join('\n'))
    expect((await store.live()).map(record => [record.reply, record.source, record.owner])).toEqual([
      ['在', 'qq', false], ['刚醒', 'bili', false], ['刚剪完', 'bili', true],
    ])
    expect((await store.live()).every(record => record.origin.groups === 1)).toBe(true)
  })

  it('caps the active samples, pinning the owner\'s own up to their cap (earlier candidates preferred), and retires the rest as ids only', async () => {
    const { store, file } = await open()
    await store.ingest([owner('一'), owner('二'), owner('三')], 'optional')
    await store.ingest([qq('a'), qq('b'), qq('c')], 'optional')
    const live = await store.live()
    expect(live.filter(record => record.owner).map(record => record.reply)).toEqual(['一', '二'])
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

  it('keeps every record\'s source to qq or bili with its origin counts, and drops anything else on reading', async () => {
    const { store, file } = await open()
    await store.ingest([qq('在'), owner('刚剪完')], 'optional')
    for (const record of await store.all()) {
      expect(['qq', 'bili']).toContain(record.source)
      expect(record.origin.platform).toBe(record.source)
    }
    await writeFile(file, `${await readFile(file, 'utf8')}${JSON.stringify({ id: 'aaaaaaaaaaaa', source: 'wechat', owner: false, status: 'active', addedAt: 'x', reply: 'y', origin: { ...QQ, platform: 'wechat' } })}\n`)
    expect((await store.all()).map(record => record.source).toSorted()).toEqual(['bili', 'qq'])
  })

  it('retires strangers\' samples by age and leaves the owner\'s', async () => {
    const { store } = await open()
    await store.ingest([{ source: 'qq', origin: QQ, at: 100, prompt: '旧', reply: '旧的' }, { source: 'bili', owner: true, origin: BILI, at: 100, prompt: '旧', reply: '我的' }, qq('新')], 'optional')
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

  it('gives a reply without a prompt an id of its own and stores it without a prompt', async () => {
    const { store } = await open()
    expect(sampleId(undefined, '在')).toMatch(/^[0-9a-f]{12}$/u)
    expect(sampleId(undefined, '在')).not.toBe(sampleId('在吗', '在'))
    const { added } = await store.ingest([{ source: 'qq', origin: QQ, reply: '在' }], 'optional')
    expect(added[0]).not.toHaveProperty('prompt')
    expect(added[0]).not.toHaveProperty('at')
    expect((await store.live())[0]).toMatchObject({ reply: '在', status: 'active' })
  })

  it('reads back only well-formed records: object lines, a known status, a reply for a live one, and a valid origin', async () => {
    const { store, file } = await open()
    const base = { id: 'aaaaaaaaaaaa', source: 'qq', owner: false, status: 'active', addedAt: 'x', reply: 'y', origin: QQ }
    const lines = [
      '5', 'null', '"text"',
      JSON.stringify({ ...base, id: '7'.repeat(12), source: 5 }),
      JSON.stringify({ ...base, id: 'b'.repeat(12), status: 'sleeping' }),
      JSON.stringify({ ...base, id: 'c'.repeat(12), reply: '' }),
      JSON.stringify({ ...base, id: 'd'.repeat(12), reply: 5 }),
      JSON.stringify({ ...base, id: 'e'.repeat(12), origin: 'qq' }),
      JSON.stringify({ ...base, id: 'f'.repeat(12), origin: { ...QQ, platform: 'bili' } }),
      JSON.stringify({ ...base, id: '1'.repeat(12), origin: { ...QQ, groups: -1 } }),
      JSON.stringify({ ...base, id: '2'.repeat(12), origin: { ...QQ, speakers: 1.5 } }),
      JSON.stringify({ ...base, id: '3'.repeat(12), origin: { ...QQ, days: '1' } }),
      JSON.stringify({ ...base, id: '4'.repeat(12), status: 'removed', reply: undefined, changedAt: '2026-11-01T00:00:00.000Z' }),
      JSON.stringify(base),
    ]
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, lines.join('\n'))
    expect((await store.all()).map(record => [record.id, record.status]).toSorted()).toEqual([['4'.repeat(12), 'removed'], ['aaaaaaaaaaaa', 'active']])
  })

  it('checks an origin against its record\'s source', () => {
    expect(originFrom({ platform: 'qq', groups: 2, speakers: 3, days: 1 }, 'qq')).toEqual({ platform: 'qq', groups: 2, speakers: 3, days: 1 })
    expect(originFrom(undefined, 'qq')).toBeUndefined()
    expect(originFrom(null, 'qq')).toBeUndefined()
    expect(originFrom({ platform: 'bili', groups: 1, speakers: 1, days: 1 }, 'qq')).toBeUndefined()
  })

  it('fails loudly when the file cannot be read for any reason but being absent', async () => {
    const { store, file } = await open()
    await mkdir(file, { recursive: true })
    await expect(store.all()).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('retires pending samples beyond the pending cap', async () => {
    const { store } = await open({ maxPending: 2 })
    const result = await store.ingest([qq('一'), qq('二'), qq('三')], 'required')
    expect(result.retired).toBe(1)
    expect(result.added).toHaveLength(2)
    expect((await store.live()).every(record => record.status === 'pending')).toBe(true)
    expect((await store.all()).filter(record => record.status === 'retired')).toHaveLength(1)
  })

  it('keeps the newest tombstones, ordering those without a change time by when they were added', async () => {
    const { store, file } = await open({ maxTombstones: 1 })
    const dead = (id: string, addedAt: string) => JSON.stringify({ id, source: 'qq', owner: false, status: 'removed', addedAt, origin: QQ })
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [dead('a'.repeat(12), '2026-10-01T00:00:00.000Z'), dead('b'.repeat(12), '2026-10-02T00:00:00.000Z')].join('\n'))
    await store.ingest([qq('新')], 'optional')
    expect((await store.all()).filter(record => record.status === 'removed').map(record => record.id)).toEqual(['b'.repeat(12)])
  })

  it('leaves the other samples untouched when one is removed, and keeps a tombstone without a time as it was', async () => {
    const { store } = await open()
    const { added } = await store.ingest([{ source: 'qq', origin: QQ, prompt: '在吗', reply: '在' }, qq('不在')], 'optional')
    await store.remove(added[0]!.id)
    expect((await store.live()).map(record => record.reply)).toEqual(['不在'])
    const removed = (await store.all()).find(record => record.id === added[0]!.id)!
    expect(removed).not.toHaveProperty('at')
    expect(removed).not.toHaveProperty('reply')
  })
})
