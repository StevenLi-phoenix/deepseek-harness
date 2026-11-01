/**
 * The measurement the Settings page shows next to the samples: per day, how many answers held one of the persona's
 * forbidden stock lines (fork-integrity's `tics.json`, read only) and how long the main agent's answers were
 * (`answers.json`, kept here: counts and character sums only, never text).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TrendDay } from './view.ts'

/** Days kept in `answers.json` and shown on the page. */
export const TREND_DAYS = 14
const KEPT_DAYS = 60

/** One day of answer lengths. */
interface AnswerDay {
  answers: number
  chars: number
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

const days = (value: unknown): Record<string, Record<string, unknown>> => {
  const inner = typeof value === 'object' && value !== null ? (value as { days?: unknown }).days : undefined
  return typeof inner === 'object' && inner !== null ? inner as Record<string, Record<string, unknown>> : {}
}
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)

/** Answer lengths per day, written by the collect-mode plugin as the main agent's turns end. */
export class AnswerLog {
  private chain: Promise<void> = Promise.resolve()

  /** @param file - absolute path of `answers.json`. */
  constructor(readonly file: string) {}

  /**
   * Count one answer.
   * @param day - `YYYY-MM-DD` (UTC, as fork-integrity counts).
   * @param chars - its length in characters.
   * @returns settlement after the file is written.
   */
  record(day: string, chars: number): Promise<void> {
    this.chain = this.chain.then(async () => {
      const stored = days(await readJson(this.file))
      const entry: AnswerDay = { answers: count(stored[day]?.['answers']) + 1, chars: count(stored[day]?.['chars']) + chars }
      const next: Record<string, AnswerDay> = {}
      for (const key of Object.keys(stored).toSorted().slice(-KEPT_DAYS)) next[key] = { answers: count(stored[key]?.['answers']), chars: count(stored[key]?.['chars']) }
      next[day] = entry
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${String(process.pid)}.tmp`
      await writeFile(temporary, `${JSON.stringify({ days: next })}\n`, { mode: 0o600 })
      await rename(temporary, this.file)
    }).catch(() => undefined)
    return this.chain
  }
}

/**
 * The last {@link TREND_DAYS} days that have any data, oldest first.
 * @param ticsFile - fork-integrity's `tics.json`.
 * @param answersFile - this package's `answers.json`.
 * @returns the days.
 */
export async function readTrend(ticsFile: string, answersFile: string): Promise<TrendDay[]> {
  const tics = days(await readJson(ticsFile))
  const answers = days(await readJson(answersFile))
  const keys = [...new Set([...Object.keys(tics), ...Object.keys(answers)])]
    .filter(key => /^\d{4}-\d{2}-\d{2}$/u.test(key))
    .toSorted()
    .slice(-TREND_DAYS)
  return keys.map((day) => {
    const mainAnswers = count(answers[day]?.['answers'])
    return {
      day,
      answers: count(tics[day]?.['answers']),
      withTics: count(tics[day]?.['answersWithHits']),
      mainAnswers,
      meanChars: mainAnswers === 0 ? null : Math.round(count(answers[day]?.['chars']) / mainAnswers),
    }
  })
}
