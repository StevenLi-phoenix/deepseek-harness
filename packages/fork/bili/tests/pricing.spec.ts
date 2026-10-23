import { describe, expect, it } from 'vitest'
import { nextOffPeak, offPeakParts, peakAt, pricingProblem, routeOf, ruleFor, type PricingRule } from '../src/pricing.ts'

/** DeepSeek's official schedule, in UTC: Mon–Fri 01:00–04:00 and 06:00–10:00. */
const DEEPSEEK: PricingRule = {
  providers: ['deepseek-official', 'deepseek-account'],
  peak: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '01:00', end: '04:00' }, { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '06:00', end: '10:00' }],
  noPeakDates: ['2027-01-01'],
}
const at = (iso: string): number => Date.parse(iso)

describe('UTC peak periods', () => {
  it('finds the peak an instant falls in, by UTC weekday', () => {
    // Fri 2026-10-23 is a weekday in UTC.
    expect(peakAt(DEEPSEEK, at('2026-10-23T02:30:00Z'))).toEqual([at('2026-10-23T01:00:00Z'), at('2026-10-23T04:00:00Z')])
    expect(peakAt(DEEPSEEK, at('2026-10-23T04:00:00Z'))).toBeUndefined()
    expect(peakAt(DEEPSEEK, at('2026-10-23T09:59:59Z'))).toEqual([at('2026-10-23T06:00:00Z'), at('2026-10-23T10:00:00Z')])
    // Saturday and Sunday in UTC have no peak.
    expect(peakAt(DEEPSEEK, at('2026-10-24T02:30:00Z'))).toBeUndefined()
    expect(peakAt(DEEPSEEK, at('2026-10-25T07:00:00Z'))).toBeUndefined()
    // A listed UTC date has none either (a Friday).
    expect(peakAt(DEEPSEEK, at('2027-01-01T07:00:00Z'))).toBeUndefined()
    expect(peakAt(DEEPSEEK, at('2027-01-04T07:00:00Z'))).toEqual([at('2027-01-04T06:00:00Z'), at('2027-01-04T10:00:00Z')])
  })

  it('merges touching spans, also across UTC midnight', () => {
    const late: PricingRule = { providers: ['x'], peak: [{ days: ['mon'], start: '20:00', end: '24:00' }, { days: ['tue'], start: '00:00', end: '02:00' }, { days: ['tue'], start: '02:00', end: '03:00' }] }
    expect(peakAt(late, at('2026-10-26T23:00:00Z'))).toEqual([at('2026-10-26T20:00:00Z'), at('2026-10-27T03:00:00Z')])
    expect(nextOffPeak(late, at('2026-10-26T21:00:00Z'))).toBe(at('2026-10-27T03:00:00Z'))
  })

  it('subtracts peaks from an interval and finds the next off-peak start', () => {
    // Thu 19:30–23:30 New York (EDT) = Thu 23:30 – Fri 03:30 UTC; Friday's 01:00 peak cuts it.
    expect(offPeakParts(DEEPSEEK, at('2026-10-22T23:30:00Z'), at('2026-10-23T03:30:00Z'))).toEqual([[at('2026-10-22T23:30:00Z'), at('2026-10-23T01:00:00Z')]])
    expect(offPeakParts(DEEPSEEK, at('2026-10-23T03:00:00Z'), at('2026-10-23T07:00:00Z'))).toEqual([[at('2026-10-23T04:00:00Z'), at('2026-10-23T06:00:00Z')]])
    expect(offPeakParts(DEEPSEEK, at('2026-10-23T07:00:00Z'), at('2026-10-23T09:00:00Z'))).toEqual([])
    expect(nextOffPeak(DEEPSEEK, at('2026-10-23T07:00:00Z'))).toBe(at('2026-10-23T10:00:00Z'))
    expect(nextOffPeak(DEEPSEEK, at('2026-10-23T12:00:00Z'))).toBe(at('2026-10-23T12:00:00Z'))
    expect(nextOffPeak({ providers: ['all'], peak: [{ days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '00:00', end: '24:00' }] }, 0)).toBeUndefined()
  })
})

describe('pricing configuration', () => {
  it('accepts the DeepSeek schedule and an empty list', () => {
    expect(pricingProblem([DEEPSEEK])).toBeUndefined()
    expect(pricingProblem([])).toBeUndefined()
    expect(ruleFor([DEEPSEEK], 'deepseek-account')).toBe(DEEPSEEK)
    expect(ruleFor([DEEPSEEK], 'opencode-go')).toBeUndefined()
  })

  it('names what cannot work', () => {
    const span = { days: ['mon' as const], start: '01:00', end: '04:00' }
    expect(pricingProblem([{ providers: [], peak: [span] }])).toBe('pricing[0] lists no providers')
    expect(pricingProblem([{ providers: ['a'], peak: [span] }, { providers: ['a'], peak: [span] }])).toBe('pricing[1] repeats provider "a"')
    expect(pricingProblem([{ providers: ['a'], peak: [{ ...span, start: '1:00' }] }])).toBe('pricing[0].peak[0] must use HH:MM UTC times, start before end')
    expect(pricingProblem([{ providers: ['a'], peak: [{ ...span, start: '05:00' }] }])).toBe('pricing[0].peak[0] must use HH:MM UTC times, start before end')
    expect(pricingProblem([{ providers: ['a'], peak: [{ ...span, days: ['funday' as never] }] }])).toBe('pricing[0].peak[0] has an unknown day "funday"; use sun, mon, tue, wed, thu, fri, sat')
    expect(pricingProblem([{ providers: ['a'], peak: [{ ...span, days: [] }] }])).toBe('pricing[0].peak[0] lists no days')
    expect(pricingProblem([{ providers: ['a'], peak: [span], noPeakDates: ['2027-13-01'] }])).toBe('pricing[0].noPeakDates[0] must be a UTC date (YYYY-MM-DD)')
    expect(pricingProblem([{ providers: ['a'], peak: [{ days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '00:00', end: '24:00' }] }])).toBe('pricing[0] leaves no off-peak time in a week')
  })
})

describe('route precedence', () => {
  const fallback = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
  it('takes an explicit pick, then the Session\'s last request, then the profile default', () => {
    const header = { provider: 'deepseek-official', model: 'deepseek-flash' }
    const pick = { provider: 'openrouter', model: 'x' }
    expect(routeOf({ pick, header, fallback })).toEqual({ ...pick, source: 'pick' })
    expect(routeOf({ header, fallback })).toEqual({ ...header, source: 'session' })
    expect(routeOf({ fallback })).toEqual({ ...fallback, source: 'default' })
    expect(routeOf({})).toBeUndefined()
  })
})
