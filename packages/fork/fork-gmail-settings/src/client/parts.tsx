/** What every card of the Gmail section receives, and the small pieces they share. */

import type { ReactNode } from 'react'
import type { GmailAction, GmailView } from '../view.ts'
import { failureLine, type ActionFailure, type Translate } from './gmail.ts'
import css from './GmailSection.module.css'

/** The section's state and callbacks as every card reads them. */
export interface PartProps {
  readonly view: GmailView
  /** When the status was read; relative times count from it. */
  readonly at: number
  /** The control whose action is in flight. */
  readonly busy: string | null
  readonly failure: ActionFailure | null
  readonly t: Translate
  /** Post an action; resolves to whether the Host did it. */
  readonly act: (action: GmailAction, control?: string) => Promise<boolean>
  /** An instant in the browser's locale and zone. */
  readonly clock: (at: number) => string
}

/**
 * One labelled row of a definition list.
 * @param props - the label, the value, and an optional emphasis.
 * @returns the row.
 */
export function Field({ label, children, tone }: { label: string; children: ReactNode; tone?: 'bcc' | undefined }): ReactNode {
  return (
    <div className={css.field} data-tone={tone}>
      <dt className={css.fieldLabel}>{label}</dt>
      <dd className={css.fieldValue}>{children}</dd>
    </div>
  )
}

/**
 * The failure of one of the given controls, shown beside them; nothing for another control's failure.
 * @param props - the section's failure, the controls this place owns, and the copy.
 * @returns the line, or null.
 */
export function ActionError(
  { failure, controls, t }: { failure: ActionFailure | null; controls: readonly string[]; t: Translate },
): ReactNode {
  if (failure === null || !controls.includes(failure.control)) return null
  return <p className={css.error} role="alert">{failureLine(failure, t)}</p>
}

/**
 * Addresses as one line.
 * @param addresses - the addresses.
 * @returns them separated by commas.
 */
export function addressList(addresses: readonly string[]): string {
  return addresses.join(', ')
}
