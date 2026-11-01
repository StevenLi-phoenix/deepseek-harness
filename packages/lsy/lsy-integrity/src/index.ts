/**
 * Integrity watch for the owner's main agent.
 *
 * The agent's behaviour is steered by a few files it (or a stranger it listens to) could change:
 * the profile patches that can override a persona, the instruction files of its workspaces, the skill
 * directories, the memory file, and the scheduled tasks. This plugin keeps their digests, tells the
 * owner on WeChat when one changes (the name, never the content), logs a hash of every Session's
 * system prompt so a persona edit shows in the log, and counts the stock lines the persona forbids.
 *
 * @module @deepseek-ai/dsh-lsy-integrity
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-lsy-event-bus'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { ABSENT, diffTasks, digestOf, scheduleState, targetsFor, type Target } from './scan.ts'
import { ticHits, TICS } from './tics.ts'

export { ABSENT, digestOf, INSTRUCTION_FILES, targetsFor, type Target, type TargetKind } from './scan.ts'
export { compileTic, ticHits, TICS } from './tics.ts'

/** Plugin name. */
export const name = 'lsy-integrity'

/** Settings. */
export interface Config {
  /** Turn the whole watch off. */
  enabled?: boolean
  /** Directories the agent works in: their instruction files and skill directories are watched. */
  workspaces?: string[]
  /** Seconds between scans. */
  intervalSec?: number
  /** Tell the owner on WeChat when a target changes. */
  notify?: boolean
  /** Fewest seconds between two notices; changes seen sooner wait for the next one. */
  minGapSec?: number
  /** Notices in a day. */
  noticesPerDay?: number
  /** Agent presets whose answers are checked for the persona's forbidden stock lines. */
  ticPresets?: string[]
  /** Directory of the state files; defaults to `<DSH_HOME>/lsy-integrity`. */
  stateDir?: string
  /** The memory file whose digest is checked against the memory history; defaults to `<DSH_HOME>/lsy-memory/memory.jsonl`. */
  memoryFile?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  workspaces: z.array(z.string()).default([]),
  intervalSec: z.natural().min(5).default(300),
  notify: z.boolean().default(true),
  minGapSec: z.natural().min(0).default(1800),
  noticesPerDay: z.natural().min(1).default(6),
  ticPresets: z.array(z.string()).default(['unattended', 'bili']),
  stateDir: z.string(),
  memoryFile: z.string(),
})

const trustedOf = (digest: string, tasks: Record<string, string> | undefined): TrustedSchedule => (
  { at: new Date().toISOString(), digest, ...tasks === undefined ? {} : { tasks } }
)

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** What the baseline file holds. */
interface Baseline {
  at: string
  digests: Record<string, string>
  /** The definition digest of each scheduled task at the last scan, to count what a direct edit changed. */
  scheduleTasks?: Record<string, string>
}

/**
 * The scheduled tasks as the schedule service last wrote them. Every `schedule/changed` event follows a
 * durable write of the service, so the file as it stood then is legitimate; a file that differs from it
 * was edited behind the service's back.
 */
export interface TrustedSchedule {
  at: string
  digest: string
  tasks?: Record<string, string>
}

/** How many tasks a direct edit of the schedule file added, removed, and changed. */
export interface TaskCounts {
  readonly added: number
  readonly removed: number
  readonly changed: number
}

/** One change between the baseline and now. */
export interface Change {
  readonly target: string
  readonly label: string
  readonly kind: 'changed' | 'added' | 'removed'
  /** For the schedule file: how many tasks differ (counts only), when the earlier state is known. */
  readonly counts?: TaskCounts
}

/** Per-day counters of the forbidden stock lines. */
interface TicDay {
  answers: number
  answersWithHits: number
  hits: number
  perLine: Record<string, number>
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/** The SHA the memory history last recorded for the memory file, if there is a history. */
async function lastHistorySha(memoryFile: string): Promise<string | undefined> {
  try {
    const lines = (await readFile(join(dirname(memoryFile), 'memory.history.jsonl'), 'utf8')).split('\n').filter(line => line.trim() !== '')
    for (const line of lines.toReversed()) {
      try {
        const sha = (JSON.parse(line) as { sha?: unknown }).sha
        if (typeof sha === 'string') return sha
      } catch {
        // A torn line is skipped.
      }
    }
  } catch {
    // No history yet.
  }
  return undefined
}

/**
 * Compare the targets with a baseline.
 * @param targets - what to watch.
 * @param baseline - digests from the last scan; absent on the first run.
 * @param memoryFile - the memory file, checked against its history.
 * @param trusted - the schedule file as the schedule service last wrote it; a schedule file equal to it is not a change.
 * @returns the new digests, the task digests of the schedule file, and the changes (none when there is no baseline).
 */
export async function scan(
  targets: readonly Target[], baseline: Baseline | undefined, memoryFile: string, trusted?: TrustedSchedule,
): Promise<{ digests: Record<string, string>; scheduleTasks?: Record<string, string>; changes: Change[] }> {
  const digests: Record<string, string> = {}
  const changes: Change[] = []
  let scheduleTasks: Record<string, string> | undefined
  const compare = (target: string, label: string, was: string | undefined, now: string): void => {
    digests[target] = now
    if (was === undefined || was === now) return
    changes.push({ target, label, kind: was === ABSENT ? 'added' : now === ABSENT ? 'removed' : 'changed' })
  }
  for (const target of targets) {
    if (target.kind !== 'schedule') {
      compare(target.name, target.label, baseline?.digests[target.name], await digestOf(target))
      continue
    }
    // The schedule changes all day through the schedule service; it is a change only when it is not what the service last wrote.
    const state = await scheduleState(target.path)
    scheduleTasks = state.tasks
    const was = baseline?.digests[target.name]
    digests[target.name] = state.digest
    if (was === undefined || was === state.digest || trusted?.digest === state.digest) continue
    const earlier = trusted?.tasks ?? baseline?.scheduleTasks
    changes.push({
      target: target.name, label: target.label, kind: was === ABSENT ? 'added' : state.digest === ABSENT ? 'removed' : 'changed',
      ...earlier !== undefined && state.tasks !== undefined ? { counts: diffTasks(earlier, state.tasks) } : {},
    })
  }
  // The memory file changes legitimately all day; it is a change only when it is not what the memory history last wrote.
  let memory = ABSENT
  try {
    memory = sha256(await readFile(memoryFile, 'utf8'))
  } catch {
    // Absent.
  }
  const expected = await lastHistorySha(memoryFile) ?? baseline?.digests['memory']
  digests['memory'] = memory
  if (expected !== undefined && expected !== memory && baseline !== undefined) changes.push({ target: 'memory', label: '记忆文件 memory.jsonl（不是经记忆工具改的）', kind: 'changed' })
  return { digests, ...scheduleTasks === undefined ? {} : { scheduleTasks }, changes }
}

/**
 * The notice for a set of changes.
 * @param changes - what differs from the baseline.
 */
export function integrityNotice(changes: readonly Change[]): { title: string; body?: string } {
  const verb = { changed: '被改动', added: '新出现', removed: '被删除' } as const
  const bypass = { changed: '直接改动', added: '直接新建', removed: '直接删除' } as const
  const countsOf = (change: Change): string | undefined => {
    const counts = change.counts
    return counts === undefined ? undefined : `新增 ${String(counts.added)} 条、删除 ${String(counts.removed)} 条、修改 ${String(counts.changed)} 条`
  }
  const line = (change: Change): string => {
    if (change.target !== 'schedule') return `· ${change.label}：${verb[change.kind]}`
    const counts = countsOf(change)
    return `· 定时任务文件被绕过 DSH ${bypass[change.kind]}${counts === undefined ? '' : `：${counts}`}`
  }
  const [only] = changes
  if (changes.length === 1 && only !== undefined) {
    if (only.target !== 'schedule') return { title: `${only.label} ${verb[only.kind]}了（不显示内容）` }
    const counts = countsOf(only)
    return { title: `定时任务文件被绕过 DSH ${bypass[only.kind]}了（不显示内容）`, ...counts === undefined ? {} : { body: counts } }
  }
  return {
    title: `有 ${String(changes.length)} 处受监控的文件被改动（不显示内容）`,
    body: [...changes.slice(0, 8).map(line), ...changes.length > 8 ? [`…另有 ${String(changes.length - 8)} 处`] : []].join('\n'),
  }
}

/** Text of a message's content blocks. */
function textOf(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return ''
  return (message.content as Array<{ type?: string; text?: string }>).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/**
 * Start the watch.
 * @param ctx - the root context.
 * @param config - settings.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) {
    ctx.logger.info('lsy-integrity: disabled by configuration')
    return
  }
  const home = resolveDshHome(undefined, process.env)
  const stateDir = config.stateDir ?? join(home, 'lsy-integrity')
  const memoryFile = config.memoryFile ?? join(home, 'lsy-memory', 'memory.jsonl')
  const targets = targetsFor(home, config.workspaces ?? [], homedir())
  const baselineFile = join(stateDir, 'baseline.json')
  const trustedFile = join(stateDir, 'schedule-trusted.json')
  const scheduleTarget = targets.find(target => target.kind === 'schedule')
  const intervalMs = (config.intervalSec ?? 300) * 1000
  const minGapMs = (config.minGapSec ?? 1800) * 1000
  const perDay = config.noticesPerDay ?? 6
  let lastNoticeAt = 0
  let sentToday = { day: '', count: 0 }
  let scanning: Promise<void> = Promise.resolve()
  // The schedule service announces every durable write; the file as it stands then is the legitimate state.
  let trusting: Promise<void> = Promise.resolve()
  let trustVersion = 0
  const trustSchedule = async (): Promise<void> => {
    if (scheduleTarget === undefined) return
    const state = await scheduleState(scheduleTarget.path)
    if (state.digest === 'unreadable') {
      ctx.logger.warn('lsy-integrity: schedule file unreadable right after a schedule change; the last trusted state stays')
      return
    }
    await writeJson(trustedFile, trustedOf(state.digest, state.tasks))
    ctx.logger.info('lsy-integrity: schedule written through the service: %d task(s), digest %s', Object.keys(state.tasks ?? {}).length, state.digest.slice(0, 12))
  }
  if (scheduleTarget !== undefined) {
    ctx.on('schedule/changed', () => {
      trustVersion += 1
      trusting = trusting.then(trustSchedule).catch((error: unknown) => {
        ctx.logger.warn('lsy-integrity: recording the schedule state failed: %s', error instanceof Error ? error.message : String(error))
      })
    })
  }

  const runScan = async (): Promise<void> => {
    const baseline = await readJson<Baseline>(baselineFile)
    let found: Awaited<ReturnType<typeof scan>>
    let trusted: TrustedSchedule | undefined
    // A schedule write that lands while the scan reads the file is announced a moment later: look again once it is recorded.
    for (let attempt = 0; ; attempt += 1) {
      await trusting
      const version = trustVersion
      trusted = await readJson<TrustedSchedule>(trustedFile)
      found = await scan(targets, baseline, memoryFile, trusted)
      if (version === trustVersion || attempt >= 2) break
    }
    const { digests, scheduleTasks, changes } = found
    const stored = (): Baseline => ({ at: new Date().toISOString(), digests, ...scheduleTasks === undefined ? {} : { scheduleTasks } })
    // A schedule state nobody has reported yet is accepted as the trusted one: the first baseline, or a scan that found nothing new.
    const seedTrusted = async (): Promise<void> => {
      if (scheduleTarget === undefined || trusted !== undefined) return
      await writeJson(trustedFile, trustedOf(digests[scheduleTarget.name] ?? ABSENT, scheduleTasks))
    }
    if (baseline === undefined) {
      await writeJson(baselineFile, stored())
      await seedTrusted()
      ctx.logger.info('lsy-integrity: baseline of %d target(s) written', Object.keys(digests).length)
      return
    }
    if (changes.length === 0) {
      const moved = JSON.stringify(digests) !== JSON.stringify(baseline.digests)
        || JSON.stringify(scheduleTasks) !== JSON.stringify(baseline.scheduleTasks)
      if (moved) await writeJson(baselineFile, stored())
      await seedTrusted()
      return
    }
    ctx.logger.warn('lsy-integrity: %d target(s) changed: %s', changes.length, changes.map(change => `${change.target} (${change.kind})`).join(', '))
    const now = Date.now()
    const day = new Date(now).toDateString()
    if (sentToday.day !== day) sentToday = { day, count: 0 }
    const wait = now - lastNoticeAt < minGapMs || sentToday.count >= perDay
    // A change that waits stays out of the baseline, so the next scan finds it again and the notice merges what piled up.
    if (config.notify !== false && wait) {
      ctx.logger.info('lsy-integrity: notice held back (%s)', sentToday.count >= perDay ? 'daily limit' : 'minimum gap')
      return
    }
    const notifier = ctx.get('lsyNotifier')
    if (config.notify !== false && notifier !== undefined) {
      const note = integrityNotice(changes)
      try {
        await notifier.send({ title: note.title, ...note.body === undefined ? {} : { body: note.body }, safety: true, origin: 'the integrity watch of your own host (a notice to the owner that a file steering the agent changed)' })
        lastNoticeAt = now
        sentToday.count += 1
        ctx.logger.info('lsy-integrity: told the owner about %d change(s)', changes.length)
      } catch (error: unknown) {
        ctx.logger.warn('lsy-integrity: notice failed, will retry: %s', error instanceof Error ? error.message : String(error))
        return
      }
    }
    await writeJson(baselineFile, stored())
  }

  const schedule = (): void => {
    scanning = scanning.then(runScan).catch((error: unknown) => {
      ctx.logger.warn('lsy-integrity: scan failed: %s', error instanceof Error ? error.message : String(error))
    })
  }
  schedule()
  const timer = setInterval(schedule, intervalMs)
  timer.unref()
  ctx.effect(() => () => { clearInterval(timer) }, 'lsy-integrity: stop scanning')

  // Persona hashes and the stock-line count follow the Sessions' own events.
  const personaFile = join(stateDir, 'persona.json')
  const ticsFile = join(stateDir, 'tics.json')
  const ticPresets = new Set(config.ticPresets ?? ['unattended', 'bili'])
  const tics = { days: {} as Record<string, TicDay> }
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
        ctx.logger.info('lsy-integrity: session %s preset %s system prompt sha256:%s (%d chars)', session.id, preset, sha, text.length)
        if (was !== undefined && was !== sha) ctx.logger.warn('lsy-integrity: the system prompt of preset %s changed (sha256:%s -> sha256:%s); expected after an upgrade or a model switch, not otherwise', preset, was, sha)
        if (was !== sha) {
          seenPersona.set(preset, sha)
          await writeJson(personaFile, Object.fromEntries(seenPersona)).catch(() => undefined)
        }
      })()
    } else if (event.type === 'turn/end' && ticPresets.has(preset)) {
      let answer = ''
      for (let seq = event.seq - 1; seq >= 0; seq -= 1) {
        // oxlint-disable-next-line typescript/no-deprecated -- Same Session history read as lsy-memory's visibility check.
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
        const entry = tics.days[day] ?? { answers: 0, answersWithHits: 0, hits: 0, perLine: {} }
        entry.answers += 1
        if (hits.length > 0) entry.answersWithHits += 1
        entry.hits += hits.length
        for (const index of hits) entry.perLine[String(index)] = (entry.perLine[String(index)] ?? 0) + 1
        tics.days[day] = entry
        for (const old of Object.keys(tics.days).toSorted().slice(0, -60)) Reflect.deleteProperty(tics.days, old)
        ctx.logger.info('lsy-integrity: tics session %s preset %s answer %d chars: %d of %d forbidden lines (day %s: %d/%d answers)', session.id, preset, answer.length, hits.length, TICS.length, day, entry.answersWithHits, entry.answers)
        await writeJson(ticsFile, tics).catch(() => undefined)
      })()
    }
  })
}
