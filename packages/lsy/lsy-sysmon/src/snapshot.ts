/**
 * What the Host system status route answers, shared by both halves as types
 * only. Every reading the Host could not take is `null`, never `0`.
 */

/** State of the macmon power reader: `missing` when the binary is absent, `failed` when it ran but gave no reading. */
export type MacmonStatus = 'ok' | 'missing' | 'failed'

/** Processor load. */
export interface CpuReading {
  /** Share of non-idle time across all cores, 0-1; null without a measuring window (the first sample without macmon). */
  readonly usage: number | null
  /** Logical cores. */
  readonly cores: number
  /** Load averages over 1, 5, and 15 minutes. */
  readonly load: readonly [number, number, number]
}

/** Memory in bytes. */
export interface MemoryReading {
  readonly total: number
  readonly used: number
  /** Null when macmon gave no reading. */
  readonly swapTotal: number | null
  readonly swapUsed: number | null
  /** True when `used` is total minus free pages from Node (macmon unavailable), which overstates use on macOS. */
  readonly approximate: boolean
}

/** Power draw in watts. */
export interface PowerReading {
  /** Whole machine, from the SMC. */
  readonly system: number | null
  readonly cpu: number | null
  readonly gpu: number | null
  /** Apple Neural Engine. */
  readonly ane: number | null
}

/** Average die temperatures in °C. */
export interface TemperatureReading {
  readonly cpu: number | null
  readonly gpu: number | null
}

/** One volume, in bytes. `used` is everything not available to the Host user, so `used + free = total`. */
export interface DiskReading {
  readonly mount: string
  readonly label: string
  readonly total: number
  readonly used: number
  readonly free: number
}

/** Why a configured mount has no reading. */
export type SkipReason = 'not found' | 'not permitted' | 'unreadable'

/** A configured mount that could not be read, such as an unplugged external disk. */
export interface SkippedMount {
  readonly mount: string
  readonly label: string
  readonly reason: SkipReason
}

/** Body of `GET api/lsy.sysmon`. */
export interface SysmonSnapshot {
  /** When the sample was taken, epoch milliseconds. */
  readonly sampledAt: number
  /** Host uptime in seconds. */
  readonly uptime: number
  readonly cpu: CpuReading
  readonly memory: MemoryReading
  /** Null without macmon or without power sensors (virtual machines). */
  readonly power: PowerReading | null
  /** Null without macmon or without temperature sensors. */
  readonly temperature: TemperatureReading | null
  /** Configured mounts that could be read, in configuration order. */
  readonly disks: readonly DiskReading[]
  /** Configured mounts that could not be read. */
  readonly skippedMounts: readonly SkippedMount[]
  readonly sources: { readonly macmon: MacmonStatus }
}

/** Absolute Host registration path of the system status route. */
export const SYSMON_PATH = '/api/lsy.sysmon'
/** Document-relative form the browser fetches. */
export const SYSMON_ROUTE = SYSMON_PATH.slice(1)
