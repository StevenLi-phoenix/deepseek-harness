/**
 * The quiet-hours (勿扰) Settings section: whether the owner counts as asleep and why, the buttons that
 * override it, the daily fallback window, the urgent event kinds, and the iPhone Shortcut that feeds the
 * phone's Sleep Focus to the Host, with the latest signal shown so the owner can see the automation
 * works. It polls while mounted and pauses while the page is hidden. Nothing it shows is a token: the
 * instructions name the environment variable that holds it.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CLOCK_PATTERN, type PresenceAction, type PresenceView } from '../../presence-view.ts'
import { agoText, dateTime, stampTime, type Translate } from './format.ts'
import { POLL_INTERVAL_MS, startPolling, type PresenceState } from './presence.ts'
import css from './PresenceSection.module.css'

/** The section's injected face (slot `inject`). */
export interface PresenceInjected {
  hooks: {
    /** The shared quiet-hours store. */
    presence: ObservableSnapshot<PresenceState>
  }
  /** One status refresh; a request in flight is shared. */
  refresh: () => void
  /** One button. */
  act: (action: PresenceAction) => void
}

/** Props delivered by the settings shell. */
export type PresenceProps = PropsRuntime<'settings.section'> & InjectFace<PresenceInjected> & PropsLocale<'fork.presence'>

type Act = (action: PresenceAction) => void

function Card({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }): ReactNode {
  const id = useId()
  return (
    <section className={wide === true ? `${css.card} ${css.wide}` : css.card} aria-labelledby={id}>
      <div className={css.cardHeader}><span id={id} className={css.cardTitle}>{title}</span></div>
      {children}
    </section>
  )
}

function StateCard({ view, now, busy, act, t }: { view: PresenceView; now: number; busy: boolean; act: Act; t: Translate }): ReactNode {
  const times = [
    view.since === null ? undefined : t('state.since', { time: dateTime(view.since, view.timeZone) }),
    view.asleep && view.until !== null ? t('state.until', { time: dateTime(view.until, view.timeZone) }) : undefined,
  ].filter(Boolean).join(' · ')
  const stateName = (asleep: boolean): string => t(asleep ? 'state.asleep' : 'state.awake')
  return (
    <section className={`${css.card} ${css.wide} ${css.hero}`} aria-label={t('state.title')} data-asleep={view.asleep ? '' : undefined}>
      <div className={css.who}>
        <div className={css.nameRow}>
          <span className={css.name}>{stateName(view.asleep)}</span>
          <span className={css.pill} data-tone={view.asleep ? 'asleep' : 'awake'}>{t(`source.${view.source}`)}</span>
        </div>
        {times === '' ? null : <span className={css.meta}>{times}</span>}
        <span className={css.hint}>{view.asleep ? t('state.asleep.hint') : t('state.awake.hint')}</span>
        <span className={view.deferred > 0 ? css.big : css.meta}>{view.deferred > 0 ? t('held.count', { n: view.deferred }) : t('held.none')}</span>
        <span className={css.meta}>
          {view.lastFocus === null
            ? t('focus.none')
            : t('focus.last', { ago: agoText(view.lastFocus.at, now, t), state: t(view.lastFocus.asleep ? 'focus.on' : 'focus.off') })}
        </span>
        {view.manual === null
          ? null
          : (
            <div className={css.actions}>
              <span className={css.warn}>{t('manual.active', { state: stateName(view.manual.asleep), until: t('state.until', { time: dateTime(view.manual.until, view.timeZone) }) })}</span>
              <button type="button" className={css.secondary} disabled={busy} onClick={() => { act({ action: 'manual.clear' }) }}>{t('manual.clear')}</button>
            </div>
          )}
      </div>
    </section>
  )
}

function ButtonsCard({ view, state, act, t }: { view: PresenceView; state: PresenceState; act: Act; t: Translate }): ReactNode {
  const [until, setUntil] = useState('08:00')
  const id = useId()
  const busy = state.busy !== null
  const valid = CLOCK_PATTERN.test(until)
  return (
    <Card title={t('buttons.title')}>
      <div className={css.actions}>
        <button type="button" className={css.primary} disabled={busy} onClick={() => { act({ action: 'sleep.now' }) }}>{t('btn.sleep')}</button>
        <button type="button" className={css.primary} disabled={busy} onClick={() => { act({ action: 'wake.now' }) }}>{t('btn.wake')}</button>
      </div>
      <div className={css.actions}>
        <label className={css.hint} htmlFor={id}>{t('btn.quiet.label')}</label>
        <input id={id} className={css.input} type="time" value={until} onChange={(event) => { setUntil(event.target.value) }} aria-invalid={valid ? undefined : true} />
        <button type="button" className={css.secondary} disabled={busy || !valid} onClick={() => { act({ action: 'quiet.until', until }) }}>{t('btn.quiet.go')}</button>
      </div>
      <span className={css.hint}>{t('manual.hint')}</span>
      <div className={css.actions}>
        <button type="button" className={css.secondary} disabled={busy} onClick={() => { act({ action: 'flush' }) }}>
          {state.busy === 'flush' ? t('btn.flushing') : `${t('btn.flush')}${view.deferred > 0 ? ` (${view.deferred})` : ''}`}
        </button>
        {state.flushed === null ? null : <span className={css.meta} role="status">{t('btn.flushed', { n: state.flushed })}</span>}
      </div>
    </Card>
  )
}

function WindowCard({ view, busy, act, t }: { view: PresenceView; busy: boolean; act: Act; t: Translate }): ReactNode {
  const stored = view.window
  const [draft, setDraft] = useState(stored)
  const [base, setBase] = useState(stored)
  // A save (or another tab's) moves the stored window; an untouched draft follows it.
  if (stored.enabled !== base.enabled || stored.start !== base.start || stored.end !== base.end) {
    setBase(stored)
    if (draft.enabled === base.enabled && draft.start === base.start && draft.end === base.end) setDraft(stored)
  }
  const id = useId()
  const valid = CLOCK_PATTERN.test(draft.start) && CLOCK_PATTERN.test(draft.end)
  const same = draft.enabled && draft.start === draft.end
  const changed = draft.enabled !== stored.enabled || draft.start !== stored.start || draft.end !== stored.end
  return (
    <Card title={t('window.title')}>
      <span className={css.hint}>{t('window.hint', { zone: view.timeZone })}</span>
      <label className={css.check}>
        <input type="checkbox" checked={draft.enabled} onChange={(event) => { setDraft({ ...draft, enabled: event.target.checked }) }} />
        {t('window.enabled')}
      </label>
      <div className={css.actions}>
        <label className={css.hint} htmlFor={`${id}-start`}>{t('window.start')}</label>
        <input id={`${id}-start`} className={css.input} type="time" value={draft.start} disabled={!draft.enabled} onChange={(event) => { setDraft({ ...draft, start: event.target.value }) }} />
        <label className={css.hint} htmlFor={`${id}-end`}>{t('window.end')}</label>
        <input id={`${id}-end`} className={css.input} type="time" value={draft.end} disabled={!draft.enabled} onChange={(event) => { setDraft({ ...draft, end: event.target.value }) }} />
      </div>
      {same ? <span className={css.reason}>{t('window.same')}</span> : null}
      <div className={css.actions}>
        <button type="button" className={css.primary} disabled={busy || !valid || same || !changed} onClick={() => { act({ action: 'window.set', ...draft }) }}>{t('window.save')}</button>
      </div>
    </Card>
  )
}

function UrgentCard({ view, t }: { view: PresenceView; t: Translate }): ReactNode {
  return (
    <Card title={t('urgent.title')}>
      <span className={css.hint}>{t('urgent.hint')}</span>
      <ul className={css.chips}>{view.urgentKinds.map(kind => <li key={kind}><code>{kind}</code></li>)}</ul>
      <span className={css.hint}>{t('urgent.edit')}</span>
    </Card>
  )
}

function ShortcutCard({ view, t }: { view: PresenceView; t: Translate }): ReactNode {
  const { shortcut } = view
  // A code sample, not UI copy: the header name, a colon, and the scheme.
  const authHeader = [shortcut.header, 'Bearer …'].join(': ')
  const steps = ['shortcut.step1', 'shortcut.step2', 'shortcut.step3', 'shortcut.step4', 'shortcut.step5', 'shortcut.step6', 'shortcut.step7'] as const
  return (
    <Card title={t('shortcut.title')} wide>
      <span className={css.hint}>{t('shortcut.intro')}</span>
      <dl className={css.facts}>
        <dt>{t('shortcut.url')}</dt>
        <dd><code className={css.code}>{shortcut.url ?? t('shortcut.url.unset', { path: shortcut.path })}</code></dd>
        <dt>{t('shortcut.headers')}</dt>
        <dd>
          <code className={css.code}>{authHeader}</code>
          <span className={css.hint}>{t('shortcut.header.auth', { env: shortcut.tokenEnv })}</span>
          <code className={css.code}>{t('shortcut.header.type')}</code>
        </dd>
        <dt>{t('shortcut.body.on')}</dt>
        <dd><pre className={css.pre}>{shortcut.bodyOn}</pre></dd>
        <dt>{t('shortcut.body.off')}</dt>
        <dd><pre className={css.pre}>{shortcut.bodyOff}</pre><span className={css.hint}>{t('shortcut.body.note')}</span></dd>
      </dl>
      <span className={css.cardTitle}>{t('shortcut.steps.title')}</span>
      <ol className={css.steps}>{steps.map(step => <li key={step}>{t(step)}</li>)}</ol>
    </Card>
  )
}

/**
 * Render the quiet-hours section.
 * @param props - the store hook, the callbacks, and copy.
 * @returns the section.
 */
export function PresenceSection({ usePresence, refresh, act, t }: PresenceProps): ReactNode {
  const state = usePresence(value => value)
  const translate = t as Translate
  const view = state.view
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])
  const now = Date.now()

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
          <div className={css.grid}>
            <StateCard view={view} now={now} busy={state.busy !== null} act={act} t={translate} />
            <ButtonsCard view={view} state={state} act={act} t={translate} />
            <WindowCard view={view} busy={state.busy !== null} act={act} t={translate} />
            <UrgentCard view={view} t={translate} />
            <ShortcutCard view={view} t={translate} />
          </div>
        )}
    </section>
  )
}
