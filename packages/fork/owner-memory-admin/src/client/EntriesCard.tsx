/**
 * The entries card: a compact, searchable list of what the agent remembers, newest change first, and — behind the
 * same card — the groups of entries that say nearly the same thing. A row is one line (category, its opening, the
 * date, the protected mark); opening it fetches the full text and its history. Rows can be selected for a merge, an
 * erase, or a category change, and a merge always shows its text before it applies.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CATEGORIES, type Category, type DuplicateGroupView, type EntryView } from '../view.ts'
import { dismissKey, groupMatches, keepShown, selectAll, toggleSelection, type ListFilter, type ListMode } from './filter.ts'
import type { MemoryActions, MemoryState } from './memory.ts'
import { Button, Card, shortSession, Tag, when, type Translate } from './parts.tsx'
import css from './Memory.module.css'

/** Milliseconds the search box waits after the last keystroke before it asks the Host. */
const SEARCH_DEBOUNCE_MS = 250

function Detail({ entry, state, actions, t }: { entry: EntryView; state: MemoryState; actions: MemoryActions; t: Translate }): ReactNode {
  const detail = state.details[entry.id]
  const busy = state.busy.includes(entry.id)
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
      <div className={css.actions}>
        {entry.revertible
          ? <Button busy={busy} onClick={() => { void actions.review('revert', [entry.id]) }}>{t('entries.revert')}</Button>
          : null}
        <Button kind="danger" busy={busy} onClick={() => { void actions.purgePreview([entry.id]) }}>{t('entries.forget')}</Button>
      </div>
    </>
  )
}

function Row({ entry, open, selected, onToggle, onSelect, state, actions, t }: {
  entry: EntryView
  open: boolean
  selected: boolean
  onToggle: () => void
  onSelect: () => void
  state: MemoryState
  actions: MemoryActions
  t: Translate
}): ReactNode {
  return (
    <li className={css.entry} data-entry={entry.id} data-open={open ? '' : undefined}>
      <input
        type="checkbox"
        className={css.check}
        aria-label={t('entry.select', { id: entry.id })}
        checked={selected}
        onChange={onSelect}
      />
      <button type="button" className={css.rowButton} aria-expanded={open} onClick={onToggle}>
        <Tag>{t(`category.${entry.category}`)}</Tag>
        <span className={css.entryText}>{entry.text}</span>
        <span className={css.when}>{entry.date}</span>
        {entry.protected ? <Tag>{t('entries.protected')}</Tag> : null}
        {entry.source === 'tainted-turn' ? <Tag tone="warn">{t('source.tainted-turn')}</Tag> : null}
      </button>
      {open
        ? (
          <div className={css.detail}>
            <div className={css.itemMeta}>
              <span>{t(`source.${entry.source}`)}</span>
              {entry.session === undefined ? null : <span>{t('meta.session', { session: shortSession(entry.session) })}</span>}
              {entry.origin === undefined ? null : <span>{t('meta.origin', { origin: entry.origin })}</span>}
              <span className={css.id}>{entry.id}</span>
            </div>
            <Detail entry={entry} state={state} actions={actions} t={t} />
          </div>
        )
        : null}
    </li>
  )
}

function Group({ group, actions, t }: { group: DuplicateGroupView; actions: MemoryActions; t: Translate }): ReactNode {
  const conflict = group.kind === 'conflict'
  return (
    <li className={css.group} data-group={group.key} data-kind={group.kind}>
      <div className={css.groupHead}>
        <Tag tone={conflict ? 'warn' : undefined}>{t(conflict ? 'dupes.conflict' : 'dupes.duplicate')}</Tag>
        <span className={css.meta}>{t('dupes.similarity', { percent: Math.round(group.score * 100) })}</span>
        <span className={css.meta}>{t('dupes.members', { count: group.ids.length })}</span>
        <div className={css.actions}>
          <Button kind="primary" onClick={() => { void actions.mergePreview(group.ids) }}>{t('dupes.merge')}</Button>
          <Button onClick={() => { actions.dismiss(dismissKey('merge', group.ids)) }}>{t('dupes.keepBoth')}</Button>
        </div>
      </div>
      <ul className={css.groupMembers}>
        {group.members.map(member => (
          <li key={member.id} className={css.groupMember}>
            <div className={css.itemHead}>
              <Tag>{t(`category.${member.category}`)}</Tag>
              <span className={css.id}>{member.id}</span>
              <span className={css.when}>{member.date}</span>
              {member.protected ? <Tag>{t('entries.protected')}</Tag> : null}
            </div>
            <p className={css.text}>
              {member.parts.length === 0
                ? member.text
                : member.parts.map((part, index) => (part.differs
                  ? <mark key={index} className={css.diff}>{part.text}</mark>
                  : <span key={index}>{part.text}</span>))}
            </p>
          </li>
        ))}
      </ul>
    </li>
  )
}

/**
 * Render the entries card: the compact rows, the duplicate groups, and the selection toolbar.
 * @param props - the state slice, the actions, and copy.
 */
export function EntriesCard({ state, actions, t }: { state: MemoryState; actions: MemoryActions; t: Translate }): ReactNode {
  const { view, query } = state
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState(query.q)
  const [mode, setMode] = useState<ListMode>('all')
  const [selected, setSelected] = useState<string[]>([])
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
  const matched = view?.entries.matched ?? 0
  const items = view?.entries.items ?? []
  const ids = items.map(entry => entry.id)
  const shown = ids.join(',')
  // A new page or a narrowed filter drops the ids it no longer shows.
  useEffect(() => { setSelected(current => keepShown(current, shown === '' ? [] : shown.split(','))) }, [shown])
  // A merge that went through leaves nothing selected: the entries it covered are gone.
  const mergeStage = state.merge?.stage ?? null
  useEffect(() => { if (mergeStage === 'done') setSelected([]) }, [mergeStage])
  const filter: ListFilter = { q: query.q, category: query.category, mode }
  const groups = (view?.curation?.groups ?? [])
    .filter(group => !state.dismissed.includes(dismissKey('merge', group.ids)) && groupMatches(group, filter))
  const toggle = (id: string): void => {
    const next = open === id ? null : id
    setOpen(next)
    if (next !== null) void actions.loadDetail(next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    if (open !== null) {
      setOpen(null)
      event.stopPropagation()
      return
    }
    if (selected.length > 0) {
      setSelected([])
      event.stopPropagation()
    }
  }
  const allSelected = items.length > 0 && items.every(entry => selected.includes(entry.id))
  const from = matched === 0 ? 0 : query.offset + 1
  const to = Math.min(matched, query.offset + query.limit)
  return (
    <Card title={t('entries.title')} id="entries" onKeyDown={onKeyDown} {...view === null ? {} : { meta: t('entries.matched', { matched, total: view.total }) }}>
      <div className={css.toolbar}>
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
        <div className={css.modes} role="group" aria-label={t('entries.title')}>
          <Button pressed={mode === 'all'} onClick={() => { setMode('all') }}>{t('entries.mode.all')}</Button>
          <Button pressed={mode === 'duplicates'} onClick={() => { setMode('duplicates') }}>
            {`${t('entries.mode.duplicates')} ${String(groups.length)}`}
          </Button>
        </div>
      </div>
      <div className={css.chips} role="group" aria-label={t('entries.title')}>
        <Button pressed={query.category === 'all'} onClick={() => { void actions.setQuery({ category: 'all' }) }}>{t('entries.all')}</Button>
        {CATEGORIES.map((category: Category) => (
          <Button key={category} pressed={query.category === category} onClick={() => { void actions.setQuery({ category }) }}>
            {`${t(`category.${category}`)} ${String(view?.counts[category] ?? 0)}`}
          </Button>
        ))}
      </div>
      {mode === 'duplicates'
        ? (
          groups.length === 0
            ? <p className={css.empty}>{t('dupes.none')}</p>
            : <ul className={css.list}>{groups.map(group => <Group key={group.key} group={group} actions={actions} t={t} />)}</ul>
        )
        : (
          <>
            {items.length === 0
              ? <p className={css.empty}>{view !== null && view.total === 0 ? t('entries.empty') : t('entries.noMatch')}</p>
              : (
                <>
                  <div className={css.selection}>
                    <label className={css.checkLabel}>
                      <input
                        type="checkbox"
                        aria-label={t('entries.selectAll')}
                        checked={allSelected}
                        onChange={() => { setSelected(selectAll(selected, ids)) }}
                      />
                      {t('entries.selectAll')}
                    </label>
                    {selected.length === 0 ? null : <span className={css.meta}>{t('entries.selected', { count: selected.length })}</span>}
                  </div>
                  {selected.length === 0
                    ? null
                    : (
                      <div className={css.bulk} role="toolbar" aria-label={t('entries.selected', { count: selected.length })}>
                        <Button disabled={selected.length < 2} onClick={() => { void actions.mergePreview(selected) }}>{t('entries.mergeSelected')}</Button>
                        <Button kind="danger" onClick={() => { void actions.purgePreview(selected) }}>{t('entries.forgetSelected')}</Button>
                        <label className={css.moveTo}>
                          <span className={css.fieldLabel}>{t('entries.categoryTo')}</span>
                          <select
                            className={css.input}
                            aria-label={t('entries.categoryTo')}
                            value=""
                            onChange={(event) => {
                              const category = event.target.value
                              if (category === '') return
                              void actions.reclassify(selected, category as Category).then(() => { setSelected([]) })
                            }}
                          >
                            <option value="">—</option>
                            {CATEGORIES.map(category => <option key={category} value={category}>{t(`category.${category}`)}</option>)}
                          </select>
                        </label>
                        <Button onClick={() => { setSelected([]) }}>{t('entries.clearSelection')}</Button>
                      </div>
                    )}
                  <ul className={css.list}>
                    {items.map(entry => (
                      <Row
                        key={entry.id}
                        entry={entry}
                        open={open === entry.id}
                        selected={selected.includes(entry.id)}
                        onToggle={() => { toggle(entry.id) }}
                        onSelect={() => { setSelected(toggleSelection(selected, entry.id)) }}
                        state={state}
                        actions={actions}
                        t={t}
                      />
                    ))}
                  </ul>
                </>
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
          </>
        )}
    </Card>
  )
}
