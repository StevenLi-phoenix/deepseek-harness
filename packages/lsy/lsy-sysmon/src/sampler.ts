/**
 * One system status sample and the cache in front of it. Every probe is a
 * seam (tests replace them), every failure becomes a null field or a
 * `sources`/`skippedMounts` entry, and a sample never rejects. A source that
 * stops or resumes working is logged once per change, not once per request.
 */

import { existsSync, statfsSync } from 'node:fs'
import { cpus, freemem, homedir, loadavg, totalmem, uptime } from 'node:os'
import { join } from 'node:path'
import { nodeExecFile, runMacmon, type ExecFile, type MacmonReading } from './macmon.ts'
import type { CpuReading, DiskReading, MacmonStatus, MemoryReading, SkipReason, SkippedMount, SysmonSnapshot } from './snapshot.ts'

/** One volume to show. */
export interface SysmonMount {
  /** Mount point passed to `statfs`, for example `/Volumes/MiniSSD`. */
  mount: string
  /** Name shown on the volume's row. */
  label: string
}

/** The Mac mini's internal user-data volume and the owner's external SSD. */
export const DEFAULT_MOUNTS: readonly SysmonMount[] = [
  { mount: '/System/Volumes/Data', label: 'Internal' },
  { mount: '/Volumes/MiniSSD', label: 'MiniSSD' },
]

/** Where Homebrew installs macmon. */
export const HOMEBREW_MACMON = '/opt/homebrew/bin/macmon'

/** A forced refresh still reuses a sample younger than this. */
export const MIN_FRESH_MS = 2000

/** A previous sample older than this is too old to measure CPU usage against; the sample's own window is used instead. */
export const CPU_BASELINE_MAX_AGE_MS = 30_000

/** A CPU window shorter than this per core is too coarse for the 10 ms tick counters. */
export const CPU_MIN_WINDOW_PER_CORE_MS = 100

/** The `os.cpus()` fields this package reads. */
export interface CpuTimes {
  readonly times: { readonly user: number; readonly nice: number; readonly sys: number; readonly idle: number; readonly irq: number }
}

/** What `statfs` answers, in blocks. */
export interface FsStats {
  readonly bsize: number
  readonly blocks: number
  readonly bavail: number
}

/** Host probes; tests replace any of them. */
export interface Probes {
  readonly exec: ExecFile
  readonly exists: (path: string) => boolean
  readonly cpus: () => readonly CpuTimes[]
  readonly loadavg: () => readonly number[]
  readonly totalmem: () => number
  readonly freemem: () => number
  readonly uptime: () => number
  readonly statfs: (path: string) => FsStats
  readonly homedir: () => string
  readonly now: () => number
}

/** The real probes. */
export const NODE_PROBES: Probes = {
  exec: nodeExecFile,
  exists: existsSync,
  cpus,
  loadavg,
  totalmem,
  freemem,
  uptime,
  statfs: path => statfsSync(path),
  homedir,
  now: () => Date.now(),
}

/** The slice of the Cordis logger this module writes to. */
export interface SamplerLogger {
  info(message: string): void
  warn(message: string): void
}

/** Summed tick counters of all cores, in milliseconds. */
export interface CpuTicks {
  readonly idle: number
  readonly total: number
  readonly cores: number
}

/**
 * Sum the tick counters of all cores.
 * @param list - `os.cpus()`.
 * @returns idle and total milliseconds and the core count.
 */
export function cpuTicks(list: readonly CpuTimes[]): CpuTicks {
  let idle = 0
  let total = 0
  for (const { times } of list) {
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total, cores: list.length }
}

/**
 * Share of non-idle time between two tick readings.
 * @param previous - the earlier reading; undefined on the first sample.
 * @param current - the later reading.
 * @returns usage in 0-1, or null without a usable window (no earlier reading, a changed core count, or a window too short to measure).
 */
export function cpuUsage(previous: CpuTicks | undefined, current: CpuTicks): number | null {
  if (previous === undefined || previous.cores !== current.cores || current.cores === 0) return null
  const total = current.total - previous.total
  const idle = current.idle - previous.idle
  if (total < current.cores * CPU_MIN_WINDOW_PER_CORE_MS || idle < 0) return null
  return Math.min(1, Math.max(0, 1 - idle / total))
}

function skipReason(error: unknown): SkipReason {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not found'
  if (code === 'EACCES' || code === 'EPERM') return 'not permitted'
  return 'unreadable'
}

/**
 * Read each configured mount with `statfs`.
 * @param mounts - volumes in display order.
 * @param statfs - the `statfs` seam.
 * @returns readings of the mounts that could be read, and the rest with why.
 */
export function readDisks(mounts: readonly SysmonMount[], statfs: Probes['statfs']): { disks: DiskReading[]; skipped: SkippedMount[] } {
  const disks: DiskReading[] = []
  const skipped: SkippedMount[] = []
  for (const { mount, label } of mounts) {
    let stats: FsStats
    try {
      stats = statfs(mount)
    } catch (error) {
      skipped.push({ mount, label, reason: skipReason(error) })
      continue
    }
    const total = stats.blocks * stats.bsize
    const free = Math.min(total, stats.bavail * stats.bsize)
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) {
      skipped.push({ mount, label, reason: 'unreadable' })
      continue
    }
    disks.push({ mount, label, total, used: total - free, free })
  }
  return { disks, skipped }
}

/** Sampler settings. */
export interface SamplerOptions {
  /** Explicit macmon path; unset tries `<home>/bin/macmon`, then Homebrew's. */
  readonly macmonPath?: string | undefined
  readonly mounts: readonly SysmonMount[]
  /** How long a snapshot is served from cache, in milliseconds. */
  readonly cacheMs: number
  readonly logger: SamplerLogger
  readonly probes?: Partial<Probes>
}

function attempt<T>(probe: () => T, fallback: T): T {
  try {
    return probe()
  } catch {
    return fallback
  }
}

/** Samples the Host on demand, caches the snapshot, and shares a sample in flight. */
export class SystemSampler {
  private readonly probes: Probes
  private cached: { readonly at: number; readonly snapshot: SysmonSnapshot } | undefined
  private inFlight: Promise<SysmonSnapshot> | undefined
  private previousCpu: { readonly at: number; readonly ticks: CpuTicks } | undefined
  /** Last logged macmon state and per-mount skip reason, so changes are logged once. */
  private loggedMacmon: MacmonStatus | undefined
  private readonly loggedMounts = new Map<string, SkipReason | 'ok'>()

  /** @param options - mounts, cache age, logger, and probe overrides. */
  constructor(private readonly options: SamplerOptions) {
    this.probes = { ...NODE_PROBES, ...options.probes }
  }

  /**
   * The macmon binary to run.
   * @returns the configured path, else `<home>/bin/macmon` when it exists, else Homebrew's.
   */
  macmonPath(): string {
    if (this.options.macmonPath !== undefined) return this.options.macmonPath
    const own = join(attempt(() => this.probes.homedir(), '/'), 'bin', 'macmon')
    return attempt(() => this.probes.exists(own), false) ? own : HOMEBREW_MACMON
  }

  /**
   * A snapshot no older than `cacheMs`; concurrent callers share one sample.
   * @param fresh - bypass the cache, though not for a sample younger than {@link MIN_FRESH_MS}.
   * @returns the snapshot; never rejects.
   */
  read(fresh = false): Promise<SysmonSnapshot> {
    const maxAge = fresh ? Math.min(MIN_FRESH_MS, this.options.cacheMs) : this.options.cacheMs
    if (this.cached !== undefined && this.probes.now() - this.cached.at < maxAge) return Promise.resolve(this.cached.snapshot)
    this.inFlight ??= this.sample()
      .then((snapshot) => {
        this.cached = { at: this.probes.now(), snapshot }
        return snapshot
      })
      .finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /**
   * Take one uncached sample. CPU usage is measured from the previous sample
   * when it is recent, else across this sample's macmon run (about 600 ms).
   * @returns the snapshot; never rejects.
   */
  async sample(): Promise<SysmonSnapshot> {
    const { probes } = this
    const before = cpuTicks(attempt(() => probes.cpus(), []))
    const path = this.macmonPath()
    const macmon = await runMacmon(probes.exec, path)
    const at = probes.now()
    const after = cpuTicks(attempt(() => probes.cpus(), []))
    const recent = this.previousCpu !== undefined && at - this.previousCpu.at <= CPU_BASELINE_MAX_AGE_MS
    const usage = cpuUsage(recent ? this.previousCpu?.ticks : before, after)
    this.previousCpu = { at, ticks: after }
    this.logMacmon(macmon.status, path, macmon.status === 'ok' ? '' : macmon.reason)
    const reading: MacmonReading | undefined = macmon.status === 'ok' ? macmon.reading : undefined
    const { disks, skipped } = readDisks(this.options.mounts, probes.statfs)
    this.logMounts(disks, skipped)
    const load = attempt(() => probes.loadavg(), [])
    const cpu: CpuReading = {
      usage,
      cores: after.cores,
      load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    }
    return {
      sampledAt: at,
      uptime: attempt(() => probes.uptime(), 0),
      cpu,
      memory: this.memory(reading),
      power: reading?.power ?? null,
      temperature: reading?.temperature ?? null,
      disks,
      skippedMounts: skipped,
      sources: { macmon: macmon.status },
    }
  }

  private memory(reading: MacmonReading | undefined): MemoryReading {
    if (reading?.memory) return { ...reading.memory, approximate: false }
    const total = attempt(() => this.probes.totalmem(), 0)
    const free = attempt(() => this.probes.freemem(), 0)
    return { total, used: Math.max(0, total - free), swapTotal: null, swapUsed: null, approximate: true }
  }

  private logMacmon(status: MacmonStatus, path: string, reason: string): void {
    if (status === this.loggedMacmon) return
    const first = this.loggedMacmon === undefined
    this.loggedMacmon = status
    const { logger } = this.options
    if (status === 'missing') logger.info(`lsy-sysmon: macmon not found at ${path}; power and temperature are not shown (brew install macmon)`)
    else if (status === 'failed') logger.warn(`lsy-sysmon: macmon at ${path} gave no reading (${reason}); power and temperature are not shown`)
    else if (!first) logger.info(`lsy-sysmon: macmon at ${path} reads again`)
  }

  private logMounts(disks: readonly DiskReading[], skipped: readonly SkippedMount[]): void {
    const { logger } = this.options
    for (const { mount } of disks) {
      const previous = this.loggedMounts.get(mount)
      this.loggedMounts.set(mount, 'ok')
      if (previous !== undefined && previous !== 'ok') logger.info(`lsy-sysmon: ${mount} reads again`)
    }
    for (const { mount, reason } of skipped) {
      if (this.loggedMounts.get(mount) === reason) continue
      this.loggedMounts.set(mount, reason)
      logger.warn(`lsy-sysmon: ${mount} skipped (${reason})`)
    }
  }
}
