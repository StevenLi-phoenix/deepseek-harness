import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AnswerLog, readTrend, TREND_DAYS } from '../src/trend.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})
async function dir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'fork-style-trend-'))
  dirs.push(path)
  return path
}

describe('AnswerLog', () => {
  it('counts answers and characters per day, keeping the other days', async () => {
    const root = await dir()
    const log = new AnswerLog(join(root, 'sub', 'answers.json'))
    await log.record('2026-11-01', 10)
    await log.record('2026-11-01', 5)
    await log.record('2026-11-02', 7)
    expect(JSON.parse(await readFile(log.file, 'utf8'))).toEqual({ days: { '2026-11-01': { answers: 2, chars: 15 }, '2026-11-02': { answers: 1, chars: 7 } } })
  })

  it('treats damaged counts as zero and keeps only the newest 60 days', async () => {
    const root = await dir()
    const file = join(root, 'answers.json')
    const old = Object.fromEntries(Array.from({ length: 61 }, (_, index) => [`2026-01-${String(index + 1).padStart(2, '0')}`, { answers: 1, chars: 1 }]))
    await writeFile(file, JSON.stringify({ days: { ...old, '2026-12-01': { answers: 'many', chars: -3 } } }))
    await new AnswerLog(file).record('2026-12-01', 4)
    const stored = (JSON.parse(await readFile(file, 'utf8')) as { days: Record<string, unknown> }).days
    expect(Object.keys(stored)).toHaveLength(60)
    expect(stored['2026-12-01']).toEqual({ answers: 1, chars: 4 })
    expect(stored['2026-01-01']).toBeUndefined()
    expect(stored['2026-01-02']).toBeUndefined()
    expect(stored['2026-01-03']).toEqual({ answers: 1, chars: 1 })
  })

  it('swallows a write failure and goes on with the next answer', async () => {
    const root = await dir()
    await writeFile(join(root, 'blocker'), 'a file')
    const broken = new AnswerLog(join(root, 'blocker', 'answers.json'))
    await expect(broken.record('2026-11-01', 3)).resolves.toBeUndefined()
    const fine = new AnswerLog(join(root, 'ok', 'answers.json'))
    await fine.record('2026-11-01', 3)
    expect(JSON.parse(await readFile(fine.file, 'utf8'))).toEqual({ days: { '2026-11-01': { answers: 1, chars: 3 } } })
  })
})

describe('readTrend', () => {
  it('joins the stock-line counts with the answer lengths by day, oldest first, last 14 days only', async () => {
    const root = await dir()
    const tics = join(root, 'tics.json')
    const answers = join(root, 'answers.json')
    const ticDays = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`2026-10-${String(index + 1).padStart(2, '0')}`, { answers: 10, answersWithHits: 2 }]))
    await writeFile(tics, JSON.stringify({ days: { ...ticDays, 'not-a-day': { answers: 1 } } }))
    await writeFile(answers, JSON.stringify({ days: { '2026-10-16': { answers: 4, chars: 90 }, '2026-10-17': { answers: 0, chars: 0 } } }))
    const trend = await readTrend(tics, answers)
    expect(trend).toHaveLength(TREND_DAYS)
    expect(trend[0]!.day).toBe('2026-10-04')
    expect(trend.at(-1)).toEqual({ day: '2026-10-17', answers: 0, withTics: 0, mainAnswers: 0, meanChars: null })
    expect(trend.at(-2)).toEqual({ day: '2026-10-16', answers: 10, withTics: 2, mainAnswers: 4, meanChars: 23 })
  })

  it('answers an empty trend when neither file exists or holds days', async () => {
    const root = await dir()
    await mkdir(join(root, 'x'))
    await writeFile(join(root, 'odd.json'), '{"days":5}')
    expect(await readTrend(join(root, 'missing.json'), join(root, 'odd.json'))).toEqual([])
  })
})
