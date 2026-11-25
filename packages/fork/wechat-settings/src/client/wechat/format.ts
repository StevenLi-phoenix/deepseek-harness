/** Pure presentation helpers of the WeChat section: times and durations. */
import type { WechatKey } from './locales.ts'

export { agoText } from '../ago.ts'
export { dateTime, stampTime } from '@deepseek-ai/dsh-settings-kit/client'

/** The section's `t`, narrowed to this namespace. */
export type Translate = (key: WechatKey, params?: Record<string, string | number>) => string

/**
 * How long until, in the largest whole unit.
 * @param ms - the future instant.
 * @param now - the current instant.
 * @param t - translate.
 * @returns for example `5 h`.
 */
export function spanText(ms: number, now: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, ms - now) / 60_000)
  if (minutes < 1) return t('in.soon')
  if (minutes < 60) return t('in.minutes', { n: minutes })
  if (minutes < 2880) return t('in.hours', { n: Math.floor(minutes / 60) })
  return t('in.days', { n: Math.floor(minutes / 1440) })
}
