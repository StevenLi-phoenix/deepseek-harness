/**
 * What the Host QQ route answers, shared by both halves as types and constants only (no Node imports: the browser
 * half reads this file too). The QR code arrives already encoded as a module matrix, so the browser draws it
 * without a QR library and without ever seeing NapCat's link.
 */

/** Absolute Host registration path of the QQ status route (GET). */
export const QQ_PATH = '/api/lsy.qq'
/** Absolute Host registration path of the fresh-code action (POST). */
export const QQ_REFRESH_PATH = '/api/lsy.qq.refresh'
/** Document-relative form of {@link QQ_PATH}, without the leading slash. */
export const QQ_ROUTE = QQ_PATH.slice(1)
/** Document-relative form of {@link QQ_REFRESH_PATH}, without the leading slash. */
export const QQ_REFRESH_ROUTE = QQ_REFRESH_PATH.slice(1)

/** How many unrecorded groups the answer offers as candidates. */
export const QQ_GROUP_CANDIDATES = 60

/** The observer's connection to the protocol end (NapCat's OneBot server). */
export interface QqConnection {
  /**
   * `connected`: the socket is up. `reconnecting`: it is down and being retried. `waiting-token`: the access token is
   * not set, so no attempt is made. `starting`: the first attempt has not settled. `recorder-down`: the qq-recorder
   * service does not answer. `protocol-mismatch`: it speaks another protocol version than DSH. `unknown`: a state only a
   * newer recorder knows.
   */
  readonly state: 'connected' | 'reconnecting' | 'waiting-token' | 'starting' | 'recorder-down' | 'protocol-mismatch' | 'unknown'
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
 * completing it. `preparing`: a code is being made. `restarting`: QQ is reconnecting to Tencent's servers
 * (NapCat's `reconnecting` phase, which follows a scan for a minute or more).
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
   * `disabled`: `login.enabled` is false. `recorder-down`: the recorder, which asks the door, did not answer.
   */
  readonly door: 'ok' | 'napcat-down' | 'unreachable' | 'unauthorized' | 'invalid' | 'disabled' | 'recorder-down'
  readonly state: QqLoginState | null
  readonly uin: string | null
  readonly nickname: string | null
  /** NapCat's login error text, as the door trimmed it. */
  readonly error: string | null
  /** The code to scan; present only while `state` is `qr`. */
  readonly qr: QqQrMatrix | null
}

/** One group the account is in, as the whitelist offers it. */
export interface QqGroup {
  readonly groupId: string
  readonly name: string
  readonly memberCount: number | null
  /** Whether the group is on the observer's `groups` list. */
  readonly recorded: boolean
  /** Messages of an unrecorded group dropped since the observer started: a count, nothing of them is kept. */
  readonly seen: number
}

/** What `GET /api/lsy.qq` answers. */
export interface QqPanel {
  /** When the Host built this answer. */
  readonly at: number
  readonly connection: QqConnection
  readonly login: QqLogin
  /** How many groups the observer records (from its configuration). */
  readonly groupsRecorded: number
  /**
   * The groups the account is in (every recorded one, and the busiest {@link QQ_GROUP_CANDIDATES} of the others) for the
   * whitelist card; the list itself is edited through the plugin-settings form of the `lsy-qq` entry.
   */
  readonly groups: readonly QqGroup[]
}

/** What `POST /api/lsy.qq.refresh` answers: the panel after asking NapCat for a fresh code. */
export interface QqRefreshAnswer extends QqPanel {
  /** False when no fresh code was asked for. */
  readonly refreshed: boolean
  /** Why not: QQ is logged in or just was, a code was asked for a moment ago, NapCat refused, or the door is unreachable. */
  readonly reason: 'logged-in' | 'recently-logged-in' | 'too-soon' | 'napcat-refused' | 'unreachable' | null
}
