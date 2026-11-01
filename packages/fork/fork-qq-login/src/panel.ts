/**
 * Build the QQ section's answer from the QQ observer: its connection, NapCat's login reading, and the login QR
 * code as a module matrix. NapCat's link never leaves the Host; the browser gets only the drawing.
 */

import { encode } from 'uqr'
import { QQ_GROUP_CANDIDATES, type QqConnection, type QqGroup, type QqLogin, type QqPanel, type QqQrMatrix, type QqRefreshAnswer } from './view.ts'

/** The slice of the QQ observer (`ctx.forkQq`) this section reads. */
export interface QqSource {
  connectionStatus(): QqConnection
  loginStatus(options?: { fresh?: boolean }): Promise<Omit<QqLogin, 'qr'> & { qrUrl: string | null }>
  refreshLogin(): Promise<{ login: Omit<QqLogin, 'qr'> & { qrUrl: string | null }; refreshed: boolean }>
  recordedGroups(): number
  groupChoices(): readonly QqGroup[]
}

/**
 * Encode a login link as a square module matrix.
 * @param link - the link NapCat's code stands for.
 * @returns the matrix, or null when it cannot be encoded.
 */
export function qrMatrix(link: string): QqQrMatrix | null {
  try {
    const { size, data } = encode(link, { ecc: 'M' })
    return { size, rows: data.map(row => row.map(dark => (dark ? '1' : '0')).join('')) }
  } catch {
    return null
  }
}

/** Every recorded group, and the busiest of the others, so the answer stays small for an account in hundreds of groups. */
function groupsOf(source: QqSource): QqGroup[] {
  const all = source.groupChoices()
  return [...all.filter(group => group.recorded), ...all.filter(group => !group.recorded).slice(0, QQ_GROUP_CANDIDATES)]
}

function toLogin(reading: Omit<QqLogin, 'qr'> & { qrUrl: string | null }): QqLogin {
  const { qrUrl, ...rest } = reading
  return { ...rest, qr: qrUrl === null ? null : qrMatrix(qrUrl) }
}

/**
 * @param source - the QQ observer.
 * @param options - `fresh` skips the observer's shared reading of the last 1.5 s.
 * @param now - clock, replaceable in tests.
 * @returns what `GET /api/fork.qq` answers.
 */
export async function buildPanel(source: QqSource, options: { fresh?: boolean } = {}, now: () => number = Date.now): Promise<QqPanel> {
  const login = toLogin(await source.loginStatus(options))
  return { at: now(), connection: source.connectionStatus(), login, groupsRecorded: source.recordedGroups(), groups: groupsOf(source) }
}

/**
 * Ask NapCat for a fresh login code.
 * @param source - the QQ observer.
 * @param now - clock, replaceable in tests.
 * @returns what `POST /api/fork.qq.refresh` answers.
 */
export async function buildRefresh(source: QqSource, now: () => number = Date.now): Promise<QqRefreshAnswer> {
  const { login, refreshed } = await source.refreshLogin()
  return {
    at: now(),
    connection: source.connectionStatus(),
    login: toLogin(login),
    groupsRecorded: source.recordedGroups(),
    groups: groupsOf(source),
    refreshed,
  }
}
