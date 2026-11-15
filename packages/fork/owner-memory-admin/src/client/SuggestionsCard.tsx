/**
 * The curation panel: the merges the Host proposes and the entries whose subject looks over, one item at a time,
 * each with accept and reject. Accepting a merge opens the merge preview; accepting a stale entry opens the erase
 * preview; rejecting only sets the item aside for this visit. Nothing is written until the owner confirms.
 */

import type { ReactNode } from 'react'
import type { CurationView, SuggestionView } from '../view.ts'
import { dismissKey, suggestionKey } from './filter.ts'
import type { MemoryActions, MemoryState } from './memory.ts'
import type { MemoryKey } from './locales.ts'
import { Button, Card, Tag, type Translate } from './parts.tsx'
import css from './Memory.module.css'

/** The copy key of each reason. */
const REASON: Record<SuggestionView['reason'], MemoryKey> = {
  'duplicate': 'suggest.reason.duplicate',
  'expired-date': 'suggest.reason.expired-date',
  'finished-term': 'suggest.reason.finished-term',
}

function SuggestionRow({ item, actions, t }: { item: SuggestionView; actions: MemoryActions; t: Translate }): ReactNode {
  return (
    <li className={css.item} data-suggestion={item.key}>
      <div className={css.itemHead}>
        <Tag tone={item.kind === 'stale' ? 'warn' : undefined}>{t(REASON[item.reason])}</Tag>
        {item.kind === 'merge' ? <Tag>{t('dupes.members', { count: item.ids.length })}</Tag> : null}
        <Tag>{t(`category.${item.category}`)}</Tag>
        <span className={css.id}>{item.ids.join(' ')}</span>
      </div>
      <p className={css.text} data-proposal="">{item.text}</p>
      <div className={css.actions}>
        <Button
          kind="primary"
          onClick={() => {
            if (item.kind === 'merge') void actions.mergePreview(item.ids)
            else void actions.purgePreview(item.ids)
          }}
        >
          {t('suggest.accept')}
        </Button>
        <Button onClick={() => { actions.dismiss(suggestionKey(item)) }}>{t('suggest.reject')}</Button>
      </div>
    </li>
  )
}

/**
 * Render the curation suggestions the Host sent with its read.
 * @param props - the state slice, the actions, and copy.
 * @returns the card, or nothing on a Host that computes no curation.
 */
export function SuggestionsCard({ state, actions, t }: { state: MemoryState; actions: MemoryActions; t: Translate }): ReactNode {
  const curation: CurationView | undefined = state.view?.curation
  if (curation === undefined) return null
  const items = curation.suggestions.filter(item => !state.dismissed.includes(suggestionKey(item)))
  return (
    <Card title={t('suggest.title')} id="suggest" {...items.length === 0 ? {} : { meta: t('suggest.meta', { count: items.length }) }}>
      <p className={css.sub}>{t('suggest.hint')}</p>
      {items.length === 0
        ? <p className={css.empty}>{t('suggest.empty')}</p>
        : (
          <ul className={`${css.list} ${css.suggestList}`}>
            {items.map(item => <SuggestionRow key={item.key ?? dismissKey(item.kind, item.ids)} item={item} actions={actions} t={t} />)}
          </ul>
        )}
    </Card>
  )
}
