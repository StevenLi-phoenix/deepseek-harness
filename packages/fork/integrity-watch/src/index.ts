/**
 * Integrity watch for the owner's main agent.
 *
 * The agent's behaviour is steered by a few files it (or a stranger it listens to) could change:
 * the profile patches that can override a persona, the instruction files of its workspaces, the skill
 * directories, the memory file, and the scheduled tasks. This plugin keeps their digests, tells the
 * owner on WeChat when one changes (the name, never the content), logs a hash of every Session's
 * system prompt so a persona edit shows in the log, and counts the stock lines the persona forbids.
 *
 * @module @deepseek-ai/dsh-integrity-watch
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { mountScanner } from './scanner.ts'
import { targetsFor } from './scan.ts'
import { mountSessionWatch } from './session-watch.ts'

export { ABSENT, digestOf, INSTRUCTION_FILES, targetsFor, type Target, type TargetKind } from './scan.ts'
export { compileTic, ticHits, TICS } from './tics.ts'
export { integrityNotice, scan, type Change, type TaskCounts, type TrustedSchedule } from './compare.ts'

/** Plugin name. */
export const name = 'integrity-watch'

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
  /** Directory of the state files; defaults to `<DSH_HOME>/integrity-watch`. */
  stateDir?: string
  /** The memory file whose digest is checked against the memory history; defaults to `<DSH_HOME>/owner-memory/memory.jsonl`. */
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

/**
 * Start the watch.
 * @param ctx - the root context.
 * @param config - settings.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) {
    ctx.logger.info('integrity-watch: disabled by configuration')
    return
  }
  const home = resolveDshHome(undefined, process.env)
  const stateDir = config.stateDir ?? join(home, 'integrity-watch')
  mountScanner(ctx, {
    targets: targetsFor(home, config.workspaces ?? [], homedir()),
    memoryFile: config.memoryFile ?? join(home, 'owner-memory', 'memory.jsonl'),
    baselineFile: join(stateDir, 'baseline.json'),
    trustedFile: join(stateDir, 'schedule-trusted.json'),
    intervalMs: (config.intervalSec ?? 300) * 1000,
    notify: config.notify !== false,
    minGapMs: (config.minGapSec ?? 1800) * 1000,
    perDay: config.noticesPerDay ?? 6,
  })
  // Persona hashes and the stock-line count follow the Sessions' own events.
  mountSessionWatch(ctx, stateDir, new Set(config.ticPresets ?? ['unattended', 'bili']))
}
