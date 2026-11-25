/** How long ago, as both sections of this package print it. */

import { minutesAgo } from '@deepseek-ai/dsh-settings-kit/client'

/** Copy keys {@link agoText} reads; each but `ago.now` gets `{ n }`. */
export type AgoKey = 'ago.now' | 'ago.seconds' | 'ago.minutes' | 'ago.hours' | 'ago.days'

/**
 * How long ago, in the largest whole unit.
 * @param ms - the past instant.
 * @param now - the current instant.
 * @param t - translate.
 * @returns for example `3 min ago`; "now" under five seconds, never negative.
 */
export function agoText(ms: number, now: number, t: (key: AgoKey, params?: Record<string, number>) => string): string {
  const seconds = Math.floor(Math.max(0, now - ms) / 1000)
  if (seconds < 5) return t('ago.now')
  if (seconds < 60) return t('ago.seconds', { n: seconds })
  return minutesAgo(Math.floor(seconds / 60), t)
}
