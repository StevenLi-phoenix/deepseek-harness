/**
 * Account page card listing the balance or quota of every provider key the
 * Host holds (OpenRouter, the DeepSeek API, OpenCode Go), under the DeepSeek
 * account card. One row per provider: name and explanation on the left, the
 * headline value on the right, and a bar per window for quota subscriptions.
 * It reads on opening and on Refresh, and renders nothing while no provider
 * key is configured.
 */

import { useEffect, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BalanceState } from './balance.ts'
// Type-only: registers the lsy.balance locale namespace this component's `t` reads.
import type {} from './locales.ts'
import { freshness, providerRows, type Translate } from './rows.ts'
import css from './ProviderBalances.module.css'

/** Age of a reading the card accepts when it opens. */
export const OPEN_MAX_AGE_MS = 30_000

/** The card's injected face (slot `inject`). */
export interface ProviderBalancesInjected {
  hooks: {
    /** The shared balance store. */
    balance: ObservableSnapshot<BalanceState>
  }
  /** Query unless an answer settled within `maxAgeMs`; 0 always queries. */
  refresh: (maxAgeMs: number) => void
}

/** Props delivered by the Account page's balances area. */
export type ProviderBalancesProps = InjectFace<ProviderBalancesInjected> & PropsLocale<'lsy.balance'>

/**
 * Render the provider balance card.
 * @param props - the store hook, refresh callback, and copy.
 * @returns the card, or null while there is nothing to show.
 */
export function ProviderBalances({ useBalance, refresh, t }: ProviderBalancesProps): ReactNode {
  const state = useBalance(value => value)
  useEffect(() => { refresh(OPEN_MAX_AGE_MS) }, [refresh])

  const translate = t as Translate
  const rows = providerRows(state, translate)
  if (rows.length === 0) return null
  return (
    <section className={css.card} aria-label={translate('title')}>
      <div className={css.header}>
        <span className={css.title}>{translate('title')}</span>
        <span className={css.status} role="status">{freshness(state, translate)}</span>
      </div>
      {rows.map(row => (
        <div key={row.key} className={css.block} data-balance-source={row.key}>
          <div className={css.divider} />
          <div className={css.row}>
            <div className={css.identity}>
              <span className={css.name}>{row.label}</span>
              {row.details.map(detail => <span key={detail} className={css.detail}>{detail}</span>)}
            </div>
            <span className={[css.value, row.exhausted ? css.exhausted : '', row.stale ? css.stale : ''].filter(Boolean).join(' ')}>
              {row.value}
            </span>
          </div>
          {row.windows.length === 0
            ? null
            : (
              <div className={css.windows}>
                {row.windows.map(window => (
                  <div key={window.label} className={css.window}>
                    <span className={css.windowLabel}>{window.label}</span>
                    <span
                      className={css.track}
                      role="meter"
                      aria-label={window.label}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(window.percent)}
                    >
                      <span
                        className={window.percent >= 100 ? `${css.fill} ${css.full}` : window.percent >= 80 ? `${css.fill} ${css.high}` : css.fill}
                        style={{ width: `${window.percent}%` }}
                      />
                    </span>
                    <span className={css.windowValue}>{`${Math.round(window.percent)}%`}</span>
                  </div>
                ))}
              </div>
            )}
        </div>
      ))}
      <div className={css.divider} />
      <div className={css.footer}>
        <button
          type="button"
          className={css.refresh}
          aria-label={translate('refreshAria')}
          aria-busy={state.refreshing}
          disabled={state.refreshing}
          onClick={() => { refresh(0) }}
        >
          {translate('refresh')}
        </button>
      </div>
    </section>
  )
}
