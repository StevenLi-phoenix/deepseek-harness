/**
 * What the Host balance route answers, shared by both halves as types only:
 * one reading per configured provider key, already stripped of the key.
 */

/** Wallet currencies DeepSeek reports. */
export type WalletCurrency = 'CNY' | 'USD'

/** One currency's balance; decimal strings keep the server's precision. */
export interface WalletLine {
  readonly currency: WalletCurrency
  /** Topped-up plus granted. */
  readonly total: string
  readonly toppedUp: string
  readonly granted: string
}

/** One quota window of a subscription, such as five hours or a week. */
export interface QuotaWindow {
  /** The provider's window name, for example `fiveHour`. */
  readonly name: string
  /** Share used, 0-100. */
  readonly percent: number
  readonly resetsAt: string | null
}

/** Fields every reading carries. */
interface ReadingBase {
  /** Source kind, also the stable id: one reading per kind. */
  readonly source: string
  /** Display name. */
  readonly label: string
}

/** One provider's balance as the card renders it. */
export type ProviderReading = ReadingBase & (
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'ready'; readonly kind: 'wallets'; readonly wallets: readonly WalletLine[] }
  | {
    readonly status: 'ready'
    readonly kind: 'credit'
    readonly currency: 'USD'
    /** Credit left under the key's limit; null when the key has no limit. */
    readonly remaining: number | null
    readonly limit: number | null
    readonly used: number
  }
  | { readonly status: 'ready'; readonly kind: 'quota'; readonly windows: readonly QuotaWindow[] }
)

/** Body of `GET api/lsy.balance`. */
export interface BalanceRouteBody {
  readonly readings: readonly ProviderReading[]
}

/** Absolute Host registration path of the balance route. */
export const BALANCE_PATH = '/api/lsy.balance'
/** Document-relative form the browser fetches. */
export const BALANCE_ROUTE = BALANCE_PATH.slice(1)
