/**
 * The gate card of the Bilibili section: bili-svc's mode, its risk brake with the reason and time,
 * the day's counters against their caps, and (with the manage token) the controls. Reopening the
 * Reply Gate has an order the card spells out: release the brake first, then switch to automatic,
 * and the switch asks for a second, explicit click that says who will speak in public. Stopping is
 * one click. A refusal by bili-svc shows inside the card.
 */

import { useState, type ReactNode } from 'react'
import { agoText, dateTime } from './format.ts'
import type { CardProps } from './shared.ts'
import css from './BiliAccount.module.css'

/** What a refused mode switch leaves in the store, shown inside the card. */
export interface GateRefusal {
  /** bili-svc's words. */
  readonly message: string
}

/**
 * The gate card.
 * @param props - the view and the action callback.
 * @param refusal - bili-svc's refusal of the last mode switch, or null.
 */
export function Gate(props: CardProps & { refusal: GateRefusal | null }): ReactNode {
  const { view, now, t, busy, act, refusal } = props
  const [confirming, setConfirming] = useState(false)
  const { gate } = view
  if (gate === null) {
    return <section className={`${css.card} ${css.wide}`} aria-label={t('gate.title')}><span className={css.hint}>{t('gate.unknown')}</span></section>
  }
  const auto = gate.mode === 'auto'
  const braked = gate.brake !== null
  const modeLabel = auto ? t('gate.mode.auto') : gate.mode === 'readonly' ? t('gate.mode.readonly') : gate.mode || '—'
  const mine = (action: 'gate.mode' | 'brake.release'): boolean => busy?.action === action
  const speaker = view.speaker === null ? t('gate.speaker.unknown') : view.speaker.display
  const switching = (
    <>
      <button
        type="button"
        className={css.primary}
        disabled={busy !== null}
        aria-busy={mine('gate.mode') ? true : undefined}
        onClick={() => { setConfirming(false); act({ action: 'gate.mode', mode: 'auto' }) }}
      >
        {mine('gate.mode') ? t('busy.mode') : t('gate.toAuto.confirm')}
      </button>
      <button type="button" className={css.secondary} onClick={() => { setConfirming(false) }}>{t('account.cancel')}</button>
    </>
  )
  return (
    <section className={`${css.card} ${css.wide}`} aria-label={t('gate.title')} data-gate={gate.readonly ? 'held' : 'open'}>
      <div className={css.cardHeader}>
        <span className={css.cardTitle}>{t('gate.title')}</span>
        <span className={css.pill} data-state={gate.readonly ? 'dead' : 'ok'}>{gate.readonly ? t('gate.state.held') : t('gate.state.open')}</span>
      </div>
      <span className={css.meta}>{t('gate.mode', { mode: modeLabel })}</span>
      <span className={css.hint}>{gate.readonly ? t('gate.hint.held') : t('gate.hint.open')}</span>
      {gate.brake === null
        ? null
        : (
          <div className={css.brake} role="status">
            <span className={css.bannerTitle}>{t('gate.brake', { reason: gate.brake.reason === '' ? '—' : gate.brake.reason })}</span>
            {gate.brake.detail === '' ? null : <span className={css.bannerHint}>{gate.brake.detail}</span>}
            {gate.brake.ts === null
              ? null
              : <span className={css.bannerHint} title={dateTime(gate.brake.ts, view.timeZone)}>{t('gate.brake.at', { ago: agoText(gate.brake.ts, now, t) })}</span>}
          </div>
        )}
      {gate.used === null || gate.caps === null
        ? null
        : <span className={css.meta}>{t('gate.used', { comment: gate.used.comment, commentCap: gate.caps.comment, dm: gate.used.dm, dmCap: gate.caps.dm })}</span>}
      {refusal === null
        ? null
        : (
          <div className={css.error} role="alert" data-scope="gate">
            <span>{t('error.mode_refused')}</span>
            {refusal.message === '' ? null : <span className={css.meta}>{refusal.message}</span>}
          </div>
        )}
      {view.manage
        ? (
          <>
            {!auto && braked ? <span className={css.hint}>{t('gate.toAuto.brake')}</span> : null}
            {confirming && !auto && !braked
              ? <span className={css.hint} role="note">{t('gate.toAuto.warn', { name: speaker })}</span>
              : null}
            <div className={css.actions}>
              {braked
                ? (
                  <button type="button" className={css.primary} disabled={busy !== null} aria-busy={mine('brake.release') ? true : undefined} onClick={() => { act({ action: 'brake.release' }) }}>
                    {mine('brake.release') ? t('busy.brake') : t('gate.brake.release')}
                  </button>
                )
                : null}
              {auto
                ? (
                  <button type="button" className={css.secondary} disabled={busy !== null} aria-busy={mine('gate.mode') ? true : undefined} onClick={() => { act({ action: 'gate.mode', mode: 'readonly' }) }}>
                    {mine('gate.mode') ? t('busy.mode') : t('gate.toReadonly')}
                  </button>
                )
                : confirming && !braked
                  ? switching
                  : (
                    <button type="button" className={css.secondary} disabled={busy !== null || braked} title={braked ? t('gate.toAuto.brake') : undefined} onClick={() => { setConfirming(true) }}>
                      {t('gate.toAuto')}
                    </button>
                  )}
            </div>
          </>
        )
        : null}
    </section>
  )
}
