/**
 * What the pill shows: one segment per provider ("OpenRouter $7.50") and the
 * tooltip lines that explain each one. Pure functions over the store state.
 */

import { Big } from 'big.js'
import type { BalanceState, ProviderReading, WalletLine } from './balance.ts'
import { formatAmount } from './balance.ts'
import type { BalanceKey } from './locales.ts'

/** The translate seat this module formats with. */
export type Translate = (key: BalanceKey, params?: Record<string, string | number>) => string

/** One labelled reading in the pill. */
export interface Segment {
  readonly key: string
  readonly label: string
  readonly value: string
  /** Nothing left to spend: requests on this route will fail. */
  readonly exhausted: boolean
  /** A reading a refresh could not renew, or none at all. */
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

function usd(amount: number): string {
  return formatAmount(String(amount), 'USD')
}

/** The wallets worth showing: funded ones, CNY first; an account with none funded shows its first. */
function shown(wallets: readonly WalletLine[]): WalletLine[] {
  const sorted = wallets.toSorted((left, right) => CURRENCY_ORDER[left.currency] - CURRENCY_ORDER[right.currency])
  const funded = sorted.filter(wallet => new Big(wallet.total).gt(0))
  return funded.length > 0 ? funded : sorted.slice(0, 1)
}

function totals(wallets: readonly WalletLine[]): string {
  return shown(wallets).map(wallet => formatAmount(wallet.total, wallet.currency)).join(' / ')
}

function drained(wallets: readonly WalletLine[]): boolean {
  return wallets.length > 0 && wallets.every(wallet => new Big(wallet.total).lte(0))
}

/** The account's wallets as shown: an account without wallets reads ¥0.00. */
function accountWallets(state: BalanceState): readonly WalletLine[] {
  return state.phase === 'ready' && state.wallets.length === 0
    ? [{ currency: 'CNY', total: '0', toppedUp: '0', granted: '0' }]
    : state.wallets
}

/** The DeepSeek API key of the signed-in account reports the same wallets; one segment is enough. */
function sameAccount(state: BalanceState, reading: ProviderReading): boolean {
  if (state.phase !== 'ready' || reading.status !== 'ready' || reading.kind !== 'wallets') return false
  // Platform and the API list empty wallets differently and with different precision (329.8642
  // against 329.86), so the account is identified by the funded amounts as the pill shows them.
  const key = (wallets: readonly WalletLine[]): string => wallets.filter(wallet => !new Big(wallet.total).eq(0))
    .map(wallet => formatAmount(wallet.total, wallet.currency)).sort().join(',')
  return key(state.wallets) === key(reading.wallets)
}

function windowName(name: string, t: Translate): string {
  const key = WINDOW_KEYS[name]
  return key === undefined ? name : t(key)
}

function mostUsed(reading: Extract<ProviderReading, { kind: 'quota' }>) {
  return reading.windows.reduce<(typeof reading.windows)[number] | undefined>(
    (top, window) => top === undefined || window.percent > top.percent ? window : top, undefined)
}

function readingValue(reading: ProviderReading, t: Translate): Pick<Segment, 'value' | 'exhausted' | 'stale'> {
  if (reading.status === 'failed') return { value: t('value.unavailable'), exhausted: false, stale: true }
  switch (reading.kind) {
    case 'wallets':
      return { value: totals(reading.wallets), exhausted: drained(reading.wallets), stale: false }
    case 'credit':
      return reading.remaining === null
        ? { value: t('value.used', { amount: usd(reading.used) }), exhausted: false, stale: false }
        : { value: usd(reading.remaining), exhausted: reading.remaining <= 0, stale: false }
    case 'quota': {
      const top = mostUsed(reading)
      return top === undefined
        ? { value: t('value.unavailable'), exhausted: false, stale: true }
        : { value: `${Math.round(top.percent)}%`, exhausted: top.percent >= 100, stale: false }
    }
  }
}

/**
 * The pill's segments: the DeepSeek account first, then each provider key.
 * @param state - the store state.
 * @param t - translate seat.
 * @returns segments in display order; empty when there is nothing to show.
 */
export function pillSegments(state: BalanceState, t: Translate): Segment[] {
  const segments: Segment[] = []
  if (state.phase === 'ready' || state.phase === 'failed') {
    const wallets = accountWallets(state)
    segments.push({
      key: 'account',
      label: t('label.account'),
      value: wallets.length === 0 ? t('value.unavailable') : totals(wallets),
      exhausted: state.phase === 'ready' && drained(wallets),
      stale: state.phase === 'failed',
    })
  }
  for (const reading of state.providers) {
    if (sameAccount(state, reading)) continue
    segments.push({ key: reading.source, label: reading.label, ...readingValue(reading, t) })
  }
  return segments
}

function walletLines(label: string, wallets: readonly WalletLine[], t: Translate): string[] {
  return shown(wallets).map(wallet => t('tooltip.wallet', {
    label,
    toppedUp: formatAmount(wallet.toppedUp, wallet.currency),
    granted: formatAmount(wallet.granted, wallet.currency),
  }))
}

function readingLines(reading: ProviderReading, t: Translate): string[] {
  if (reading.status === 'failed') return [t('tooltip.failedSource', { label: reading.label, reason: reading.reason })]
  switch (reading.kind) {
    case 'wallets':
      return walletLines(reading.label, reading.wallets, t)
    case 'credit':
      return [reading.remaining === null || reading.limit === null
        ? t('tooltip.creditUnlimited', { label: reading.label, used: usd(reading.used) })
        : t('tooltip.credit', { label: reading.label, remaining: usd(reading.remaining), limit: usd(reading.limit), used: usd(reading.used) })]
    case 'quota': {
      const line = t('tooltip.quota', {
        label: reading.label,
        windows: reading.windows.map(window => `${windowName(window.name, t)} ${Math.round(window.percent)}%`).join(' · '),
      })
      const top = mostUsed(reading)
      const resets = top?.resetsAt == null ? Number.NaN : Date.parse(top.resetsAt)
      return Number.isNaN(resets) || top === undefined
        ? [line]
        : [line, t('tooltip.quotaReset', { window: windowName(top.name, t), time: dateClock(resets) })]
    }
  }
}

/**
 * The tooltip: one or two lines per segment, then when the readings were taken.
 * @param state - the store state.
 * @param t - translate seat.
 * @returns lines to join with newlines.
 */
export function tooltipLines(state: BalanceState, t: Translate): string[] {
  const lines: string[] = []
  if (state.phase === 'ready') lines.push(...walletLines(t('tooltip.account'), accountWallets(state), t))
  if (state.phase === 'failed') {
    if (state.updatedAt === null) lines.push(t('tooltip.failed'))
    else lines.push(...walletLines(t('tooltip.account'), state.wallets, t), t('tooltip.stale', { time: clock(state.updatedAt) }))
  }
  for (const reading of state.providers) {
    if (!sameAccount(state, reading)) lines.push(...readingLines(reading, t))
  }
  lines.push(state.refreshing || state.checkedAt === null ? t('tooltip.refreshing') : t('tooltip.updated', { time: clock(state.checkedAt) }))
  return lines
}
