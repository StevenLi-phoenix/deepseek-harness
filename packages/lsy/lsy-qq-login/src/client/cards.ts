/**
 * What the QQ section shows, as pure functions over the Host's panel: the one-glance headline (the answer to "is QQ
 * working, and if not, what do I do"), the connection detail rows, the status line, the QR drawing path, and the
 * formatting they share.
 */

import type { QqPanel, QqQrMatrix } from '../view.ts'
import type { QqKey } from './locales.ts'
import type { QqState } from './qq.ts'

/** The translate seat this module formats with. */
export type Translate = (key: QqKey, params?: Record<string, string | number>) => string

/** How the headline reads: `ok` green, `action` blue (the owner has something to do), `wait` amber, `bad` red. */
export type Tone = 'ok' | 'action' | 'wait' | 'bad'

/** The headline over the cards. */
export interface Headline {
  /** Which situation this is; the section shows the QR card for `scan` only. */
  readonly kind: 'connected' | 'connecting' | 'scan' | 'scanned' | 'logging-in' | 'preparing' | 'offline' | 'restarting' | 'unknown'
    | 'napcat-down' | 'door-down' | 'door-denied' | 'door-invalid' | 'no-token' | 'disconnected' | 'recorder-down' | 'protocol-mismatch'
  readonly tone: Tone
  readonly text: string
  readonly detail: string
}

/** One row of the connection card. */
export interface DetailRow {
  readonly key: string
  readonly label: string
  readonly value: string
  /** Render the value in a monospace face (raw error text). */
  readonly code?: boolean
}

/** The line above the cards. */
export interface StatusLine {
  readonly text: string
  readonly tone: 'loading' | 'live' | 'stale'
}

const TONES: Record<Headline['kind'], Tone> = {
  'connected': 'ok',
  'connecting': 'wait',
  'scan': 'action',
  'scanned': 'action',
  'logging-in': 'wait',
  'preparing': 'wait',
  'offline': 'bad',
  'restarting': 'wait',
  'unknown': 'bad',
  'napcat-down': 'bad',
  'door-down': 'bad',
  'door-denied': 'bad',
  'door-invalid': 'bad',
  'no-token': 'bad',
  'disconnected': 'bad',
  'recorder-down': 'bad',
  'protocol-mismatch': 'bad',
}

/**
 * Format a span as a coarse duration.
 * @param seconds - a span; negative counts as 0.
 * @param t - translate seat.
 * @returns days and hours, hours and minutes, or minutes.
 */
export function formatDuration(seconds: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return t('duration.days', { days, hours: hours % 24 })
  if (hours > 0) return t('duration.hours', { hours, minutes: minutes % 60 })
  return t('duration.minutes', { minutes })
}

const two = (value: number): string => String(value).padStart(2, '0')

/**
 * Format a time of day with seconds.
 * @param at - epoch milliseconds.
 * @returns local `HH:MM:SS`.
 */
export function clock(at: number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(two).join(':')
}

/**
 * Format when something happened, leaving the date out for today.
 * @param at - epoch milliseconds, or null.
 * @param now - the current time, to leave the date out for today.
 * @param t - translate seat.
 * @returns local `HH:MM` for today, `MM-DD HH:MM` otherwise; the unknown mark for null.
 */
export function stamp(at: number | null, now: number, t: Translate): string {
  if (at === null) return t('value.unknown')
  const date = new Date(at)
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`
  return date.toDateString() === new Date(now).toDateString() ? time : `${two(date.getMonth() + 1)}-${two(date.getDate())} ${time}`
}

/** How the account is named: the nickname with the number, or the number alone. */
function account(panel: QqPanel): string {
  const uin = panel.login.uin ?? panel.connection.selfId
  if (uin === null) return '—'
  return panel.login.nickname === null ? uin : `${panel.login.nickname} (${uin})`
}

/**
 * Decide the headline. The observer's own connection wins when it is up; otherwise NapCat's login says what to do,
 * and when the login door cannot answer, the headline says how to bring it back.
 * @param panel - the Host's answer.
 * @param now - the current time.
 * @param t - translate seat.
 * @returns the situation, its tone, and its two lines of copy.
 */
export function headline(panel: QqPanel, now: number, t: Translate): Headline {
  const { connection, login } = panel
  const since = stamp(connection.since, now, t)
  const make = (kind: Headline['kind'], params: Record<string, string | number> = {}): Headline => ({
    kind, tone: TONES[kind], text: t(`head.${kind}`, params), detail: t(`head.${kind}.detail`, params),
  })
  // Without the recorder nothing is known about QQ: the door and the socket are the recorder's to read.
  if (connection.state === 'recorder-down') return make('recorder-down')
  if (connection.state === 'protocol-mismatch') return make('protocol-mismatch')
  if (connection.state === 'connected') {
    return make('connected', { account: account(panel), duration: formatDuration(connection.since === null ? 0 : (now - connection.since) / 1000, t) })
  }
  if (connection.state === 'waiting-token') return make('no-token')
  if (login.door === 'ok') {
    switch (login.state) {
      case 'online': return make('connecting', { account: account(panel), attempt: connection.attempt + 1 })
      case 'qr': return make('scan')
      case 'scanned': return make('scanned')
      case 'logging-in': return make('logging-in')
      case 'preparing': return make('preparing')
      case 'offline': return make('offline')
      case 'restarting': return make('restarting')
      default: return make('unknown')
    }
  }
  if (login.door === 'napcat-down') return make('napcat-down')
  if (login.door === 'unreachable') return make('door-down')
  if (login.door === 'unauthorized') return make('door-denied')
  if (login.door === 'invalid') return make('door-invalid')
  return make('disconnected', { attempt: connection.attempt, since })
}

/**
 * Build the rows of the connection card.
 * @param panel - the Host's answer.
 * @param now - the current time.
 * @param t - translate seat.
 * @returns the rows of the connection card.
 */
export function detailRows(panel: QqPanel, now: number, t: Translate): DetailRow[] {
  const { connection, login } = panel
  const since = stamp(connection.since, now, t)
  const rows: DetailRow[] = [{
    key: 'connection',
    label: t('detail.connection'),
    value: t(`detail.connection.${connection.state}`, { attempt: connection.attempt, since }),
  }]
  rows.push({
    key: 'login',
    label: t('detail.login'),
    value: login.door !== 'ok' || login.state === null
      ? t('detail.login.unavailable')
      : login.state === 'online' ? t('detail.login.online', { account: account(panel) }) : t(`detail.login.${login.state}`),
  })
  rows.push({ key: 'groups', label: t('detail.groups'), value: t('detail.groups.value', { count: panel.groupsRecorded }) })
  if (connection.state !== 'connected' && connection.lastError !== null) {
    rows.push({ key: 'error', label: t('detail.error'), value: connection.lastError, code: true })
  }
  return rows
}

/**
 * Describe how current the shown answer is.
 * @param state - what the store holds.
 * @param t - translate seat.
 * @returns when the shown answer was built, and whether it is current.
 */
export function statusLine(state: QqState, t: Translate): StatusLine {
  if (state.panel === null) return state.stale ? { text: t('status.failed'), tone: 'stale' } : { text: t('status.loading'), tone: 'loading' }
  const time = clock(state.panel.at)
  return state.stale ? { text: t('status.stale', { time }), tone: 'stale' } : { text: t('status.live', { time }), tone: 'live' }
}

/** The quiet zone around a QR code, in modules (the standard asks for four; two scans reliably on screens). */
export const QUIET_ZONE = 2

/**
 * Turn a module matrix into one SVG path: a horizontal bar per run of dark modules.
 * @param matrix - the Host's matrix.
 * @returns the viewBox (with the quiet zone) and the path of the dark modules; null for a matrix that is not square 0/1 rows.
 */
export function qrPath(matrix: QqQrMatrix): { viewBox: string; d: string } | null {
  const { size, rows } = matrix
  if (!Number.isInteger(size) || size < 1 || size > 177 || rows.length !== size) return null
  if (rows.some(row => !/^[01]*$/.test(row) || row.length !== size)) return null
  const parts: string[] = []
  rows.forEach((row, y) => {
    for (const run of row.matchAll(/1+/g)) parts.push(`M${run.index + QUIET_ZONE} ${y + QUIET_ZONE}h${run[0].length}v1h-${run[0].length}z`)
  })
  const full = size + QUIET_ZONE * 2
  return { viewBox: `0 0 ${full} ${full}`, d: parts.join('') }
}
