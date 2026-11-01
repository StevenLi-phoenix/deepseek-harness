import { describe, expect, it } from 'vitest'
import { clockMinutes, evaluate, hours, localSeconds, nextChange, nextClockTime, type PresenceInputs, type PresenceRules } from '../src/state.ts'

/** 2026-11-03 in New York is EST (UTC-5): 05:00 local is 10:00Z. */
const at = (hhmm: string, day = 3): number => Date.parse(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00Z`)

const RULES: PresenceRules = {
  timeZone: 'America/New_York',
  window: { enabled: true, start: '03:30', end: '10:30' },
  focusFreshMs: hours(2),
  sleepMaxMs: hours(14),
  manualMaxMs: hours(12),
}

describe('daily window', () => {
  it('is asleep inside the window in the owner\'s zone, with its start and end', () => {
    // 05:00 EST.
    expect(evaluate(at('10:00'), {}, RULES)).toEqual({ asleep: true, source: 'window', since: at('08:30'), until: at('15:30') })
  })

  it('is awake outside it, since the window ended', () => {
    // 12:00 EST.
    expect(evaluate(at('17:00'), {}, RULES)).toEqual({ asleep: false, source: 'window', since: at('15:30'), until: null })
    // 02:00 EST, before it starts: it ended yesterday.
    expect(evaluate(at('07:00'), {}, RULES)).toEqual({ asleep: false, source: 'window', since: at('15:30', 2), until: null })
  })

  it('wraps past midnight and treats its end as exclusive', () => {
    const night = { ...RULES, window: { enabled: true, start: '23:00', end: '07:00' } }
    // 02:00 EST and 23:30 EST are inside; 07:00 EST (12:00Z) is not.
    expect(evaluate(at('07:00'), {}, night)).toMatchObject({ asleep: true, since: at('04:00', 3), until: at('12:00') })
    expect(evaluate(at('04:30', 4), {}, night)).toMatchObject({ asleep: true, since: at('04:00', 4) })
    expect(evaluate(at('12:00'), {}, night).asleep).toBe(false)
  })

  it('is awake with nothing to say when it is off', () => {
    expect(evaluate(at('10:00'), {}, { ...RULES, window: { enabled: false, start: '03:30', end: '10:30' } })).toEqual({ asleep: false, source: 'window', since: null, until: null })
    expect(evaluate(at('10:00'), {}, { ...RULES, window: { enabled: true, start: '04:00', end: '04:00' } }).asleep).toBe(false)
  })
})

describe('Focus signal', () => {
  it('beats the window both ways while it is fresh', () => {
    // Focus on at 14:00 EST, long before the window: asleep, until the longest an asleep signal holds.
    const on: PresenceInputs = { focus: { asleep: true, at: at('19:00'), since: at('19:00'), heartbeatAt: null } }
    expect(evaluate(at('19:30'), on, RULES)).toEqual({ asleep: true, source: 'focus', since: at('19:00'), until: at('19:00') + hours(14) })
    // Focus off at 04:00 EST, inside the window: awake.
    const off: PresenceInputs = { focus: { asleep: false, at: at('09:00'), since: at('09:00'), heartbeatAt: null } }
    expect(evaluate(at('10:00'), off, RULES)).toEqual({ asleep: false, source: 'focus', since: at('09:00'), until: null })
  })

  it('lets go after 14 hours asleep and 2 hours awake without a newer signal, and the window decides again', () => {
    const on: PresenceInputs = { focus: { asleep: true, at: at('19:00'), since: at('19:00'), heartbeatAt: null } }
    // 14 h later it is 09:00 EST... 14:00Z next day, inside the window: asleep by the window now.
    expect(evaluate(at('19:00') + hours(14), on, RULES)).toMatchObject({ source: 'window' })
    expect(evaluate(at('19:00') + hours(14) - 1, on, RULES)).toMatchObject({ source: 'focus' })
    // An awake signal from 02:00 EST is stale at 04:00 EST, and the window then says asleep.
    const off: PresenceInputs = { focus: { asleep: false, at: at('07:00'), since: at('07:00'), heartbeatAt: null } }
    expect(evaluate(at('07:00') + hours(2) - 1, off, RULES)).toMatchObject({ source: 'focus', asleep: false })
    expect(evaluate(at('07:00') + hours(2), off, RULES)).toMatchObject({ source: 'window', asleep: true })
  })
})

describe('heartbeat', () => {
  it('keeps the state holding past its hold time without moving its start', () => {
    // On since 19:00Z; the latest heartbeat came 13 h later, so the signal now holds 14 h from there.
    const on: PresenceInputs = { focus: { asleep: true, at: at('19:00') + hours(13), since: at('19:00'), heartbeatAt: at('19:00') + hours(13) } }
    const state = evaluate(at('19:00') + hours(20), on, { ...RULES, window: { enabled: false, start: '03:30', end: '10:30' } })
    expect(state).toEqual({ asleep: true, source: 'focus', since: at('19:00'), until: at('19:00') + hours(27) })
  })

  it('does not end a button: only the change that began the state is compared with it', () => {
    const inputs = { focus: { asleep: false, at: at('19:30'), since: at('17:00'), heartbeatAt: at('19:30') }, manual: { asleep: true, at: at('18:00') } }
    expect(evaluate(at('19:40'), inputs, RULES)).toMatchObject({ source: 'manual', asleep: true })
  })

  it('goes stale from the latest signal, whenever the state began', () => {
    const off: PresenceInputs = { focus: { asleep: false, at: at('09:00'), since: at('03:00'), heartbeatAt: at('09:00') } }
    expect(evaluate(at('09:00') + hours(2) - 1, off, RULES).source).toBe('focus')
    expect(evaluate(at('09:00') + hours(2), off, RULES).source).toBe('window')
    expect(nextChange(at('09:30'), off, RULES)).toBe(at('11:00'))
  })
})

describe('manual override', () => {
  // Awake since 09:00Z, kept fresh by heartbeats up to 19:30Z.
  const focusOff: PresenceInputs = { focus: { asleep: false, at: at('19:30'), since: at('09:00'), heartbeatAt: at('19:30') } }

  it('beats a fresh Focus signal and the window, until it lapses', () => {
    const sleeping = { ...focusOff, manual: { asleep: true, at: at('17:00'), until: at('20:00') } }
    expect(evaluate(at('18:00'), sleeping, RULES)).toEqual({ asleep: true, source: 'manual', since: at('17:00'), until: at('20:00') })
    expect(evaluate(at('20:00'), sleeping, RULES)).toMatchObject({ source: 'focus', asleep: false })
    const awake = { manual: { asleep: false, at: at('10:00') } }
    expect(evaluate(at('11:00'), awake, RULES)).toMatchObject({ asleep: false, source: 'manual' })
  })

  it('holds at most manualMaxMs when it names no end, or an end beyond that', () => {
    const open = { manual: { asleep: true, at: at('17:00') } }
    expect(evaluate(at('17:00') + hours(12) - 1, open, RULES)).toMatchObject({ source: 'manual', until: at('17:00') + hours(12) })
    expect(evaluate(at('17:00') + hours(12), open, RULES).source).toBe('window')
    const far = { manual: { asleep: true, at: at('17:00'), until: at('17:00') + hours(40) } }
    expect(evaluate(at('17:00') + hours(13), far, RULES).source).toBe('window')
  })

  it('ends when a Focus signal arrives after it, but not for one that came before it', () => {
    const older = { focus: { asleep: false, at: at('17:00'), since: at('17:00'), heartbeatAt: null }, manual: { asleep: true, at: at('18:00') } }
    expect(evaluate(at('19:00'), older, RULES)).toMatchObject({ source: 'manual', asleep: true })
    const newer = { focus: { asleep: false, at: at('19:00'), since: at('19:00'), heartbeatAt: null }, manual: { asleep: true, at: at('18:00') } }
    expect(evaluate(at('19:30'), newer, RULES)).toMatchObject({ source: 'focus', asleep: false })
  })
})

describe('next change', () => {
  it('is the nearest of the window edges, the Focus signal going stale, and the button lapsing', () => {
    // 12:00 EST: the window starts at 03:30 EST next day.
    expect(nextChange(at('17:00'), {}, RULES)).toBe(at('08:30', 4))
    // A fresh asleep signal goes stale in 14 h, a button lapses sooner.
    const inputs: PresenceInputs = { focus: { asleep: true, at: at('17:00'), since: at('17:00'), heartbeatAt: null }, manual: undefined }
    expect(nextChange(at('17:30'), inputs, RULES)).toBe(at('07:00', 4))
    expect(nextChange(at('17:30'), { ...inputs, manual: { asleep: false, at: at('17:20'), until: at('18:00') } }, RULES)).toBe(at('18:00'))
    // Window off and nothing else: nothing is scheduled.
    expect(nextChange(at('17:00'), {}, { ...RULES, window: { enabled: false, start: '03:30', end: '10:30' } })).toBeUndefined()
  })
})

describe('clock helpers', () => {
  it('reads minutes, local seconds, and the next occurrence of a clock time', () => {
    expect(clockMinutes('03:30')).toBe(210)
    expect(localSeconds(at('10:00'), 'America/New_York')).toBe(5 * 3600)
    expect(localSeconds(at('10:00'), 'Asia/Shanghai')).toBe(18 * 3600)
    expect(nextClockTime(at('10:00'), '07:15', 'America/New_York')).toBe(at('12:15'))
    expect(nextClockTime(at('10:00'), '04:00', 'America/New_York')).toBe(at('09:00', 4))
    // The same minute is a day away.
    expect(nextClockTime(at('10:00'), '05:00', 'America/New_York')).toBe(at('10:00', 4))
  })
})
