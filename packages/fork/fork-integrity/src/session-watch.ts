/**
 * What the Sessions' own events tell: a hash of every Session's system prompt (a persona edit shows in the log, and a
 * preset whose prompt changed is warned about), and a per-day count of the stock lines the persona forbids.
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import { readJson, sha256, writeJson } from './files.ts'
import { ticHits, TICS } from './tics.ts'

/** Per-day counters of the forbidden stock lines. */
interface TicDay {
  answers: number
  answersWithHits: number
  hits: number
  perLine: Record<string, number>
}

/** Text of a message's content blocks. */
export function textOf(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return ''
  return (message.content as Array<{ type?: string; text?: string }>).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/** The day-by-day counts, as stored. */
export interface TicCounts {
  days: Record<string, TicDay>
}

/** Days of counts kept. */
const TIC_DAYS_KEPT = 60

/**
 * Add one answer to a day's counts and drop days beyond the sixty most recent.
 * @param counts - the counts, changed in place.
 * @param day - `YYYY-MM-DD`.
 * @param hits - indexes of the forbidden lines the answer used (repeats count again).
 * @returns the day's counts after this answer.
 */
export function countAnswer(counts: TicCounts, day: string, hits: readonly number[]): TicDay {
  const entry = counts.days[day] ?? { answers: 0, answersWithHits: 0, hits: 0, perLine: {} }
  entry.answers += 1
  if (hits.length > 0) entry.answersWithHits += 1
  entry.hits += hits.length
  for (const index of hits) entry.perLine[String(index)] = (entry.perLine[String(index)] ?? 0) + 1
  counts.days[day] = entry
  for (const old of Object.keys(counts.days).toSorted().slice(0, -TIC_DAYS_KEPT)) Reflect.deleteProperty(counts.days, old)
  return entry
}

/**
 * Follow the Sessions' events.
 * @param ctx - the root context.
 * @param stateDir - where `persona.json` and `tics.json` live.
 * @param ticPresets - the presets whose answers are checked for forbidden lines.
 */
export function mountSessionWatch(ctx: Context, stateDir: string, ticPresets: ReadonlySet<string>): void {
  const personaFile = join(stateDir, 'persona.json')
  const ticsFile = join(stateDir, 'tics.json')
  const tics: TicCounts = { days: {} }
  let ticsLoaded: Promise<void> | undefined
  const loadTics = (): Promise<void> => {
    ticsLoaded ??= readJson<typeof tics>(ticsFile).then((stored) => { if (stored?.days !== undefined) tics.days = stored.days })
    return ticsLoaded
  }
  const seenPersona = new Map<string, string>()
  let personaLoaded: Promise<void> | undefined
  const loadPersona = (): Promise<void> => {
    personaLoaded ??= readJson<Record<string, string>>(personaFile).then((stored) => {
      for (const [preset, sha] of Object.entries(stored ?? {})) seenPersona.set(preset, sha)
    })
    return personaLoaded
  }

  ctx.on('session/event', (session, event) => {
    const preset = session.header.agentPreset ?? 'unknown'
    if (event.type === 'system/message') {
      const text = textOf(event.data.message)
      // An empty prompt means "none yet"; it carries no persona to hash.
      if (text === '') return
      const sha = sha256(text).slice(0, 12)
      void (async () => {
        await loadPersona()
        const was = seenPersona.get(preset)
        ctx.logger.info('fork-integrity: session %s preset %s system prompt sha256:%s (%d chars)', session.id, preset, sha, text.length)
        if (was !== undefined && was !== sha) ctx.logger.warn('fork-integrity: the system prompt of preset %s changed (sha256:%s -> sha256:%s); expected after an upgrade or a model switch, not otherwise', preset, was, sha)
        if (was !== sha) {
          seenPersona.set(preset, sha)
          await writeJson(personaFile, Object.fromEntries(seenPersona)).catch(() => undefined)
        }
      })()
    } else if (event.type === 'turn/end' && ticPresets.has(preset)) {
      let answer = ''
      for (let seq = event.seq - 1; seq >= 0; seq -= 1) {
        // oxlint-disable-next-line typescript/no-deprecated -- Same Session history read as fork-memory's visibility check.
        const earlier = session.eventAt(seq as never)
        if (earlier?.type === 'turn/start') break
        if (earlier?.type === 'assistant/message') {
          answer = textOf(earlier.data.message)
          break
        }
      }
      if (answer.trim() === '' || answer.trim() === 'NO_REPLY') return
      const hits = ticHits(answer)
      void (async () => {
        await loadTics()
        const day = new Date().toISOString().slice(0, 10)
        const entry = countAnswer(tics, day, hits)
        ctx.logger.info('fork-integrity: tics session %s preset %s answer %d chars: %d of %d forbidden lines (day %s: %d/%d answers)', session.id, preset, answer.length, hits.length, TICS.length, day, entry.answersWithHits, entry.answers)
        await writeJson(ticsFile, tics).catch(() => undefined)
      })()
    }
  })
}
