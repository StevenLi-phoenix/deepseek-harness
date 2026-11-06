import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lastHistorySha, readJson, sha256, writeJson } from '../src/files.ts'
import { NoticeGate } from '../src/scanner.ts'
import { countAnswer, textOf, type TicCounts } from '../src/session-watch.ts'
import { trustedOf } from '../src/schedule-trust.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-integrity-parts-'))
  dirs.push(dir)
  return dir
}

describe('NoticeGate', () => {
  const MINUTE = 60_000
  const noon = new Date('2026-11-02T12:00:00').getTime()

  it('lets the first notice go, then holds the next inside the minimum gap', () => {
    const gate = new NoticeGate(30 * MINUTE, 6)
    expect(gate.holdBack(noon)).toBeUndefined()
    gate.sent(noon)
    expect(gate.holdBack(noon + 10 * MINUTE)).toBe('minimum gap')
    expect(gate.holdBack(noon + 30 * MINUTE)).toBeUndefined()
  })

  it('stops at the daily limit whatever the gap, and starts a new day with a clean count', () => {
    const gate = new NoticeGate(0, 2)
    gate.sent(noon)
    gate.sent(noon + MINUTE)
    expect(gate.holdBack(noon + 2 * MINUTE)).toBe('daily limit')
    expect(gate.holdBack(noon + 24 * 60 * MINUTE)).toBeUndefined()
  })

  it('names the daily limit before the gap when both hold', () => {
    const gate = new NoticeGate(30 * MINUTE, 1)
    gate.sent(noon)
    expect(gate.holdBack(noon + MINUTE)).toBe('daily limit')
  })
})

describe('countAnswer', () => {
  it('counts answers, answers with a forbidden line, hits, and hits per line', () => {
    const counts: TicCounts = { days: {} }
    expect(countAnswer(counts, '2026-11-02', [])).toEqual({ answers: 1, answersWithHits: 0, hits: 0, perLine: {} })
    expect(countAnswer(counts, '2026-11-02', [3, 3, 7])).toEqual({ answers: 2, answersWithHits: 1, hits: 3, perLine: { 3: 2, 7: 1 } })
    expect(countAnswer(counts, '2026-11-03', [3]).answers).toBe(1)
    expect(Object.keys(counts.days)).toEqual(['2026-11-02', '2026-11-03'])
  })

  it('keeps the sixty most recent days', () => {
    const counts: TicCounts = { days: {} }
    for (let day = 1; day <= 65; day += 1) countAnswer(counts, `2026-${String(Math.ceil(day / 28)).padStart(2, '0')}-${String(((day - 1) % 28) + 1).padStart(2, '0')}`, [])
    const days = Object.keys(counts.days).toSorted()
    expect(days).toHaveLength(60)
    expect(days[0]).toBe('2026-01-06')
    expect(days.at(-1)).toBe('2026-03-09')
  })
})

describe('textOf', () => {
  it('joins the text blocks of a message and ignores the rest', () => {
    expect(textOf({ content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo')
    expect(textOf({ content: 'plain' })).toBe('')
    expect(textOf({})).toBe('')
  })
})

describe('state files', () => {
  it('writes JSON atomically at mode 600, creates the directory, and reads it back', async () => {
    const dir = await tmp()
    const path = join(dir, 'nested', 'state.json')
    await writeJson(path, { a: 1 })
    expect(await readJson(path)).toEqual({ a: 1 })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700)
  })

  it('reads a missing or torn file as undefined', async () => {
    const dir = await tmp()
    expect(await readJson(join(dir, 'none.json'))).toBeUndefined()
    await writeFile(join(dir, 'torn.json'), '{"a":')
    expect(await readJson(join(dir, 'torn.json'))).toBeUndefined()
  })

  it('takes the last sha of the memory history, skipping a torn line', async () => {
    const dir = await tmp()
    const memory = join(dir, 'memory.jsonl')
    expect(await lastHistorySha(memory)).toBeUndefined()
    await writeFile(join(dir, 'memory.history.jsonl'), `${JSON.stringify({ sha: 'aaa' })}\n${JSON.stringify({ sha: 'bbb' })}\n{"sha": \n\n`)
    expect(await lastHistorySha(memory)).toBe('bbb')
    await writeFile(join(dir, 'memory.history.jsonl'), '\n')
    expect(await lastHistorySha(memory)).toBeUndefined()
  })

  it('hashes with SHA-256 and stamps a trusted schedule state', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(trustedOf('d', undefined)).toMatchObject({ digest: 'd' })
    expect(trustedOf('d', undefined)).not.toHaveProperty('tasks')
    expect(trustedOf('d', { t: 'x' })).toMatchObject({ digest: 'd', tasks: { t: 'x' } })
  })
})
