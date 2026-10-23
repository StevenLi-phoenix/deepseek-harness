/**
 * What the System status section shows, as pure functions over a snapshot:
 * the CPU, Memory, Power, and Storage cards, the status line, and the unit
 * formatting they share. Sizes use binary units with GB/TB labels, as
 * Activity Monitor and `df -h` count them.
 */

import type { SysmonSnapshot } from '../snapshot.ts'
import type { SysmonKey } from './locales.ts'
import type { SysmonState } from './sysmon.ts'

/** The translate seat this module formats with. */
export type Translate = (key: SysmonKey, params?: Record<string, string | number>) => string

/** Bar colour: amber from {@link WARN_RATIO}, red from {@link CRITICAL_RATIO}. */
export type Level = 'normal' | 'warn' | 'critical'

/** Share used at which a bar turns amber. */
export const WARN_RATIO = 0.85
/** Share used at which a bar turns red. */
export const CRITICAL_RATIO = 0.95

/** One bar: share filled, 0-1, and its colour. */
export interface Meter {
  readonly ratio: number
  readonly level: Level
}

/** The CPU card. */
export interface CpuCard {
  readonly value: string
  readonly meter: Meter | null
  readonly cores: string
  readonly details: readonly string[]
}

/** The Memory card. */
export interface MemoryCard {
  readonly value: string
  readonly total: string
  readonly meter: Meter | null
  readonly details: readonly string[]
}

/** Why the Power card has no reading; `missing` comes with the install command. */
export interface PowerNotice {
  readonly kind: 'missing' | 'failed' | 'unsupported'
  readonly text: string
}

/** The Power card. */
export interface PowerCard {
  /** Whole-machine watts; null when there is no power reading. */
  readonly value: string | null
  readonly details: readonly string[]
  readonly notice: PowerNotice | null
}

/** One volume row of the Storage card. */
export interface StorageRow {
  readonly key: string
  readonly label: string
  readonly mount: string
  /** Share used as text; empty for a skipped mount. */
  readonly percent: string
  readonly meter: Meter | null
  readonly details: readonly string[]
}

/** The line above the cards. */
export interface StatusLine {
  readonly text: string
  readonly tone: 'loading' | 'live' | 'stale'
}

/** The Homebrew command the Power card offers when macmon is missing. */
export const INSTALL_MACMON = 'brew install macmon'

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** Fixed digits without a trailing `.0`. */
function trimmed(value: number, digits: number): string {
  const text = value.toFixed(digits)
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

function clamp(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0
}

/**
 * @param ratio - share used, 0-1.
 * @returns the bar colour for that share.
 */
export function usageLevel(ratio: number): Level {
  if (ratio >= CRITICAL_RATIO) return 'critical'
  if (ratio >= WARN_RATIO) return 'warn'
  return 'normal'
}

/**
 * @param bytes - a size.
 * @returns the size in binary units, one decimal below 100: `10.8 GB`, `245 GB`, `3.6 TB`.
 */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${trimmed(value, unit === 0 || value >= 100 ? 0 : 1)} ${BYTE_UNITS[unit]}`
}

/**
 * @param ratio - a share, 0-1.
 * @returns whole percent.
 */
export function formatPercent(ratio: number): string {
  return `${Math.round(clamp(ratio) * 100)}%`
}

/**
 * @param watts - a power reading.
 * @param t - translate seat.
 * @returns one decimal below 10 W, whole watts above; the unknown mark for null.
 */
export function formatWatts(watts: number | null, t: Translate): string {
  return watts === null ? t('value.unknown') : `${trimmed(watts, watts < 10 ? 1 : 0)} W`
}

/**
 * @param celsius - a temperature reading.
 * @param t - translate seat.
 * @returns whole degrees; the unknown mark for null.
 */
export function formatCelsius(celsius: number | null, t: Translate): string {
  return celsius === null ? t('value.unknown') : `${Math.round(celsius)} °C`
}

/**
 * @param seconds - an uptime.
 * @param t - translate seat.
 * @returns days and hours, hours and minutes, or minutes.
 */
export function formatDuration(seconds: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return t('duration.days', { days, hours: hours % 24 })
  if (hours > 0) return t('duration.hours', { hours, minutes: minutes % 60 })
  return t('duration.minutes', { minutes })
}

/**
 * @param at - epoch milliseconds.
 * @returns local `HH:MM:SS`.
 */
export function clock(at: number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}

/**
 * @param snapshot - the Host's answer.
 * @param t - translate seat.
 * @returns usage, core count, and load averages.
 */
export function cpuCard(snapshot: SysmonSnapshot, t: Translate): CpuCard {
  const { usage, cores, load } = snapshot.cpu
  const loadLine = t('cpu.load', { load: load.map(value => value.toFixed(2)).join(' / ') })
  return {
    value: usage === null ? t('value.unknown') : formatPercent(usage),
    meter: usage === null ? null : { ratio: clamp(usage), level: 'normal' },
    cores: t('cpu.cores', { cores }),
    details: usage === null ? [t('cpu.measuring'), loadLine] : [loadLine],
  }
}

/**
 * Memory used against total, with swap. An approximate reading (no macmon)
 * counts cached pages as used, so its bar keeps the normal colour.
 * @param snapshot - the Host's answer.
 * @param t - translate seat.
 * @returns the card.
 */
export function memoryCard(snapshot: SysmonSnapshot, t: Translate): MemoryCard {
  const { total, used, swapTotal, swapUsed, approximate } = snapshot.memory
  const ratio = total > 0 ? clamp(used / total) : null
  const details: string[] = []
  if (swapTotal !== null && swapUsed !== null && swapTotal > 0) {
    details.push(t('memory.swap', { used: formatBytes(swapUsed), total: formatBytes(swapTotal) }))
  }
  if (approximate) details.push(t('memory.approximate'))
  return {
    value: formatBytes(used),
    total: t('memory.of', { total: formatBytes(total) }),
    meter: ratio === null ? null : { ratio, level: approximate ? 'normal' : usageLevel(ratio) },
    details,
  }
}

/**
 * Whole-machine power with its parts and die temperatures, or why there is none.
 * @param snapshot - the Host's answer.
 * @param t - translate seat.
 * @returns the card.
 */
export function powerCard(snapshot: SysmonSnapshot, t: Translate): PowerCard {
  const { power, temperature } = snapshot
  const temperatureLine = temperature === null
    ? []
    : [t('power.temperature', { cpu: formatCelsius(temperature.cpu, t), gpu: formatCelsius(temperature.gpu, t) })]
  if (snapshot.sources.macmon === 'missing') return { value: null, details: [], notice: { kind: 'missing', text: t('power.missing') } }
  if (snapshot.sources.macmon === 'failed') return { value: null, details: [], notice: { kind: 'failed', text: t('power.failed') } }
  if (power === null) return { value: null, details: temperatureLine, notice: { kind: 'unsupported', text: t('power.unsupported') } }
  return {
    value: formatWatts(power.system, t),
    details: [
      t('power.parts', { cpu: formatWatts(power.cpu, t), gpu: formatWatts(power.gpu, t), ane: formatWatts(power.ane, t) }),
      ...temperatureLine,
    ],
    notice: null,
  }
}

/**
 * One row per configured volume: readable ones in configuration order, then
 * the skipped ones with why.
 * @param snapshot - the Host's answer.
 * @param t - translate seat.
 * @returns the rows.
 */
export function storageRows(snapshot: SysmonSnapshot, t: Translate): StorageRow[] {
  const read = snapshot.disks.map((disk): StorageRow => {
    const ratio = disk.total > 0 ? clamp(disk.used / disk.total) : 0
    return {
      key: disk.mount,
      label: disk.label,
      mount: disk.mount,
      percent: formatPercent(ratio),
      meter: { ratio, level: usageLevel(ratio) },
      details: [
        t('storage.used', { used: formatBytes(disk.used), total: formatBytes(disk.total) }),
        t('storage.free', { free: formatBytes(disk.free) }),
      ],
    }
  })
  const skipped = snapshot.skippedMounts.map((mount): StorageRow => ({
    key: mount.mount,
    label: mount.label,
    mount: mount.mount,
    percent: '',
    meter: null,
    details: [t('storage.skipped', { reason: t(`reason.${mount.reason}`) })],
  }))
  return [...read, ...skipped]
}

/**
 * @param state - the store state.
 * @param t - translate seat.
 * @returns when the shown reading was taken, and whether it is current.
 */
export function statusLine(state: SysmonState, t: Translate): StatusLine {
  if (state.snapshot === null) return state.stale ? { text: t('status.failed'), tone: 'stale' } : { text: t('status.loading'), tone: 'loading' }
  const time = clock(state.snapshot.sampledAt)
  return state.stale ? { text: t('status.stale', { time }), tone: 'stale' } : { text: t('status.live', { time }), tone: 'live' }
}
