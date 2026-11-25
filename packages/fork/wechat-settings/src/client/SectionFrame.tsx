/** What both sections of this package show around their cards. */

import { StatusHeader, stampTime, statusLine, type SectionClasses, type StatusKey } from '@deepseek-ai/dsh-settings-kit/client'
import type { ReactNode } from 'react'

/** What the frame reads of a section's state. */
export interface FrameState<View> {
  readonly view: View | null
  readonly checkedAt: number | null
  readonly stale: boolean
  readonly error: string | null
}

/**
 * The section around its cards: the status line, the last action's error, and the grid of cards once there is a view.
 * @param props - the section's classes (`section`, `error`, `grid`, and those of the status header), its label and
 *   state, the current instant, translate, and the cards for a view.
 * @returns the section.
 */
export function SectionFrame<View>({ css, label, state, now, t, cards }: {
  css: SectionClasses
  label: string
  state: FrameState<View>
  now: number
  t: (key: StatusKey | 'error.action', params?: Record<string, string>) => string
  cards: (view: View) => ReactNode
}): ReactNode {
  const { view } = state
  const status = statusLine(view === null ? null : state.checkedAt ?? now, state.stale, t, { time: stampTime, waiting: 'idle' })
  return (
    <section className={css.section} aria-label={label} data-stale={state.stale ? '' : undefined}>
      <StatusHeader css={css} line={status} />
      {state.error === null ? null : <div className={css.error} role="alert">{t('error.action', { error: state.error })}</div>}
      {view === null ? null : <div className={css.grid}>{cards(view)}</div>}
    </section>
  )
}
