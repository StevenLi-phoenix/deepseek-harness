import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sharesSpan, spanKeys } from '../src/overlap.ts'
import { MemoryStore } from '../src/store.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

async function store(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-memory-overlap-'))
  dirs.push(dir)
  return new MemoryStore(join(dir, 'memory.jsonl'), () => '2026-11-01')
}

describe('spanKeys', () => {
  it('makes a key for each 6-character CJK window and none for shorter runs', () => {
    expect(spanKeys('住在布鲁克林的一栋楼').size).toBe(5)
    expect(spanKeys('喜欢吃面')).toEqual(new Set())
  })

  it('makes a key for each run of three non-filler words, across case, width, and filler', () => {
    expect(spanKeys('Uses PNPM for the JS builds')).toEqual(new Set(['w:uses pnpm js', 'w:pnpm js builds']))
    expect(spanKeys('ＵＳＥＳ pnpm JS')).toEqual(new Set(['w:uses pnpm js']))
  })

  it('does not join words across a sentence stop or a CJK run', () => {
    expect(spanKeys('likes tea. drinks coffee')).toEqual(new Set())
    expect(spanKeys('likes tea 然后 drinks coffee')).toEqual(new Set())
  })

  it('shares a span only when a key is common', () => {
    expect(sharesSpan(spanKeys('住在布鲁克林的一栋楼'), spanKeys('他住在布鲁克林的一间房'))).toBe(true)
    expect(sharesSpan(spanKeys('住在布鲁克林的一栋楼'), spanKeys('住在纽约的一栋楼里面'))).toBe(false)
    expect(sharesSpan(spanKeys('他住在布鲁克林的一间房'), spanKeys('住在布鲁克林的一栋楼'))).toBe(true)
  })
})

describe('MemoryStore.containsSpanOf', () => {
  it('is false for a missing file', async () => {
    expect(await (await store()).containsSpanOf('住在布鲁克林的一栋楼')).toBe(false)
  })

  it('finds a span of an entry and of a waiting write, and answers only a boolean', async () => {
    const memory = await store()
    await memory.save({ text: '主人住在布鲁克林的一栋红砖公寓', category: 'identity' })
    await memory.savePending({ text: 'studies Computer Science at some school', category: 'identity' })
    expect(await memory.containsSpanOf('猫娘说她住在布鲁克林的一栋房子')).toBe(true)
    expect(await memory.containsSpanOf('he studies computer science, he says')).toBe(true)
    expect(await memory.containsSpanOf('傲娇猫娘，嘴硬心软，句尾爱带喵')).toBe(false)
    expect(await memory.containsSpanOf('')).toBe(false)
  })

  it('throws on a corrupt file, so a caller that publishes can fail closed', async () => {
    const memory = await store()
    await memory.save({ text: 'x', category: 'projects' })
    await writeFile(memory.file, 'not json\n')
    await expect(memory.containsSpanOf('住在布鲁克林的一栋楼')).rejects.toMatchObject({ code: 'corrupt' })
  })
})
