/** Pure presentation helpers of the WeChat section: times and durations. */
import type { PresenceKey } from './locales.ts'

/** The section's `t`, narrowed to this namespace. */
export type Translate = (key: PresenceKey, params?: Record<string, string | number>) => string

/**
 * `HH:MM:SS` of an instant, for the status line.
 * @param ms - Unix epoch milliseconds.
 * @returns the time of day, 24-hour.
 */
export function stampTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms)
}

/**
 * `MM-DD HH:MM` of an instant in a zone.
 * @param ms - Unix epoch milliseconds.
 * @param timeZone - IANA zone.
 * @returns the date and time in that zone.
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
 * @returns for example `3 min ago`.
 */
export function agoText(ms: number, now: number, t: Translate): string {
  const seconds = Math.floor(Math.max(0, now - ms) / 1000)
  if (seconds < 5) return t('ago.now')
  if (seconds < 60) return t('ago.seconds', { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('ago.minutes', { n: minutes })
  if (minutes < 2880) return t('ago.hours', { n: Math.floor(minutes / 60) })
  return t('ago.days', { n: Math.floor(minutes / 1440) })
}
