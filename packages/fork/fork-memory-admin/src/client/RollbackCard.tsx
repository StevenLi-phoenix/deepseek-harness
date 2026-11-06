/**
 * The rollback card: undo what one Session changed, or everything since a time. The Host computes a
 * preview first; confirming applies exactly that preview, and the Host refuses if memory changed in between.
 */

import { useState, type ReactNode } from 'react'
import type { MemoryActions, MemoryState, RollbackTarget } from './memory.ts'
import { Button, Card, shortSession, Tag, when, type Translate } from './parts.tsx'
import css from './Memory.module.css'

type Mode = 'session' | 'time'

/**
 * The ISO time a `datetime-local` value means in the viewer's zone.
 * @param local - `YYYY-MM-DDTHH:mm`, or empty.
 * @returns the ISO string, or undefined when the value is not a time.
 */
export function isoFromLocal(local: string): string | undefined {
  if (local === '') return undefined
  const time = new Date(local)
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString()
}

/**
 * Render the rollback card.
 * @param props - the state slice, the actions, and copy.
 */
export function RollbackCard({ state, actions, t }: { state: MemoryState; actions: MemoryActions; t: Translate }): ReactNode {
  const sessions = state.view?.sessions ?? []
  const [mode, setMode] = useState<Mode>('session')
  const [session, setSession] = useState('')
  const [since, setSince] = useState('')
  const flow = state.rollback
  const chosen = sessions.some(candidate => candidate.id === session) ? session : (sessions[0]?.id ?? '')
  const sinceIso = isoFromLocal(since)
  const target: RollbackTarget | undefined = mode === 'session'
    ? (chosen === '' ? undefined : { session: chosen })
    : (sinceIso === undefined ? undefined : { since: sinceIso })
  const working = flow?.stage === 'previewing' || flow?.stage === 'applying'
  const preview = flow?.preview
  return (
    <Card title={t('rollback.title')} id="rollback">
      <p className={css.sub}>{t('rollback.hint')}</p>
      <div className={css.chips} role="group" aria-label={t('rollback.title')}>
        <Button pressed={mode === 'session'} onClick={() => { setMode('session'); actions.rollbackCancel() }}>{t('rollback.bySession')}</Button>
        <Button pressed={mode === 'time'} onClick={() => { setMode('time'); actions.rollbackCancel() }}>{t('rollback.byTime')}</Button>
      </div>
      {mode === 'session'
        ? (sessions.length === 0
          ? <p className={css.empty}>{t('rollback.noSessions')}</p>
          : (
            <select
              className={css.input}
              aria-label={t('rollback.session')}
              value={chosen}
              onChange={(event) => { setSession(event.target.value); actions.rollbackCancel() }}
            >
              {sessions.map(item => (
                <option key={item.id} value={item.id}>
                  {t('rollback.sessionOption', { id: shortSession(item.id), changes: item.changes, time: when(item.lastAt) })}
                </option>
              ))}
            </select>
          ))
        : (
          <input
            className={css.input}
            type="datetime-local"
            aria-label={t('rollback.since')}
            value={since}
            onChange={(event) => { setSince(event.target.value); actions.rollbackCancel() }}
          />
        )}
      <div className={css.actions}>
        <Button
          kind="primary"
          disabled={target === undefined || working}
          busy={flow?.stage === 'previewing'}
          onClick={() => {
            /* v8 ignore else -- the button is disabled while target is undefined, so a click always has one (type narrowing) */
            if (target !== undefined) void actions.rollbackPreview(target)
          }}
        >
          {flow?.stage === 'previewing' ? t('rollback.working') : t('rollback.preview')}
        </Button>
      </div>
      {preview === undefined ? null : (
        <div className={css.confirm} data-stage={flow?.stage}>
          {preview.matched === 0
            ? <p>{t('rollback.nothing')}</p>
            : <p className={css.confirmTitle}>{t('rollback.summary', { matched: preview.matched, restored: preview.restored, removed: preview.removed })}</p>}
          <ul className={css.list}>
            {preview.items.map(item => (
              <li key={item.id} className={css.item} data-change={item.change}>
                <span className={css.itemHead}>
                  <Tag tone={item.change === 'remove' ? 'bad' : item.change === 'none' ? undefined : 'good'}>{t(`change.${item.change}`)}</Tag>
                  {item.category === undefined ? null : <Tag>{t(`category.${item.category}`)}</Tag>}
                  <span className={css.id}>{item.id}</span>
                </span>
                {item.now === undefined ? null : <span className={css.sub}>{item.now}</span>}
                {item.then === undefined || item.change === 'none' ? null : <span className={css.text}>{item.then}</span>}
              </li>
            ))}
          </ul>
          <div className={css.actions}>
            {preview.matched === 0
              ? null
              : <Button kind="danger" busy={flow?.stage === 'applying'} onClick={() => { void actions.rollbackApply() }}>{t('rollback.confirm')}</Button>}
            <Button disabled={flow?.stage === 'applying'} onClick={() => { actions.rollbackCancel() }}>{t('rollback.cancel')}</Button>
          </div>
        </div>
      )}
      {flow?.stage === 'done'
        ? (
          <div className={css.confirm} data-stage="done" role="status">
            <p>{t('rollback.done', { restored: flow.restored ?? 0, removed: flow.removed ?? 0 })}</p>
            <div className={css.actions}><Button onClick={() => { actions.rollbackCancel() }}>{t('rollback.close')}</Button></div>
          </div>
        )
        : null}
    </Card>
  )
}
