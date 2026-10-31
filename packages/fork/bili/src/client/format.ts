/** Pure presentation helpers of the Bilibili account section: times and durations. */
import type { BiliKey } from './locales.ts'

/** The section's `t`, narrowed to this namespace. */
export type Translate = (key: BiliKey, params?: Record<string, string | number>) => string

/**
 * `HH:MM:SS` of an instant, for the status line.
 * @param ms - Unix epoch milliseconds.
 */
export function stampTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms)
}

/**
 * `MM-DD HH:MM` of an instant in a zone.
 * @param ms - Unix epoch milliseconds.
 * @param timeZone - IANA zone.
 */
export function dateTime(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone === undefined ? {} : { timeZone }) }).formatToParts(ms)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(entry => entry.type === type)?.value ?? ''
  return `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/**
 * How long ago, in the largest whole unit.
 * @param ms - the past instant.
 * @param now - the current instant.
 * @param t - translate.
 */
export function agoText(ms: number, now: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return t('ago.now')
  if (minutes < 60) return t('ago.minutes', { n: minutes })
  if (minutes < 2880) return t('ago.hours', { n: Math.floor(minutes / 60) })
  return t('ago.days', { n: Math.floor(minutes / 1440) })
}
