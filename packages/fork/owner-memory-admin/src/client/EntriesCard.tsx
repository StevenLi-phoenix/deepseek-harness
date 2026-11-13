/**
 * The entries card: a searchable, filterable, paged list of what the agent remembers, newest change first.
 * A row shows the opening of an entry; opening it fetches the full text and its history. Undo and erase
 * act on one entry; erase always shows what it will remove before it does.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CATEGORIES, type Category, type EntryView } from '../view.ts'
import type { MemoryActions, MemoryState } from './memory.ts'
import { Button, Card, shortSession, Tag, when, type Translate } from './parts.tsx'
import css from './Memory.module.css'

/** Milliseconds the search box waits after the last keystroke before it asks the Host. */
const SEARCH_DEBOUNCE_MS = 250

function PurgePanel({ id, state, actions, t }: { id: string; state: MemoryState; actions: MemoryActions; t: Translate }): ReactNode {
  const flow = state.purge
  if (flow === null || !flow.ids.includes(id)) return null
  const item = flow.preview?.items.find(candidate => candidate.id === id)
  return (
    <div className={css.confirm} role="alertdialog" aria-label={t('forget.title', { id })} data-stage={flow.stage}>
      {flow.stage === 'previewing' ? <p>{t('forget.working')}</p> : null}
      {flow.preview === undefined ? null : (
        <>
          <p className={css.confirmTitle}>{t('forget.title', { id })}</p>
          {item?.found === true ? <p className={css.text}>{item.text}</p> : <p>{t('forget.notFound')}</p>}
          <p className={css.sub}>{t('forget.warn')}</p>
          {item === undefined ? null : <p className={css.sub}>{t('forget.counts', { history: item.history, snapshots: item.snapshots, pending: item.pending })}</p>}
          <div className={css.actions}>
            <Button kind="danger" busy={flow.stage === 'applying'} onClick={() => { void actions.purgeApply() }}>{t('forget.confirm')}</Button>
            <Button disabled={flow.stage === 'applying'} onClick={() => { actions.purgeCancel() }}>{t('forget.cancel')}</Button>
          </div>
        </>
      )}
    </div>
  )
}

function Detail({ entry, state, t }: { entry: EntryView; state: MemoryState; t: Translate }): ReactNode {
  const detail = state.details[entry.id]
  if (detail === undefined || detail.status === 'loading') return <p className={css.sub}>{t('entries.loading')}</p>
  if (detail.status === 'error') return <p className={css.sub}>{t('entries.loadFailed')}</p>
  const { history } = detail.detail
  return (
    <>
      <p className={css.text} data-full="">{detail.detail.entry.text}</p>
      <div className={css.history}>
        <span className={css.historyTitle}>{t('entries.history')}</span>
        {history.length === 0
          ? <span className={css.sub}>{t('entries.noHistory')}</span>
          : (
            <ul className={css.historyList}>
              {history.map(line => (
                <li key={`${line.at}-${line.op}`}>
                  <span className={css.when}>{when(line.at)}</span>
                  <Tag>{t(`op.${line.op}` as 'op.add')}</Tag>
                  {line.session === undefined ? null : <span>{t('meta.session', { session: shortSession(line.session) })}</span>}
                  {line.origin === undefined ? null : <span>{t('meta.origin', { origin: line.origin })}</span>}
                </li>
              ))}
            </ul>
          )}
      </div>
    </>
  )
}

function Row({ entry, open, onToggle, state, actions, t }: {
  entry: EntryView
  open: boolean
  onToggle: () => void
  state: MemoryState
  actions: MemoryActions
  t: Translate
}): ReactNode {
  const busy = state.busy.includes(entry.id)
  return (
    <li className={css.item} data-entry={entry.id} data-open={open ? '' : undefined}>
      <button type="button" className={css.rowButton} aria-expanded={open} onClick={onToggle}>
        <span className={css.itemHead}>
          <Tag>{t(`category.${entry.category}`)}</Tag>
          {entry.protected ? <Tag>{t('entries.protected')}</Tag> : null}
          {entry.source === 'tainted-turn' ? <Tag tone="warn">{t('source.tainted-turn')}</Tag> : null}
          <span className={css.id}>{entry.id}</span>
          <span className={css.when}>{entry.date}</span>
        </span>
        {open ? null : <span className={css.clip}>{entry.text}</span>}
      </button>
      {open
        ? (
          <div className={css.detail}>
            <Detail entry={entry} state={state} t={t} />
            <div className={css.itemMeta}>
              <span>{t(`source.${entry.source}`)}</span>
              {entry.session === undefined ? null : <span>{t('meta.session', { session: shortSession(entry.session) })}</span>}
              {entry.origin === undefined ? null : <span>{t('meta.origin', { origin: entry.origin })}</span>}
            </div>
            <div className={css.actions}>
              {entry.revertible
                ? <Button busy={busy} onClick={() => { void actions.review('revert', [entry.id]) }}>{t('entries.revert')}</Button>
                : null}
              <Button kind="danger" busy={busy} onClick={() => { void actions.purgePreview([entry.id]) }}>{t('entries.forget')}</Button>
            </div>
            <PurgePanel id={entry.id} state={state} actions={actions} t={t} />
          </div>
        )
        : null}
    </li>
  )
}

/**
 * Render the entries list.
 * @param props - the state slice, the actions, and copy.
 */
export function EntriesCard({ state, actions, t }: { state: MemoryState; actions: MemoryActions; t: Translate }): ReactNode {
  const { view, query } = state
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState(query.q)
  const asked = useRef(query.q)
  // The search box answers each keystroke at once and asks the Host once typing pauses.
  useEffect(() => {
    if (draft === asked.current) return undefined
    const timer = setTimeout(() => {
      asked.current = draft
      void actions.setQuery({ q: draft.trim() })
    }, SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [draft, actions])
  const toggle = (id: string): void => {
    const next = open === id ? null : id
    setOpen(next)
    if (next !== null) void actions.loadDetail(next)
  }
  const matched = view?.entries.matched ?? 0
  const items = view?.entries.items ?? []
  const from = matched === 0 ? 0 : query.offset + 1
  const to = Math.min(matched, query.offset + query.limit)
  return (
    <Card title={t('entries.title')} id="entries" {...view === null ? {} : { meta: t('entries.matched', { matched, total: view.total }) }}>
      <input
        className={css.input}
        type="search"
        value={draft}
        placeholder={t('entries.search')}
        aria-label={t('entries.search')}
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        onChange={(event) => { setDraft(event.target.value) }}
      />
      <div className={css.chips} role="group" aria-label={t('entries.title')}>
        <Button pressed={query.category === 'all'} onClick={() => { void actions.setQuery({ category: 'all' }) }}>{t('entries.all')}</Button>
        {CATEGORIES.map((category: Category) => (
          <Button key={category} pressed={query.category === category} onClick={() => { void actions.setQuery({ category }) }}>
            {`${t(`category.${category}`)} ${String(view?.counts[category] ?? 0)}`}
          </Button>
        ))}
      </div>
      {items.length === 0
        ? <p className={css.empty}>{view !== null && view.total === 0 ? t('entries.empty') : t('entries.noMatch')}</p>
        : (
          <ul className={css.list}>
            {items.map(entry => (
              <Row
                key={entry.id}
                entry={entry}
                open={open === entry.id}
                onToggle={() => { toggle(entry.id) }}
                state={state}
                actions={actions}
                t={t}
              />
            ))}
          </ul>
        )}
      {matched > query.limit
        ? (
          <div className={css.pager}>
            <Button disabled={query.offset === 0} onClick={() => { void actions.setQuery({ offset: Math.max(0, query.offset - query.limit) }) }}>{t('entries.prev')}</Button>
            <span className={css.meta}>{t('entries.range', { from, to, matched })}</span>
            <Button disabled={to >= matched} onClick={() => { void actions.setQuery({ offset: query.offset + query.limit }) }}>{t('entries.next')}</Button>
          </div>
        )
        : null}
    </Card>
  )
}
