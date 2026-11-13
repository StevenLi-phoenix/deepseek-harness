/** Times as the owner reads them in WeChat: month/day, weekday, and 24-hour clock in one zone, and spans in hours or days. */

const HOUR_MS = 3_600_000

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** The wall-clock parts of an instant in a zone. */
function parts(at: number, timeZone: string): { month: number; day: number; weekday: number; hour: number; minute: number } {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  /* v8 ignore next -- Intl returns every part requested above, so find() always hits; ?? only satisfies the types. */
  const get = (type: Intl.DateTimeFormatPartTypes): string => formatted.find(part => part.type === type)?.value ?? ''
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { month: Number(get('month')), day: Number(get('day')), weekday, hour: Number(get('hour')), minute: Number(get('minute')) }
}

/**
 * An instant as `11/2 周一 22:00` in the zone.
 * @param at - Unix epoch milliseconds.
 * @param timeZone - IANA zone.
 * @returns the label.
 */
export function stamp(at: number, timeZone: string): string {
  const p = parts(at, timeZone)
  /* v8 ignore next -- indexOf over the fixed en-US names gives 0 to 6; ?? only satisfies noUncheckedIndexedAccess. */
  return `${p.month}/${p.day} ${WEEKDAYS[p.weekday] ?? ''} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

/**
 * Minutes since local midnight in the zone.
 * @param at - Unix epoch milliseconds.
 * @param timeZone - IANA zone.
 * @returns 0 to 1439.
 */
export function minuteOfDay(at: number, timeZone: string): number {
  const p = parts(at, timeZone)
  return p.hour * 60 + p.minute
}

/**
 * Whether a local clock time falls in a daily window; a window whose end is earlier than its start wraps midnight.
 * @param at - Unix epoch milliseconds.
 * @param window - `HH:MM` start (inclusive) and end (exclusive).
 * @param timeZone - IANA zone.
 * @returns true inside the window.
 */
export function inWindow(at: number, window: { readonly start: string; readonly end: string }, timeZone: string): boolean {
  const toMinutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))
  const now = minuteOfDay(at, timeZone)
  const start = toMinutes(window.start)
  const end = toMinutes(window.end)
  return start <= end ? now >= start && now < end : now >= start || now < end
}

/**
 * Time left until a deadline as the owner reads it: `不到 1 小时`, `5 小时`, `2 天 3 小时`.
 * @param ms - milliseconds left; zero or less reads `已过`.
 * @returns the label.
 */
export function span(ms: number): string {
  if (ms <= 0) return '已过'
  const hours = Math.floor(ms / HOUR_MS)
  if (hours < 1) return '不到 1 小时'
  if (hours < 48) return `${hours} 小时`
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days} 天` : `${days} 天 ${rest} 小时`
}

/**
 * Hours as milliseconds.
 * @param value - hours.
 * @returns milliseconds.
 */
export function hours(value: number): number {
  return value * HOUR_MS
}
