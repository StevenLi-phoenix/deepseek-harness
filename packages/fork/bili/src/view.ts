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

/** Counters of one day's limited actions: comments and direct messages. */
export interface UsageCounts {
  readonly comment: number
  readonly dm: number
  /** Messages to the owner on the account's own initiative (the daily share); null from a bili-svc before 0.5.0. */
  readonly share: number | null
}

/** The risk brake bili-svc set after Bilibili answered with risk control (or the owner pulled it). */
export interface BrakeView {
  /** Short reason code, bounded. */
  readonly reason: string
  /** bili-svc's words about it, bounded. */
  readonly detail: string
  /** When it was set, Unix epoch milliseconds; null when bili-svc gave none. */
  readonly ts: number | null
}

/** bili-svc's gate: `readonly` while its mode is not automatic or its brake is set, so actions are held. */
export interface GateView {
  readonly mode: string
  readonly readonly: boolean
  /** The brake, or null while none is set (and for a token that cannot see it). */
  readonly brake: BrakeView | null
  /** Actions used today; null when bili-svc did not report them. */
  readonly used: UsageCounts | null
  /** Daily caps; null when bili-svc did not report them. */
  readonly caps: UsageCounts | null
}

/** Who renews an account's session. */
export const REFRESH_MODES = ['owner', 'external', 'none'] as const
/** One of {@link REFRESH_MODES}. */
export type RefreshMode = typeof REFRESH_MODES[number]

/** One account bili-svc holds, as the Settings cards show it. */
export interface ManagedAccount {
  readonly id: string
  readonly mid: number
  readonly display: string
  /** `ok`, `dead`, `missing`, `none`, as bili-svc reports. */
  readonly session: SessionState
  /**
   * `owner` (bili-svc signs in and renews it), `external` (another service owns the session, bili-svc only reads it),
   * `none` (no renewal), or null when bili-svc's answer did not say (no manage token).
   */
  readonly refreshMode: RefreshMode | null
  /** Whether Settings may sign this account in (bili-svc owns its session). */
  readonly login: boolean
  /** Whether this is the agent's own account (`account` in the configuration). */
  readonly agent: boolean
  /** Unix epoch milliseconds of the last renewal, or null. */
  readonly refreshedAt: number | null
  /** Unix epoch milliseconds the session was imported, or null. */
  readonly importedAt: number | null
  /** Why the session died, bounded; null while it lives. */
  readonly deadReason: string | null
}

/** One row of bili-svc's action ledger. Every text is third-party-ish: render it as plain text. */
export interface LedgerRow {
  /** Unix epoch milliseconds; null when bili-svc gave none. */
  readonly ts: number | null
  readonly kind: string
  readonly target: string
  readonly state: string
  readonly reason: string
  readonly caller: string
  /** The drafted text, bounded. */
  readonly draft: string
  /** The classifier's verdict, bounded. */
  readonly verdict: string
}

/** The recent ledger and its summary counters. */
export interface LedgerView {
  readonly rows: readonly LedgerRow[]
  /** Flat counters from bili-svc's day summary (`comment.states.sent` and the like), at most 24. */
  readonly summary: Readonly<Record<string, string | number>>
}

/** States of a QR sign-in attempt. */
export const LOGIN_STATES = ['waiting', 'scanned', 'expired', 'done', 'failed'] as const
/** One of {@link LOGIN_STATES}. */
export type LoginState = typeof LOGIN_STATES[number]

/** A QR sign-in in progress (or just finished) for one account; the key stays on the Host. */
export interface LoginView {
  readonly account: string
  readonly state: LoginState
  /** QR modules as rows of `0`/`1`, while the code can still be scanned. */
  readonly qr: readonly string[] | null
  /** When the code expires, Unix epoch milliseconds. */
  readonly expiresAt: number
  /** bili-svc's words for a failed attempt, bounded. */
  readonly message: string | null
}

/** What the last owner action did, on a `POST` answer only. */
export interface ActionResult {
  readonly action: BiliAction['action']
  readonly account: string | null
  /**
   * A short outcome word: `refreshed` or `unchanged` (refresh), `valid` or `invalid` (check), `released` or `none`
   * (brake), `auto` or `readonly` (mode), `started`, a QR state (poll), `cancelled`, `logged-out`, `ok`.
   */
  readonly outcome: string
  /** Days left of a session the check found valid, when bili-svc knew; otherwise null. */
  readonly days: number | null
}

/** How one daily share went: sent on Bilibili, sent to WeChat instead, nothing worth sending, not run in time, or failed. */
export const SHARE_OUTCOMES = ['sent', 'wechat', 'silent', 'missed', 'failed'] as const
/** One of {@link SHARE_OUTCOMES}. */
export type ShareOutcome = typeof SHARE_OUTCOMES[number]

/** One daily share, as Settings shows it. */
export interface ShareRow {
  /** Local day (`timeZone`). */
  readonly day: string
  /** `plan`: the day's share; `manual`: the owner pressed 现在发一条. */
  readonly reason: 'plan' | 'manual'
  /** When it is due, Unix epoch milliseconds. */
  readonly planAt: number
  /** When the Session was prompted, or null while it waits. */
  readonly firedAt: number | null
  /** Null while it is planned or its turn runs. */
  readonly outcome: ShareOutcome | null
  /** Why, in one line; null when there is nothing to add. */
  readonly detail: string | null
  /** What reached the owner, bounded (the account's own words); null when nothing did. */
  readonly text: string | null
}

/** The daily share: once a day the account messages the owner first with a video and a 热梗. */
export interface ShareView {
  /** Whether the daily share runs. */
  readonly enabled: boolean
  /** Whether the switch in Settings set `enabled` (else the configuration did). */
  readonly overridden: boolean
  /** The window the day's random time falls in, `HH:MM` in `timeZone`. */
  readonly start: string
  readonly end: string
  /** Today's planned share, or null before it is planned. */
  readonly today: ShareRow | null
  /** The latest shares, newest first (planned and manual, today's included). */
  readonly recent: readonly ShareRow[]
  /** Whether a share's turn is running now. */
  readonly running: boolean
}

/** Body of `GET api/bili` and of every `POST`. */
export interface BiliView {
  /** The agent's own account (`account` in the configuration). */
  readonly account: AccountView
  /** bili-svc's gate, or null when it did not answer. */
  readonly gate: GateView | null
  /** Every account bili-svc lists. */
  readonly accounts: readonly ManagedAccount[]
  /** Recent ledger; null without the manage token or when bili-svc did not answer. */
  readonly ledger: LedgerView | null
  /** QR sign-ins in progress. */
  readonly logins: readonly LoginView[]
  /** The account that speaks when the Reply Gate answers comments in public (bili-svc's `reply_comment` route), or null when unknown. */
  readonly speaker: { readonly id: string; readonly display: string } | null
  /** Whether Settings holds a manage token, so the write controls work. */
  readonly manage: boolean
  /** Name of the credential that holds the manage token, for the hint shown without it. */
  readonly manageEnv: string
  /** Why bili-svc refused or could not answer the manage calls, when it did not. */
  readonly manageError: string | null
  /** The last action's outcome, on a `POST` answer; null on `GET`. */
  readonly result: ActionResult | null
  /** The owner's main account, the only account whose messages the account answers; 0 while unset. */
  readonly ownerMid: number
  /** When the owner last set it in Settings, or null when it comes from the configuration or is unset. */
  readonly ownerUpdatedAt: number | null
  /** IANA zone of the journal and the daily limit, for showing times. */
  readonly timeZone: string
  /** The daily share to the owner. */
  readonly share: ShareView
}

/** Modes the gate switches between. */
export const GATE_MODES = ['auto', 'readonly'] as const
/** One of {@link GATE_MODES}. */
export type GateMode = typeof GATE_MODES[number]

/** Body of `POST api/bili`. */
export type BiliAction =
  | { readonly action: 'owner'; readonly mid: number }
  | { readonly action: 'gate.mode'; readonly mode: GateMode }
  | { readonly action: 'brake.release' }
  | { readonly action: 'login.start'; readonly account: string }
  | { readonly action: 'login.poll'; readonly account: string }
  | { readonly action: 'login.cancel'; readonly account: string }
  | { readonly action: 'session.refresh'; readonly account: string }
  | { readonly action: 'session.check'; readonly account: string }
  | { readonly action: 'logout'; readonly account: string; readonly confirm: string }
  | { readonly action: 'ledger'; readonly limit: number }
  | { readonly action: 'share.enabled'; readonly enabled: boolean }
  | { readonly action: 'share.now' }

/** Absolute Host registration path of the Settings route. */
export const BILI_PATH = '/api/bili'
/** Document-relative form the browser fetches. */
export const BILI_ROUTE = BILI_PATH.slice(1)
