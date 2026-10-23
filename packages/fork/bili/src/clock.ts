/**
 * The body clock: each local day gets one random wake time inside every
 * configured window, and each window is skipped with `skipChance`. Plans are
 * pure values; the service stores them, so a restart neither re-rolls a day
 * nor wakes twice.
 */
import type { PlanRecord } from './storage.ts'
import { dayKey, localTime, parseClock } from './time.ts'

/** One daily wake window in local time. */
export interface WakeWindow {
  /** `HH:MM`, inclusive. */
  start: string
  /** `HH:MM`, exclusive; later than `start` on the same day. */
  end: string
}

/**
 * Check windows at load time.
 * @param windows - configured windows.
 * @returns a reason the windows cannot work, or undefined.
 */
export function windowProblem(windows: readonly WakeWindow[]): string | undefined {
  for (const [index, window] of windows.entries()) {
    const start = parseClock(window.start)
    const end = parseClock(window.end)
    if (start === undefined || end === undefined) return `wakes[${index}] must use HH:MM times`
    if (end <= start) return `wakes[${index}] must end after it starts on the same day`
  }
  return undefined
}

/**
 * Roll one day's plan.
 * @param day - local day, `YYYY-MM-DD`.
 * @param windows - valid windows.
 * @param skipChance - probability (0-1) that a window gets no wake.
 * @param timeZone - zone of the windows.
 * @param random - uniform source in [0, 1).
 * @returns the plan, every wake `planned` or `skipped`.
 */
export function rollPlan(
  day: string, windows: readonly WakeWindow[], skipChance: number, timeZone: string, random: () => number = Math.random,
): PlanRecord {
  return {
    day,
    wakes: windows.map((window, index) => {
      if (random() < skipChance) return { window: index, state: 'skipped' as const }
      const start = localTime(day, parseClock(window.start) ?? 0, timeZone)
      const end = localTime(day, parseClock(window.end) ?? 0, timeZone)
      return { window: index, at: start + Math.floor(random() * (end - start)), state: 'planned' as const }
    }),
  }
}

/**
 * Settle a stored plan against `now` after a restart: a planned wake whose
 * window has closed becomes `missed`; one whose time passed while its window
 * is still open stays planned and fires at once.
 * @param plan - stored plan.
 * @param windows - configured windows.
 * @param now - current time.
 * @param timeZone - zone of the windows.
 * @returns the settled plan (the input when nothing changed).
 */
export function settlePlan(plan: PlanRecord, windows: readonly WakeWindow[], now: number, timeZone: string): PlanRecord {
  const wakes = plan.wakes.map((wake) => {
    const window = windows[wake.window]
    if (wake.state !== 'planned' || wake.at === undefined || window === undefined) return wake
    const closes = localTime(plan.day, parseClock(window.end) ?? 1440, timeZone)
    return now < closes ? wake : { ...wake, state: 'missed' as const }
  })
  return wakes.some((wake, index) => wake !== plan.wakes[index]) ? { ...plan, wakes } : plan
}

/**
 * The next planned wake of a plan.
 * @param plan - a day's plan.
 * @returns the earliest planned wake, or undefined.
 */
export function nextPlanned(plan: PlanRecord): { window: number; at: number } | undefined {
  let next: { window: number; at: number } | undefined
  for (const wake of plan.wakes) {
    if (wake.state !== 'planned' || wake.at === undefined) continue
    if (next === undefined || wake.at < next.at) next = { window: wake.window, at: wake.at }
  }
  return next
}

/**
 * The local day key a plan for `now` uses.
 * @param now - current time.
 * @param timeZone - zone of the windows.
 */
export function planDay(now: number, timeZone: string): string {
  return dayKey(now, timeZone)
}
