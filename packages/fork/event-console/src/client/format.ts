/** Time and duration text shared by the sections. */

import type { StatusLine } from '@deepseek-ai/dsh-settings-kit/client'
import type { ConsoleKey } from './locales.ts'

/** The `t` the settings shell delivers, narrowed to this namespace. */
export type Translate = (key: ConsoleKey, params?: Record<string, string | number>) => string

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * `HH:mm:ss` in the browser's time zone.
 * @param at - epoch milliseconds.
 * @returns the clock text.
 */
export function clock(at: number): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * `MM-DD HH:mm` short date and time in the browser's zone.
 * @param at - epoch milliseconds.
 * @returns the stamp text.
 */
export function stamp(at: number): string {
  const date = new Date(at)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * How long ago.
 * @param at - past time.
 * @param now - current time.
 * @param t - copy.
 * @returns for example `5 min ago`.
 */
export function ago(at: number, now: number, t: Translate): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return t('common.ago.seconds', { n: seconds })
  if (seconds < 3600) return t('common.ago.minutes', { n: Math.floor(seconds / 60) })
  if (seconds < 86_400) return t('common.ago.hours', { n: Math.floor(seconds / 3600) })
  return t('common.ago.days', { n: Math.floor(seconds / 86_400) })
}

/**
 * How long until.
 * @param at - future time.
 * @param now - current time.
 * @param t - copy.
 * @returns for example `in 5 min`; a time already past reads as `in 0 min`.
 */
export function until(at: number, now: number, t: Translate): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 60) return t('common.in.minutes', { n: minutes })
  if (minutes < 1440) return t('common.in.hours', { n: Math.floor(minutes / 60) })
  return t('common.in.days', { n: Math.floor(minutes / 1440) })
}

/**
 * A span of seconds.
 * @param seconds - length.
 * @param t - copy.
 * @returns for example `1 d 1 h`.
 */
export function duration(seconds: number, t: Translate): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 1440) return t('duration.days', { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60) })
  if (minutes >= 60) return t('duration.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
  return t('duration.minutes', { minutes })
}

/**
 * The status line of a section over one resource: loading until the first read settles, failed while no read brought
 * data, then the time the data was read, stale while the last read failed.
 * @param state - the read state and the data, which carries its own reading time.
 * @param t - copy.
 * @returns the dot's tone and the text.
 */
export function resourceStatus(
  state: { readonly checkedAt: number | null; readonly stale: boolean; readonly data: { readonly checkedAt: number } | null },
  t: Translate,
): StatusLine {
  const view = state.data
  const tone = state.checkedAt === null ? 'loading' : state.stale ? 'stale' : 'live'
  const text = state.checkedAt === null
    ? t('status.loading')
    : view === null
      ? t('status.failed')
      : state.stale ? t('status.stale', { time: clock(view.checkedAt) }) : t('status.live', { time: clock(view.checkedAt) })
  return { tone, text }
}
