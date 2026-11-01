/**
 * The Subscriptions and monitors settings section: the event bus subscriptions (configuration ones read-only, run-time ones
 * pausable and deletable, and a form for a simple new one) and the Host schedule reminders. Every click shows its effect at once:
 * pause and resume flip the row, delete removes it, and a refusal puts it back with the reason. Deleting asks for a second click
 * on the row. Monitors started with monitor_start belong to their own conversations and are explained, not listed.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: registers the fork.console locale namespace this component's `t` reads.
import type {} from './locales.ts'
import type { ScheduleRow, SubscriptionAction, SubscriptionRow, SubscriptionsView } from '../views.ts'
import { ago, clock, stamp, until, type Translate } from './format.ts'
import type { ConsoleKey } from './locales.ts'
import { POLL_INTERVAL_MS, startPolling, type ResourceState } from './resource.ts'
import { blankDraft, requestKey, toRequest, validateDraft, type DraftError, type SubscriptionDraft } from './subs.ts'
import css from './Console.module.css'

/** The section's injected face (slot `inject`). */
export interface SubscriptionsInjected {
  hooks: {
    /** The shared subscriptions store. */
    subscriptions: ObservableSnapshot<ResourceState<SubscriptionsView>>
  }
  /** One refresh; a request in flight is shared. */
  refresh: () => void
  /** One change; resolves true when the Host accepted it. */
  act: (request: SubscriptionAction) => Promise<boolean>
  /** Clear the notice. */
  dismiss: () => void
}

/** Props delivered by the settings shell. */
export type SubscriptionsProps = PropsRuntime<'settings.section'> & InjectFace<SubscriptionsInjected> & PropsLocale<'fork.console'>

const csv = (list: readonly string[], t: Translate): string => (list.length === 0 ? t('common.all') : list.join(', '))

function createdBy(row: SubscriptionRow, t: Translate): string | null {
  if (row.createdBy === null) return null
  return row.createdBy === 'settings' ? t('subs.createdBy.settings') : t('subs.createdBy.session', { id: row.createdBy.slice(0, 12) })
}

/** Delete with a second click on the row, so a stray click removes nothing. */
function DeleteButton({ label, confirmText, onConfirm, t, disabled }: {
  label: string
  confirmText: string
  onConfirm: () => void
  t: Translate
  disabled: boolean
}): ReactNode {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return <button type="button" className={css.button} data-kind="danger" disabled={disabled} onClick={() => { setAsking(true) }}>{label}</button>
  }
  return (
    <span className={css.confirm} role="alertdialog" aria-label={confirmText}>
      <span>{confirmText}</span>
      <button type="button" className={css.button} data-kind="danger" onClick={() => { setAsking(false); onConfirm() }}>{t('common.confirmDelete')}</button>
      <button type="button" className={css.button} onClick={() => { setAsking(false) }}>{t('common.cancel')}</button>
    </span>
  )
}

function SubscriptionRowView({ row, busy, now, t, act }: {
  row: SubscriptionRow
  busy: boolean
  now: number
  t: Translate
  act: SubscriptionsInjected['act']
}): ReactNode {
  const by = createdBy(row, t)
  const meta = [
    by,
    t('subs.fired', { count: row.fireCount }),
    row.lastFiredAt === null ? t('common.never') : t('subs.lastFired', { when: ago(row.lastFiredAt, now, t) }),
    row.pending > 0 ? t('subs.pending', { count: row.pending }) : null,
  ].filter(entry => entry !== null)
  const change = (action: 'pause' | 'resume' | 'delete'): void => { void act({ action, target: 'subscription', id: row.id }) }
  return (
    <div className={css.row} data-subscription={row.id} data-busy={busy ? '' : undefined}>
      <div className={css.rowMain}>
        <span className={css.rowTitle}>
          {row.id}
          <span className={css.badge}>{t(`subs.mode.${row.mode}`)}</span>
          {row.origin === 'config' ? <span className={css.badge}>{t('subs.fromConfig')}</span> : null}
          {row.paused ? <span className={css.badge} data-kind="paused">{t('subs.paused')}</span> : null}
          {row.lastStatus === 'failed' ? <span className={css.badge} data-kind="failed">{t('subs.lastFailed')}</span> : null}
        </span>
        <span className={css.meta}>
          {[t('subs.sources', { list: csv(row.sources, t) }), t('subs.kinds', { list: csv(row.kinds, t) }), t('subs.subjects', { list: csv(row.subjects, t) })].join(' · ')}
        </span>
        <span className={css.meta}>{meta.join(' · ')}</span>
      </div>
      {row.origin === 'config'
        ? null
        : (
          <div className={css.rowActions}>
            <button type="button" className={css.button} disabled={busy} onClick={() => { change(row.paused ? 'resume' : 'pause') }}>
              {row.paused ? t('common.resume') : t('common.pause')}
            </button>
            <DeleteButton label={t('common.delete')} confirmText={t('subs.deleteConfirm', { id: row.id })} t={t} disabled={busy} onConfirm={() => { change('delete') }} />
          </div>
        )}
    </div>
  )
}

function ScheduleRowView({ row, busy, now, t, act }: {
  row: ScheduleRow
  busy: boolean
  now: number
  t: Translate
  act: SubscriptionsInjected['act']
}): ReactNode {
  const change = (action: 'pause' | 'resume' | 'delete'): void => { void act({ action, target: 'schedule', id: row.id }) }
  const rule = [t(`subs.schedules.rule.${row.rule}` as ConsoleKey), row.detail].filter(entry => entry !== '').join(' ')
  const when = row.status === 'ended' ? null : row.nextAt === null ? null : t('subs.schedules.next', { when: `${until(row.nextAt, now, t)} (${stamp(row.nextAt)})` })
  const meta = [when, row.lastFiredAt === null ? t('common.never') : t('subs.lastFired', { when: ago(row.lastFiredAt, now, t) })].filter(entry => entry !== null)
  return (
    <div className={css.row} data-schedule={row.id} data-busy={busy ? '' : undefined}>
      <div className={css.rowMain}>
        <span className={css.rowTitle}>
          {row.title}
          <span className={css.badge} data-kind={row.status === 'paused' ? 'paused' : undefined}>{t(`subs.schedules.status.${row.status}`)}</span>
        </span>
        <span className={css.meta}>{rule}</span>
        <span className={css.meta}>{meta.join(' · ')}</span>
      </div>
      <div className={css.rowActions}>
        {row.status === 'ended'
          ? null
          : (
            <button type="button" className={css.button} disabled={busy} onClick={() => { change(row.status === 'paused' ? 'resume' : 'pause') }}>
              {row.status === 'paused' ? t('common.resume') : t('common.pause')}
            </button>
          )}
        <DeleteButton label={t('common.delete')} confirmText={t('subs.schedules.deleteConfirm', { id: row.title })} t={t} disabled={busy} onConfirm={() => { change('delete') }} />
      </div>
    </div>
  )
}

function Field({ label, error, children }: {
  label: string
  error?: string | undefined
  children: (props: { id: string; invalid: boolean }) => ReactNode
}): ReactNode {
  const id = useId()
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={id}>{label}</label>
      {children({ id, invalid: error !== undefined })}
      {error === undefined ? null : <span className={css.fieldError} role="alert">{error}</span>}
    </div>
  )
}

function CreateForm({ defaults, busy, t, onCreate, onClose }: {
  defaults: SubscriptionsView['defaults']
  busy: boolean
  t: Translate
  onCreate: (request: SubscriptionAction) => Promise<boolean>
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<SubscriptionDraft>(blankDraft)
  const [errors, setErrors] = useState<readonly DraftError[]>([])
  const set = <K extends keyof SubscriptionDraft>(key: K, value: SubscriptionDraft[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
  }
  const message = (kind: DraftError): string | undefined => (errors.includes(kind) ? t(`subs.form.err.${kind}`) : undefined)
  const submit = (): void => {
    const found = validateDraft(draft)
    setErrors(found)
    if (found.length > 0) return
    void onCreate(toRequest(draft)).then((accepted) => { if (accepted) onClose() })
  }
  return (
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); submit() }} noValidate>
      <Field label={t('subs.form.id')} error={message('id')}>
        {({ id, invalid }) => <input id={id} className={css.input} aria-invalid={invalid} value={draft.id} onChange={(event) => { set('id', event.target.value) }} autoComplete="off" />}
      </Field>
      <Field label={t('subs.form.sources')} error={message('selector')}>
        {({ id }) => <input id={id} className={css.input} value={draft.sources} onChange={(event) => { set('sources', event.target.value) }} autoComplete="off" />}
      </Field>
      <div className={css.fieldRow}>
        <Field label={t('subs.form.kinds')}>
          {({ id }) => <input id={id} className={css.input} value={draft.kinds} onChange={(event) => { set('kinds', event.target.value) }} autoComplete="off" />}
        </Field>
        <Field label={t('subs.form.subjects')}>
          {({ id }) => <input id={id} className={css.input} value={draft.subjects} onChange={(event) => { set('subjects', event.target.value) }} autoComplete="off" />}
        </Field>
      </div>
      <Field label={t('subs.form.mode')}>
        {({ id }) => (
          <select id={id} className={css.select} value={draft.mode} onChange={(event) => { set('mode', event.target.value === 'session' ? 'session' : 'notify') }}>
            <option value="notify">{t('subs.mode.notify')}</option>
            <option value="session">{t('subs.mode.session')}</option>
          </select>
        )}
      </Field>
      {draft.mode === 'session'
        ? (
          <Field label={t('subs.form.instructions')} error={message('instructions')}>
            {({ id, invalid }) => (
              <>
                <textarea id={id} className={css.textarea} aria-invalid={invalid} value={draft.instructions} onChange={(event) => { set('instructions', event.target.value) }} />
                <span className={css.hint}>{t('subs.form.sessionNote', { preset: defaults.agentPreset, workspace: defaults.workspacePath })}</span>
              </>
            )}
          </Field>
        )
        : null}
      <div className={css.fieldRow}>
        <Field label={t('subs.form.coalesce')} error={message('number')}>
          {({ id }) => <input id={id} className={css.input} inputMode="numeric" placeholder={String(defaults.coalesceSeconds)} value={draft.coalesceSeconds} onChange={(event) => { set('coalesceSeconds', event.target.value) }} />}
        </Field>
        <Field label={t('subs.form.maxPerHour')}>
          {({ id }) => (
            <input
              id={id} className={css.input} inputMode="numeric" value={draft.maxPerHour}
              placeholder={String(draft.mode === 'session' ? defaults.sessionMaxPerHour : defaults.notifyMaxPerHour)}
              onChange={(event) => { set('maxPerHour', event.target.value) }}
            />
          )}
        </Field>
      </div>
      <div className={css.formActions}>
        <button type="button" className={css.button} onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className={css.button} data-kind="primary" disabled={busy}>{t('subs.form.create')}</button>
      </div>
    </form>
  )
}

/**
 * Render the Subscriptions and monitors section.
 * @param props - the store hook, callbacks, and copy.
 * @returns the section.
 */
export function SubscriptionsSection({ useSubscriptions, refresh, act, dismiss, t }: SubscriptionsProps): ReactNode {
  const state = useSubscriptions(value => value)
  const [creating, setCreating] = useState(false)
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])

  const translate = t as Translate
  const view = state.data
  const now = state.checkedAt ?? 0
  const tone = state.checkedAt === null ? 'loading' : state.stale ? 'stale' : 'live'
  const text = state.checkedAt === null
    ? translate('status.loading')
    : view === null
      ? translate('status.failed')
      : state.stale ? translate('status.stale', { time: clock(view.checkedAt) }) : translate('status.live', { time: clock(view.checkedAt) })
  const busyKey = (request: SubscriptionAction): boolean => state.busy[requestKey(request)] === true
  const busyFor = (target: 'subscription' | 'schedule', id: string): boolean =>
    (['pause', 'resume', 'delete'] as const).some(action => busyKey({ action, target, id }))
  const failure = state.notice
  return (
    <section className={css.section} aria-label={translate('title.subscriptions')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={tone} aria-hidden="true" />
          {text}
        </span>
      </div>
      {failure === null
        ? null
        : (
          <div className={css.notice} role="alert">
            <span>{translate(`error.${failure.code}`)}{failure.detail === undefined ? '' : ` (${failure.detail})`}</span>
            <button type="button" className={css.button} onClick={dismiss}>{translate('common.dismiss')}</button>
          </div>
        )}

      <div className={css.heading}>
        <span className={css.headingTitle}>{translate('subs.events.title')}</span>
        {view?.subscriptions == null || creating
          ? null
          : <button type="button" className={css.button} data-kind="primary" onClick={() => { setCreating(true) }}>{translate('subs.new')}</button>}
      </div>
      <span className={css.hint}>{translate('subs.events.hint')}</span>
      {creating && view !== null
        ? (
          <CreateForm
            defaults={view.defaults} t={translate}
            busy={Object.keys(state.busy).some(key => key.startsWith('create:'))}
            onCreate={act} onClose={() => { setCreating(false) }}
          />
        )
        : null}
      {view === null
        ? null
        : view.subscriptions === null
          ? <div className={css.rows}><div className={css.empty}>{translate('subs.events.unavailable')}</div></div>
          : (
            <div className={css.rows}>
              {view.subscriptions.length === 0 ? <div className={css.empty}>{translate('subs.events.empty')}</div> : null}
              {view.subscriptions.map(row => (
                <SubscriptionRowView key={row.id} row={row} busy={busyFor('subscription', row.id)} now={now} t={translate} act={act} />
              ))}
            </div>
          )}

      <div className={css.heading}>
        <span className={css.headingTitle}>{translate('subs.schedules.title')}</span>
      </div>
      <span className={css.hint}>{translate('subs.schedules.hint')}</span>
      {view === null
        ? null
        : view.schedules === null
          ? <div className={css.rows}><div className={css.empty}>{translate('subs.schedules.unavailable')}</div></div>
          : (
            <div className={css.rows}>
              {view.schedules.length === 0 ? <div className={css.empty}>{translate('subs.schedules.empty')}</div> : null}
              {view.schedules.map(row => (
                <ScheduleRowView key={row.id} row={row} busy={busyFor('schedule', row.id)} now={now} t={translate} act={act} />
              ))}
            </div>
          )}

      <div className={css.heading}>
        <span className={css.headingTitle}>{translate('subs.monitors.title')}</span>
      </div>
      <span className={css.hint}>{translate('subs.monitors.note')}</span>
    </section>
  )
}
