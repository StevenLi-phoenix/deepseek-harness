/**
 * What the Host QQ route answers, shared by both halves as types and constants only (no Node imports: the browser
 * half reads this file too). The QR code arrives already encoded as a module matrix, so the browser draws it
 * without a QR library and without ever seeing NapCat's link.
 */

/** Absolute Host registration path of the QQ status route (GET) and its refresh action (POST). */
export const QQ_PATH = '/api/fork.qq'
export const QQ_REFRESH_PATH = '/api/fork.qq.refresh'
/** Document-relative forms the browser fetches. */
export const QQ_ROUTE = QQ_PATH.slice(1)
export const QQ_REFRESH_ROUTE = QQ_REFRESH_PATH.slice(1)

/** The observer's connection to the protocol end (NapCat's OneBot server). */
export interface QqConnection {
  /**
   * `connected`: the socket is up. `reconnecting`: it is down and being retried. `waiting-token`: the access token is
   * not set, so no attempt is made. `starting`: the first attempt has not settled.
   */
  readonly state: 'connected' | 'reconnecting' | 'waiting-token' | 'starting'
  /** When the state began, in epoch milliseconds; null while starting. */
  readonly since: number | null
  /** Failed attempts in a row (0 while connected). */
  readonly attempt: number
  /** Why the last attempt failed; null when none did. */
  readonly lastError: string | null
  /** The account the observer is logged in as; null while not connected. */
  readonly selfId: string | null
}

/**
 * NapCat's own login, as the login door reports it. `online`: logged in. `offline`: the session ended and NapCat
 * wants a new login. `qr`: a code is waiting for a scan. `scanned`/`logging-in`: the scan was taken and QQ is
 * completing it. `preparing`: a code is being made. `restarting`: NapCat's login service is restarting.
 */
export type QqLoginState = 'online' | 'offline' | 'qr' | 'scanned' | 'logging-in' | 'preparing' | 'restarting' | 'unknown'

/** A QR code as a square module matrix: `rows[y][x]` is `'1'` for a dark module. */
export interface QqQrMatrix {
  readonly size: number
  readonly rows: readonly string[]
}

/** The login half of the answer. */
export interface QqLogin {
  /**
   * `ok`: NapCat answered. `napcat-down`: the door is up but NapCat's WebUI is not. `unreachable`: the door is not
   * running. `unauthorized`: the door refused our token. `invalid`: the door answered something unexpected.
   * `disabled`: `login.enabled` is false.
   */
  readonly door: 'ok' | 'napcat-down' | 'unreachable' | 'unauthorized' | 'invalid' | 'disabled'
  readonly state: QqLoginState | null
  readonly uin: string | null
  readonly nickname: string | null
  /** NapCat's login error text, as the door trimmed it. */
  readonly error: string | null
  /** The code to scan; present only while `state` is `qr`. */
  readonly qr: QqQrMatrix | null
}

/** What `GET /api/fork.qq` answers. */
export interface QqPanel {
  /** When the Host built this answer. */
  readonly at: number
  readonly connection: QqConnection
  readonly login: QqLogin
  /** How many groups the observer records (from its configuration). */
  readonly groupsRecorded: number
}

/** What `POST /api/fork.qq.refresh` answers: the panel after asking NapCat for a fresh code. */
export interface QqRefreshAnswer extends QqPanel {
  /** False when the door declined (too soon, NapCat refused, or the door is unreachable). */
  readonly refreshed: boolean
}
