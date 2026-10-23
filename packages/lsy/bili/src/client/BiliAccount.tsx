/**
 * The Bilibili account Settings section: an account card with the login
 * state and the QR sign-in, a pause banner with the owner's Resume, today's
 * budget per action, the body clock, the owner's interests text, and the
 * recent writes. It polls while mounted (faster while a QR code waits) and
 * pauses while the page is hidden. Nothing it shows can be a cookie or token:
 * the Host builds the view from its storage, not from the credential record.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { MAX_INTERESTS_CHARS, type BiliAction, type BiliView, type WriteAction } from '../view.ts'
import { LOGIN_POLL_MS, POLL_INTERVAL_MS, startPolling, type BiliState } from './bili.ts'
import { agoText, clockTime, countdown, dateTime, qrPath, stampTime, usageLevel, type Translate } from './format.ts'
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

/** The current time, re-read every second while something counts down. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return undefined
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [ticking])
  return ticking ? now : Date.now()
}

function Card({ title, meta, wide, tone, children }: { title: string; meta?: string; wide?: boolean; tone?: 'warn'; children: ReactNode }): ReactNode {
  const id = useId()
  const classes = [css.card, wide === true ? css.wide : '', tone === 'warn' ? css.warnCard : ''].filter(Boolean).join(' ')
  return (
    <section className={classes} aria-labelledby={id}>
      <div className={css.cardHeader}>
        <span id={id} className={css.cardTitle}>{title}</span>
        {meta === undefined ? null : <span className={css.meta}>{meta}</span>}
      </div>
      {children}
    </section>
  )
}

function QrCode({ modules, label }: { modules: readonly string[]; label: string }): ReactNode {
  const size = modules.length
  return (
    <svg className={css.qr} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={qrPath(modules)} fill="#18191c" />
    </svg>
  )
}

/** What every card of the section receives. */
interface CardProps {
  view: BiliView
  now: number
  act: (action: BiliAction) => void
  busy: boolean
  t: Translate
}

function LoginPanel({ view, now, act, busy, t }: CardProps): ReactNode {
  const { login } = view
  if (login.state === 'waiting' || login.state === 'scanned') {
    return (
      <div className={css.login}>
        {login.qr === undefined ? null : <QrCode modules={login.qr.modules} label={t('login.qr')} />}
        <div className={css.loginText}>
          <ol className={css.steps}>
            <li>{t('login.step1')}</li>
            <li>{t('login.step2')}</li>
            <li>{t('login.step3')}</li>
          </ol>
          <span className={css.loginStatus} role="status" data-state={login.state}>
            {t(login.state === 'scanned' ? 'login.scanned' : 'login.waiting')}
          </span>
          {login.qr === undefined ? null : <span className={css.meta}>{t('login.expires', { time: countdown(login.qr.expiresAt, now) })}</span>}
        </div>
      </div>
    )
  }
  const message = login.state === 'expired' ? t('login.expired') : login.state === 'failed' ? t('login.failed', { error: login.error ?? '' }) : undefined
  const label = view.account.state === 'signed-out' ? 'login.start' : view.account.state === 'login-needed' ? 'login.renew' : 'login.again'
  const primary = view.account.state !== 'active' || login.state === 'expired'
  return (
    <div className={css.actions}>
      {message === undefined ? null : <span className={css.loginStatus} data-state={login.state}>{message}</span>}
      <button type="button" className={primary ? css.primary : css.secondary} disabled={busy} onClick={() => { act({ action: 'login' }) }}>
        {t(login.state === 'expired' ? 'login.newCode' : label)}
      </button>
    </div>
  )
}

function AccountCard({ view, now, act, busy, t }: CardProps): ReactNode {
  const { account } = view
  const zone = view.clock.timeZone
  const initial = Array.from(account.uname ?? 'B')[0] ?? 'B'
  return (
    <section className={`${css.card} ${css.wide} ${css.hero}`} aria-label={t('account.title')} data-account={account.state}>
      <div className={css.identity}>
        <span className={css.avatar} aria-hidden="true">{initial}</span>
        <div className={css.who}>
          <div className={css.nameRow}>
            <span className={css.name}>{account.uname ?? t('account.signedOut')}</span>
            {account.level === undefined ? null : <span className={css.level}>{t('account.level', { level: account.level })}</span>}
            <span className={css.pill} data-state={account.state}>{t(`account.state.${account.state}`)}</span>
          </div>
          {account.mid === undefined
            ? <span className={css.meta}>{t('account.signedOutHint')}</span>
            : (
              <span className={css.meta}>
                {[
                  t('account.uid', { mid: account.mid }),
                  account.loggedInAt === undefined ? undefined : t('account.since', { date: dateTime(account.loggedInAt, zone) }),
                  account.refreshedAt === undefined ? undefined : t('account.refreshed', { ago: agoText(account.refreshedAt, now, t) }),
                ].filter(Boolean).join(' · ')}
              </span>
            )}
          {account.state === 'login-needed' && account.reason !== undefined ? <span className={css.reason}>{t('account.reason', { reason: account.reason })}</span> : null}
        </div>
      </div>
      <LoginPanel view={view} now={now} act={act} busy={busy} t={t} />
    </section>
  )
}

function PauseBanner({ view, act, busy, t }: CardProps): ReactNode {
  const { pause, readsResumeAt } = view
  if (pause === null && readsResumeAt === null) return null
  const zone = view.clock.timeZone
  const reads = readsResumeAt === null ? '' : t('pause.reads', { time: clockTime(readsResumeAt, zone) })
  return (
    <section className={css.banner} role="alert" data-scope={pause?.scope ?? 'reads'}>
      <div className={css.bannerText}>
        <span className={css.bannerTitle}>{pause === null ? reads : t(pause.scope === 'all' ? 'pause.all' : 'pause.speech')}</span>
        {pause === null ? null : <span className={css.meta}>{t('pause.reason', { reason: pause.reason, date: dateTime(pause.since, zone) })}</span>}
        {pause === null ? null : <span className={css.bannerHint}>{t(pause.scope === 'all' ? 'pause.allHint' : 'pause.speechHint')}</span>}
        {pause !== null && reads !== '' ? <span className={css.meta}>{reads}</span> : null}
      </div>
      <button type="button" className={css.primary} disabled={busy} onClick={() => { act({ action: 'resume' }) }}>{t('pause.resume')}</button>
    </section>
  )
}

function UsageCard({ view, t }: { view: BiliView; t: Translate }): ReactNode {
  return (
    <Card title={t('usage.title')} meta={t('usage.day', { day: view.usage.day })}>
      <ul className={css.usage}>
        {view.usage.actions.map(({ action, used, cap }) => {
          const level = usageLevel(used, cap)
          return (
            <li key={action} className={css.usageRow} data-action={action}>
              <span className={css.usageLabel}>{t(`action.${action}` as const)}</span>
              <span className={css.track} role="meter" aria-label={t(`action.${action}` as const)} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used}>
                <span className={css.fill} data-level={level} style={{ width: `${cap === 0 ? 100 : Math.min(100, Math.round((used / cap) * 100))}%` }} />
              </span>
              <span className={css.usageCount}>{t('usage.count', { used, cap })}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function ClockCard({ view, now, t }: { view: BiliView; now: number; t: Translate }): ReactNode {
  const { clock } = view
  return (
    <Card title={t('clock.title')} meta={clock.timeZone}>
      <ul className={css.wakes}>
        {clock.today.map(wake => (
          <li key={wake.window} className={css.wake} data-state={wake.state}>
            <span className={css.wakeWindow}>{wake.window}</span>
            <span className={css.wakeAt}>{wake.at === null ? '—' : clockTime(wake.at, clock.timeZone)}</span>
            <span className={css.wakeState}>{t(`clock.state.${wake.state}`)}</span>
          </li>
        ))}
      </ul>
      <div className={css.details}>
        <span>{clock.nextWakeAt === null ? t('clock.none') : t('clock.next', { time: clockTime(clock.nextWakeAt, clock.timeZone) })}</span>
        {clock.lastWake === null ? null : <span>{t('clock.last', { ago: agoText(clock.lastWake.at, now, t), reason: t(`clock.reason.${clock.lastWake.reason}`) })}</span>}
      </div>
    </Card>
  )
}

function InterestsCard({ view, act, busy, t }: Omit<CardProps, 'now'>): ReactNode {
  const stored = view.interests.text
  const [draft, setDraft] = useState(stored)
  const [base, setBase] = useState(stored)
  // A save (or another tab's) moves the stored text; an untouched draft follows it.
  if (stored !== base) {
    setBase(stored)
    if (draft === base) setDraft(stored)
  }
  const length = Array.from(draft).length
  const changed = draft.trim() !== stored
  const id = useId()
  return (
    <Card title={t('interests.title')} wide {...view.interests.updatedAt === null ? {} : { meta: t('interests.saved', { time: dateTime(view.interests.updatedAt, view.clock.timeZone) }) }}>
      <label className={css.hint} htmlFor={id}>{t('interests.hint')}</label>
      <textarea
        id={id}
        className={css.textarea}
        value={draft}
        rows={3}
        maxLength={MAX_INTERESTS_CHARS}
        placeholder={t('interests.placeholder')}
        onChange={(event) => { setDraft(event.target.value) }}
      />
      <div className={css.actions}>
        <span className={css.meta}>{t('interests.count', { count: length, max: MAX_INTERESTS_CHARS })}</span>
        <button type="button" className={css.primary} disabled={busy || !changed} onClick={() => { act({ action: 'interests', text: draft }) }}>{t('interests.save')}</button>
      </div>
    </Card>
  )
}

function RecentCard({ view, now, t }: { view: BiliView; now: number; t: Translate }): ReactNode {
  return (
    <Card title={t('recent.title')} wide>
      {view.recent.length === 0
        ? <span className={css.meta}>{t('recent.empty')}</span>
        : (
          <ul className={css.recent}>
            {view.recent.map(row => (
              <li key={`${row.at}-${row.action}-${row.target}`} className={css.recentRow} data-state={row.state}>
                <span className={css.recentAction}>{t(`action.${row.action satisfies WriteAction}` as const)}</span>
                <span className={css.recentTarget}>{row.target}</span>
                <span className={css.chip} data-state={row.state}>{t(`recent.state.${row.state}`)}</span>
                {row.visibility === undefined ? null : <span className={css.chip} data-visibility={row.visibility}>{t(`recent.visibility.${row.visibility}`)}</span>}
                <span className={css.recentAt}>{agoText(row.at, now, t)}</span>
                {row.detail === undefined || row.state === 'accepted' ? null : <span className={css.recentDetail}>{row.detail}</span>}
              </li>
            ))}
          </ul>
        )}
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
  const loginLive = view?.login.state === 'waiting' || view?.login.state === 'scanned'
  useEffect(() => startPolling(refresh, loginLive ? LOGIN_POLL_MS : POLL_INTERVAL_MS), [refresh, loginLive])
  const now = useNow(loginLive)
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
            <PauseBanner view={view} now={now} act={act} busy={busy} t={translate} />
            <div className={css.grid}>
              <AccountCard view={view} now={now} act={act} busy={busy} t={translate} />
              <UsageCard view={view} t={translate} />
              <ClockCard view={view} now={now} t={translate} />
              <InterestsCard view={view} act={act} busy={busy} t={translate} />
              <RecentCard view={view} now={now} t={translate} />
            </div>
          </>
        )}
    </section>
  )
}
