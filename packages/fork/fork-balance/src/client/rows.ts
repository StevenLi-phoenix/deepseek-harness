/**
 * What the Account page's provider card shows: one row per provider key the
 * Host reads, with its headline value and the lines that explain it. Pure
 * functions over the store state.
 */

import { Big } from 'big.js'
import type { BalanceState, ProviderReading, WalletLine } from './balance.ts'
import { formatAmount } from './balance.ts'
import type { BalanceKey } from './locales.ts'

/** The translate seat this module formats with. */
export type Translate = (key: BalanceKey, params?: Record<string, string | number>) => string

/** One quota window drawn as a bar. */
export interface WindowBar {
  readonly label: string
  readonly percent: number
  /** When the window resets, relative to the reading (`今天 13:49`, `11-15 13:32`); null when unknown. */
  readonly resets: string | null
}

/** One provider row. */
export interface ProviderRow {
  readonly key: string
  readonly label: string
  /** Headline: what is left, or the busiest quota window. */
  readonly value: string
  /** Secondary lines under the name. */
  readonly details: readonly string[]
  /** Quota windows, for subscriptions. */
  readonly windows: readonly WindowBar[]
  /** Nothing left to spend: requests on this route will fail. */
  readonly exhausted: boolean
  /** A reading that could not be taken. */
  readonly stale: boolean
}

/** OpenCode Go names its five-hour window `rolling`. */
const WINDOW_KEYS: Readonly<Record<string, BalanceKey>> = {
  rolling: 'window.fiveHour', fiveHour: 'window.fiveHour', weekly: 'window.weekly', monthly: 'window.monthly',
}

const CURRENCY_ORDER: Readonly<Record<WalletLine['currency'], number>> = { CNY: 0, USD: 1 }

function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function dateClock(at: number): string {
  const date = new Date(at)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${clock(at)}`
}

/** A reset time as the card shows it: today, tomorrow, or month-day and clock. */
function resetLabel(resetsAt: string | null, now: number, t: Translate): string | null {
  const at = resetsAt === null ? Number.NaN : Date.parse(resetsAt)
  if (Number.isNaN(at)) return null
  const day = (time: number): number => {
    const date = new Date(time)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const days = Math.round((day(at) - day(now)) / 86_400_000)
  if (days === 0) return t('reset.today', { time: clock(at) })
  if (days === 1) return t('reset.tomorrow', { time: clock(at) })
  return dateClock(at)
}

function usd(amount: number): string {
  return formatAmount(String(amount), 'USD')
}

/** The wallets worth showing: funded ones, CNY first; a source with none funded shows its first. */
function shown(wallets: readonly WalletLine[]): WalletLine[] {
  const sorted = wallets.toSorted((left, right) => CURRENCY_ORDER[left.currency] - CURRENCY_ORDER[right.currency])
  const funded = sorted.filter(wallet => new Big(wallet.total).gt(0))
  return funded.length > 0 ? funded : sorted.slice(0, 1)
}

/**
 * The DeepSeek API key of the signed-in account reports the same wallets as
 * the account card above it; one is enough. Platform and the API list empty
 * wallets differently and with different precision (329.8642 against
 * 329.86), so the account is identified by the funded amounts as displayed.
 */
function sameAccount(state: BalanceState, reading: ProviderReading): boolean {
  if (state.phase !== 'ready' || reading.status !== 'ready' || reading.kind !== 'wallets') return false
  const key = (wallets: readonly WalletLine[]): string => wallets.filter(wallet => !new Big(wallet.total).eq(0))
    .map(wallet => formatAmount(wallet.total, wallet.currency)).sort().join(',')
  return key(state.wallets) === key(reading.wallets)
}

function windowName(name: string, t: Translate): string {
  const key = WINDOW_KEYS[name]
  return key === undefined ? name : t(key)
}

function row(reading: ProviderReading, t: Translate, now: number): ProviderRow {
  const base = { key: reading.source, label: reading.label }
  if (reading.status === 'failed') {
    return { ...base, value: t('value.unavailable'), details: [t('detail.failed', { reason: reading.reason })], windows: [], exhausted: false, stale: true }
  }
  switch (reading.kind) {
    case 'wallets': {
      const wallets = shown(reading.wallets)
      return {
        ...base,
        value: wallets.map(wallet => formatAmount(wallet.total, wallet.currency)).join(' / '),
        details: wallets.map(wallet => t('detail.wallet', {
          toppedUp: formatAmount(wallet.toppedUp, wallet.currency), granted: formatAmount(wallet.granted, wallet.currency),
        })),
        windows: [],
        exhausted: wallets.every(wallet => new Big(wallet.total).lte(0)),
        stale: false,
      }
    }
    case 'credit':
      return reading.remaining === null || reading.limit === null
        ? { ...base, value: t('value.used', { amount: usd(reading.used) }), details: [t('detail.noLimit')], windows: [], exhausted: false, stale: false }
        : {
          ...base,
          value: usd(reading.remaining),
          details: [t('detail.credit', { limit: usd(reading.limit), used: usd(reading.used) })],
          windows: [],
          exhausted: reading.remaining <= 0,
          stale: false,
        }
    case 'quota': {
      const top = reading.windows.reduce<(typeof reading.windows)[number] | undefined>(
        (best, window) => best === undefined || window.percent > best.percent ? window : best, undefined)
      if (top === undefined) return { ...base, value: t('value.unavailable'), details: [], windows: [], exhausted: false, stale: true }
      const resets = top.resetsAt === null ? Number.NaN : Date.parse(top.resetsAt)
      return {
        ...base,
        value: t('value.used', { amount: `${Math.round(top.percent)}%` }),
        details: Number.isNaN(resets) ? [] : [t('detail.reset', { window: windowName(top.name, t), time: dateClock(resets) })],
        windows: reading.windows.map(window => ({
          label: windowName(window.name, t),
          percent: Math.max(0, Math.min(100, window.percent)),
          resets: resetLabel(window.resetsAt, now, t),
        })),
        exhausted: top.percent >= 100,
        stale: false,
      }
    }
  }
}

/**
 * The card's rows, in the Host's source order, without a DeepSeek API reading
 * that repeats the signed-in account.
 * @param state - the store state.
 * @param t - translate seat.
 * @returns rows; empty when no provider key is configured.
 */
export function providerRows(state: BalanceState, t: Translate): ProviderRow[] {
  const now = state.checkedAt ?? Date.now()
  return state.providers.filter(reading => !sameAccount(state, reading)).map(reading => row(reading, t, now))
}

/**
 * The card's footer status.
 * @param state - the store state.
 * @param t - translate seat.
 * @returns refreshing, or when the readings were taken.
 */
export function freshness(state: BalanceState, t: Translate): string {
  return state.refreshing || state.checkedAt === null ? t('refreshing') : t('updated', { time: clock(state.checkedAt) })
}
