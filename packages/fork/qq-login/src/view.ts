/**
 * What the Host QQ route answers, shared by both halves as types and constants only (no Node imports: the browser
 * half reads this file too). The QR code arrives already encoded as a module matrix, so the browser draws it
 * without a QR library and without ever seeing NapCat's link. The observer's connection and login states are the QQ
 * package's own types, imported type-only from its `./status` subpath.
 */

import type { QqConnection, QqLoginState } from '@deepseek-ai/dsh-qq/status'

export type { QqConnection, QqLoginState }

/** Absolute Host registration path of the QQ status route (GET). */
export const QQ_PATH = '/api/qq'
/** Absolute Host registration path of the fresh-code action (POST). */
export const QQ_REFRESH_PATH = '/api/qq.refresh'
/** Document-relative form of {@link QQ_PATH}, without the leading slash. */
export const QQ_ROUTE = QQ_PATH.slice(1)
/** Document-relative form of {@link QQ_REFRESH_PATH}, without the leading slash. */
export const QQ_REFRESH_ROUTE = QQ_REFRESH_PATH.slice(1)

/** How many unrecorded groups the answer offers as candidates. */
export const QQ_GROUP_CANDIDATES = 60

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

/** What `GET /api/qq` answers. */
export interface QqPanel {
  /** When the Host built this answer. */
  readonly at: number
  readonly connection: QqConnection
  readonly login: QqLogin
  /** How many groups the observer records (from its configuration). */
  readonly groupsRecorded: number
  /**
   * The groups the account is in (every recorded one, and the busiest {@link QQ_GROUP_CANDIDATES} of the others) for the
   * whitelist card; the list itself is edited through the plugin-settings form of the `qq` entry.
   */
  readonly groups: readonly QqGroup[]
}

/** What `POST /api/qq.refresh` answers: the panel after asking NapCat for a fresh code. */
export interface QqRefreshAnswer extends QqPanel {
  /** False when no fresh code was asked for. */
  readonly refreshed: boolean
  /** Why not: QQ is logged in or just was, a code was asked for a moment ago, NapCat refused, or the door is unreachable. */
  readonly reason: 'logged-in' | 'recently-logged-in' | 'too-soon' | 'napcat-refused' | 'unreachable' | null
}
