import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountDetails } from '@deepseek-ai/dsh-deepseek-account/types'
import { BalanceLoader, createBalanceStore, formatAmount, summarizeWallets, type ProviderReading } from '../src/client/balance.ts'

type BalanceAnswer = AccountDetails['balance'] | null

const OPENROUTER: ProviderReading = { source: 'openrouter', label: 'OpenRouter', status: 'ready', kind: 'credit', currency: 'USD', remaining: 7.5, limit: 10, used: 2.5 }
const noProviders = (): Promise<readonly ProviderReading[]> => Promise.resolve([])

const ready = (cny: string, bonus = '0'): BalanceAnswer => ({
  status: 'ready', value: [{ currency: 'CNY', balance: cny }], bonusWallets: [{ currency: 'CNY', balance: bonus }],
})

afterEach(() => { vi.restoreAllMocks() })

describe('summarizeWallets', () => {
  it('adds topped-up and granted balances per currency, CNY first', () => {
    expect(summarizeWallets(
      [{ currency: 'USD', balance: '1.5' }, { currency: 'CNY', balance: '10.10' }],
      [{ currency: 'CNY', balance: '0.20' }],
    )).toEqual([
      { currency: 'CNY', total: '10.3', toppedUp: '10.1', granted: '0.2' },
      { currency: 'USD', total: '1.5', toppedUp: '1.5', granted: '0' },
    ])
  })

  it('keeps precision beyond floating point and accepts exponent decimals', () => {
    expect(summarizeWallets([{ currency: 'CNY', balance: '0.1' }], [{ currency: 'CNY', balance: '0.2' }])[0]?.total).toBe('0.3')
    expect(summarizeWallets([{ currency: 'CNY', balance: '0E-16' }], [])[0]?.total).toBe('0')
  })

  it('lists nothing when the account has no wallet', () => {
    expect(summarizeWallets([], [])).toEqual([])
  })
})

describe('formatAmount', () => {
  it('follows the Platform display rules', () => {
    expect(formatAmount('1234.567', 'CNY')).toBe('¥1,234.56')
    expect(formatAmount('0', 'USD')).toBe('$0.00')
    expect(formatAmount('0.004', 'CNY')).toBe('<¥0.01')
    expect(formatAmount('-0.004', 'CNY')).toBe('-¥0.01')
    expect(formatAmount('-12.5', 'USD')).toBe('-$12.50')
  })
})

describe('BalanceLoader', () => {
  it('publishes a ready answer with its wallets and time', async () => {
    const store = createBalanceStore()
    const loader = new BalanceLoader(store, () => Promise.resolve(ready('8.5', '1.5')), () => Promise.resolve([OPENROUTER]), () => 1_000)
    await loader.refresh(0)
    expect(store.getSnapshot()).toEqual({
      phase: 'ready',
      wallets: [{ currency: 'CNY', total: '10', toppedUp: '8.5', granted: '1.5' }],
      updatedAt: 1_000,
      checkedAt: 1_000,
      refreshing: false,
      providers: [OPENROUTER],
    })
  })

  it('shares one request between concurrent refreshes and skips fresh answers', async () => {
    const store = createBalanceStore()
    let now = 0
    const read = vi.fn(() => Promise.resolve(ready('1')))
    const loader = new BalanceLoader(store, read, noProviders, () => now)
    await Promise.all([loader.refresh(60_000), loader.refresh(60_000)])
    expect(read).toHaveBeenCalledTimes(1)
    now = 59_999
    await loader.refresh(60_000)
    expect(read).toHaveBeenCalledTimes(1)
    now = 60_000
    await loader.refresh(60_000)
    expect(read).toHaveBeenCalledTimes(2)
    // A click asks for a fresh answer regardless of age.
    await loader.refresh(0)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('marks the request in flight', async () => {
    const store = createBalanceStore()
    const pending = Promise.withResolvers<BalanceAnswer>()
    const loader = new BalanceLoader(store, () => pending.promise, noProviders, () => 5)
    const refresh = loader.refresh(0)
    expect(store.getSnapshot().refreshing).toBe(true)
    pending.resolve(ready('1'))
    await refresh
    expect(store.getSnapshot().refreshing).toBe(false)
  })

  it('keeps the last good wallets through a failure and clears them on sign-out', async () => {
    const store = createBalanceStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers: (BalanceAnswer | Error)[] = [ready('3'), { status: 'failed' }, new Error('offline'), null]
    let now = 0
    const loader = new BalanceLoader(store, () => {
      const answer = answers.shift()
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer ?? null)
    }, noProviders, () => now)
    await loader.refresh(0)
    now = 10
    await loader.refresh(0)
    expect(store.getSnapshot()).toMatchObject({ phase: 'failed', updatedAt: 0, checkedAt: 10 })
    expect(store.getSnapshot().wallets).toHaveLength(1)
    now = 20
    await loader.refresh(0)
    expect(store.getSnapshot()).toMatchObject({ phase: 'failed', checkedAt: 20 })
    expect(warn).toHaveBeenCalledTimes(2)
    // The reason stays generic: nothing the Host returned reaches the console.
    expect(warn.mock.calls.map(call => call.join(' '))).toEqual([
      '[lsy-balance] balance read failed',
      '[lsy-balance] balance read failed',
    ])
    await loader.refresh(0)
    expect(store.getSnapshot()).toMatchObject({ phase: 'signed-out', wallets: [], updatedAt: null })
  })

  it('asks the Host to bypass its cache on a forced refresh and keeps readings through a failed route', async () => {
    const store = createBalanceStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const readProviders = vi.fn((_fresh: boolean): Promise<readonly ProviderReading[]> => Promise.resolve([OPENROUTER]))
    let now = 0
    const loader = new BalanceLoader(store, () => Promise.resolve(null), readProviders, () => now)
    await loader.refresh(60_000)
    expect(readProviders).toHaveBeenLastCalledWith(false)
    readProviders.mockRejectedValueOnce(new Error('offline'))
    now = 1
    await loader.refresh(0)
    expect(readProviders).toHaveBeenLastCalledWith(true)
    expect(store.getSnapshot()).toMatchObject({ phase: 'signed-out', providers: [OPENROUTER] })
    expect(warn).toHaveBeenCalledWith('[lsy-balance] provider balances read failed')
  })
})
