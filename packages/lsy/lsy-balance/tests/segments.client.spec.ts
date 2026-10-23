import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { BalanceState, ProviderReading } from '../src/client/balance.ts'
import { zh } from '../src/client/locales.ts'
import { pillSegments, tooltipLines, type Translate } from '../src/client/segments.ts'

const t = makeTranslate(zh) as Translate

const state = (overrides: Partial<BalanceState>): BalanceState => ({
  phase: 'idle', wallets: [], updatedAt: null, checkedAt: 0, refreshing: false, providers: [], ...overrides,
})
const wallets = (total: string): ProviderReading => ({
  source: 'deepseek', label: 'DeepSeek API', status: 'ready', kind: 'wallets',
  wallets: [{ currency: 'CNY', total, toppedUp: total, granted: '0' }],
})

describe('pillSegments', () => {
  it('drops the DeepSeek API reading when it repeats the signed-in account', () => {
    const account = { phase: 'ready' as const, wallets: [{ currency: 'CNY' as const, total: '10.0', toppedUp: '10', granted: '0' }] }
    expect(pillSegments(state({ ...account, providers: [wallets('10.00')] }), t).map(segment => segment.key)).toEqual(['account'])
    expect(pillSegments(state({ ...account, providers: [wallets('3.00')] }), t).map(segment => segment.key)).toEqual(['account', 'deepseek'])
    expect(tooltipLines(state({ ...account, providers: [wallets('10.00')] }), t)).toHaveLength(2)
  })

  it('shows usage for a key without a limit and flags a full quota', () => {
    const [credit, quota] = pillSegments(state({ providers: [
      { source: 'openrouter', label: 'OpenRouter', status: 'ready', kind: 'credit', currency: 'USD', remaining: null, limit: null, used: 1.234 },
      { source: 'opencode-go', label: 'OpenCode Go', status: 'ready', kind: 'quota', windows: [{ name: 'monthly', percent: 100, resetsAt: null }] },
    ] }), t)
    expect(credit).toMatchObject({ value: '已用 $1.23', exhausted: false })
    expect(quota).toMatchObject({ value: '100%', exhausted: true })
  })

  it('shows only funded currencies, CNY first, and names the rolling window', () => {
    const reading: ProviderReading = { source: 'deepseek', label: 'DeepSeek API', status: 'ready', kind: 'wallets', wallets: [
      { currency: 'USD', total: '0.00', toppedUp: '0.00', granted: '0.00' },
      { currency: 'CNY', total: '329.91', toppedUp: '323.91', granted: '5.99' },
    ] }
    expect(pillSegments(state({ providers: [reading] }), t)[0]).toMatchObject({ value: '¥329.91', exhausted: false })
    expect(tooltipLines(state({ providers: [reading] }), t)[0]).toBe('DeepSeek API：充值 ¥323.91 · 赠金 ¥5.99')
    // The same account seen through Platform lists its wallets in another order and without the empty one.
    const account = { phase: 'ready' as const, wallets: [{ currency: 'CNY' as const, total: '329.9142', toppedUp: '323.9242', granted: '5.99' }] }
    expect(pillSegments(state({ ...account, providers: [reading] }), t).map(segment => segment.key)).toEqual(['account'])
    const quota: ProviderReading = { source: 'opencode-go', label: 'OC', status: 'ready', kind: 'quota', windows: [{ name: 'rolling', percent: 3, resetsAt: null }] }
    expect(tooltipLines(state({ providers: [quota] }), t)[0]).toBe('OC：5 小时 3%')
    const empty = { ...reading, wallets: reading.wallets.map(wallet => ({ ...wallet, total: '0.00' })) }
    expect(pillSegments(state({ providers: [empty] }), t)[0]).toMatchObject({ value: '¥0.00', exhausted: true })
  })

  it('keeps unknown quota window names and treats an empty quota as unreadable', () => {
    const reading: ProviderReading = { source: 'opencode-go', label: 'OC', status: 'ready', kind: 'quota', windows: [{ name: 'daily', percent: 5, resetsAt: 'not a date' }] }
    expect(tooltipLines(state({ providers: [reading] }), t)[0]).toBe('OC：daily 5%')
    expect(pillSegments(state({ providers: [{ ...reading, windows: [] }] }), t)[0]).toMatchObject({ value: '—', stale: true })
  })

  it('says the account could not be read when no reading was ever taken', () => {
    expect(pillSegments(state({ phase: 'failed' }), t)[0]).toMatchObject({ value: '—', stale: true })
    expect(tooltipLines(state({ phase: 'failed', checkedAt: null }), t)).toEqual(['DeepSeek 账号：余额读取失败', '正在刷新…'])
  })
})
