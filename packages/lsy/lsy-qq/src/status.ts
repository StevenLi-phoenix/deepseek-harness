/**
 * What the observer reports about itself for a Settings page: its connection to the protocol end (NapCat's OneBot
 * server, seen through the qq-recorder service) and NapCat's own QQ login as the login door sees it. Plain data; the
 * browser-facing shape is built from these by `@deepseek-ai/dsh-lsy-qq-login`.
 */

/** The observer's connection to the protocol end, through the recorder. */
export interface QqConnection {
  /**
   * `connected`: the socket is up. `reconnecting`: it is down and being retried. `waiting-token`: the access token is
   * not set, so no attempt is made. `starting`: the first attempt has not settled. `recorder-down`: the qq-recorder
   * service does not answer, so nothing is known about QQ. `protocol-mismatch`: the recorder speaks another major
   * protocol version. `unknown`: a state only a newer recorder knows.
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
 * NapCat's own login. `online`: logged in. `offline`: the session ended and NapCat wants a new login. `qr`: a code is
 * waiting for a scan. `scanned`/`logging-in`: the scan was taken and QQ is completing it. `preparing`: a code is
 * being made. `restarting`: QQ is reconnecting to Tencent's servers
 * (NapCat's `reconnecting` phase, which follows a scan for a minute or more).
 */
export type QqLoginState = 'online' | 'offline' | 'qr' | 'scanned' | 'logging-in' | 'preparing' | 'restarting' | 'unknown'

/** Why the login door did not ask NapCat for a fresh code. */
export type RefreshRefusal = 'logged-in' | 'recently-logged-in' | 'too-soon' | 'napcat-refused' | 'unreachable'

/** What asking the login door came to, for one reading of NapCat's login. */
export interface QqLoginReading {
  /**
   * `ok`: NapCat answered. `napcat-down`: the door is up but NapCat's WebUI is not. `unreachable`: the door is not
   * running. `unauthorized`: the door refused our token. `invalid`: the door answered something unexpected.
   * `disabled`: `login.enabled` is false. `recorder-down`: the qq-recorder, which asks the door, did not answer.
   */
  readonly door: 'ok' | 'napcat-down' | 'unreachable' | 'unauthorized' | 'invalid' | 'disabled' | 'recorder-down'
  readonly state: QqLoginState | null
  readonly uin: string | null
  readonly nickname: string | null
  /** NapCat's login error text, as the door trimmed it. */
  readonly error: string | null
  /** The https link the waiting QR code stands for; present only while `state` is `qr`. Sensitive: never log it. */
  readonly qrUrl: string | null
}
