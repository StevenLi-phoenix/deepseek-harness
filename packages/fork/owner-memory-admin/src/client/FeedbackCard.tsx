/**
 * The feedback card: the owner's keep/delete verdicts on persona replies, which the `up` and `bili` presets
 * read as examples of tone. The owner can add one by hand or remove one.
 */

import { useState, type ReactNode } from 'react'
import type { FeedbackView } from '../view.ts'
import type { MemoryActions, MemoryState } from './memory.ts'
import { Button, Card, Tag, when, type Translate } from './parts.tsx'
import css from './Memory.module.css'

function Verdict({ item, busy, actions, t }: { item: FeedbackView; busy: boolean; actions: MemoryActions; t: Translate }): ReactNode {
  return (
    <li className={css.item} data-feedback={item.id}>
      <div className={css.itemHead}>
        <Tag tone={item.verdict === 'keep' ? 'good' : 'bad'}>{t(`verdict.${item.verdict}`)}</Tag>
        <Tag>{t(`scope.${item.scope}`)}</Tag>
        <Tag>{t(`kind.${item.kind}`)}</Tag>
        <span className={css.when}>{when(item.at)}</span>
      </div>
      <p className={css.text}>{item.text}</p>
      {item.note === undefined ? null : <p className={css.sub}>{item.note}</p>}
      <div className={css.actions}>
        <Button busy={busy} onClick={() => { void actions.feedbackForget(item.id) }}>{t('feedback.remove')}</Button>
      </div>
    </li>
  )
}

function AddForm({ actions, close, t }: { actions: MemoryActions; close: () => void; t: Translate }): ReactNode {
  const [scope, setScope] = useState<'up' | 'bili'>('up')
  const [verdict, setVerdict] = useState<'keep' | 'delete'>('keep')
  const [kind, setKind] = useState<'comment' | 'dm'>('comment')
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<void> => {
    setSaving(true)
    const ok = await actions.feedbackAdd({
      action: 'feedback.add', scope, verdict, kind, text: text.trim(), ...note.trim() === '' ? {} : { note: note.trim() },
    })
    setSaving(false)
    if (ok) close()
  }
  return (
    <div className={css.form}>
      <div className={css.formRow}>
        <select className={css.input} aria-label={t('verdict.keep')} value={verdict} onChange={(event) => { setVerdict(event.target.value as 'keep' | 'delete') }}>
          <option value="keep">{t('verdict.keep')}</option>
          <option value="delete">{t('verdict.delete')}</option>
        </select>
        <select className={css.input} aria-label={t('scope.up')} value={scope} onChange={(event) => { setScope(event.target.value as 'up' | 'bili') }}>
          <option value="up">{t('scope.up')}</option>
          <option value="bili">{t('scope.bili')}</option>
        </select>
        <select className={css.input} aria-label={t('kind.comment')} value={kind} onChange={(event) => { setKind(event.target.value as 'comment' | 'dm') }}>
          <option value="comment">{t('kind.comment')}</option>
          <option value="dm">{t('kind.dm')}</option>
        </select>
      </div>
      <textarea className={css.input} rows={3} maxLength={300} placeholder={t('feedback.text')} aria-label={t('feedback.text')} value={text} onChange={(event) => { setText(event.target.value) }} />
      <input className={css.input} maxLength={200} placeholder={t('feedback.note')} aria-label={t('feedback.note')} value={note} onChange={(event) => { setNote(event.target.value) }} />
      <div className={css.actions}>
        <Button kind="primary" busy={saving} disabled={text.trim() === ''} onClick={() => { void save() }}>{t('feedback.save')}</Button>
        <Button disabled={saving} onClick={close}>{t('feedback.cancel')}</Button>
      </div>
    </div>
  )
}

/**
 * Render the feedback card.
 * @param props - the state slice, the actions, and copy.
 */
export function FeedbackCard({ state, actions, t }: { state: MemoryState; actions: MemoryActions; t: Translate }): ReactNode {
  const [adding, setAdding] = useState(false)
  const items = state.view?.feedback ?? []
  return (
    <Card title={t('feedback.title')} id="feedback" {...items.length === 0 ? {} : { meta: t('pending.count', { count: items.length }) }}>
      <p className={css.sub}>{t('feedback.hint')}</p>
      {items.length === 0
        ? <p className={css.empty}>{t('feedback.empty')}</p>
        : (
          <ul className={css.list}>
            {items.map(item => <Verdict key={item.id} item={item} busy={state.busy.includes(item.id)} actions={actions} t={t} />)}
          </ul>
        )}
      {adding
        ? <AddForm actions={actions} close={() => { setAdding(false) }} t={t} />
        : <div className={css.actions}><Button onClick={() => { setAdding(true) }}>{t('feedback.add')}</Button></div>}
    </Card>
  )
}
