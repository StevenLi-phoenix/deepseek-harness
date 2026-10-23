/**
 * What the Settings route answers and accepts, shared by both halves as types
 * and constants only. Nothing here can carry a cookie or token: the route
 * builds this view from the storage domain, never from the credential record.
 */

/** Write actions; each has its own daily cap except {@link UNCAPPED_ACTIONS}. */
export const WRITE_ACTIONS = ['follow', 'unfollow', 'favorite', 'like', 'watchlater', 'comment', 'reply', 'dynamic', 'dmOwner', 'dmReply', 'coin', 'triple', 'watch', 'share'] as const
/** One of {@link WRITE_ACTIONS}. */
export type WriteAction = typeof WRITE_ACTIONS[number]
/**
 * Writes without a daily cap: coins (a single coin or a triple) are limited by
 * the coin balance and Bilibili's per-video rule instead.
 */
export const UNCAPPED_ACTIONS = ['coin', 'triple'] as const
/** A write with a daily cap. */
export type CappedAction = Exclude<WriteAction, typeof UNCAPPED_ACTIONS[number]>
/** Writes with a daily cap, in display order. */
export const CAPPED_ACTIONS = WRITE_ACTIONS.filter(
  (action): action is CappedAction => !(UNCAPPED_ACTIONS as readonly string[]).includes(action),
)
/** Reports the host makes about what the account really did (a read video, a delivered link), not choices of the model. */
export const HOST_REPORTS: ReadonlySet<WriteAction> = new Set(['watch', 'share'])
/** Writes that need a verified phone number on Bilibili, by kind: messages to the owner, and public speech. */
export const VERIFY_KINDS = ['message', 'speech'] as const
/** One of {@link VERIFY_KINDS}. */
export type VerifyKind = typeof VERIFY_KINDS[number]

/** Login states of a stored account. */
export const ACCOUNT_STATES = ['active', 'login-needed'] as const
/** What a pause stops: every write, or only public speech (comments, replies, dynamics). */
export const PAUSE_SCOPES = ['all', 'speech'] as const
/** Body-clock wake states. */
export const WAKE_STATES = ['planned', 'done', 'skipped', 'missed'] as const
/** Why the Session was woken: the body clock, new inbox items, or the owner's Wake now in Settings. */
export const WAKE_REASONS = ['clock', 'inbox', 'manual'] as const
/** One of {@link WAKE_REASONS}. */
export type WakeReason = typeof WAKE_REASONS[number]

/** How off-peak pricing changed a wake: confined to its window's off-peak part, moved past a peak, or deferred at wake time. */
export const WAKE_ADJUSTMENTS = ['clipped', 'moved', 'deferred'] as const

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

/** One capped action's use today. */
export interface UsageView {
  readonly action: CappedAction
  readonly used: number
  readonly cap: number
}

/** One planned wake of today. */
export interface WakeView {
  /** The window, e.g. `12:00–14:00`. */
  readonly window: string
  readonly at: number | null
  readonly state: typeof WAKE_STATES[number]
  /** How off-peak pricing changed it, if it did. */
  readonly adjusted?: typeof WAKE_ADJUSTMENTS[number]
}

/** The model route the body clock decides by. */
export interface RouteView {
  readonly provider: string
  readonly model: string
  /** `pick` (an explicit choice not yet used), `session` (its last request), or `default` (the profile default). */
  readonly source: 'pick' | 'session' | 'default'
  /** Whether the route has time-of-day pricing, so wakes fall only off-peak. */
  readonly priced: boolean
  /** While a priced route is in a peak period: when off-peak starts. */
  readonly offPeakAt: number | null
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

/** One day's daily rewards: 5 EXP each for login, watch, and share, and EXP from coins. */
export interface DailyRewardsView {
  readonly day: string
  readonly login: boolean
  readonly watch: boolean
  readonly share: boolean
  readonly coinExp: number
}

/** Level, EXP, coins, and today's daily rewards, as last read. */
export interface ProgressView {
  readonly level: number
  readonly exp: number
  /** EXP floor of the current level. */
  readonly min: number
  /** EXP of the next level; null at LV6. */
  readonly next: number | null
  readonly coins: number
  readonly rewards: DailyRewardsView | null
  readonly checkedAt: number
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
    readonly lastWake: { readonly at: number; readonly reason: WakeReason } | null
    /** The route of the last check, or null before the first. */
    readonly route: RouteView | null
  }
  readonly recent: readonly RecentWriteView[]
  /** The owner's main account, the only DM recipient; 0 while unset. */
  readonly ownerMid: number
  /** When the owner last set it in Settings, or null when it comes from the configuration or is unset. */
  readonly ownerUpdatedAt: number | null
  /** The owner's last Wake now since the Host started, or null. */
  readonly manualWake: ManualWakeView | null
  /** Level and daily rewards, or null before the first read. */
  readonly progress: ProgressView | null
  /**
   * Kinds of write Bilibili refused until the account verifies a phone number
   * (or real name), with Bilibili's own words; each clears when a later write
   * of that kind goes through.
   */
  readonly verification: readonly VerificationView[]
}

/** One kind of write Bilibili refused for want of a verified phone number. */
export interface VerificationView {
  readonly kind: VerifyKind
  /** Bilibili's message, e.g. `为了维护社区的良好秩序，只有绑定手机号的账号才能发送消息`. */
  readonly message: string
  readonly since: number
}

/** What the owner's last Wake now did. */
export interface ManualWakeView {
  readonly at: number
  readonly outcome: 'started' | 'refused'
  /** Why it was refused: no account, a login to renew, a turn already running, a wake in the last minute, or an error (`detail`). */
  readonly reason?: 'signed-out' | 'login-needed' | 'busy' | 'recent' | 'failed'
  readonly detail?: string
  /** It ran in a peak period of a priced route: which, and when off-peak starts. */
  readonly peak?: { readonly provider: string; readonly offPeakAt: number | null }
  /** It ran while reads were backing off after risk control, until then. */
  readonly readsResumeAt?: number
}

/** Body of `POST api/bili`. */
export type BiliAction =
  | { readonly action: 'login' }
  | { readonly action: 'resume' }
  | { readonly action: 'wake' }
  | { readonly action: 'interests'; readonly text: string }
  | { readonly action: 'owner'; readonly mid: number }

/** Longest interests text the route stores. */
export const MAX_INTERESTS_CHARS = 2000

/** Absolute Host registration path of the Settings route. */
export const BILI_PATH = '/api/bili'
/** Document-relative form the browser fetches. */
export const BILI_ROUTE = BILI_PATH.slice(1)
