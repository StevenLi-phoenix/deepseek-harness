/**
 * Settings → 课程 DDL: whether reminders are on, the last and next check with a button to check now, the course
 * sync's health with the newest failure reason, the next deadlines with their next reminder, the reminder rules,
 * the latest messages, and, at the foot, the All settings card of `fork-courses` (switch, checkpoints, quiet hours).
 * It refreshes while open and pauses while the page is hidden.
 */

import { useEffect, useId, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: declares the 'settings.plugin-config' factory this section renders at its foot.
import type {} from '@deepseek-ai/dsh-fork-config/client'
// Type-only: registers the fork.courses locale namespace this component's `t` reads.
import type {} from './locales.ts'
import { POLL_INTERVAL_MS, clock, pollLine, ruleLines, syncLines, upcomingText, type CoursesState, type Translate } from './courses.ts'
import { startPolling } from './polling.ts'
import css from './CoursesSection.module.css'

/** The section's injected face (slot `inject`). */
export interface CoursesInjected {
  hooks: {
    /** The shared section store. */
    courses: ObservableSnapshot<CoursesState>
  }
  /** One refresh; a request in flight is shared. */
  refresh: () => void
  /** Check now: one poll on the Host, which sends what is due. */
  checkNow: () => void
}

/** The plugin entries whose every setting the page lists at its foot. */
const CONFIG_ENTRIES = ['fork-courses'] as const

/** Props delivered by the settings shell. */
export type CoursesProps = PropsRuntime<'settings.section'> & InjectFace<CoursesInjected> & PropsLocale<'fork.courses'>
  & Partial<PropsRenderFactories>

function Card({ title, children, tone }: { title: string; children: ReactNode; tone?: string | undefined }): ReactNode {
  const id = useId()
  return (
    <section className={css.card} aria-labelledby={id} data-tone={tone}>
      <span id={id} className={css.cardTitle}>{title}</span>
      {children}
    </section>
  )
}

/**
 * Render the course deadline section.
 * @param props - the store hook, refresh and check callbacks, and copy.
 * @returns the section.
 */
export function CoursesSection({ useCourses, refresh, checkNow, renderFactorySlot, t }: CoursesProps): ReactNode {
  const state = useCourses(value => value)
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])
  const translate = t as Translate
  const { view } = state
  if (view === null) {
    return (
      <section className={css.section} aria-label={translate('title')}>
        <span className={css.status} role="status">{state.stale ? translate('status.failed') : translate('status.loading')}</span>
        {renderFactorySlot?.('settings.plugin-config', { entries: CONFIG_ENTRIES })}
      </section>
    )
  }
  const zone = view.timeZone
  const sync = syncLines(view.sync, zone, translate)
  const busy = state.checking || view.polling
  return (
    <section className={css.section} aria-label={translate('title')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={view.enabled ? 'on' : 'off'} aria-hidden="true" />
          {view.enabled ? translate('state.on') : translate('state.off')}
          {view.quietNow ? <span className={css.badge}>{translate('state.quiet')}</span> : null}
        </span>
        <button type="button" className={css.secondary} disabled={busy} onClick={checkNow}>{busy ? translate('poll.running') : translate('action.poll')}</button>
      </div>
      {state.stale ? <p className={css.notice}>{translate('status.failed')}</p> : null}
      <div className={css.grid}>
        <Card title={translate('poll.title')} tone={view.lastPoll?.ok === false ? 'warn' : undefined}>
          <span>{pollLine(view.lastPoll, zone, translate)}</span>
          {view.nextPollAt === null ? null : <span className={css.meta}>{translate('poll.next', { time: clock(view.nextPollAt, zone) })}</span>}
          {view.outage.failures > 0 ? <span className={css.warnText}>{translate('outage', { count: view.outage.failures, time: view.outage.since === null ? '—' : clock(view.outage.since, zone) })}</span> : null}
        </Card>
        <Card title={translate('sync.title')} tone={sync.tone}>
          {sync.lines.map(line => <span key={line} className={sync.tone === 'warn' ? css.warnText : undefined}>{line}</span>)}
        </Card>
      </div>
      <Card title={translate('upcoming.title')}>
        {view.upcoming.length === 0
          ? <span className={css.meta}>{translate('upcoming.empty')}</span>
          : (
            <ul className={css.list}>
              {view.upcoming.map((row) => {
                const text = upcomingText(row, zone, translate)
                return (
                  <li key={row.id} className={css.row} data-phase={row.phase}>
                    <span className={css.rowTitle}>{row.course === '' ? row.title : `${row.course} · ${row.title}`}</span>
                    <span className={row.phase === 'late' ? css.warnText : undefined}>{text.when}</span>
                    <span className={css.meta}>{text.next}</span>
                  </li>
                )
              })}
            </ul>
          )}
      </Card>
      <Card title={translate('notes.title')}>
        {view.notes.length === 0
          ? <span className={css.meta}>{translate('notes.empty')}</span>
          : (
            <ul className={css.list}>
              {view.notes.map(note => (
                <li key={`${note.at}-${note.title}`} className={css.row}>
                  <details>
                    <summary className={css.rowTitle}>
                      <span className={css.meta}>{clock(note.at, zone)}</span>
                      {' '}
                      {note.title}
                    </summary>
                    <pre className={css.body}>{note.body}</pre>
                  </details>
                  {note.outcome === 'failed' ? <span className={css.warnText}>{translate('notes.failed', { error: note.error ?? '' })}</span> : null}
                </li>
              ))}
            </ul>
          )}
      </Card>
      <Card title={translate('rules.title')}>
        {ruleLines(view, translate).map(line => <span key={line}>{line}</span>)}
      </Card>
      {renderFactorySlot?.('settings.plugin-config', { entries: CONFIG_ENTRIES })}
    </section>
  )
}
