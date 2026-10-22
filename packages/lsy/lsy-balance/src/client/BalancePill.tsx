/**
 * Composer dock pill showing every balance in one row: the DeepSeek account
 * and each provider key the Host holds ("DeepSeek ¥12.34 · OpenRouter $7.50 ·
 * OpenCode Go 34%"). It renders nothing until the first answer or while there
 * is nothing to show; a segment with nothing left turns red, an unrenewed one
 * dims, and the tooltip explains each. It refreshes on click (bypassing the
 * Host cache), on window focus, and every two minutes while the page is visible.
 */

import { useEffect, type ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BalanceState } from './balance.ts'
// Type-only: registers the lsy.balance locale namespace this component's `t` reads.
import type {} from './locales.ts'
import { pillSegments, tooltipLines, type Translate } from './segments.ts'
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
 * @returns the pill, or null while there is nothing to show.
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

  const translate = t as Translate
  const segments = pillSegments(state, translate)
  if (segments.length === 0) return null
  return (
    <span className={css.anchor} data-composer-stat="balance">
      <Tooltip label={() => tooltipLines(state, translate).join('\n')} side="top" portal>
        <button
          type="button"
          className={state.refreshing ? `${css.pill} ${css.refreshing}` : css.pill}
          aria-label={translate('pill.aria', { summary: segments.map(segment => `${segment.label} ${segment.value}`).join(', ') })}
          aria-busy={state.refreshing}
          onClick={() => { refresh(0) }}
        >
          <WalletIcon />
          <span className={css.label}>
            {segments.map((segment, index) => (
              <span
                key={segment.key}
                data-balance-source={segment.key}
                className={[css.segment, segment.exhausted ? css.exhausted : '', segment.stale ? css.stale : ''].filter(Boolean).join(' ')}
              >
                {index > 0 ? <span className={css.sep} aria-hidden>·</span> : null}
                <span className={css.name}>{segment.label}</span>
                {' '}
                {segment.value}
              </span>
            ))}
          </span>
        </button>
      </Tooltip>
    </span>
  )
}
