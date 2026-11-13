/**
 * The content guard's card: how many texts it checked and refused in the last 24 hours, by rule. It shows rule names
 * and numbers the Host sends and nothing else; the guard never reports a text.
 */

import type { ReactNode } from 'react'
import type { MemoryState } from './memory.ts'
import { Card, Tag, when, type Translate } from './parts.tsx'
import css from './Memory.module.css'

/**
 * Render the card; nothing while the Host has no guard.
 * @param props - the store state and the translate seat.
 * @returns the card, or null.
 */
export function GuardCard({ state, t }: { state: MemoryState; t: Translate }): ReactNode {
  const { guard } = state
  if (guard === null) return null
  const rules = Object.entries(guard.byRule).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  return (
    <Card title={t('guard.title')} meta={t('guard.window')} id="guard">
      <p className={css.sub}>{t('guard.summary', { checked: guard.checked, rejected: guard.rejected })}</p>
      {rules.length === 0
        ? <p className={css.empty}>{t('guard.none')}</p>
        : (
          <ul className={css.list}>
            {rules.map(([rule, count]) => (
              <li key={rule} className={css.itemHead} data-rule={rule}>
                <Tag tone="warn">{rule}</Tag>
                <span className={css.when}>{count}</span>
              </li>
            ))}
          </ul>
        )}
      {guard.lastError === null
        ? null
        : <p className={css.sub} role="status">{t('guard.error', { rule: guard.lastError.rule, time: when(new Date(guard.lastError.at).toISOString()), message: guard.lastError.message })}</p>}
      <p className={css.sub}>{t('guard.hint')}</p>
    </Card>
  )
}
