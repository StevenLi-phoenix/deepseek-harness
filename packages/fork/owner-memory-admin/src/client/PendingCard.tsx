/**
 * The waiting-writes card: protected writes the agent made in a turn the owner did not start alone, held until
 * the owner answers. Answering removes the item at once; the Host's refusal brings it back with the reason.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { PendingView } from '../view.ts'
import type { MemoryActions, MemoryState } from './memory.ts'
import { Button, Card, shortSession, Tag, type Translate } from './parts.tsx'
import css from './Memory.module.css'

/** Milliseconds a bulk button stays armed for its second click. */
const ARM_MS = 4000

type Bulk = 'approve' | 'discard'

function PendingItem({ item, busy, actions, t }: { item: PendingView; busy: boolean; actions: MemoryActions; t: Translate }): ReactNode {
  return (
    <li className={css.item} data-pending={item.id} data-tainted={item.tainted ? '' : undefined}>
      <div className={css.itemHead}>
        <Tag>{t(`category.${item.category}`)}</Tag>
        {item.tainted ? <Tag tone="warn">{t('pending.tainted')}</Tag> : <Tag>{t(`source.${item.source}`)}</Tag>}
        {item.op === 'replace' && item.target !== undefined ? <Tag>{t('pending.replace', { id: item.target })}</Tag> : null}
        <span className={css.id}>{item.id}</span>
      </div>
      <p className={css.text}>{item.text}</p>
      {item.replaces === undefined ? null : <p className={css.sub}>{t('pending.replaces', { text: item.replaces })}</p>}
      <div className={css.itemMeta}>
        {item.session === undefined ? null : <span>{t('meta.session', { session: shortSession(item.session) })}</span>}
        {item.origin === undefined ? null : <span>{t('meta.origin', { origin: item.origin })}</span>}
        <span>{t('pending.expires', { date: item.expiresOn })}</span>
      </div>
      <div className={css.actions}>
        <Button kind="primary" busy={busy} onClick={() => { void actions.review('approve', [item.id]) }}>{t('pending.approve')}</Button>
        <Button busy={busy} onClick={() => { void actions.review('discard', [item.id]) }}>{t('pending.discard')}</Button>
      </div>
    </li>
  )
}

/**
 * Render the waiting writes.
 * @param props - the state slice, the actions, and copy.
 */
export function PendingCard({ state, actions, t }: { state: MemoryState; actions: MemoryActions; t: Translate }): ReactNode {
  const items = (state.view?.pending ?? []).filter(item => !state.hiding.includes(item.id))
  const [armed, setArmed] = useState<Bulk | null>(null)
  // A bulk button armed for one list does not stay armed for another.
  useEffect(() => {
    if (armed === null) return undefined
    const timer = setTimeout(() => { setArmed(null) }, ARM_MS)
    return () => { clearTimeout(timer) }
  }, [armed, items.length])
  const bulk = (op: Bulk): void => {
    if (armed !== op) {
      setArmed(op)
      return
    }
    setArmed(null)
    void actions.review(op, items.map(item => item.id))
  }
  return (
    <Card title={t('pending.title')} id="pending" {...items.length === 0 ? {} : { meta: t('pending.count', { count: items.length }) }}>
      {items.length === 0
        ? <p className={css.empty}>{t('pending.empty')}</p>
        : (
          <>
            <p className={css.sub}>{t('pending.hint')}</p>
            <ul className={css.list}>
              {items.map(item => <PendingItem key={item.id} item={item} busy={state.busy.includes(item.id)} actions={actions} t={t} />)}
            </ul>
            {items.length > 1
              ? (
                <div className={css.actions}>
                  <Button kind="primary" onClick={() => { bulk('approve') }}>
                    {armed === 'approve' ? t('pending.sure', { count: items.length }) : t('pending.approveAll')}
                  </Button>
                  <Button onClick={() => { bulk('discard') }}>
                    {armed === 'discard' ? t('pending.sure', { count: items.length }) : t('pending.discardAll')}
                  </Button>
                </div>
              )
              : null}
          </>
        )}
    </Card>
  )
}
