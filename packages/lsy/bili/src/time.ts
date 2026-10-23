/** Wall-clock arithmetic in one IANA time zone: day keys, local times, and the stamps prompts show. */

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

/** Minutes after local midnight of an `HH:MM` text, or undefined when it is not one. */
export function parseClock(text: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(text)
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined
}

/**
 * The instant a local clock in `timeZone` shows `minutes` after midnight of `day`.
 * Across a DST change the nearest existing instant is used.
 * @param day - `YYYY-MM-DD`.
 * @param minutes - minutes after local midnight; 1440 is the next midnight.
 * @param timeZone - IANA zone.
 * @returns Unix epoch milliseconds.
 */
export function localTime(day: string, minutes: number, timeZone: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const wanted = Date.UTC(year, month - 1, date, 0, minutes)
  let guess = wanted
  // Two corrections settle every zone offset, including one that changes between the guesses.
  for (let step = 0; step < 2; step += 1) {
    const shown = zonedParts(guess, timeZone)
    const shownUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second)
    guess += wanted - shownUtc
  }
  return guess
}

/** Start of the local day after the one containing `ms`. */
export function nextDayStart(ms: number, timeZone: string): number {
  return localTime(dayKey(ms, timeZone), 1440, timeZone)
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
