/**
 * The 说话风格 section: one verdict card (how many exchanges tune the main agent, whether it is on, how samples get
 * in), the samples grouped by where they came from with a delete button each, pending samples with keep and delete
 * when review is required, a field for a line of the owner's own, the last collection run as counts, and the daily
 * trend of stock lines and answer length. It polls while mounted and the page is visible.
 */

import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: registers the fork.style locale namespace this component's `t` reads.
import type {} from './locales.ts'
import type { StyleKey } from './locales.ts'
import { POLL_INTERVAL_MS, pollWhileVisible, type StyleEdit, type StyleState } from './style.ts'
import type { RunReport, SampleView, StylePanel, TrendDay } from '../view.ts'
import css from './StyleSection.module.css'

/** The section's injected face (slot `inject`). */
export interface StyleSectionInjected {
  hooks: {
    /** The shared style store. */
    style: ObservableSnapshot<StyleState>
  }
  /** One panel read; a read in flight is shared. */
  refresh: () => void
  /** Apply an edit; resolves to whether the Host accepted it. */
  edit: (edit: StyleEdit) => Promise<boolean>
  /** Start a collection run. */
  collect: () => void
}

/** Props delivered by the settings shell. */
export type StyleSectionProps = PropsRuntime<'settings.section'> & InjectFace<StyleSectionInjected> & PropsLocale<'fork.style'>

type Translate = (key: StyleKey, params?: Record<string, string | number>) => string

const pad = (value: number): string => String(value).padStart(2, '0')
/** `MM-DD HH:mm` in the browser's zone. */
export function shortTime(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function SampleRow({ sample, translate, edit, pending }: { sample: SampleView; translate: Translate; edit: StyleSectionInjected['edit']; pending: boolean }): ReactNode {
  const text = sample.prompt === undefined ? sample.reply : `${sample.prompt} → ${sample.reply}`
  const tag = sample.source === 'owner-bili' || sample.source === 'owner-manual' ? translate(`source.${sample.source}`) : null
  return (
    <li className={css.row}>
      <p className={css.exchange}>
        {sample.prompt === undefined ? null : <><span className={css.prompt}>{sample.prompt}</span><span className={css.arrow} aria-hidden="true">→</span></>}
        <span className={css.reply}>{sample.reply}</span>
        {tag === null ? null : <span className={css.tag}>{tag}</span>}
      </p>
      <div className={css.rowActions}>
        {pending
          ? <button type="button" className={css.keep} aria-label={translate('sample.keep.label', { text })} onClick={() => { void edit({ op: 'keep', id: sample.id }) }}>{translate('pending.keep')}</button>
          : null}
        <button type="button" className={css.remove} aria-label={translate('sample.remove.label', { text })} onClick={() => { void edit({ op: 'remove', id: sample.id }) }}>
          {translate('sample.remove')}
        </button>
      </div>
    </li>
  )
}

function Group({ title, hint, samples, translate, edit, pending = false }: {
  title: string
  hint?: string
  samples: readonly SampleView[]
  translate: Translate
  edit: StyleSectionInjected['edit']
  pending?: boolean
}): ReactNode {
  const id = useId()
  if (samples.length === 0) return null
  return (
    <section className={css.card} aria-labelledby={id} data-pending={pending ? '' : undefined}>
      <span id={id} className={css.cardTitle}>{title}</span>
      {hint === undefined ? null : <p className={css.hint}>{hint}</p>}
      <ul className={css.list}>
        {samples.map(sample => <SampleRow key={sample.id} sample={sample} translate={translate} edit={edit} pending={pending} />)}
      </ul>
    </section>
  )
}

function AddForm({ max, translate, edit, saving }: { max: number; translate: Translate; edit: StyleSectionInjected['edit']; saving: boolean }): ReactNode {
  const id = useId()
  const [prompt, setPrompt] = useState('')
  const [reply, setReply] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (reply.trim() === '') return
    void edit({ op: 'add', reply, ...prompt.trim() === '' ? {} : { prompt } }).then((ok) => {
      if (!ok) return
      setPrompt('')
      setReply('')
    })
  }
  return (
    <form className={css.card} aria-labelledby={id} onSubmit={submit}>
      <span id={id} className={css.cardTitle}>{translate('add.title')}</span>
      <div className={css.fields}>
        <input className={css.input} value={prompt} maxLength={max} placeholder={translate('add.prompt')} aria-label={translate('add.prompt')} onChange={(event) => { setPrompt(event.target.value) }} />
        <input className={css.input} value={reply} maxLength={max} placeholder={translate('add.reply')} aria-label={translate('add.reply')} onChange={(event) => { setReply(event.target.value) }} />
        <button type="submit" className={css.primary} disabled={saving || reply.trim() === ''}>{translate('add.submit')}</button>
      </div>
      <p className={css.hint}>{translate('add.hint', { max })}</p>
    </form>
  )
}

function runRows(panel: StylePanel, translate: Translate): Array<{ key: string; label: string; value: string }> {
  const run: RunReport | null = panel.lastRun
  const rows = [
    { key: 'last', label: translate('run.last'), value: run === null ? translate('run.never') : translate('run.last.value', { time: shortTime(run.at), seen: run.seen, accepted: run.accepted, added: run.added }) },
    { key: 'next', label: translate('run.next'), value: panel.nextRunAt === null ? translate('run.next.off') : shortTime(panel.nextRunAt) },
  ]
  if (run === null) return rows
  const qq = run.qq.status === 'ok' ? translate('run.qq.ok', { groups: run.qq.groups, messages: run.qq.messages }) : translate(`run.qq.${run.qq.status}`)
  const bili = run.bili.status === 'ok'
    ? translate('run.bili.ok', { comments: run.bili.comments, threads: run.bili.threads })
    : run.bili.status === 'unavailable' ? translate('run.bili.unavailable', { error: run.bili.error ?? '' }) : translate(`run.bili.${run.bili.status}`)
  return [...rows, { key: 'qq', label: translate('run.qq'), value: qq }, { key: 'bili', label: translate('run.bili'), value: bili }]
}

function Trend({ days, translate }: { days: readonly TrendDay[]; translate: Translate }): ReactNode {
  const id = useId()
  return (
    <section className={css.card} aria-labelledby={id}>
      <span id={id} className={css.cardTitle}>{translate('trend.title')}</span>
      <p className={css.hint}>{translate('trend.hint')}</p>
      {days.length === 0
        ? <p className={css.empty}>{translate('trend.empty')}</p>
        : (
          <ul className={css.trend}>
            {days.map(day => (
              <li key={day.day} className={css.trendRow}>
                <span className={css.trendDay}>{day.day.slice(5)}</span>
                <span className={css.bar} aria-hidden="true">
                  <span className={css.barFill} style={{ width: `${String(day.answers === 0 ? 0 : Math.round((day.withTics / day.answers) * 100))}%` }} />
                </span>
                <span className={css.trendText}>
                  {translate('trend.tics', { withTics: day.withTics, answers: day.answers })}
                  {day.meanChars === null ? null : ` · ${translate('trend.chars', { chars: day.meanChars })}`}
                </span>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

/**
 * Render the style section.
 * @param props - the store hook, callbacks, and copy.
 * @returns the section.
 */
export function StyleSection({ useStyle, refresh, edit, collect, t }: StyleSectionProps): ReactNode {
  const state = useStyle(value => value)
  useEffect(() => pollWhileVisible(refresh, POLL_INTERVAL_MS), [refresh])
  const translate = t as Translate
  const { panel } = state
  const runId = useId()

  const status = panel === null
    ? (state.stale ? translate('status.failed') : translate('status.loading'))
    : translate(state.stale ? 'status.stale' : 'status.live', { time: shortTime(state.checkedAt ?? Date.now()) })
  if (panel === null) {
    return (
      <section className={css.section} aria-label={translate('title')}>
        <div className={css.header}><span className={css.status} role="status">{status}</span></div>
      </section>
    )
  }

  const active = panel.samples.filter(sample => sample.status === 'active')
  const pending = panel.samples.filter(sample => sample.status === 'pending')
  const owner = active.filter(sample => sample.source === 'owner-bili' || sample.source === 'owner-manual')
  const qq = active.filter(sample => sample.source === 'qq-group')
  const bili = active.filter(sample => sample.source === 'bili-viewer')
  const tone = !panel.enabled ? 'off' : active.length === 0 ? 'empty' : 'on'
  const filtered = Object.entries(panel.lastRun?.filtered ?? {}).filter(([, count]) => count > 0).toSorted((a, b) => b[1] - a[1])
  const busy = state.saving || panel.running

  return (
    <section className={css.section} aria-label={translate('title')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={state.stale ? 'stale' : 'live'} aria-hidden="true" />
          {status}
        </span>
      </div>
      <div className={css.hero} data-tone={tone}>
        <span className={css.mark} data-tone={tone} aria-hidden="true" />
        <div className={css.heroText}>
          <h3 className={css.verdict}>{tone === 'on' ? translate('head.on', { count: active.length }) : translate(`head.${tone}`)}</h3>
          <p className={css.next}>{translate(`head.${tone}.detail`)}</p>
          <div className={css.heroActions}>
            <span className={css.chip}>{translate(panel.review === 'required' ? 'head.review.required' : 'head.review.optional')}</span>
            <button type="button" className={css.secondary} disabled={busy || !panel.enabled} onClick={collect}>
              {translate(panel.running ? 'action.collecting' : 'action.collect')}
            </button>
          </div>
        </div>
      </div>
      {state.error === null ? null : <p className={css.notice} role="alert">{translate(`error.${state.error === 'not_found' || state.error === 'network' ? state.error : 'invalid_input'}`)}</p>}
      <Group title={translate('pending.title', { count: pending.length })} samples={pending} translate={translate} edit={edit} pending />
      <Group title={translate('group.owner', { count: owner.length })} hint={translate('group.owner.hint', { max: panel.limits.maxOwner })} samples={owner} translate={translate} edit={edit} />
      <Group title={translate('group.qq', { count: qq.length })} samples={qq} translate={translate} edit={edit} />
      <Group title={translate('group.bili', { count: bili.length })} samples={bili} translate={translate} edit={edit} />
      <AddForm max={panel.limits.maxChars} translate={translate} edit={edit} saving={state.saving} />
      <section className={css.card} aria-labelledby={runId}>
        <span id={runId} className={css.cardTitle}>{translate('run.title')}</span>
        <dl className={css.rows}>
          {runRows(panel, translate).map(row => (
            <div key={row.key} className={css.pair}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
          {filtered.length === 0
            ? null
            : (
              <div className={css.pair}>
                <dt>{translate('run.filtered')}</dt>
                <dd className={css.reasons}>
                  {filtered.map(([reason, count]) => <span key={reason} className={css.chip}>{`${translate(`reason.${reason}` as StyleKey)} ${String(count)}`}</span>)}
                </dd>
              </div>
            )}
        </dl>
      </section>
      <Trend days={panel.trend} translate={translate} />
    </section>
  )
}
