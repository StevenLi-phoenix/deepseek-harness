/**
 * Auto-archive: a periodic sweep that archives chat Sessions nobody has touched for a while, so the sidebar stays short.
 * It only archives, through the Host's own `workspaceRegistry.archiveSession` (which asks every `workspace/session-activity`
 * provider first and refuses a Session with a running turn, agent, job, or scheduled task); it never deletes, and
 * an archived Session is one click from the archive list in the Web UI.
 *
 * Which Sessions are left alone is decided here in a fixed order, so every skip lands in exactly one category:
 * `recent`, `subagent`, `running`, `pinned`, `persistent` (a subscription's persistent Session), `subscription` (a
 * Session whose agent created a run-time subscription or watch), then one category per registered protector
 * ({@link SessionArchiver.protect}, for example `wechat`, `qq`). A protector that throws protects the Session.
 */

import z from '@deepseek-ai/schemastery'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z as zod } from 'zod'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
/** Archived Sessions kept in the "recently archived" table. */
export const MAX_RECENT_ARCHIVED = 200
/** Would-archive rows kept from a dry run. */
const MAX_PREVIEW = 100
/** Most skipped-Session ids listed per category in a sweep report. */
const MAX_SKIPPED_IDS = 20

/** Auto-archive configuration (the `autoArchive` block of the bus configuration). */
export interface AutoArchiveConfig {
  /** Run the sweep. */
  enabled: boolean
  /** Archive Sessions whose last message is older than this many days. */
  inactiveDays: number
  /** Select and log, but archive nothing. */
  dryRun: boolean
  /** Most Sessions archived by one sweep; the rest wait for the next. */
  maxPerSweep: number
  /** Minutes after startup before the first sweep. */
  firstSweepMinutes: number
  /** Hours between sweeps. */
  sweepHours: number
}

/** Defaults of {@link AutoArchiveConfig}. */
export const AUTO_ARCHIVE_DEFAULTS: AutoArchiveConfig = {
  enabled: true,
  inactiveDays: 7,
  dryRun: false,
  maxPerSweep: 50,
  firstSweepMinutes: 10,
  sweepHours: 6,
}

/** Configuration schema of the `autoArchive` block. */
export const autoArchiveSchema: z<AutoArchiveConfig> = z.object({
  enabled: z.boolean().default(AUTO_ARCHIVE_DEFAULTS.enabled),
  inactiveDays: z.number().min(1).default(AUTO_ARCHIVE_DEFAULTS.inactiveDays),
  dryRun: z.boolean().default(AUTO_ARCHIVE_DEFAULTS.dryRun),
  maxPerSweep: z.natural().min(1).default(AUTO_ARCHIVE_DEFAULTS.maxPerSweep),
  firstSweepMinutes: z.number().min(0).default(AUTO_ARCHIVE_DEFAULTS.firstSweepMinutes),
  sweepHours: z.number().min(0.01).default(AUTO_ARCHIVE_DEFAULTS.sweepHours),
})

/**
 * Fill a configuration block with the defaults. A configuration that has no block at all (a plain object that did not
 * go through the schema) keeps auto-archive off, so only a deployment that went through the schema sweeps.
 * @param block - the `autoArchive` value of the bus configuration.
 * @returns the effective settings.
 */
export function resolveAutoArchive(block: Partial<AutoArchiveConfig> | undefined): AutoArchiveConfig {
  if (block === undefined) return { ...AUTO_ARCHIVE_DEFAULTS, enabled: false }
  return { ...AUTO_ARCHIVE_DEFAULTS, ...block }
}

const archivedRecordSchema = zod.object({
  sessionId: zod.string().min(1),
  title: zod.string().optional(),
  cwd: zod.string().optional(),
  archivedAt: zod.number(),
  /** Time of the Session's last message when it was archived. */
  lastActiveAt: zod.number(),
}).strict()

/** One Session the sweep archived. */
export type ArchivedRecord = zod.infer<typeof archivedRecordSchema>

/** Storage of the "recently archived" table. */
export const archiveDomain = defineDomain({
  name: 'fork_event_bus_archive',
  version: 1,
  tables: {
    archived: domainTable<string, ArchivedRecord>(archivedRecordSchema),
  },
})

/** One Session as the sweep reads it. */
export interface SessionRow {
  readonly id: string
  /** Time of the last message, Unix epoch milliseconds. */
  readonly updatedAt: number
  /** A turn is running. */
  readonly running: boolean
  /** A subagent's Session; it belongs to its parent. */
  readonly subagent: boolean
  readonly cwd?: string | undefined
  readonly title?: string | undefined
}

/** What a protector sees of a Session. */
export type ProtectedSession = Pick<SessionRow, 'id' | 'updatedAt' | 'cwd' | 'title'>

/**
 * A plugin's claim on its own Sessions: return `true` (or a short reason) to keep the Session out of the sweep.
 * Called only for Sessions that are otherwise due; may be async. A throw protects the Session.
 */
export type SessionProtector = (session: ProtectedSession) => boolean | string | undefined | Promise<boolean | string | undefined>

/** Handle a plugin gets from {@link SessionArchiver.protect}; call it to withdraw the claim. */
export type ProtectionDisposer = () => void

/** What the sweep needs from the Host, replaceable in tests. */
export interface ArchiveHost {
  /** Every Session the Host lists, archived ones included. */
  list(signal: AbortSignal): Promise<readonly SessionRow[]>
  archivedIds(): ReadonlySet<string>
  pinnedIds(): ReadonlySet<string>
  /** Archive one Session through the Host's registry; rejects when it cannot. */
  archive(id: string): Promise<void>
  /** Sessions the bus itself keeps, by category (`persistent`, `subscription`). */
  builtinProtected(): ReadonlyMap<string, string>
  now(): number
}

/** Result of one sweep. */
export interface SweepReport {
  at: number
  durationMs: number
  trigger: 'timer' | 'manual'
  dryRun: boolean
  /** Sessions the Host listed. */
  scanned: number
  /** Archived before the sweep. */
  alreadyArchived: number
  /** Due Sessions no rule protected. */
  due: number
  archived: string[]
  /** The Sessions a dry run would have archived. */
  wouldArchive: Array<{ id: string; title?: string; lastActiveAt: number }>
  /** Skipped Sessions per category. */
  skipped: Record<string, number>
  /** A few ids per category, for the log. */
  skippedIds: Record<string, string[]>
  /** Failures: `id: reason`. */
  errors: string[]
  /** Set when the sweep could not run (listing failed, registry missing). */
  aborted?: string
}

/** Status for health and Settings. */
export interface ArchiveStatus {
  enabled: boolean
  dryRun: boolean
  inactiveDays: number
  maxPerSweep: number
  sweepHours: number
  /** When the next sweep is due; undefined while disabled or stopped. */
  nextSweepAt?: number
  /** Labels of the registered protectors. */
  protectors: string[]
  lastSweep?: SweepReport
  /** Newest first. */
  recent: ArchivedRecord[]
}

/** Logger surface the archiver needs. */
export interface ArchiveLogger {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

/** Scheduler surface (a Cordis `ctx.timeout`). */
export type ArchiveTimeout = (callback: () => void, ms: number) => () => void

/** What a sweep selected before anything was archived. */
export interface Selection {
  candidates: SessionRow[]
  skipped: Map<string, string[]>
  alreadyArchived: number
}

/**
 * Decide which Sessions a sweep archives. Pure: protectors are the only async part.
 * @param rows - the Sessions the Host lists.
 * @param options - the clock, the threshold, the archived and pinned sets, the bus's own protections, and the protectors.
 * @returns candidates oldest first, plus the skipped ids per category.
 */
export async function selectSessions(rows: readonly SessionRow[], options: {
  now: number
  inactiveMs: number
  archived: ReadonlySet<string>
  pinned: ReadonlySet<string>
  builtin: ReadonlyMap<string, string>
  protectors: ReadonlyArray<{ label: string; check: SessionProtector }>
  onProtectorError?: (label: string, id: string, error: unknown) => void
}): Promise<Selection> {
  const skipped = new Map<string, string[]>()
  const skip = (category: string, id: string): void => {
    const list = skipped.get(category)
    if (list === undefined) skipped.set(category, [id])
    else list.push(id)
  }
  let alreadyArchived = 0
  const candidates: SessionRow[] = []
  for (const row of [...rows].sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (options.archived.has(row.id)) { alreadyArchived += 1; continue }
    if (options.now - row.updatedAt < options.inactiveMs) { skip('recent', row.id); continue }
    if (row.subagent) { skip('subagent', row.id); continue }
    if (row.running) { skip('running', row.id); continue }
    if (options.pinned.has(row.id)) { skip('pinned', row.id); continue }
    const builtin = options.builtin.get(row.id)
    if (builtin !== undefined) { skip(builtin, row.id); continue }
    let category: string | undefined
    for (const protector of options.protectors) {
      try {
        const verdict = await protector.check({ id: row.id, updatedAt: row.updatedAt, cwd: row.cwd, title: row.title })
        if (verdict !== undefined && verdict !== false) { category = protector.label; break }
      } catch (error: unknown) {
        options.onProtectorError?.(protector.label, row.id, error)
        category = protector.label
        break
      }
    }
    if (category !== undefined) { skip(category, row.id); continue }
    candidates.push(row)
  }
  return { candidates, skipped, alreadyArchived }
}

/** A registry refusal that means "something still runs in this Session". */
function isActiveRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === 'WorkspaceActiveSessionError'
}

/** Error text for logs. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns the sweep timer, the protector registry, the last report, and the recently-archived table. */
export class SessionArchiver {
  private readonly protectors: Array<{ label: string; check: SessionProtector }> = []
  private nextAt: number | undefined
  private cancelTimer: (() => void) | undefined
  private running: Promise<SweepReport> | undefined
  private last: SweepReport | undefined
  private domain: Domain<typeof archiveDomain> | undefined
  private stopped = true
  private readonly abort = new AbortController()

  /**
   * @param config - effective settings.
   * @param host - Host access.
   * @param logger - log sink.
   * @param timeout - one-shot scheduler; its disposer cancels.
   * @param open - opens the table storage; omitted keeps the recent list in memory only.
   */
  constructor(
    private readonly config: AutoArchiveConfig,
    private readonly host: ArchiveHost,
    private readonly logger: ArchiveLogger,
    private readonly timeout: ArchiveTimeout,
    private readonly open?: () => Promise<Domain<typeof archiveDomain>>,
  ) {}

  /**
   * Claim Sessions for a plugin: the sweep skips every Session `check` accepts. Registering twice with one label
   * keeps both. The disposer withdraws the claim; plugins register inside an effect so a reload withdraws it.
   * @param label - skip category name, for example `wechat`.
   * @param check - the claim.
   * @returns the disposer.
   */
  protect(label: string, check: SessionProtector): ProtectionDisposer {
    const entry = { label, check }
    this.protectors.push(entry)
    this.logger.debug(`fork-event-bus: auto-archive protector "${label}" registered`)
    return () => {
      const index = this.protectors.indexOf(entry)
      if (index >= 0) this.protectors.splice(index, 1)
      this.logger.debug(`fork-event-bus: auto-archive protector "${label}" withdrawn`)
    }
  }

  /** Open storage and arm the first sweep; a disabled archiver only opens storage so the table stays readable. */
  async start(): Promise<void> {
    this.stopped = false
    if (this.open !== undefined) {
      try { this.domain = await this.open() } catch (error: unknown) { this.logger.warn(`fork-event-bus: auto-archive table unavailable (${errorText(error)}); the recent list is kept in memory`) }
    }
    if (!this.config.enabled) {
      this.logger.info('fork-event-bus: auto-archive is disabled')
      return
    }
    this.arm(Math.max(0, this.config.firstSweepMinutes) * MINUTE_MS)
    this.logger.info(`fork-event-bus: auto-archive on: Sessions idle over ${this.config.inactiveDays} day(s), at most ${this.config.maxPerSweep} per sweep, every ${this.config.sweepHours} h${this.config.dryRun ? ' (dry run)' : ''}; first sweep in ${this.config.firstSweepMinutes} min`)
  }

  /** Cancel the timer, abort a running sweep, and wait for it. */
  async stop(): Promise<void> {
    this.stopped = true
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.nextAt = undefined
    this.abort.abort()
    await this.running?.catch(() => undefined)
    await this.domain?.close()
    this.domain = undefined
  }

  private arm(ms: number): void {
    this.cancelTimer?.()
    if (this.stopped) return
    this.nextAt = this.host.now() + ms
    this.cancelTimer = this.timeout(() => {
      this.cancelTimer = undefined
      void this.sweep('timer').catch((error: unknown) => { this.logger.warn(`fork-event-bus: auto-archive sweep failed: ${errorText(error)}`) })
        .finally(() => { this.arm(this.config.sweepHours * HOUR_MS) })
    }, ms)
  }

  /**
   * Run one sweep now. A sweep already running is joined instead of started twice.
   * @param trigger - `manual` for the Settings button, `timer` for the schedule.
   * @param override - `dryRun: true` previews without archiving, whatever the configuration says.
   * @returns the report.
   */
  sweep(trigger: 'timer' | 'manual' = 'manual', override: { dryRun?: boolean } = {}): Promise<SweepReport> {
    if (this.running !== undefined) return this.running
    const work = this.run(trigger, override.dryRun ?? this.config.dryRun).finally(() => { this.running = undefined })
    this.running = work
    return work
  }

  private async run(trigger: 'timer' | 'manual', dryRun: boolean): Promise<SweepReport> {
    const started = this.host.now()
    const report: SweepReport = {
      at: started, durationMs: 0, trigger, dryRun, scanned: 0, alreadyArchived: 0, due: 0,
      archived: [], wouldArchive: [], skipped: {}, skippedIds: {}, errors: [],
    }
    const finish = (): SweepReport => {
      report.durationMs = this.host.now() - started
      this.last = report
      const skippedText = Object.entries(report.skipped).map(([category, count]) => `${category}=${count}`).join(' ') || 'none'
      if (report.aborted !== undefined) {
        this.logger.warn(`fork-event-bus: auto-archive sweep aborted: ${report.aborted}`)
      } else {
        this.logger.info(`fork-event-bus: auto-archive sweep (${trigger}${dryRun ? ', dry run' : ''}): scanned ${report.scanned}, already archived ${report.alreadyArchived}, due ${report.due}, ${dryRun ? `would archive ${report.wouldArchive.length}` : `archived ${report.archived.length}`}, skipped ${skippedText}${report.errors.length > 0 ? `, errors ${report.errors.length}` : ''} in ${report.durationMs} ms${report.archived.length > 0 ? `; archived ${report.archived.join(', ')}` : ''}`)
        for (const [category, ids] of Object.entries(report.skippedIds)) {
          if (category === 'recent') continue
          this.logger.debug(`fork-event-bus: auto-archive skipped ${category}: ${ids.join(', ')}${(report.skipped[category] ?? 0) > ids.length ? ', …' : ''}`)
        }
        for (const line of report.errors) this.logger.warn(`fork-event-bus: auto-archive could not archive ${line}`)
      }
      return report
    }
    let rows: readonly SessionRow[]
    try {
      rows = await this.host.list(this.abort.signal)
    } catch (error: unknown) {
      report.aborted = `could not list Sessions: ${errorText(error)}`
      return finish()
    }
    report.scanned = rows.length
    const selection = await selectSessions(rows, {
      now: this.host.now(),
      inactiveMs: this.config.inactiveDays * DAY_MS,
      archived: this.host.archivedIds(),
      pinned: this.host.pinnedIds(),
      builtin: this.host.builtinProtected(),
      protectors: [...this.protectors],
      onProtectorError: (label, id, error) => { this.logger.warn(`fork-event-bus: auto-archive protector "${label}" failed for ${id} (${errorText(error)}); the Session is kept`) },
    })
    report.alreadyArchived = selection.alreadyArchived
    for (const [category, ids] of selection.skipped) {
      report.skipped[category] = ids.length
      report.skippedIds[category] = ids.slice(0, MAX_SKIPPED_IDS)
    }
    report.due = selection.candidates.length
    const batch = selection.candidates.slice(0, this.config.maxPerSweep)
    const over = selection.candidates.length - batch.length
    if (over > 0) report.skipped.overLimit = over
    for (const row of batch) {
      if (this.abort.signal.aborted) { report.aborted = 'stopped'; break }
      if (dryRun) {
        report.wouldArchive.push({ id: row.id, ...(row.title === undefined ? {} : { title: row.title }), lastActiveAt: row.updatedAt })
        continue
      }
      try {
        await this.host.archive(row.id)
        report.archived.push(row.id)
        await this.remember(row)
      } catch (error: unknown) {
        if (isActiveRefusal(error)) {
          report.skipped.active = (report.skipped.active ?? 0) + 1
          ;(report.skippedIds.active ??= []).push(row.id)
        } else {
          report.errors.push(`${row.id}: ${errorText(error)}`)
        }
      }
    }
    report.wouldArchive = report.wouldArchive.slice(0, MAX_PREVIEW)
    return finish()
  }

  private recentMemory: ArchivedRecord[] = []

  /** Add an archived Session to the recent table and trim it. */
  private async remember(row: SessionRow): Promise<void> {
    const record: ArchivedRecord = {
      sessionId: row.id,
      ...(row.title === undefined ? {} : { title: row.title }),
      ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
      archivedAt: this.host.now(),
      lastActiveAt: row.updatedAt,
    }
    const table = this.domain?.table('archived')
    if (table === undefined) {
      this.recentMemory = [record, ...this.recentMemory.filter(entry => entry.sessionId !== row.id)].slice(0, MAX_RECENT_ARCHIVED)
      return
    }
    try {
      await table.put(row.id, record)
      const excess = table.size - MAX_RECENT_ARCHIVED
      if (excess > 0) {
        const oldest = [...table.entries()].map(([key, value]) => ({ key, at: value.archivedAt })).sort((a, b) => a.at - b.at).slice(0, excess)
        for (const victim of oldest) await table.delete(victim.key)
      }
    } catch (error: unknown) {
      this.logger.warn(`fork-event-bus: could not record archived Session ${row.id} (${errorText(error)})`)
    }
  }

  /**
   * Read-only view for health and Settings.
   * @returns the settings, the schedule, the labels of the protectors, the last report, and the recently archived Sessions.
   */
  status(): ArchiveStatus {
    const table = this.domain?.table('archived')
    const recent = table === undefined ? this.recentMemory : [...table.entries()].map(([, value]) => value)
    return {
      enabled: this.config.enabled,
      dryRun: this.config.dryRun,
      inactiveDays: this.config.inactiveDays,
      maxPerSweep: this.config.maxPerSweep,
      sweepHours: this.config.sweepHours,
      ...(this.nextAt === undefined ? {} : { nextSweepAt: this.nextAt }),
      protectors: [...new Set(this.protectors.map(entry => entry.label))],
      ...(this.last === undefined ? {} : { lastSweep: this.last }),
      recent: [...recent].sort((a, b) => b.archivedAt - a.archivedAt),
    }
  }
}
