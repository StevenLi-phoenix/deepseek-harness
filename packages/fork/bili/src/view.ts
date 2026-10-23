/**
 * What the Settings route answers and accepts, shared by both halves as types
 * and constants only. Nothing here can carry a cookie or token: the route
 * builds this view from the storage domain, never from the credential record.
 */

/** Write actions; each has its own daily cap. */
export const WRITE_ACTIONS = ['follow', 'unfollow', 'favorite', 'like', 'watchlater', 'comment', 'reply', 'dynamic', 'dmOwner'] as const
/** One of {@link WRITE_ACTIONS}. */
export type WriteAction = typeof WRITE_ACTIONS[number]

/** Login states of a stored account. */
export const ACCOUNT_STATES = ['active', 'login-needed'] as const
/** What a pause stops: every write, or only public speech (comments, replies, dynamics). */
export const PAUSE_SCOPES = ['all', 'speech'] as const
/** Body-clock wake states. */
export const WAKE_STATES = ['planned', 'done', 'skipped', 'missed'] as const

/** The account card. `signed-out` means no account was ever signed in. */
export interface AccountView {
  readonly state: 'signed-out' | typeof ACCOUNT_STATES[number]
  readonly mid?: number
  readonly uname?: string
  readonly level?: number
  readonly loggedInAt?: number
  readonly refreshedAt?: number
  readonly checkedAt?: number
  readonly reason?: string
}

/** A QR login attempt the page shows. */
export interface LoginView {
  readonly state: 'idle' | 'waiting' | 'scanned' | 'expired' | 'failed' | 'done'
  /** QR modules, one string of `0`/`1` per row, while a code is live. */
  readonly qr?: { readonly modules: readonly string[]; readonly expiresAt: number }
  /** Why the attempt failed. */
  readonly error?: string
}

/** One action's use today. */
export interface UsageView {
  readonly action: WriteAction
  readonly used: number
  readonly cap: number
}

/** One planned wake of today. */
export interface WakeView {
  /** The window, e.g. `12:00–14:00`. */
  readonly window: string
  readonly at: number | null
  readonly state: typeof WAKE_STATES[number]
}

/** One recent write. */
export interface RecentWriteView {
  readonly at: number
  readonly action: WriteAction
  readonly target: string
  readonly state: 'reserved' | 'accepted' | 'failed' | 'uncertain'
  readonly detail?: string
  readonly visibility?: 'pending' | 'visible' | 'hidden' | 'unknown'
}

/** Body of `GET api/bili` and of every `POST`. */
export interface BiliView {
  readonly account: AccountView
  readonly login: LoginView
  /** Present while writes are paused; only the owner's Resume clears it. */
  readonly pause: { readonly scope: typeof PAUSE_SCOPES[number]; readonly reason: string; readonly since: number } | null
  /** Reads resume at this time after a risk signal. */
  readonly readsResumeAt: number | null
  readonly usage: { readonly day: string; readonly actions: readonly UsageView[] }
  readonly interests: { readonly text: string; readonly updatedAt: number | null }
  readonly clock: {
    readonly timeZone: string
    readonly today: readonly WakeView[]
    readonly nextWakeAt: number | null
    readonly lastWake: { readonly at: number; readonly reason: 'clock' | 'inbox' } | null
  }
  readonly recent: readonly RecentWriteView[]
  /** The owner's main account, the only DM recipient. */
  readonly ownerMid: number
}

/** Body of `POST api/bili`. */
export type BiliAction =
  | { readonly action: 'login' }
  | { readonly action: 'resume' }
  | { readonly action: 'interests'; readonly text: string }

/** Longest interests text the route stores. */
export const MAX_INTERESTS_CHARS = 2000

/** Absolute Host registration path of the Settings route. */
export const BILI_PATH = '/api/bili'
/** Document-relative form the browser fetches. */
export const BILI_ROUTE = BILI_PATH.slice(1)
