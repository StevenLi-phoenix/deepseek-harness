/** Wall-clock arithmetic in one IANA time zone: day keys and the stamps prompts show. */

/** Calendar fields of one instant in a zone. */
interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: string
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Calendar fields of `ms` as a clock in `timeZone` shows them. */
function zonedParts(ms: number, timeZone: string): ZonedParts {
  let format = formatters.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
    formatters.set(timeZone, format)
  }
  const parts = format.formatToParts(ms)
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? ''
  return {
    year: Number(value('year')), month: Number(value('month')), day: Number(value('day')),
    hour: Number(value('hour')), minute: Number(value('minute')), second: Number(value('second')),
    weekday: value('weekday'),
  }
}

/** `2026-10-23`-style key of the local day containing `ms`. */
export function dayKey(ms: number, timeZone: string): string {
  const { year, month, day } = zonedParts(ms, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Wall-clock stamp as prompts show it.
 * @param ms - Unix epoch milliseconds.
 * @param timeZone - IANA zone.
 * @returns e.g. `Thu 2026-10-23 12:41`.
 */
export function formatStamp(ms: number, timeZone: string): string {
  const { year, month, day, hour, minute, weekday } = zonedParts(ms, timeZone)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${weekday} ${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`
}

/**
 * Whether `timeZone` is a zone the runtime knows.
 * @param timeZone - candidate IANA name.
 */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
