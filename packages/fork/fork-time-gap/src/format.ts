/** Wall-clock stamps and gap lengths as the fork's prompts write them; fork-wechat shares these. */

/**
 * Wall-clock time as a Session reads it.
 * @param ms - Unix epoch milliseconds.
 * @param timeZone - IANA zone.
 * @returns e.g. `Thu 2026-10-22 08:49`.
 */
export function formatStamp(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms)
  /* v8 ignore next -- Intl returns every part requested above, so find() always hits and the empty fallback only satisfies the types */
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === type)?.value ?? ''
  return `${part('weekday')} ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/**
 * A duration rounded down to whole minutes, at most two units.
 * @param ms - milliseconds; negative counts as zero.
 * @returns e.g. `12 min`, `5 h 39 min`, `2 d 3 h`, or `under a minute`.
 */
export function formatGap(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'under a minute'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`
  if (hours > 0) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`
  return `${rest} min`
}
