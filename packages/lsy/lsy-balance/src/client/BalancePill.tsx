/**
 * Composer dock pill showing the DeepSeek account balance next to the activity
 * and usage pills. It renders nothing until the first answer and while signed
 * out; afterwards it shows each currency's total, tints red when nothing is
 * left, dims a reading a failed refresh could not renew, and refreshes on
 * click, on window focus, and every few minutes while the page is visible.
 */

import { useEffect, type ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Big } from 'big.js'
import { formatAmount, type BalanceState, type WalletLine } from './balance.ts'
// Type-only: registers the lsy.balance locale namespace this component's `t` reads.
import type {} from './locales.ts'
import css from './BalancePill.module.css'

/** Background refresh period, and the age a mount accepts. */
export const POLL_MS = 120_000
/** Age a returning window accepts before asking again. */
export const WAKE_MS = 30_000

/** The pill's injected face (slot `inject`). */
export interface BalancePillInjected {
  hooks: {
    /** The shared balance store. */
    balance: ObservableSnapshot<BalanceState>
  }
  /** Query unless an answer settled within `maxAgeMs`; 0 always queries. */
  refresh: (maxAgeMs: number) => void
}

/** Props delivered by the dock outlet. */
export type BalancePillProps = InjectFace<BalancePillInjected> & PropsLocale<'lsy.balance'>

function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function tooltipText(state: BalanceState, t: BalancePillProps['t']): string {
  if (state.refreshing) return t('tooltip.refreshing')
  const wallets = state.wallets.map(wallet => t('tooltip.wallet', {
    toppedUp: formatAmount(wallet.toppedUp, wallet.currency),
    granted: formatAmount(wallet.granted, wallet.currency),
  }))
  if (state.phase === 'failed') {
    return state.updatedAt === null ? t('tooltip.failed') : [...wallets, t('tooltip.stale', { time: clock(state.updatedAt) })].join('\n')
  }
  /* v8 ignore next -- a ready state always carries its answer time */
  return [...wallets, t('tooltip.updated', { time: clock(state.updatedAt ?? Date.now()) })].join('\n')
}

function WalletIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={css.icon}>
      <path d="M3 4.75 10.25 2.5c.6-.2 1.25.25 1.25.9v1.35" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <rect x="2.5" y="4.75" width="11" height="8.75" rx="1.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M13.5 7.75h-2.25a1.4 1.4 0 0 0 0 2.8h2.25" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Render the balance pill.
 * @param props - the dock-delivered store hook, refresh callback, and copy.
 * @returns the pill, or null before the first answer and while signed out.
 */
export function BalancePill({ useBalance, refresh, t }: BalancePillProps): ReactNode {
  const state = useBalance(value => value)

  useEffect(() => {
    refresh(POLL_MS)
    const poll = setInterval(() => { if (document.visibilityState === 'visible') refresh(POLL_MS) }, POLL_MS)
    const wake = (): void => { if (document.visibilityState === 'visible') refresh(WAKE_MS) }
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      clearInterval(poll)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [refresh])

  if (state.phase === 'idle' || state.phase === 'signed-out') return null
  const wallets: readonly WalletLine[] = state.phase === 'ready' && state.wallets.length === 0
    ? [{ currency: 'CNY', total: '0', toppedUp: '0', granted: '0' }]
    : state.wallets
  const amounts = wallets.map(wallet => formatAmount(wallet.total, wallet.currency))
  const exhausted = wallets.length > 0 && wallets.every(wallet => new Big(wallet.total).lte(0))
  const className = [
    css.pill,
    exhausted ? css.exhausted : '',
    state.phase === 'failed' ? css.stale : '',
    state.refreshing ? css.refreshing : '',
  ].filter(Boolean).join(' ')
  return (
    <span className={css.anchor} data-composer-stat="balance">
      <Tooltip label={() => tooltipText(state, t)} side="top" portal>
        <button
          type="button"
          className={className}
          aria-label={amounts.length === 0 ? t('pill.unavailable') : t('pill.aria', { amount: amounts.join(' / ') })}
          aria-busy={state.refreshing}
          onClick={() => { refresh(0) }}
        >
          <WalletIcon />
          <span className={css.label}>
            {amounts.length === 0
              ? t('pill.unavailable')
              : amounts.map((amount, index) => (
                <span key={wallets[index]?.currency}>
                  {index > 0 ? <span className={css.sep} aria-hidden>·</span> : null}
                  {amount}
                </span>
              ))}
          </span>
        </button>
      </Tooltip>
    </span>
  )
}
