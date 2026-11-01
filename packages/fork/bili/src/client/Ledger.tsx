/**
 * The ledger card of the Bilibili section: bili-svc's recent actions, collapsed until opened.
 * Every row is plain text and is cut short by the Host; the draft and the verdict, which carry
 * words written by others or by a model, show only when a row is opened.
 */

import type { ReactNode } from 'react'
import type { LedgerRow } from '../view.ts'
import { LEDGER_MAX } from './bili.ts'
import { dateTime } from './format.ts'
import type { CardProps } from './shared.ts'
import css from './BiliAccount.module.css'

/** Rows added by one "show more". */
const MORE = 30

function Row({ row, timeZone, t }: { row: LedgerRow; timeZone: string; t: CardProps['t'] }): ReactNode {
  const details: [string, string][] = [
    [t('ledger.reason'), row.reason], [t('ledger.caller'), row.caller], [t('ledger.draft'), row.draft], [t('ledger.verdict'), row.verdict],
  ]
  const present = details.filter(([, value]) => value !== '')
  return (
    <details className={css.row}>
      <summary className={css.rowSummary}>
        <span className={css.meta}>{row.ts === null ? '—' : dateTime(row.ts, timeZone)}</span>
        <span>{row.kind}</span>
        <span className={css.target}>{row.target}</span>
        <span className={css.pill} data-state={row.state === 'sent' ? 'ok' : row.state}>{row.state}</span>
      </summary>
      {present.length === 0
        ? null
        : (
          <dl className={css.rowDetails}>
            {present.map(([label, value]) => (
              <div key={label} className={css.rowDetail}>
                <dt className={css.meta}>{label}</dt>
                <dd className={css.plain}>{value}</dd>
              </div>
            ))}
          </dl>
        )}
    </details>
  )
}

/**
 * The ledger card.
 * @param props - the view and the action callback.
 * @param limit - ledger rows asked for so far.
 */
export function Ledger(props: CardProps & { limit: number }): ReactNode {
  const { view, t, busy, act, limit } = props
  const { ledger } = view
  if (!view.manage) return null
  const more = ledger !== null && ledger.rows.length >= limit && limit < LEDGER_MAX
  return (
    <details className={`${css.card} ${css.wide} ${css.ledger}`}>
      <summary className={css.ledgerSummary}>
        <span className={css.cardTitle}>{t('ledger.title')}</span>
        {ledger === null ? null : <span className={css.meta}>{t('ledger.count', { n: ledger.rows.length })}</span>}
      </summary>
      {ledger === null ? <span className={css.hint}>{t('ledger.unavailable')}</span> : null}
      {ledger !== null && ledger.rows.length === 0 ? <span className={css.hint}>{t('ledger.empty')}</span> : null}
      {ledger === null || Object.keys(ledger.summary).length === 0
        ? null
        : (
          <div className={css.chips}>
            {Object.entries(ledger.summary).map(([key, value]) => <span key={key} className={css.chip}>{`${key} ${value}`}</span>)}
          </div>
        )}
      {ledger?.rows.map((row, index) => <Row key={`${row.ts ?? 0}-${index}`} row={row} timeZone={view.timeZone} t={t} />)}
      {more
        ? (
          <div className={css.actions}>
            <button type="button" className={css.secondary} disabled={busy !== null} aria-busy={busy?.action === 'ledger' ? true : undefined} onClick={() => { act({ action: 'ledger', limit: Math.min(limit + MORE, LEDGER_MAX) }) }}>
              {busy?.action === 'ledger' ? t('busy.more') : t('ledger.more')}
            </button>
          </div>
        )
        : null}
    </details>
  )
}
