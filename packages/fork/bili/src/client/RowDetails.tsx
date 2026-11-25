/** The details of an opened row in the ledger and share cards of the Bilibili section. */

import type { ReactNode } from 'react'
import css from './BiliAccount.module.css'

/**
 * The label and value pairs of an opened row as plain text, without the empty ones.
 * @param props - the pairs, in order.
 * @returns the list, or nothing when every value is empty.
 */
export function RowDetails({ details }: { details: ReadonlyArray<readonly [string, string]> }): ReactNode {
  const present = details.filter(([, value]) => value !== '')
  if (present.length === 0) return null
  return (
    <dl className={css.rowDetails}>
      {present.map(([label, value]) => (
        <div key={label} className={css.rowDetail}>
          <dt className={css.meta}>{label}</dt>
          <dd className={css.plain}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
