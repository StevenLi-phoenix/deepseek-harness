/**
 * What the Settings route answers and accepts, shared by both halves as types
 * and constants only. Nothing here can carry a cookie or token: the account's
 * state comes from bili-svc's `GET /v1/status`, which names accounts and
 * session states only.
 */

/** Session states bili-svc reports for an account. */
export const SESSION_STATES = ['ok', 'dead', 'missing', 'none'] as const
/** One of {@link SESSION_STATES}. */
export type SessionState = typeof SESSION_STATES[number]

/** The account card, read-only: bili-svc owns the session and its renewal. */
export interface AccountView {
  /** bili-svc's id of the agent's account (`account` in the configuration). */
  readonly account: string
  /**
   * `ok`, `dead` (Bilibili ended the session), `missing` (no readable session), `none` (bili-svc holds
   * none for this account), or `unreachable` (bili-svc did not answer, or does not list the account).
   */
  readonly session: SessionState | 'unreachable'
  readonly mid?: number
  readonly uname?: string
  /** Why the state is `unreachable`. */
  readonly error?: string
  /** When bili-svc was last asked. */
  readonly checkedAt: number
}

/** bili-svc's gate: `readonly` while its mode is not automatic or its brake is set, so actions are held. */
export interface GateView {
  readonly mode: string
  readonly readonly: boolean
}

/** Body of `GET api/bili` and of every `POST`. */
export interface BiliView {
  readonly account: AccountView
  /** bili-svc's gate, or null when it did not answer. */
  readonly gate: GateView | null
  /** The owner's main account, the only account whose messages the account answers; 0 while unset. */
  readonly ownerMid: number
  /** When the owner last set it in Settings, or null when it comes from the configuration or is unset. */
  readonly ownerUpdatedAt: number | null
  /** IANA zone of the journal and the daily limit, for showing times. */
  readonly timeZone: string
}

/** Body of `POST api/bili`. */
export type BiliAction = { readonly action: 'owner'; readonly mid: number }

/** Absolute Host registration path of the Settings route. */
export const BILI_PATH = '/api/bili'
/** Document-relative form the browser fetches. */
export const BILI_ROUTE = BILI_PATH.slice(1)
