/**
 * The QQ settings section: one verdict card ("is QQ working, and what do I do"), the login QR code when a scan is
 * needed (large, centred, renewed by itself as NapCat rotates it), and the connection details. It polls while
 * mounted, which the settings shell does only while the section is the open one, and pauses while the page is
 * hidden. A failed refresh keeps the last answer and says so quietly in the status line.
 */

import { useEffect, useId, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: registers the lsy.qq locale namespace this component's `t` reads.
import type {} from './locales.ts'
import { detailRows, headline, qrPath, statusLine, type Translate } from './cards.ts'
import { POLL_INTERVAL_MS, startPolling, type QqState } from './qq.ts'
import css from './QqLogin.module.css'

/** The section's injected face (slot `inject`). */
export interface QqLoginInjected {
  hooks: {
    /** The shared QQ store. */
    qq: ObservableSnapshot<QqState>
  }
  /** One status refresh; a request in flight is shared. */
  refresh: () => void
  /** Ask NapCat for a fresh login code. */
  renewCode: () => void
}

/** Props delivered by the settings shell. */
export type QqLoginProps = PropsRuntime<'settings.section'> & InjectFace<QqLoginInjected> & PropsLocale<'lsy.qq'>

function QrCard({ matrix, state, translate, renewCode }: {
  matrix: NonNullable<QqState['panel']>['login']['qr']
  state: QqState
  translate: Translate
  renewCode: () => void
}): ReactNode {
  const id = useId()
  const drawing = matrix === null ? null : qrPath(matrix)
  const error = state.panel?.login.error ?? null
  return (
    <section className={css.card} aria-labelledby={id}>
      <span id={id} className={css.cardTitle}>{translate('qr.title')}</span>
      <div className={css.qrBox}>
        {drawing === null
          ? null
          : (
            <svg className={css.qr} viewBox={drawing.viewBox} role="img" aria-label={translate('qr.label')} shapeRendering="crispEdges">
              <path className={css.qrMods} d={drawing.d} />
            </svg>
          )}
        <div className={css.actions}>
          <button type="button" className={css.secondary} disabled={state.codeRequested} onClick={renewCode}>
            {translate(state.codeRequested ? 'qr.refreshing' : 'qr.refresh')}
          </button>
        </div>
        {state.codeDeclined ? <p className={css.notice} role="status">{translate('qr.declined')}</p> : null}
        {error === null ? null : <p className={css.notice}>{translate('qr.error', { error })}</p>}
        <p className={css.hint}>{translate('qr.auto')}</p>
        <p className={css.hint}>{translate('qr.phone')}</p>
      </div>
    </section>
  )
}

/**
 * Render the QQ section.
 * @param props - the store hook, callbacks, and copy.
 * @returns the section.
 */
export function QqLoginSection({ useQq, refresh, renewCode, t }: QqLoginProps): ReactNode {
  const state = useQq(value => value)
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])

  const translate = t as Translate
  const status = statusLine(state, translate)
  const { panel } = state
  const now = state.checkedAt ?? Date.now()
  const verdict = panel === null ? undefined : headline(panel, now, translate)
  const rows = panel === null ? [] : detailRows(panel, now, translate)
  return (
    <section className={css.section} aria-label={translate('title')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={status.tone} aria-hidden="true" />
          {status.text}
        </span>
      </div>
      {panel === null || verdict === undefined
        ? null
        : (
          <>
            <div className={css.hero} data-tone={verdict.tone} data-kind={verdict.kind}>
              <span className={css.mark} data-tone={verdict.tone} aria-hidden="true" />
              <div className={css.heroText}>
                <h3 className={css.verdict}>{verdict.text}</h3>
                <p className={css.next}>{verdict.detail}</p>
              </div>
            </div>
            {verdict.kind === 'scan' ? <QrCard matrix={panel.login.qr} state={state} translate={translate} renewCode={renewCode} /> : null}
            <section className={css.card} aria-label={translate('detail.title')}>
              <span className={css.cardTitle}>{translate('detail.title')}</span>
              <dl className={css.rows}>
                {rows.map(row => (
                  <div key={row.key} style={{ display: 'contents' }}>
                    <dt>{row.label}</dt>
                    <dd className={row.code === true ? css.code : undefined}>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </>
        )}
    </section>
  )
}
