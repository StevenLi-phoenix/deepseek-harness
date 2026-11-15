/**
 * The two confirmations the entries page shows at its top: a merge the owner asked for, whose text they may
 * word before it is applied, and the erase preview the Host made. Both appear only after an explicit click;
 * Escape closes either, and nothing is written until the confirm button is pressed.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CATEGORIES, type Category } from '../view.ts'
import type { MemoryActions, MemoryState } from './memory.ts'
import { Button, type Translate } from './parts.tsx'
import css from './Memory.module.css'

/**
 * Render the merge preview, its text and category, and its result.
 * @param props - the state slice, the actions, and copy.
 */
export function MergePanel({ state, actions, t }: { state: MemoryState; actions: MemoryActions; t: Translate }): ReactNode {
  const flow = state.merge
  const [text, setText] = useState('')
  const [category, setCategory] = useState<Category>('projects')
  const [shown, setShown] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const heading = useId()
  const token = flow?.preview?.token ?? null
  // A closed preview forgets what was typed, so opening it again starts from the Host's proposal.
  useEffect(() => {
    if (flow === null) setShown(null)
  }, [flow])
  // A new preview replaces what the owner typed for the last one, and takes the focus.
  useEffect(() => {
    if (flow?.stage !== 'ready' || flow.preview === undefined || token === shown) return
    setText(flow.preview.text)
    setCategory(flow.preview.category)
    setShown(token)
    area.current?.focus()
  }, [flow, token, shown])
  if (flow === null) return null
  const title = t('merge.title', { count: flow.preview?.ids.length ?? flow.ids.length })
  if (flow.stage === 'previewing') {
    return (
      <div className={css.confirm} role="dialog" aria-label={title} data-stage={flow.stage}>
        <p>{t('merge.working')}</p>
      </div>
    )
  }
  if (flow.stage === 'done') {
    return (
      <div className={css.confirm} role="status" aria-label={title}>
        <p className={css.confirmTitle}>{t('merge.done', { id: flow.preview?.keep ?? '' })}</p>
        <div className={css.actions}>
          <Button onClick={() => { actions.mergeCancel() }}>{t('merge.close')}</Button>
        </div>
      </div>
    )
  }
  const preview = flow.preview
  if (preview === undefined) return null
  const busy = flow.stage === 'applying'
  return (
    <div className={css.confirm} role="dialog" aria-label={title} aria-labelledby={heading} data-stage={flow.stage}>
      <p className={css.confirmTitle} id={heading}>{title}</p>
      <p className={css.sub}>
        {t('merge.keep', { id: preview.keep, removed: preview.removed })}
        {' · '}
        {preview.ids.join(' ')}
      </p>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('merge.text')}</span>
        <textarea
          ref={area}
          className={css.input}
          rows={4}
          value={text}
          maxLength={2000}
          disabled={busy}
          onChange={(event) => { setText(event.target.value) }}
        />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('merge.category')}</span>
        <select
          className={css.input}
          value={category}
          disabled={busy}
          onChange={(event) => { setCategory(event.target.value as Category) }}
        >
          {CATEGORIES.map(candidate => <option key={candidate} value={candidate}>{t(`category.${candidate}`)}</option>)}
        </select>
      </label>
      <div className={css.actions}>
        <Button
          kind="primary"
          busy={busy}
          disabled={text.trim() === ''}
          onClick={() => { void actions.mergeApply({ text: text.trim(), category }) }}
        >
          {t('merge.confirm')}
        </Button>
        <Button kind="quiet" disabled={busy} onClick={() => { actions.mergeCancel() }}>{t('merge.cancel')}</Button>
      </div>
    </div>
  )
}

/**
 * Render what erasing the entries the owner picked would remove.
 * @param props - the state slice, the actions, and copy.
 */
export function ForgetConfirm({ state, actions, t }: { state: MemoryState; actions: MemoryActions; t: Translate }): ReactNode {
  const flow = state.purge
  if (flow === null) return null
  const single = flow.ids.length === 1
  const title = single ? t('forget.title', { id: flow.ids[0] ?? '' }) : t('forget.bulkTitle', { count: flow.ids.length })
  const items = flow.preview?.items ?? []
  return (
    <div className={css.confirm} role="alertdialog" aria-label={title} data-stage={flow.stage}>
      {flow.stage === 'previewing' ? <p>{t('forget.working')}</p> : null}
      {flow.preview === undefined ? null : (
        <>
          <p className={css.confirmTitle}>{title}</p>
          {items.length === 0
            ? <p className={css.sub}>{t('forget.notFound')}</p>
            : single && items[0]?.found === true
              ? <p className={css.text}>{items[0].text}</p>
              : (
                <ul className={css.confirmList}>
                  {items.map(item => (
                    <li key={item.id}>
                      <span className={css.id}>{item.id}</span>
                      {' '}
                      {item.found ? item.text : t('forget.notFound')}
                    </li>
                  ))}
                </ul>
              )}
          <p className={css.sub}>{t('forget.warn')}</p>
          {single && items[0] !== undefined
            ? <p className={css.sub}>{t('forget.counts', { history: items[0].history, snapshots: items[0].snapshots, pending: items[0].pending })}</p>
            : null}
          <div className={css.actions}>
            <Button autoFocus kind="danger" busy={flow.stage === 'applying'} onClick={() => { void actions.purgeApply() }}>{t('forget.confirm')}</Button>
            <Button disabled={flow.stage === 'applying'} onClick={() => { actions.purgeCancel() }}>{t('forget.cancel')}</Button>
          </div>
        </>
      )}
    </div>
  )
}
