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
        windows: [{ label: '5 小时', percent: 0 }, { label: '每周', percent: 29.4 }, { label: '每月', percent: 25 }],
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
    expect(rows[1]).toMatchObject({ value: '已用 120%', exhausted: true, details: [], windows: [{ label: 'daily', percent: 100 }] })
    expect(rows[2]).toMatchObject({ value: '—', stale: true, details: ['读取失败（HTTP 401）'] })
    expect(providerRows(state({ providers: [{ ...OPENROUTER, remaining: null, limit: null, used: 1.5 }] }), t)[0])
      .toMatchObject({ value: '已用 $1.50', details: ['这个 key 没有设置限额'] })
    expect(providerRows(state({ providers: [{ ...OPENCODE, windows: [] }] }), t)[0]).toMatchObject({ value: '—', stale: true })
  })

  it('says when the readings were taken', () => {
    expect(freshness(state({ checkedAt: new Date(2026, 9, 22, 20, 5).getTime() }), t)).toBe('20:05 更新')
    expect(freshness(state({ refreshing: true }), t)).toBe('正在刷新…')
    expect(freshness(state({ checkedAt: null }), t)).toBe('正在刷新…')
  })
})
