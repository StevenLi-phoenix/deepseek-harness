/**
 * Balances for the composer dock: the DeepSeek account's per-currency totals,
 * read through the same Host account Remote the Account settings page uses,
 * and the readings of the provider keys the Host balance route queries
 * (OpenRouter, the DeepSeek API, OpenCode Go).
 */

import { Big } from 'big.js'
import type { AccountDetails, AccountWallet } from '@deepseek-ai/dsh-deepseek-account/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ProviderReading, WalletLine } from '../readings.ts'

export type { ProviderReading, WalletLine } from '../readings.ts'

/** Wallet currencies Platform reports. */
export type Currency = AccountWallet['currency']

/** What the pill renders. */
export interface BalanceState {
  /** `idle` until the first answer; `signed-out` when no account grant is stored. */
  phase: 'idle' | 'ready' | 'signed-out' | 'failed'
  /** Last good wallets; a failed refresh keeps them so the pill can show them as stale. */
  wallets: readonly WalletLine[]
  /** Time of the last ready answer. */
  updatedAt: number | null
  /** Time of the last settled request, ready or not; freshness is measured from here. */
  checkedAt: number | null
  refreshing: boolean
  /** The Host route's last answer: one reading per provider key it holds. */
  providers: readonly ProviderReading[]
}

/** One Host balance answer: null when no account grant is stored. */
export type BalanceAnswer = AccountDetails['balance'] | null

const CURRENCY_ORDER: readonly Currency[] = ['CNY', 'USD']
const SYMBOL: Record<Currency, string> = { CNY: '¥', USD: '$' }

/**
 * Join the topped-up and granted wallets by currency.
 * @param toppedUp - recharge wallets.
 * @param granted - bonus wallets.
 * @returns one line per currency present in either list, CNY first.
 */
export function summarizeWallets(toppedUp: readonly AccountWallet[], granted: readonly AccountWallet[]): WalletLine[] {
  const sum = (wallets: readonly AccountWallet[], currency: Currency): Big =>
    wallets.filter(wallet => wallet.currency === currency).reduce((total, wallet) => total.plus(wallet.balance), new Big(0))
  return CURRENCY_ORDER
    .filter(currency => [...toppedUp, ...granted].some(wallet => wallet.currency === currency))
    .map((currency) => {
      const paid = sum(toppedUp, currency)
      const bonus = sum(granted, currency)
      return { currency, total: paid.plus(bonus).toString(), toppedUp: paid.toString(), granted: bonus.toString() }
    })
}

/**
 * Format an amount with Platform Web's two-decimal and sub-cent rules (the
 * Account settings page uses the same ones).
 * @param amount - decimal string.
 * @param currency - wallet currency.
 * @returns signed currency text with grouped digits.
 */
export function formatAmount(amount: string, currency: Currency): string {
  const symbol = SYMBOL[currency]
  const value = new Big(amount)
  if (value.eq(0)) return `${symbol}0.00`
  if (value.lt(0)) return `-${symbol}${value.gt(-0.01) ? '0.01' : grouped(value.abs().toFixed(2))}`
  if (value.lt('0.01')) return `<${symbol}0.01`
  return `${symbol}${grouped(value.round(2, Big.roundDown).toFixed(2))}`
}

function grouped(value: string): string {
  const [integer, fraction] = value.split('.')
  return `${Number(integer).toLocaleString('en-US')}.${fraction}`
}

/** @returns a store holding the not-yet-loaded state. */
export function createBalanceStore(): SnapshotStore<BalanceState> {
  return createSnapshotStore<BalanceState>({ phase: 'idle', wallets: [], updatedAt: null, checkedAt: null, refreshing: false, providers: [] })
}

/** Reads the balances into a store, one round at a time. */
export class BalanceLoader {
  private inFlight: Promise<void> | undefined

  /**
   * @param store - the store the pill renders.
   * @param read - one account balance query; rejects on transport failure.
   * @param readProviders - one Host balance route query; `fresh` asks the Host to bypass its cache.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<BalanceState>,
    private readonly read: () => Promise<BalanceAnswer>,
    private readonly readProviders: (fresh: boolean) => Promise<readonly ProviderReading[]>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Query unless an answer settled within `maxAgeMs`; concurrent callers share
   * the request in flight.
   * @param maxAgeMs - accepted age of the last settled answer; 0 always queries.
   * @returns settlement after the answer is published.
   */
  refresh(maxAgeMs: number): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    const { checkedAt } = this.store.getSnapshot()
    if (maxAgeMs > 0 && checkedAt !== null && this.now() - checkedAt < maxAgeMs) return Promise.resolve()
    this.store.update((draft) => { draft.refreshing = true })
    const request = this.query(maxAgeMs === 0).finally(() => { this.inFlight = undefined })
    this.inFlight = request
    return request
  }

  private async query(fresh: boolean): Promise<void> {
    const [answer, providers] = await Promise.all([
      this.read().catch((): BalanceAnswer => ({ status: 'failed' })),
      // A failed route keeps the previous readings; each reading carries its own failure.
      this.readProviders(fresh).catch(() => { console.warn('[lsy-balance] provider balances read failed'); return undefined }),
    ])
    const at = this.now()
    if (answer?.status === 'failed') console.warn('[lsy-balance] balance read failed')
    this.store.update((draft) => {
      draft.refreshing = false
      draft.checkedAt = at
      if (providers !== undefined) draft.providers = providers
      if (answer === null) {
        draft.phase = 'signed-out'
        draft.wallets = []
        draft.updatedAt = null
      } else if (answer.status === 'failed') {
        draft.phase = 'failed'
      } else {
        draft.phase = 'ready'
        draft.wallets = summarizeWallets(answer.value, answer.bonusWallets)
        draft.updatedAt = at
      }
    })
  }
}
