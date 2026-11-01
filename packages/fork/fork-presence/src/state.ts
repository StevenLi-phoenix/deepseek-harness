/**
 * The presence state machine, pure: what the phone's Sleep Focus, the daily window, and a button in
 * Settings say, and which of them wins. The service keeps the inputs and asks this module for the
 * answer and for the next moment it can change.
 *
 * Precedence: a button that is still in force, then a fresh Focus signal, then the daily window.
 * A Focus signal that arrives after a button ends the button, because the phone has spoken again.
 * Clock times are read in the owner's time zone; on the two days a year the zone changes its offset,
 * a boundary can land an hour off.
 */
import type { FocusView, PresenceSource, QuietWindow } from './view.ts'

const HOUR = 3_600_000
const DAY_SECONDS = 86_400

/** What the machine needs besides the inputs. */
export interface PresenceRules {
  /** IANA zone of the owner. */
  timeZone: string
  window: QuietWindow
  /** How long an awake Focus signal outranks the window, in milliseconds. */
  focusFreshMs: number
  /** How long an asleep Focus signal holds without its off signal, in milliseconds. */
  sleepMaxMs: number
  /** How long a button holds when it names no end, in milliseconds. */
  manualMaxMs: number
}

/** A button pressed in Settings. */
export interface ManualInput {
  asleep: boolean
  at: number
  /** The end the owner named, in Unix epoch milliseconds; the machine caps every button at `manualMaxMs`. */
  until?: number | undefined
}

/** What the machine remembers. */
export interface PresenceInputs {
  focus?: FocusView | undefined
  manual?: ManualInput | undefined
}

/** The answer. */
export interface PresenceState {
  asleep: boolean
  source: PresenceSource
  /** Unix epoch milliseconds the state began; null when nothing says. */
  since: number | null
  /** Unix epoch milliseconds it ends by itself; null when it lasts until the next signal. */
  until: number | null
}

/**
 * Minutes since midnight of an `HH:MM` string.
 * @param clock - `HH:MM`, 24-hour.
 * @returns the minutes.
 */
export function clockMinutes(clock: string): number {
  const [hours = '0', minutes = '0'] = clock.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * Seconds since local midnight.
 * @param ms - an instant in Unix epoch milliseconds.
 * @param timeZone - IANA zone.
 * @returns seconds in `[0, 86400)`.
 */
export function localSeconds(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(ms)
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(entry => entry.type === type)?.value ?? 0)
  return part('hour') * 3600 + part('minute') * 60 + part('second')
}

/**
 * The next instant the local clock reads `clock`, strictly after `now` (a whole minute later at the earliest).
 * @param now - Unix epoch milliseconds.
 * @param clock - `HH:MM`, 24-hour.
 * @param timeZone - IANA zone.
 * @returns the instant in Unix epoch milliseconds.
 */
export function nextClockTime(now: number, clock: string, timeZone: string): number {
  const nowSeconds = localSeconds(now, timeZone)
  let ahead = clockMinutes(clock) * 60 - nowSeconds
  if (ahead <= 0) ahead += DAY_SECONDS
  return now + ahead * 1000
}

/** Where `now` stands against the daily window; undefined while the window is off. */
function windowPosition(now: number, rules: PresenceRules): { inside: boolean; since: number; until: number } | undefined {
  const { window, timeZone } = rules
  const start = clockMinutes(window.start) * 60
  const end = clockMinutes(window.end) * 60
  if (!window.enabled || start === end) return undefined
  const at = localSeconds(now, timeZone)
  const inside = start < end ? at >= start && at < end : at >= start || at < end
  const since = (at - (inside ? start : end) + DAY_SECONDS) % DAY_SECONDS
  const until = ((inside ? end : start) - at + DAY_SECONDS) % DAY_SECONDS
  return { inside, since: now - since * 1000, until: now + until * 1000 }
}

/** The end of a button: the one the owner named, capped at the longest a button holds. */
function manualEnd(manual: ManualInput, rules: PresenceRules): number {
  const cap = manual.at + rules.manualMaxMs
  return manual.until === undefined ? cap : Math.min(manual.until, cap)
}

/** Whether a button still decides: not lapsed, and no Focus signal came after it. */
function manualActive(now: number, inputs: PresenceInputs, rules: PresenceRules): inputs is PresenceInputs & { manual: ManualInput } {
  const { manual, focus } = inputs
  if (manual === undefined || now >= manualEnd(manual, rules)) return false
  return focus === undefined || focus.at <= manual.at
}

/** How long the Focus signal holds, in milliseconds. */
function focusHold(focus: FocusView, rules: PresenceRules): number {
  return focus.asleep ? rules.sleepMaxMs : rules.focusFreshMs
}

/**
 * Decide whether the owner is asleep.
 * @param now - Unix epoch milliseconds.
 * @param inputs - the latest Focus signal and the button in force, if any.
 * @param rules - zone, window, and holding times.
 * @returns the state, its source, and when it began and ends.
 */
export function evaluate(now: number, inputs: PresenceInputs, rules: PresenceRules): PresenceState {
  if (manualActive(now, inputs, rules)) {
    const { manual } = inputs
    return { asleep: manual.asleep, source: 'manual', since: manual.at, until: manualEnd(manual, rules) }
  }
  const { focus } = inputs
  if (focus !== undefined && now - focus.at < focusHold(focus, rules)) {
    return { asleep: focus.asleep, source: 'focus', since: focus.at, until: focus.asleep ? focus.at + rules.sleepMaxMs : null }
  }
  const position = windowPosition(now, rules)
  if (position === undefined) return { asleep: false, source: 'window', since: null, until: null }
  return { asleep: position.inside, source: 'window', since: position.since, until: position.inside ? position.until : null }
}

/**
 * The next instant the answer can change without a new input: a button lapsing, a Focus signal growing
 * stale, or the window opening or closing.
 * @param now - Unix epoch milliseconds.
 * @param inputs - the latest Focus signal and the button in force, if any.
 * @param rules - zone, window, and holding times.
 * @returns the instant, or undefined when nothing is scheduled.
 */
export function nextChange(now: number, inputs: PresenceInputs, rules: PresenceRules): number | undefined {
  const candidates: number[] = []
  if (inputs.manual !== undefined) candidates.push(manualEnd(inputs.manual, rules))
  if (inputs.focus !== undefined) candidates.push(inputs.focus.at + focusHold(inputs.focus, rules))
  const { window } = rules
  if (window.enabled && window.start !== window.end) {
    candidates.push(nextClockTime(now, window.start, rules.timeZone), nextClockTime(now, window.end, rules.timeZone))
  }
  const future = candidates.filter(at => at > now)
  return future.length === 0 ? undefined : Math.min(...future)
}

/**
 * Hours as milliseconds.
 * @param count - hours.
 * @returns milliseconds.
 */
export function hours(count: number): number {
  return count * HOUR
}
