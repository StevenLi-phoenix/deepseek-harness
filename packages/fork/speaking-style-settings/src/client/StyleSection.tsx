/**
 * The 说话风格 section: one verdict card (how many style items shape DSH's talk, whether it is on, how tone samples get
 * in); DSH's persona card with edit, delete, and its revision history (each version against the one before, with roll
 * back); pending tone samples with keep and delete when review is required; three columns (traits, memes with the
 * groups' jargon first and HotWatch's titles after, tone samples) with a delete button per item; the last collection run
 * as counts; the meme miner's last run (what it read, kept, and refused, by rule); the daily trend of stock lines and
 * answer length; and, at the foot, the All settings card of the plugin's configuration. It polls while mounted and the
 * page is visible. Every edit shows on the page at once and is replaced by the Host's answer.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: declares the 'settings.plugin-config' factory this section renders at its foot.
import type {} from '@deepseek-ai/dsh-plugin-config/client'
// Type-only: registers the speaking-style locale namespace this component's `t` reads.
import type {} from './locales.ts'
import { zh, type StyleKey } from './locales.ts'
import { POLL_INTERVAL_MS, pollWhileVisible, type StyleEdit, type StyleState } from './style.ts'
import type { CardView, MineReport, NoteView, RunReport, SampleView, StylePanel, TrendDay } from '../view.ts'
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
export type StyleSectionProps = PropsRuntime<'settings.section'> & InjectFace<StyleSectionInjected> & PropsLocale<'speaking-style'>
  & Partial<PropsRenderFactories>

/** The plugin entry the All settings card edits, and the fields the card leaves out because they belong to the preset rows. */
const CONFIG_ENTRIES = ['speaking-style'] as const
const CONFIG_EXCLUDE = ['mode', 'block', 'tools', 'dir', 'ticsFile'] as const

type Translate = (key: StyleKey, params?: Record<string, string | number>) => string

const pad = (value: number): string => String(value).padStart(2, '0')
/** `MM-DD HH:mm` in the browser's zone. */
export function shortTime(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** One deletable row: a tone sample (with keep while pending) or a profile item. */
function Row({ id, text, label, meta, translate, edit, pending, children }: {
  id: string
  text: string
  label: string
  meta: string
  translate: Translate
  edit: StyleSectionInjected['edit']
  pending: boolean
  children: ReactNode
}): ReactNode {
  return (
    <li className={css.row}>
      <div className={css.exchange}>
        <p className={css.text}>{children}</p>
        <p className={css.meta}>{meta}</p>
      </div>
      <div className={css.rowActions}>
        {pending
          ? <button type="button" className={css.keep} aria-label={translate('sample.keep.label', { text })} onClick={() => { void edit({ op: 'keep', id }) }}>{translate('pending.keep')}</button>
          : null}
        <button type="button" className={css.remove} aria-label={translate('sample.remove.label', { text })} onClick={() => { void edit({ op: 'remove', id }) }}>
          {label}
        </button>
      </div>
    </li>
  )
}

function SampleRow({ sample, translate, edit, pending }: { sample: SampleView; translate: Translate; edit: StyleSectionInjected['edit']; pending: boolean }): ReactNode {
  const text = sample.prompt === undefined ? sample.reply : `${sample.prompt} → ${sample.reply}`
  const meta = sample.owner ? `${translate(`platform.${sample.source}`)} · ${translate('sample.owner')}` : translate(`platform.${sample.source}`)
  return (
    <Row id={sample.id} text={text} label={translate('sample.remove')} meta={meta} translate={translate} edit={edit} pending={pending}>
      {sample.prompt === undefined ? null : <><span className={css.prompt}>{sample.prompt}</span><span className={css.arrow} aria-hidden="true">→</span></>}
      <span className={css.reply}>{sample.reply}</span>
    </Row>
  )
}

/** One column of the persona: its title, an optional hint, and its rows (or a quiet "none yet"). */
function Column({ title, hint, empty, children }: { title: string; hint?: string; empty: string | null; children: ReactNode }): ReactNode {
  const id = useId()
  return (
    <section className={css.card} aria-labelledby={id}>
      <span id={id} className={css.cardTitle}>{title}</span>
      {hint === undefined ? null : <p className={css.hint}>{hint}</p>}
      {empty === null ? <ul className={css.list}>{children}</ul> : <p className={css.empty}>{empty}</p>}
    </section>
  )
}

function NoteRow({ note, translate, edit }: { note: NoteView; translate: Translate; edit: StyleSectionInjected['edit'] }): ReactNode {
  const parts = [
    translate(`platform.${note.source}`),
    ...note.meaningSource === undefined ? [] : [translate('note.meaning.from', { source: translate(`meaning.source.${note.meaningSource}`) })],
    translate('note.example', { text: note.example }),
    ...note.related === undefined || note.related.length === 0 ? [] : [translate('note.related', { terms: note.related.join('、') })],
  ]
  return (
    <Row id={note.id} text={note.term} label={translate('sample.remove')} meta={parts.join(' · ')} translate={translate} edit={edit} pending={false}>
      <span className={css.reply}>{note.term}</span>
      {note.meaning === undefined ? null : <span className={css.prompt}>{` · ${note.meaning}`}</span>}
    </Row>
  )
}

/**
 * Lines of `after` not in `before` and the reverse, in order: enough to see what a revision changed.
 * @param before - the earlier card.
 * @param after - the later card.
 * @returns lines marked `+` or `−`.
 */
export function cardDiff(before: string, after: string): Array<{ sign: '+' | '−'; line: string }> {
  const old = before === '' ? [] : before.split('\n')
  const now = after === '' ? [] : after.split('\n')
  return [
    ...old.filter(line => !now.includes(line)).map(line => ({ sign: '−' as const, line })),
    ...now.filter(line => !old.includes(line)).map(line => ({ sign: '+' as const, line })),
  ]
}

function CardSection({ panel, translate, edit, saving }: { panel: StylePanel; translate: Translate; edit: StyleSectionInjected['edit']; saving: boolean }): ReactNode {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const current: CardView | undefined = panel.cards.at(-1)
  const text = current?.card ?? ''
  const meta = (card: CardView): string => translate('card.meta', { version: card.version, author: translate(`card.author.${card.author}`), time: shortTime(card.at) })
  const save = (card: string): void => {
    void edit({ op: 'card', card }).then((ok) => { if (ok) setDraft(null) })
  }
  return (
    <section className={css.card} aria-labelledby={id}>
      <span id={id} className={css.cardTitle}>{translate('card.title')}{panel.parts.persona ? '' : ` ${translate('part.off')}`}</span>
      {draft === null
        ? (
          <>
            {text === '' ? <p className={css.empty}>{translate('card.empty')}</p> : <p className={css.cardText}>{text}</p>}
            {current === undefined || text === '' ? null : <p className={css.meta}>{meta(current)}</p>}
            <div className={css.heroActions}>
              <button type="button" className={css.secondary} disabled={saving} onClick={() => { setDraft(text) }}>{translate('card.edit')}</button>
              {text === '' ? null : <button type="button" className={css.remove} disabled={saving} onClick={() => { save('') }}>{translate('card.delete')}</button>}
            </div>
          </>
        )
        : (
          <>
            <textarea className={css.textarea} value={draft} maxLength={panel.limits.cardChars} rows={8} aria-label={translate('card.title')} onChange={(event) => { setDraft(event.target.value) }} />
            <p className={css.hint}>{translate('card.hint', { max: panel.limits.cardChars })}</p>
            <div className={css.heroActions}>
              <button type="button" className={css.primary} disabled={saving} onClick={() => { save(draft) }}>{translate('card.save')}</button>
              <button type="button" className={css.secondary} onClick={() => { setDraft(null) }}>{translate('card.cancel')}</button>
            </div>
          </>
        )}
      {panel.cards.length === 0
        ? null
        : (
          <details className={css.history}>
            <summary>{translate('card.history', { count: panel.cards.length })}</summary>
            <ol className={css.list}>
              {panel.cards.toReversed().map((card, index, newest) => (
                <li key={card.version} className={css.version}>
                  <p className={css.meta}>{`${meta(card)} · ${card.reason}`}</p>
                  <pre className={css.diff}>
                    {(card.card === '' ? [{ sign: '−' as const, line: translate('card.deleted') }] : cardDiff(newest[index + 1]?.card ?? '', card.card))
                      .map(change => `${change.sign} ${change.line}`).join('\n')}
                  </pre>
                  {index === 0
                    ? null
                    : (
                      <div className={css.heroActions}>
                        <button type="button" className={css.secondary} disabled={saving} onClick={() => { void edit({ op: 'rollback', version: card.version }) }}>{translate('card.rollback')}</button>
                        <button type="button" className={css.remove} disabled={saving} aria-label={translate('card.version.delete.label', { version: card.version })} onClick={() => { void edit({ op: 'deleteVersion', version: card.version }) }}>
                          {translate('card.version.delete')}
                        </button>
                      </div>
                    )}
                </li>
              ))}
            </ol>
          </details>
        )}
    </section>
  )
}

function MemesColumn({ panel, translate, edit }: { panel: StylePanel; translate: Translate; edit: StyleSectionInjected['edit'] }): ReactNode {
  const memes = panel.notes.filter(note => note.kind === 'meme')
  const title = `${translate('col.memes', { count: memes.length + panel.hot.length })}${panel.parts.memes ? '' : ` ${translate('part.off')}`}`
  return (
    <Column title={title} empty={memes.length + panel.hot.length === 0 ? translate('col.empty') : null}>
      {memes.length === 0 ? null : <li className={css.subhead}>{translate('memes.jargon')}</li>}
      {memes.map(note => <NoteRow key={note.id} note={note} translate={translate} edit={edit} />)}
      {panel.hot.length === 0 ? null : <li className={css.subhead}>{translate('memes.hot')}</li>}
      {panel.hot.map(item => (
        <li key={item.title} className={css.row}>
          <div className={css.exchange}><p className={css.text}>{item.title}</p></div>
          <div className={css.rowActions}>
            <button type="button" className={css.remove} aria-label={translate('sample.remove.label', { text: item.title })} onClick={() => { void edit({ op: 'block', term: item.title }) }}>
              {translate('sample.remove')}
            </button>
          </div>
        </li>
      ))}
    </Column>
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

/** A refusal rule's label, or the rule's own name when the dictionary has none. */
const reasonLabel = (reason: string, translate: Translate): string =>
  (`reason.${reason}` in zh ? translate(`reason.${reason}` as StyleKey) : reason)

function MineCard({ panel, translate }: { panel: StylePanel; translate: Translate }): ReactNode {
  const id = useId()
  const run: MineReport | null = panel.lastMine
  const rejected = Object.entries(run?.rejected ?? {}).filter(([, count]) => count > 0).toSorted((a, b) => b[1] - a[1])
  return (
    <section className={css.card} aria-labelledby={id}>
      <span id={id} className={css.cardTitle}>{translate('mine.title')}{panel.parts.miner ? '' : ` ${translate('part.off')}`}</span>
      <p className={css.hint}>{translate('mine.hint')}</p>
      {run === null
        ? <p className={css.empty}>{translate('mine.never')}</p>
        : (
          <dl className={css.rows}>
            <div className={css.pair}>
              <dt>{translate('mine.last')}</dt>
              <dd>
                {run.skipped === undefined
                  ? translate('mine.last.value', { time: shortTime(run.at), kept: run.kept, touched: run.touched, candidates: run.candidates, llm: run.llmCalls, searches: run.searches })
                  : `${shortTime(run.at)} · ${translate(`mine.skipped.${run.skipped}` as StyleKey)}`}
              </dd>
            </div>
            <div className={css.pair}>
              <dt>{translate('mine.inputs')}</dt>
              <dd>{translate('mine.inputs.value', { ...run.inputs })}</dd>
            </div>
            {rejected.length === 0
              ? null
              : (
                <div className={css.pair}>
                  <dt>{translate('mine.rejected')}</dt>
                  <dd className={css.reasons}>
                    {rejected.map(([reason, count]) => <span key={reason} className={css.chip}>{`${reasonLabel(reason, translate)} ${String(count)}`}</span>)}
                  </dd>
                </div>
              )}
          </dl>
        )}
    </section>
  )
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
export function StyleSection({ useStyle, refresh, edit, collect, renderFactorySlot, t }: StyleSectionProps): ReactNode {
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
  const samples = [...active.filter(sample => sample.owner), ...active.filter(sample => !sample.owner)]
  const traits = panel.notes.filter(note => note.kind === 'trait')
  const persona = active.length + panel.notes.length + (panel.cards.at(-1)?.card ? 1 : 0)
  const tone = !panel.enabled ? 'off' : persona === 0 ? 'empty' : 'on'
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
          <h3 className={css.verdict}>{tone === 'on' ? translate('head.on', { count: persona }) : translate(`head.${tone}`)}</h3>
          <p className={css.next}>{translate(`head.${tone}.detail`)}</p>
          <div className={css.heroActions}>
            <span className={css.chip}>{translate(panel.review === 'required' ? 'head.review.required' : 'head.review.optional')}</span>
            <button type="button" className={css.secondary} disabled={busy || !panel.enabled} onClick={collect}>
              {translate(panel.running ? 'action.collecting' : 'action.collect')}
            </button>
          </div>
        </div>
      </div>
      {state.error === null ? null : <p className={css.notice} role="alert">{translate(`error.${state.error === 'not_found' || state.error === 'network' || state.error === 'current_version' ? state.error : 'invalid_input'}`)}</p>}
      {pending.length === 0
        ? null
        : (
          <Column title={translate('pending.title', { count: pending.length })} empty={null}>
            {pending.map(sample => <SampleRow key={sample.id} sample={sample} translate={translate} edit={edit} pending />)}
          </Column>
        )}
      <CardSection panel={panel} translate={translate} edit={edit} saving={state.saving} />
      <div className={css.columns}>
        <Column
          title={`${translate('col.traits', { count: traits.length, max: panel.limits.maxTraits })}${panel.parts.traits ? '' : ` ${translate('part.off')}`}`}
          empty={traits.length === 0 ? translate('col.empty') : null}
        >
          {traits.map(note => <NoteRow key={note.id} note={note} translate={translate} edit={edit} />)}
        </Column>
        <MemesColumn panel={panel} translate={translate} edit={edit} />
        <Column
          title={`${translate('col.tone', { count: samples.length })}${panel.parts.tone ? '' : ` ${translate('part.off')}`}`}
          hint={translate('col.tone.hint', { max: panel.limits.maxOwner })}
          empty={samples.length === 0 ? translate('col.empty') : null}
        >
          {samples.map(sample => <SampleRow key={sample.id} sample={sample} translate={translate} edit={edit} pending={false} />)}
        </Column>
      </div>
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
      <MineCard panel={panel} translate={translate} />
      <Trend days={panel.trend} translate={translate} />
      {renderFactorySlot?.('settings.plugin-config', { entries: CONFIG_ENTRIES, exclude: CONFIG_EXCLUDE })}
    </section>
  )
}
