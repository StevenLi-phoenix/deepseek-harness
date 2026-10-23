import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BiliAccount, { Config } from '../src/index.ts'
import { FakeBili, replyItem } from './fake-bili.ts'
import { allLogs, contexts, credentialStore, fakeSessions, harness } from './harness.ts'

/** DeepSeek's official schedule as the bundle carries it: Mon–Fri 01:00–04:00 and 06:00–10:00 UTC. */
const PRICING = [{
  providers: ['deepseek-official', 'deepseek-account'],
  peak: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '01:00', end: '04:00' }, { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '06:00', end: '10:00' }],
  noPeakDates: ['2027-01-01'],
}]
const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-flash' }
const OPENCODE = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }

let dir: string
let fake: FakeBili

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-offpeak-'))
  fake = new FakeBili()
  vi.useFakeTimers()
  // Thu 2026-10-22 10:00 in New York (EDT).
  vi.setSystemTime(new Date('2026-10-22T14:00:00.000Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  allLogs.splice(0)
})

const text = (prompt: { content: readonly unknown[] }): string => (prompt.content[0] as { text: string }).text

describe('off-peak body clock', () => {
  it('plans only off-peak wakes for a priced route and says so', async () => {
    const h = await harness({ bili: fake, workspace: dir, defaultModel: { ...DEEPSEEK }, config: { pricing: PRICING } })
    const clock = (await h.view()).clock
    expect(clock.today).toEqual([
      { window: '12:00–14:00', at: Date.parse('2026-10-22T17:00:00Z'), state: 'planned' },
      // 19:30–23:30 EDT is 23:30–03:30 UTC; Friday's 01:00 peak leaves 23:30–01:00.
      { window: '19:30–23:30', at: Date.parse('2026-10-23T00:15:00Z'), state: 'planned', adjusted: 'clipped' },
    ])
    expect(clock.route).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', source: 'default', priced: true, offPeakAt: null })
    expect(h.logs.some(line => line.text === 'bili: body clock for 2026-10-22 on deepseek-official/deepseek-flash (default route, off-peak pricing): 2 wake(s), 0 window(s) skipped, 1 clipped to off-peak')).toBe(true)
  })

  it('leaves an unpriced route exactly as before', async () => {
    const h = await harness({ bili: fake, workspace: dir, defaultModel: { ...OPENCODE }, config: { pricing: PRICING } })
    const clock = (await h.view()).clock
    expect(clock.today.map(wake => [wake.at, wake.adjusted])).toEqual([[Date.parse('2026-10-22T17:00:00Z'), undefined], [Date.parse('2026-10-23T01:30:00Z'), undefined]])
    expect(clock.route).toMatchObject({ provider: 'opencode-go', priced: false, offPeakAt: null })
    expect(h.logs.some(line => line.text === 'bili: body clock for 2026-10-22 on opencode-go/deepseek-v4.1-flash (default route, no time-of-day pricing): 2 wake(s), 0 window(s) skipped')).toBe(true)
  })

  it('defers a wake that falls in a peak to the next off-peak start, across local midnight, never twice', async () => {
    const credentials = credentialStore()
    const sessions = fakeSessions()
    const defaultModel = { ...OPENCODE }
    const h = await harness({ bili: fake, credentials, sessions, workspace: dir, defaultModel, config: { pricing: PRICING } })
    await h.signIn()
    // The plan was made for opencode-go: the evening wake is at 01:30 UTC Friday, inside DeepSeek's 01:00–04:00 peak.
    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-22T17:00:05Z') - Date.now())
    expect(sessions.state.prompts).toHaveLength(1)
    defaultModel.provider = 'deepseek-official'
    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-23T01:30:05Z') - Date.now())
    expect(sessions.state.prompts).toHaveLength(1)
    expect(h.logs.some(line => line.text === 'bili: 1 body-clock wake(s) deferred to Fri 2026-10-23 00:00 (deepseek-official is in a peak period)')).toBe(true)
    const deferred = (await h.view()).clock
    expect(deferred.route).toMatchObject({ provider: 'deepseek-official', priced: true, offPeakAt: Date.parse('2026-10-23T04:00:00Z') })
    expect(deferred.nextWakeAt).toBe(Date.parse('2026-10-23T04:00:00Z'))

    // A restart while deferred neither loses nor repeats the wake.
    await h.ctx.fiber.dispose()
    const again = await harness({
      bili: fake, credentials, sessions, pool: h.pool, workspace: dir, defaultModel, config: { pricing: PRICING },
    })
    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-23T04:00:05Z') - Date.now())
    expect(sessions.state.prompts).toHaveLength(2)
    expect(text(sessions.state.prompts[1]!)).toMatch(/^Body clock: you wake up at Fri 2026-10-23 00:00 \(America\/New_York\)/)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(sessions.state.prompts).toHaveLength(2)
    expect((await again.view()).clock.lastWake?.reason).toBe('clock')
  })

  it('reads the route from the Session\'s last request before the default, and an explicit pick before both', async () => {
    const sessions = fakeSessions()
    const h = await harness({ bili: fake, sessions, workspace: dir, defaultModel: { ...OPENCODE }, config: { pricing: PRICING } })
    await h.signIn()
    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-22T17:00:05Z') - Date.now())
    expect(sessions.state.prompts).toHaveLength(1)
    // The Session's last request went to DeepSeek: the 01:30 UTC wake waits for 04:00.
    sessions.state.headers.set('bili-1', { ...DEEPSEEK })
    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-23T01:30:05Z') - Date.now())
    expect(sessions.state.prompts).toHaveLength(1)
    expect((await h.view()).clock.route).toMatchObject({ provider: 'deepseek-official', source: 'session', priced: true })
    // An explicit pick of an unpriced route wins: the deferred wake fires at its next check.
    sessions.state.picks.set('bili-1', { ...OPENCODE })
    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-23T04:00:05Z') - Date.now())
    expect(sessions.state.prompts).toHaveLength(2)
    expect((await h.view()).clock.route).toMatchObject({ provider: 'opencode-go', source: 'pick', priced: false })
  })
})

describe('off-peak inbox', () => {
  it('keeps new items waiting through a peak and delivers them when it ends', async () => {
    // Thu 20:30 EDT = Fri 00:30 UTC, off-peak until 01:00.
    vi.setSystemTime(new Date('2026-10-23T00:30:00.000Z'))
    const sessions = fakeSessions()
    const h = await harness({
      bili: fake, sessions, workspace: dir, defaultModel: { ...DEEPSEEK },
      config: { pricing: PRICING, inboxPollMs: 600_000, wakes: [{ start: '12:00', end: '14:00' }] },
    })
    await h.signIn()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.logs.some(line => line.text.startsWith('bili: inbox baseline for reply'))).toBe(true)
    // In the peak, a reply arrives.
    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-23T01:05:00Z') - Date.now())
    fake.unread.reply = 1
    fake.replyItems = [replyItem(1, '600000000001', '你也喜欢猫？', { at: 1_790_000_100 })]
    await vi.advanceTimersByTimeAsync(600_000)
    expect(sessions.state.prompts).toEqual([])
    expect(h.logs.some(line => line.text === 'bili: 1 inbox item(s) wait for off-peak at Fri 2026-10-23 00:00 (deepseek-official is in a peak period)')).toBe(true)
    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-23T04:00:05Z') - Date.now())
    expect(sessions.state.prompts).toHaveLength(1)
    expect(text(sessions.state.prompts[0]!)).toContain('你也喜欢猫？')
  })
})

describe('pricing configuration', () => {
  it('defaults to no pricing and refuses a schedule that cannot work', () => {
    expect(Config({} as never).pricing).toEqual([])
    const bad = Config({ pricing: [{ providers: ['a'], peak: [{ days: ['mon'], start: '05:00', end: '04:00' }] }] } as never)
    expect(() => new BiliAccount(new Context(), bad)).toThrow('bili: pricing[0].peak[0] must use HH:MM UTC times, start before end')
    const twice = Config({ pricing: [{ providers: ['a'], peak: [] }, { providers: ['a'], peak: [] }] } as never)
    expect(() => new BiliAccount(new Context(), twice)).toThrow('bili: pricing[1] repeats provider "a"')
  })
})
