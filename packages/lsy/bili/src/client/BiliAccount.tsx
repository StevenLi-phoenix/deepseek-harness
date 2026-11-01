/**
 * The Bilibili account Settings section: the gate with its brake, one card per account bili-svc
 * holds (with QR sign-in, refresh, check, and sign-out when the Host has the manage token), the
 * recent action ledger, and the owner's main account. It polls while mounted and pauses while the
 * page is hidden; a QR code waiting for a scan is asked every two seconds. Nothing it shows can be
 * a cookie or token: bili-svc's answers name accounts and states only, and QR keys stay on the Host.
 */

import { useId, useEffect, useState, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ActionResult, BiliAction, BiliView } from '../view.ts'
import { Accounts } from './Accounts.tsx'
import { LOGIN_POLL_MS, POLL_INTERVAL_MS, startPolling, type BiliState } from './bili.ts'
import { dateTime, stampTime, type Translate } from './format.ts'
import { Gate } from './Gate.tsx'
import { Ledger } from './Ledger.tsx'
import css from './BiliAccount.module.css'

/** How long the line that says what an action did stays up. */
const RESULT_MS = 6000

/** The section's injected face (slot `inject`). */
export interface BiliAccountInjected {
  hooks: {
    /** The shared account store. */
    bili: ObservableSnapshot<BiliState>
  }
  /** One refresh; a request in flight is shared. */
  refresh: () => void
  /** One owner action. */
  act: (action: BiliAction) => void
  /** One background action (a QR sign-in's poll): no busy state, no error banner. */
  poll: (action: BiliAction) => void
}

/** Props delivered by the settings shell. */
export type BiliAccountProps = PropsRuntime<'settings.section'> & InjectFace<BiliAccountInjected> & PropsLocale<'bili'>

function Card({ title, meta, children }: { title: string; meta?: string; children: ReactNode }): ReactNode {
  const id = useId()
  return (
    <section className={css.card} aria-labelledby={id}>
      <div className={css.cardHeader}>
        <span id={id} className={css.cardTitle}>{title}</span>
        {meta === undefined ? null : <span className={css.meta}>{meta}</span>}
      </div>
      {children}
    </section>
  )
}

/** A UID as the owner may type it: digits only, at most 16 of them. */
const UID_PATTERN = /^\d{1,16}$/

function OwnerCard({ view, act, busy, t }: { view: BiliView; act: (action: BiliAction) => void; busy: boolean; t: Translate }): ReactNode {
  const stored = view.ownerMid === 0 ? '' : String(view.ownerMid)
  const [draft, setDraft] = useState(stored)
  const [base, setBase] = useState(stored)
  // A save (or another tab's) moves the stored UID; an untouched draft follows it.
  if (stored !== base) {
    setBase(stored)
    if (draft === base) setDraft(stored)
  }
  const value = draft.trim()
  const valid = UID_PATTERN.test(value) && Number(value) > 0
  const id = useId()
  const saved = view.ownerUpdatedAt === null ? {} : { meta: t('owner.saved', { time: dateTime(view.ownerUpdatedAt, view.timeZone) }) }
  return (
    <Card title={t('owner.title')} {...saved}>
      <label className={css.hint} htmlFor={id}>{t('owner.hint')}</label>
      <input
        id={id}
        className={css.input}
        value={draft}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        maxLength={16}
        placeholder={t('owner.placeholder')}
        aria-invalid={value !== '' && !valid ? true : undefined}
        onChange={(event) => { setDraft(event.target.value) }}
      />
      <div className={css.actions}>
        {stored === '' ? <span className={css.meta} data-owner-unset="">{t('owner.unset')}</span> : null}
        <button type="button" className={css.primary} disabled={busy || !valid || value === stored} onClick={() => { act({ action: 'owner', mid: Number(value) }) }}>
          {t('owner.save')}
        </button>
      </div>
    </Card>
  )
}

/** The line that says what an action did, or null. */
function resultText(result: ActionResult, t: Translate): string | null {
  const account = result.account ?? ''
  switch (result.action) {
    case 'gate.mode':
      return t('result.mode', { mode: result.outcome === 'auto' ? t('gate.mode.auto') : result.outcome === 'readonly' ? t('gate.mode.readonly') : result.outcome })
    case 'brake.release':
      return result.outcome === 'released' ? t('result.released') : t('result.noBrake')
    case 'session.refresh':
      return result.outcome === 'refreshed' ? t('result.refreshed', { account }) : t('result.unchanged', { account })
    case 'session.check':
      if (result.outcome === 'invalid') return t('result.checkInvalid', { account })
      return result.days === null ? t('result.checkValid', { account }) : t('result.checkExpires', { account, days: result.days })
    case 'logout':
      return t('result.loggedOut', { account })
    case 'login.poll':
      return result.outcome === 'done' ? t('result.loginDone', { account }) : null
    default:
      return null
  }
}

/** Words for a failed action: a known code gets its own line. */
function errorText(error: string, code: string | null, t: Translate): string {
  switch (code) {
    case 'mode_refused': return t('error.mode_refused')
    case 'not_owner': return t('error.not_owner')
    case 'no_token': return t('error.no_token')
    case 'refresh_failed': return t('error.refresh_failed', { error })
    case 'no_session':
    case 'session_unavailable': return t('error.no_session')
    default: return t('error.action', { error })
  }
}

/**
 * Render the Bilibili account section.
 * @param props - the store hook, refresh and action callbacks, and copy.
 * @returns the section.
 */
export function BiliAccountSection({ useBili, refresh, act, poll, t }: BiliAccountProps): ReactNode {
  const state = useBili(value => value)
  const translate = t as Translate
  const view = state.view
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])
  // A QR code waiting for a scan is asked every two seconds, until it settles.
  const waiting = view?.logins.find(login => login.state === 'waiting' || login.state === 'scanned')?.account ?? null
  useEffect(() => {
    if (waiting === null) return undefined
    return startPolling(() => { poll({ action: 'login.poll', account: waiting }) }, LOGIN_POLL_MS)
  }, [waiting, poll])
  const now = Date.now()
  // A refused switch to automatic is shown inside the gate card, where the owner is looking.
  const refusedMode = state.errorCode === 'mode_refused'

  let status: { tone: 'live' | 'stale' | 'idle'; text: string }
  if (view === null) status = state.stale ? { tone: 'stale', text: translate('status.failed') } : { tone: 'idle', text: translate('status.loading') }
  else if (state.stale) status = { tone: 'stale', text: translate('status.stale', { time: stampTime(state.checkedAt ?? now) }) }
  else status = { tone: 'live', text: translate('status.live', { time: stampTime(state.checkedAt ?? now) }) }
  const done = state.result !== null && now - state.result.at < RESULT_MS ? resultText(state.result.value, translate) : null

  return (
    <section className={css.section} aria-label={translate('title')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={status.tone} aria-hidden="true" />
          {status.text}
        </span>
      </div>
      {state.error === null || refusedMode ? null : <div className={css.error} role="alert">{errorText(state.error, state.errorCode, translate)}</div>}
      {done === null ? null : <div className={css.done} role="status">{done}</div>}
      {view === null
        ? null
        : (
          <>
            <ManageNotice view={view} t={translate} />
            <Gate view={view} now={now} t={translate} busy={state.busy} act={act} refusal={refusedMode ? { message: state.error ?? '' } : null} />
            <div className={css.grid}>
              <Accounts view={view} now={now} t={translate} busy={state.busy} act={act} />
              <OwnerCard view={view} act={act} busy={state.busy !== null} t={translate} />
            </div>
            <Ledger view={view} now={now} t={translate} busy={state.busy} act={act} limit={state.ledgerLimit} />
          </>
        )}
    </section>
  )
}

/** Why the controls are missing: no manage token, or bili-svc refused it. */
function ManageNotice({ view, t }: { view: BiliView; t: Translate }): ReactNode {
  if (view.manage) return null
  return (
    <section className={css.banner} role="status" data-scope="manage">
      <div className={css.bannerText}>
        <span className={css.bannerTitle}>{t('manage.off.title')}</span>
        <span className={css.bannerHint}>{t('manage.off.hint', { env: view.manageEnv })}</span>
        {view.manageError === null ? null : <span className={css.bannerHint}>{t('manage.error', { error: view.manageError })}</span>}
      </div>
    </section>
  )
}
