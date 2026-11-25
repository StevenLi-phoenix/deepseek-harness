/** Times and durations as a Settings section prints them. */

/** Copy keys {@link formatDuration} reads. */
export type DurationKey = 'duration.days' | 'duration.hours' | 'duration.minutes'

/** Copy keys {@link minutesAgo} reads; each gets `{ n }`. */
export type MinutesAgoKey = 'ago.minutes' | 'ago.hours' | 'ago.days'

/**
 * How long ago a span of whole minutes is, in the largest whole unit: minutes under an hour, hours under two days, then
 * days.
 * @param minutes - the span in whole minutes, at least 1.
 * @param t - translate.
 * @returns the translated text.
 */
export function minutesAgo(minutes: number, t: (key: MinutesAgoKey, params: Record<string, number>) => string): string {
  if (minutes < 60) return t('ago.minutes', { n: minutes })
  if (minutes < 2880) return t('ago.hours', { n: Math.floor(minutes / 60) })
  return t('ago.days', { n: Math.floor(minutes / 1440) })
}

/**
 * `HH:MM:SS` of an instant, for a status line.
 * @param ms - Unix epoch milliseconds.
 * @returns the time of day in the runtime's zone, 24-hour.
 */
export function stampTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms)
}

/**
 * `MM-DD HH:MM` of an instant in a zone.
 * @param ms - Unix epoch milliseconds.
 * @param timeZone - IANA zone; the runtime's zone when omitted.
 * @returns the date and time in that zone.
 */
export function dateTime(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone === undefined ? {} : { timeZone }) }).formatToParts(ms)
  /* v8 ignore next -- the formatter always yields month, day, hour, and minute parts; `?? ''` only satisfies the index type. */
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(entry => entry.type === type)?.value ?? ''
  return `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/**
 * A span as a coarse duration: days and hours, hours and minutes, or minutes.
 * @param seconds - the span; negative counts as 0.
 * @param t - translate; `duration.days` gets `{ days, hours }`, `duration.hours` `{ hours, minutes }`, `duration.minutes` `{ minutes }`.
 * @returns the translated text.
 */
export function formatDuration(seconds: number, t: (key: DurationKey, params: Record<string, number>) => string): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return t('duration.days', { days, hours: hours % 24 })
  if (hours > 0) return t('duration.hours', { hours, minutes: minutes % 60 })
  return t('duration.minutes', { minutes })
}
