/** The status line at the head of a polled Settings section. */

/** Copy keys the status line reads; `status.stale` and `status.live` get `{ time }`. */
export type StatusKey = 'status.failed' | 'status.loading' | 'status.stale' | 'status.live'

/** The tone of the status dot, which the section's stylesheet colours. */
export type StatusTone = 'live' | 'stale' | 'loading' | 'idle'

/** A status line: the dot's tone and the text beside it. */
export interface StatusLine {
  readonly tone: StatusTone
  readonly text: string
}

/** How a section words its status line. */
export interface StatusWording {
  /** The time of the data on screen as the text shows it. */
  readonly time: (ms: number) => string
  /** The dot's tone before the first answer. */
  readonly waiting: 'loading' | 'idle'
}

/**
 * The status line of a polled section.
 * @param shownAt - when the data on screen was read; null while there is none.
 * @param stale - whether the last read failed.
 * @param t - translate.
 * @param wording - the time format and the tone before the first answer.
 * @returns `status.loading` in the waiting tone or `status.failed` before any data, otherwise `status.stale` or
 *   `status.live` with the data's time.
 */
export function statusLine(
  shownAt: number | null,
  stale: boolean,
  t: (key: StatusKey, params?: Record<string, string>) => string,
  wording: StatusWording,
): StatusLine {
  if (shownAt === null) return stale ? { tone: 'stale', text: t('status.failed') } : { tone: wording.waiting, text: t('status.loading') }
  const time = wording.time(shownAt)
  return stale ? { tone: 'stale', text: t('status.stale', { time }) } : { tone: 'live', text: t('status.live', { time }) }
}
