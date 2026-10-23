/**
 * Time-of-day model pricing, as configuration data. A rule names the
 * providers it prices and their peak periods in UTC; everything outside the
 * peaks is off-peak. Pure interval arithmetic: which peak an instant falls in,
 * what part of an interval is off-peak, and when off-peak starts next. No
 * schedule lives in code; the deployment's bundle supplies it.
 */

/** UTC weekdays, in `getUTCDay()` order. */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
/** One of {@link WEEKDAYS}. */
export type Weekday = typeof WEEKDAYS[number]

/** One recurring peak period, in UTC. */
export interface PeakSpan {
  /** UTC weekdays the span applies to. */
  days: Weekday[]
  /** `HH:MM` UTC, inclusive. */
  start: string
  /** `HH:MM` UTC, exclusive, after `start`; `24:00` is the end of the day. */
  end: string
}

/** The time-of-day pricing of some model providers. */
export interface PricingRule {
  /** Provider ids (route keys) this rule prices, e.g. `deepseek-official`. */
  providers: string[]
  /** Peak periods in UTC; every other time is off-peak. */
  peak: PeakSpan[]
  /** UTC dates (`YYYY-MM-DD`) with no peak at all, such as public holidays. */
  noPeakDates?: string[]
}

/** A half-open interval `[start, end)` in Unix epoch milliseconds. */
export type Interval = readonly [number, number]

const DAY_MS = 86_400_000
/** How far {@link nextOffPeak} looks ahead before it gives up. */
const SEARCH_DAYS = 14

/** Minutes after UTC midnight of an `HH:MM` text; `24:00` only where `end` allows it. */
function minutesOf(text: string, end: boolean): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(text)
  if (match === null) return undefined
  const minutes = Number(match[1]) * 60 + Number(match[2])
  if (Number(match[2]) >= 60) return undefined
  return minutes < 1440 || (end && minutes === 1440) ? minutes : undefined
}

/**
 * Check pricing rules at load time.
 * @param rules - configured rules.
 * @returns why they cannot work, or undefined.
 */
export function pricingProblem(rules: readonly PricingRule[]): string | undefined {
  const seen = new Set<string>()
  for (const [index, rule] of rules.entries()) {
    if (rule.providers.length === 0) return `pricing[${index}] lists no providers`
    for (const provider of rule.providers) {
      if (seen.has(provider)) return `pricing[${index}] repeats provider "${provider}"`
      seen.add(provider)
    }
    for (const [spanIndex, span] of rule.peak.entries()) {
      const where = `pricing[${index}].peak[${spanIndex}]`
      if (span.days.length === 0) return `${where} lists no days`
      const unknown = span.days.find(day => !(WEEKDAYS as readonly string[]).includes(day))
      if (unknown !== undefined) return `${where} has an unknown day "${unknown}"; use ${WEEKDAYS.join(', ')}`
      const start = minutesOf(span.start, false)
      const end = minutesOf(span.end, true)
      if (start === undefined || end === undefined || end <= start) return `${where} must use HH:MM UTC times, start before end`
    }
    for (const [dateIndex, date] of (rule.noPeakDates ?? []).entries()) {
      const parsed = Date.parse(`${date}T00:00:00Z`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
        return `pricing[${index}].noPeakDates[${dateIndex}] must be a UTC date (YYYY-MM-DD)`
      }
    }
    // A week of peaks with no gap would leave a wake nowhere to go.
    const weekStart = Date.UTC(2026, 0, 4)
    if (offPeakParts(rule, weekStart, weekStart + 7 * DAY_MS).length === 0) return `pricing[${index}] leaves no off-peak time in a week`
  }
  return undefined
}

/**
 * The rule that prices a provider.
 * @param rules - configured rules.
 * @param provider - route key.
 */
export function ruleFor(rules: readonly PricingRule[], provider: string): PricingRule | undefined {
  return rules.find(rule => rule.providers.includes(provider))
}

/** Peak intervals of a rule touching `[from, to)`, merged where they touch. */
function peaks(rule: PricingRule, from: number, to: number): Interval[] {
  const noPeak = new Set(rule.noPeakDates ?? [])
  const raw: [number, number][] = []
  // One day either side: a span ending at 24:00 merges with the next day's span starting at 00:00.
  for (let day = (Math.floor(from / DAY_MS) - 1) * DAY_MS; day <= to + DAY_MS; day += DAY_MS) {
    const date = new Date(day)
    if (noPeak.has(date.toISOString().slice(0, 10))) continue
    const weekday = WEEKDAYS[date.getUTCDay()]
    for (const span of rule.peak) {
      if (weekday === undefined || !span.days.includes(weekday)) continue
      raw.push([day + (minutesOf(span.start, false) ?? 0) * 60_000, day + (minutesOf(span.end, true) ?? 0) * 60_000])
    }
  }
  raw.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const interval of raw) {
    const last = merged.at(-1)
    if (last !== undefined && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1])
    else merged.push([interval[0], interval[1]])
  }
  return merged.filter(([start, end]) => end > from && start < to)
}

/**
 * The peak an instant falls in.
 * @param rule - the pricing rule.
 * @param t - Unix epoch milliseconds.
 * @returns the (merged) peak interval containing `t`, or undefined off-peak.
 */
export function peakAt(rule: PricingRule, t: number): Interval | undefined {
  return peaks(rule, t, t + 1).find(([start, end]) => start <= t && t < end)
}

/**
 * The off-peak parts of an interval.
 * @param rule - the pricing rule.
 * @param from - interval start.
 * @param to - interval end.
 * @returns disjoint intervals in order; empty when all of it is peak.
 */
export function offPeakParts(rule: PricingRule, from: number, to: number): Interval[] {
  const parts: Interval[] = []
  let cursor = from
  for (const [start, end] of peaks(rule, from, to)) {
    if (start > cursor) parts.push([cursor, Math.min(start, to)])
    cursor = Math.max(cursor, end)
    if (cursor >= to) break
  }
  if (cursor < to) parts.push([cursor, to])
  return parts
}

/**
 * When off-peak time starts next.
 * @param rule - the pricing rule.
 * @param t - Unix epoch milliseconds.
 * @returns `t` itself off-peak, the end of the peak it falls in, or undefined when none starts within two weeks.
 */
export function nextOffPeak(rule: PricingRule, t: number): number | undefined {
  let cursor = t
  while (cursor < t + SEARCH_DAYS * DAY_MS) {
    const peak = peakAt(rule, cursor)
    if (peak === undefined) return cursor
    cursor = peak[1]
  }
  return undefined
}

/** A model route as a Session would use it. */
export interface Route {
  provider: string
  model: string
  /** `pick` (an explicit model choice not yet used), `session` (its last request), or `default` (the profile default). */
  source: 'pick' | 'session' | 'default'
}

/**
 * The route a Session's next request uses: an explicit pick, else its last
 * request header, else the profile default (the Session Controller's precedence).
 * @param facts - what is known.
 * @returns the route, or undefined when nothing is known.
 */
export function routeOf(facts: {
  pick?: { provider: string; model: string } | undefined
  header?: { provider: string; model: string } | undefined
  fallback?: { provider: string; model: string } | undefined
}): Route | undefined {
  if (facts.pick !== undefined) return { provider: facts.pick.provider, model: facts.pick.model, source: 'pick' }
  if (facts.header !== undefined) return { provider: facts.header.provider, model: facts.header.model, source: 'session' }
  if (facts.fallback !== undefined) return { provider: facts.fallback.provider, model: facts.fallback.model, source: 'default' }
  return undefined
}
