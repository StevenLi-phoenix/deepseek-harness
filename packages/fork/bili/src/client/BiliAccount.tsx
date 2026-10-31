/**
 * The Bilibili account Settings section: a read-only account card with the
 * session state bili-svc reports (bili-svc holds and renews the login; there is
 * no sign-in here), a banner while bili-svc holds every action, and the owner's
 * main account. It polls while mounted and pauses while the page is hidden.
 * Nothing it shows can be a cookie or token: bili-svc's status names accounts
 * and session states only.
 */

import { useId, useEffect, useState, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { BiliAction, BiliView } from '../view.ts'
import { POLL_INTERVAL_MS, startPolling, type BiliState } from './bili.ts'
import { agoText, dateTime, stampTime, type Translate } from './format.ts'
import css from './BiliAccount.module.css'

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

function AccountCard({ view, now, t }: { view: BiliView; now: number; t: Translate }): ReactNode {
  const { account } = view
  const initial = Array.from(account.uname ?? 'B')[0] ?? 'B'
  return (
    <section className={`${css.card} ${css.wide} ${css.hero}`} aria-label={t('account.title')} data-account={account.session}>
      <div className={css.identity}>
        <span className={css.avatar} aria-hidden="true">{initial}</span>
        <div className={css.who}>
          <div className={css.nameRow}>
            <span className={css.name}>{account.uname ?? t('account.unknown')}</span>
            <span className={css.pill} data-state={account.session}>{t(`account.state.${account.session}`)}</span>
          </div>
          <span className={css.meta}>
            {[
              account.mid === undefined ? undefined : t('account.uid', { mid: account.mid }),
              t('account.id', { id: account.account }),
              t('account.checked', { ago: agoText(account.checkedAt, now, t) }),
            ].filter(Boolean).join(' · ')}
          </span>
          {account.error === undefined ? null : <span className={css.reason}>{t('account.error', { error: account.error })}</span>}
          <span className={css.hint}>{t('account.hint')}</span>
        </div>
      </div>
    </section>
  )
}

/** Shown while bili-svc holds every action (its mode is not automatic, or its brake is set). */
function GateBanner({ view, t }: { view: BiliView; t: Translate }): ReactNode {
  if (view.gate?.readonly !== true) return null
  return (
    <section className={css.banner} role="status" data-scope="gate">
      <div className={css.bannerText}>
        <span className={css.bannerTitle}>{t('gate.held', { mode: view.gate.mode === '' ? '—' : view.gate.mode })}</span>
        <span className={css.bannerHint}>{t('gate.hint')}</span>
      </div>
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

/**
 * Render the Bilibili account section.
 * @param props - the store hook, refresh and action callbacks, and copy.
 * @returns the section.
 */
export function BiliAccountSection({ useBili, refresh, act, t }: BiliAccountProps): ReactNode {
  const state = useBili(value => value)
  const translate = t as Translate
  const view = state.view
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])
  const now = Date.now()
  const busy = state.busy !== null

  let status: { tone: 'live' | 'stale' | 'idle'; text: string }
  if (view === null) status = state.stale ? { tone: 'stale', text: translate('status.failed') } : { tone: 'idle', text: translate('status.loading') }
  else if (state.stale) status = { tone: 'stale', text: translate('status.stale', { time: stampTime(state.checkedAt ?? now) }) }
  else status = { tone: 'live', text: translate('status.live', { time: stampTime(state.checkedAt ?? now) }) }

  return (
    <section className={css.section} aria-label={translate('title')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={status.tone} aria-hidden="true" />
          {status.text}
        </span>
      </div>
      {state.error === null ? null : <div className={css.error} role="alert">{translate('error.action', { error: state.error })}</div>}
      {view === null
        ? null
        : (
          <>
            <GateBanner view={view} t={translate} />
            <div className={css.grid}>
              <AccountCard view={view} now={now} t={translate} />
              <OwnerCard view={view} act={act} busy={busy} t={translate} />
            </div>
          </>
        )}
    </section>
  )
}
