/** The refusal banner of the console's sections. */

import type { ReactNode } from 'react'
import type { Translate } from './format.ts'
import type { Notice } from './resource.ts'
import css from './Console.module.css'

/**
 * The last refused or failed action: its reason, its detail, and a button that dismisses it.
 * @param props - the notice, the dismiss callback, and translate.
 * @returns the banner, or nothing without a notice.
 */
export function FailureNotice({ failure, dismiss, t }: { failure: Notice | null; dismiss: () => void; t: Translate }): ReactNode {
  if (failure === null) return null
  return (
    <div className={css.notice} role="alert">
      <span>{t(`error.${failure.code}`)}{failure.detail === undefined ? '' : ` (${failure.detail})`}</span>
      <button type="button" className={css.button} onClick={dismiss}>{t('common.dismiss')}</button>
    </div>
  )
}
