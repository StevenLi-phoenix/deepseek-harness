import { describe, expect, it } from 'vitest'
import { nextPlanned, rollPlan, settlePlan, windowProblem } from '../src/clock.ts'
import { cookieHeader, cookiesFromUrl, isSignedIn, mergeSetCookies } from '../src/cookies.ts'
import { dayKey, formatGap, formatStamp, localTime, nextDayStart, parseClock } from '../src/time.ts'

const NY = 'America/New_York'
const WINDOWS = [{ start: '12:00', end: '14:00' }, { start: '19:30', end: '23:30' }]

describe('time helpers', () => {
  it('maps local wall times to instants across DST', () => {
    // EDT (UTC-4) before 2026-11-01, EST (UTC-5) after.
    expect(new Date(localTime('2026-10-23', 12 * 60, NY)).toISOString()).toBe('2026-10-23T16:00:00.000Z')
    expect(new Date(localTime('2026-11-02', 12 * 60, NY)).toISOString()).toBe('2026-11-02T17:00:00.000Z')
    expect(new Date(nextDayStart(Date.parse('2026-10-23T16:00:00Z'), NY)).toISOString()).toBe('2026-10-24T04:00:00.000Z')
    expect(dayKey(Date.parse('2026-10-24T03:59:00Z'), NY)).toBe('2026-10-23')
    expect(formatStamp(Date.parse('2026-10-23T16:41:00Z'), NY)).toBe('Fri 2026-10-23 12:41')
  })

  it('parses HH:MM and formats gaps', () => {
    expect(parseClock('19:30')).toBe(1170)
    expect(parseClock('24:00')).toBeUndefined()
    expect(parseClock('9:30')).toBeUndefined()
    expect(formatGap(30_000)).toBe('under a minute')
    expect(formatGap(5 * 3_600_000 + 39 * 60_000)).toBe('5 h 39 min')
    expect(formatGap(2 * 86_400_000 + 3 * 3_600_000)).toBe('2 d 3 h')
  })
})

describe('body clock plans', () => {
  it('rolls one wake inside each window and skips by chance', () => {
    const values = [0.5, 0.25, 0.9, 0.5]
    const plan = rollPlan('2026-10-23', WINDOWS, 0.15, NY, () => values.shift()!)
    expect(plan.wakes.map(wake => wake.state)).toEqual(['planned', 'planned'])
    expect(new Date(plan.wakes[0]!.at!).toISOString()).toBe('2026-10-23T16:30:00.000Z')
    expect(new Date(plan.wakes[1]!.at!).toISOString()).toBe('2026-10-24T01:30:00.000Z')
    const skipped = rollPlan('2026-10-23', WINDOWS, 0.15, NY, () => 0.1)
    expect(skipped.wakes).toEqual([{ window: 0, state: 'skipped' }, { window: 1, state: 'skipped' }])
  })

  it('marks a wake missed once its window closed, and keeps one whose window is still open', () => {
    const plan = rollPlan('2026-10-23', WINDOWS, 0, NY, () => 0)
    const midDay = Date.parse('2026-10-23T17:00:00Z')
    expect(settlePlan(plan, WINDOWS, midDay, NY)).toBe(plan)
    const late = settlePlan(plan, WINDOWS, Date.parse('2026-10-23T18:30:00Z'), NY)
    expect(late.wakes.map(wake => wake.state)).toEqual(['missed', 'planned'])
    expect(nextPlanned(late)).toEqual({ window: 1, at: Date.parse('2026-10-23T23:30:00Z') })
    expect(nextPlanned({ day: '2026-10-23', wakes: [] })).toBeUndefined()
  })

  it('rejects windows that cannot work', () => {
    expect(windowProblem(WINDOWS)).toBeUndefined()
    expect(windowProblem([{ start: '23:00', end: '01:00' }])).toBe('wakes[0] must end after it starts on the same day')
    expect(windowProblem([{ start: 'noon', end: '13:00' }])).toBe('wakes[0] must use HH:MM times')
  })
})

describe('cookies', () => {
  it('keeps only session cookies and drops expired ones', () => {
    const jar = mergeSetCookies({}, [
      'SESSDATA=abc%2C1790000000%2Cxyz*11; Path=/; Domain=bilibili.com; HttpOnly; Expires=Sat, 18 Apr 2027 00:00:00 GMT',
      'bili_jct=csrf123; Path=/; Domain=bilibili.com',
      'DedeUserID=777; Path=/',
      'tracking=1; Path=/',
    ], Date.parse('2026-10-23T00:00:00Z'))
    expect(jar).toEqual({ SESSDATA: 'abc%2C1790000000%2Cxyz*11', bili_jct: 'csrf123', DedeUserID: '777' })
    expect(isSignedIn(jar)).toBe(true)
    expect(cookieHeader(jar)).toBe('SESSDATA=abc%2C1790000000%2Cxyz*11; bili_jct=csrf123; DedeUserID=777')
    const cleared = mergeSetCookies(jar, ['SESSDATA=; Max-Age=0', 'bili_jct=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])
    expect(cleared).toEqual({ DedeUserID: '777' })
    expect(isSignedIn(cleared)).toBe(false)
  })

  it('reads the cookies the QR poll URL carries, in their encoded form', () => {
    const url = 'https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=777&DedeUserID__ckMd5=ck&Expires=1&SESSDATA=abc%2C1790000000%2Cxyz*11&bili_jct=csrf123&gourl=x'
    expect(cookiesFromUrl(url)).toEqual({ DedeUserID: '777', DedeUserID__ckMd5: 'ck', SESSDATA: 'abc%2C1790000000%2Cxyz*11', bili_jct: 'csrf123' })
    expect(cookiesFromUrl('not a url')).toEqual({})
  })
})
