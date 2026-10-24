import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { BalanceState, ProviderReading } from '../src/client/balance.ts'
import { zh } from '../src/client/locales.ts'
import { freshness, providerRows, type Translate } from '../src/client/rows.ts'

const t = makeTranslate(zh) as Translate

const state = (overrides: Partial<BalanceState>): BalanceState => ({
  phase: 'idle', wallets: [], updatedAt: null, checkedAt: 0, refreshing: false, providers: [], ...overrides,
})
const DEEPSEEK_API: ProviderReading = { source: 'deepseek', label: 'DeepSeek API', status: 'ready', kind: 'wallets', wallets: [
  { currency: 'USD', total: '0.00', toppedUp: '0.00', granted: '0.00' },
  { currency: 'CNY', total: '329.86', toppedUp: '323.87', granted: '5.99' },
] }
const OPENROUTER: ProviderReading = { source: 'openrouter', label: 'OpenRouter', status: 'ready', kind: 'credit', currency: 'USD', remaining: 9.991, limit: 10, used: 0.009 }
const OPENCODE: ProviderReading = { source: 'opencode-go', label: 'OpenCode Go', status: 'ready', kind: 'quota', windows: [
  { name: 'rolling', percent: 0, resetsAt: null },
  { name: 'weekly', percent: 29.4, resetsAt: '2026-10-26T00:00:00' },
  { name: 'monthly', percent: 25, resetsAt: null },
] }

describe('providerRows', () => {
  it('builds one row per provider with its value and explanation', () => {
    expect(providerRows(state({ providers: [OPENROUTER, DEEPSEEK_API, OPENCODE] }), t)).toEqual([
      { key: 'openrouter', label: 'OpenRouter', value: '$9.99', details: ['限额 $10.00 · 已用 <$0.01'], windows: [], exhausted: false, stale: false },
      { key: 'deepseek', label: 'DeepSeek API', value: '¥329.86', details: ['充值 ¥323.87 · 赠金 ¥5.99'], windows: [], exhausted: false, stale: false },
      {
        key: 'opencode-go', label: 'OpenCode Go', value: '已用 29%', details: ['每周额度 10-26 00:00 重置'], exhausted: false, stale: false,
        windows: [
          { label: '5 小时', percent: 0, resets: null, elapsed: null, projected: null, pace: null, overPace: false },
          { label: '每周', percent: 29.4, resets: '10-26 00:00', elapsed: null, projected: null, pace: null, overPace: false },
          { label: '每月', percent: 25, resets: null, elapsed: null, projected: null, pace: null, overPace: false },
        ],
      },
    ])
  })

  it('leaves out a DeepSeek API key that belongs to the signed-in account, despite different precision', () => {
    const account = { phase: 'ready' as const, wallets: [{ currency: 'CNY' as const, total: '329.8642', toppedUp: '323.8742', granted: '5.99' }] }
    expect(providerRows(state({ ...account, providers: [DEEPSEEK_API, OPENROUTER] }), t).map(row => row.key)).toEqual(['openrouter'])
    expect(providerRows(state({ ...account, wallets: [{ currency: 'CNY', total: '3', toppedUp: '3', granted: '0' }], providers: [DEEPSEEK_API] }), t))
      .toHaveLength(1)
  })

  it('marks exhausted, unlimited, failed, and empty readings', () => {
    const rows = providerRows(state({ providers: [
      { ...OPENROUTER, remaining: 0 },
      { source: 'opencode-go', label: 'OC', status: 'ready', kind: 'quota', windows: [{ name: 'daily', percent: 120, resetsAt: 'nope' }] },
      { source: 'deepseek', label: 'DeepSeek API', status: 'failed', reason: 'HTTP 401' },
    ] }), t)
    expect(rows[0]).toMatchObject({ value: '$0.00', exhausted: true })
    expect(rows[1]).toMatchObject({ value: '已用 120%', exhausted: true, details: [], windows: [{ label: 'daily', percent: 100, resets: null }] })
    expect(rows[2]).toMatchObject({ value: '—', stale: true, details: ['读取失败（HTTP 401）'] })
    expect(providerRows(state({ providers: [{ ...OPENROUTER, remaining: null, limit: null, used: 1.5 }] }), t)[0])
      .toMatchObject({ value: '已用 $1.50', details: ['这个 key 没有设置限额'] })
    expect(providerRows(state({ providers: [{ ...OPENCODE, windows: [] }] }), t)[0]).toMatchObject({ value: '—', stale: true })
  })

  it('gives each window its own reset time, relative to when it was read', () => {
    const at = (month: number, day: number, hour: number, minute: number): string =>
      new Date(2026, month - 1, day, hour, minute).toISOString()
    const quota: ProviderReading = { ...OPENCODE, windows: [
      { name: 'rolling', percent: 0, resetsAt: at(10, 23, 13, 49) },
      { name: 'weekly', percent: 30, resetsAt: at(10, 24, 20, 0) },
      { name: 'monthly', percent: 25, resetsAt: at(11, 15, 13, 32) },
    ] }
    const [row] = providerRows(state({ checkedAt: new Date(2026, 9, 23, 12, 11).getTime(), providers: [quota] }), t)
    expect(row!.windows.map(window => window.resets)).toEqual(['今天 13:49', '明天 20:00', '11-15 13:32'])
  })

  it('shows how much of each window\'s time has passed and where the pace so far leads', () => {
    const now = new Date(2026, 10, 25, 13, 32).getTime()
    const hours = (count: number): string => new Date(now + count * 3_600_000).toISOString()
    const quota: ProviderReading = { ...OPENCODE, windows: [
      // Four of five hours to go, nothing used: the time only.
      { name: 'rolling', percent: 0, resetsAt: hours(4) },
      // Half the week gone and 80 % used: on pace to run out tomorrow at 10:32, before the reset.
      { name: 'weekly', percent: 80, resetsAt: hours(84) },
      // 20 of 30 days to go (11-15 to 12-15): a third of the time, a quarter used, so three quarters at the reset.
      { name: 'monthly', percent: 25, resetsAt: new Date(2026, 11, 15, 13, 32).toISOString() },
      // Under a tenth of the window gone: too early to project.
      { name: 'weekly', percent: 5, resetsAt: hours(156) },
      // Used up: nothing left to project.
      { name: 'monthly', percent: 100, resetsAt: new Date(2026, 11, 15, 13, 32).toISOString() },
    ] }
    const [row] = providerRows(state({ checkedAt: now, providers: [quota] }), t)
    const summary = row!.windows.map(window =>
      [Math.round(window.elapsed ?? -1), window.projected === null ? null : Math.round(window.projected), window.pace, window.overPace])
    expect(summary).toEqual([
      [20, null, '时间已过 20%', false],
      [50, 160, '时间已过 50% · 照这个速度，明天 10:32 用完', true],
      [33, 75, '时间已过 33% · 照这个速度，到期约用 75%', false],
      [7, null, '时间已过 7%', false],
      [33, null, '时间已过 33%', false],
    ])
  })

  it('measures a month back from its reset day, and says nothing outside the window or without a length', () => {
    const quota = (name: string, resetsAt: string | null, at: number) => providerRows(state({
      checkedAt: at, providers: [{ ...OPENCODE, windows: [{ name, percent: 10, resetsAt }] }],
    }), t)[0]!.windows[0]!
    // A reset on the 31st follows a month that ends on the 28th: 3 of 31 days gone.
    expect(Math.round(quota('monthly', new Date(2027, 2, 31).toISOString(), new Date(2027, 2, 3).getTime()).elapsed!)).toBe(10)
    // A reading from before the window opened, after it reset, of an unknown window, or without a reset: no pace.
    for (const window of [
      quota('weekly', new Date(2026, 10, 25).toISOString(), new Date(2026, 10, 1).getTime()),
      quota('weekly', new Date(2026, 10, 25).toISOString(), new Date(2026, 10, 26).getTime()),
      quota('daily', new Date(2026, 10, 25).toISOString(), new Date(2026, 10, 24).getTime()),
      quota('weekly', null, new Date(2026, 10, 24).getTime()),
    ]) expect(window).toMatchObject({ elapsed: null, projected: null, pace: null, overPace: false })
  })

  it('says when the readings were taken', () => {
    expect(freshness(state({ checkedAt: new Date(2026, 9, 22, 20, 5).getTime() }), t)).toBe('20:05 更新')
    expect(freshness(state({ refreshing: true }), t)).toBe('正在刷新…')
    expect(freshness(state({ checkedAt: null }), t)).toBe('正在刷新…')
  })
})
