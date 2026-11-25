/** Pure presentation helpers of the Bilibili account section: times and durations. */
import { minutesAgo } from '@deepseek-ai/dsh-settings-kit/client'
import type { BiliKey } from './locales.ts'

export { dateTime, stampTime } from '@deepseek-ai/dsh-settings-kit/client'

/** The section's `t`, narrowed to this namespace. */
export type Translate = (key: BiliKey, params?: Record<string, string | number>) => string

/**
 * How long ago, in the largest whole unit.
 * @param ms - the past instant.
 * @param now - the current instant.
 * @param t - translate.
 * @returns the translated text; "now" under one minute, never negative.
 */
export function agoText(ms: number, now: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  return minutes < 1 ? t('ago.now') : minutesAgo(minutes, t)
}

/**
 * Path data of a QR code: one unit square per dark module.
 * @param modules - rows of `0`/`1`.
 * @returns SVG path commands; empty when there are no dark modules.
 */
export function qrPath(modules: readonly string[]): string {
  let path = ''
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === '1') path += `M${x} ${y}h1v1h-1z`
    }
  })
  return path
}

/**
 * `m:ss` left until an instant, never negative.
 * @param until - the instant.
 * @param now - the current instant.
 * @returns the text, rounded up to whole seconds.
 */
export function countdown(until: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((until - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
