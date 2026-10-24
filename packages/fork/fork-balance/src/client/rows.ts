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
  /** How much of the window's time had passed at the reading, 0 to 100; null when its span is unknown. */
  readonly elapsed: number | null
  /** The use at the reset if the pace so far holds; null before a tenth of the window, with nothing used, or used up. */
  readonly projected: number | null
  /** The line under the bar: the time gone, then the projection or when the pace runs out; null without `elapsed`. */
  readonly pace: string | null
  /** At the pace so far the window runs out before it resets. */
  readonly overPace: boolean
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

const HOUR_MS = 3_600_000

/** Length of the fixed-length windows; `monthly` runs from the same day a month before its reset. */
const WINDOW_MS: Readonly<Record<string, number>> = { rolling: 5 * HOUR_MS, fiveHour: 5 * HOUR_MS, weekly: 7 * 24 * HOUR_MS }

/** A projection needs this share of the window's time behind it. */
const PROJECT_AFTER = 0.1

const CURRENCY_ORDER: Readonly<Record<WalletLine['currency'], number>> = { CNY: 0, USD: 1 }

function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function dateClock(at: number): string {
  const date = new Date(at)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${clock(at)}`
}

/** A time as the card shows it: today, tomorrow, or month-day and clock. */
function timeLabel(at: number, now: number, t: Translate): string {
  const day = (time: number): number => {
    const date = new Date(time)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const days = Math.round((day(at) - day(now)) / 86_400_000)
  if (days === 0) return t('reset.today', { time: clock(at) })
  if (days === 1) return t('reset.tomorrow', { time: clock(at) })
  return dateClock(at)
}

/** When a window opened: a fixed length before its reset, or the same day a month before (clamped to that month's end). */
function windowStart(name: string, resetsAt: number): number | undefined {
  if (name !== 'monthly') {
    const length = WINDOW_MS[name]
    return length === undefined ? undefined : resetsAt - length
  }
  const reset = new Date(resetsAt)
  const lastDay = new Date(reset.getFullYear(), reset.getMonth(), 0).getDate()
  return new Date(reset.getFullYear(), reset.getMonth() - 1, Math.min(reset.getDate(), lastDay),
    reset.getHours(), reset.getMinutes(), reset.getSeconds(), reset.getMilliseconds()).getTime()
}

type Pace = Pick<WindowBar, 'elapsed' | 'projected' | 'pace' | 'overPace'>

const NO_PACE: Pace = { elapsed: null, projected: null, pace: null, overPace: false }

/**
 * How far a window is through its time, and where its use is headed: the use so far over the share
 * of time gone. A pace that reaches 100 % before the reset says when.
 */
function paceOf(name: string, percent: number, resetsAt: number, now: number, t: Translate): Pace {
  const start = windowStart(name, resetsAt)
  if (start === undefined || now < start || now > resetsAt) return NO_PACE
  const share = (now - start) / (resetsAt - start)
  const elapsed = share * 100
  const gone = t('pace.elapsed', { percent: `${Math.round(elapsed)}%` })
  if (share < PROJECT_AFTER || percent <= 0 || percent >= 100) return { elapsed, projected: null, pace: gone, overPace: false }
  const projected = percent / share
  if (projected < 100) return { elapsed, projected, pace: `${gone} · ${t('pace.projected', { percent: `${Math.round(projected)}%` })}`, overPace: false }
  const runsOut = start + (now - start) * 100 / percent
  return { elapsed, projected, pace: `${gone} · ${t('pace.runsOut', { time: timeLabel(runsOut, now, t) })}`, overPace: true }
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
        windows: reading.windows.map((window) => {
          const percent = Math.max(0, Math.min(100, window.percent))
          const at = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt)
          return Number.isNaN(at)
            ? { label: windowName(window.name, t), percent, resets: null, ...NO_PACE }
            : { label: windowName(window.name, t), percent, resets: timeLabel(at, now, t), ...paceOf(window.name, percent, at, now, t) }
        }),
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
