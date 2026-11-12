/**
 * The daily share card of the Bilibili section: once a day, at a random time in a window, the
 * account messages the owner's main account first with a video it watched and a recent 热梗. The
 * card holds the on/off switch, a button that sends one now, what today's share is doing, and the
 * recent shares. None of it needs the manage token: the plan is DSH's own, and bili-svc's own daily
 * cap still applies to what is sent. A share's text is the account's own words and shows only
 * when its row is opened.
 */

import { useId, type ReactNode } from 'react'
import type { ShareRow, ShareView } from '../view.ts'
import { dateTime } from './format.ts'
import type { CardProps } from './shared.ts'
import css from './BiliAccount.module.css'

/** A row's state word and the pill colour it gets. */
function rowState(row: ShareRow, t: CardProps['t']): { text: string; tone: string } {
  switch (row.outcome) {
    case 'sent': return { text: t('share.outcome.sent'), tone: 'ok' }
    case 'wechat': return { text: t('share.outcome.wechat'), tone: 'held' }
    case 'silent': return { text: t('share.outcome.silent'), tone: 'idle' }
    case 'missed': return { text: t('share.outcome.missed'), tone: 'held' }
    case 'failed': return { text: t('share.outcome.failed'), tone: 'failed' }
    default:
      return row.firedAt === null ? { text: t('share.outcome.planned'), tone: 'idle' } : { text: t('share.outcome.running'), tone: 'idle' }
  }
}

/** The line that says what today's share is doing. */
function todayText(share: ShareView, ownerSet: boolean, timeZone: string, t: CardProps['t']): string {
  if (!ownerSet) return t('share.today.noOwner')
  if (share.running) return t('share.today.running')
  const { today } = share
  if (today === null) return share.enabled ? t('share.today.unplanned') : t('share.today.off')
  switch (today.outcome) {
    case null: return share.enabled ? t('share.today.planned', { time: dateTime(today.planAt, timeZone) }) : t('share.today.off')
    case 'sent': return t('share.today.sent')
    case 'wechat': return t('share.today.wechat')
    case 'silent': return t('share.today.silent')
    case 'missed': return t('share.today.missed')
    case 'failed': return t('share.today.failed')
  }
}

function Row({ row, timeZone, t }: { row: ShareRow; timeZone: string; t: CardProps['t'] }): ReactNode {
  const state = rowState(row, t)
  const details: [string, string][] = [[t('share.row.text'), row.text ?? ''], [t('share.row.detail'), row.detail ?? '']]
  const present = details.filter(([, value]) => value !== '')
  return (
    <details className={css.row} data-share-row={row.day}>
      <summary className={css.rowSummary}>
        <span className={css.meta}>{dateTime(row.firedAt ?? row.planAt, timeZone)}</span>
        <span className={css.tag}>{row.reason === 'manual' ? t('share.reason.manual') : t('share.reason.plan')}</span>
        <span className={css.target}>{row.text ?? ''}</span>
        <span className={css.pill} data-state={state.tone}>{state.text}</span>
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
 * The daily share card.
 * @param props - the view and the action callback.
 */
export function Share(props: CardProps): ReactNode {
  const { view, t, busy, act } = props
  const { share } = view
  const id = useId()
  const ownerSet = view.ownerMid !== 0
  const mine = (action: 'share.enabled' | 'share.now'): boolean => busy?.action === action
  const used = view.gate?.used?.share ?? null
  const cap = view.gate?.caps?.share ?? null
  return (
    <section className={`${css.card} ${css.wide}`} aria-labelledby={id} data-share={share.enabled ? 'on' : 'off'}>
      <div className={css.cardHeader}>
        <span id={id} className={css.cardTitle}>{t('share.title')}</span>
        <button
          type="button"
          role="switch"
          className={css.switch}
          aria-checked={share.enabled}
          aria-label={t('share.switch')}
          aria-busy={mine('share.enabled') ? true : undefined}
          disabled={busy !== null}
          onClick={() => { act({ action: 'share.enabled', enabled: !share.enabled }) }}
        >
          <span className={css.knob} aria-hidden="true" />
        </button>
      </div>
      <span className={css.hint}>{t('share.hint', { start: share.start, end: share.end, zone: view.timeZone })}</span>
      <span className={css.shareToday} role="status" data-share-today="">{todayText(share, ownerSet, view.timeZone, t)}</span>
      {used === null || cap === null ? null : <span className={css.meta}>{t('share.used', { n: used, cap })}</span>}
      <div className={css.actions}>
        <span className={css.meta}>{t('share.now.hint')}</span>
        <button
          type="button"
          className={css.secondary}
          disabled={busy !== null || share.running || !ownerSet}
          aria-busy={mine('share.now') ? true : undefined}
          onClick={() => { act({ action: 'share.now' }) }}
        >
          {mine('share.now') ? t('busy.share') : t('share.now')}
        </button>
      </div>
      {share.recent.length === 0
        ? <span className={css.hint}>{t('share.recent.empty')}</span>
        : (
          <details className={css.shareRecent}>
            <summary className={css.ledgerSummary}>
              <span className={css.meta}>{t('share.recent', { n: share.recent.length })}</span>
            </summary>
            {share.recent.map(row => <Row key={`${row.day}-${row.planAt}`} row={row} timeZone={view.timeZone} t={t} />)}
          </details>
        )}
    </section>
  )
}
