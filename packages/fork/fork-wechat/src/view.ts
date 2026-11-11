/**
 * What the Settings route answers and accepts, shared by both halves as types,
 * constants, and pure helpers only. Nothing here can carry a bot token, a
 * message text, or a login payload other than the QR code the owner is meant
 * to scan: ids are masked, and the channel reports times, counts, and codes.
 */

/** Absolute Host registration path of the Settings route. */
export const WECHAT_PATH = '/api/fork.wechat'
/** Document-relative form the browser fetches. */
export const WECHAT_ROUTE = WECHAT_PATH.slice(1)

/** Why no reply can go out right now. */
export const WINDOW_CLOSED = ['no-account', 'stale-token', 'owner-silent', 'expired', 'used-up'] as const
/**
 * One of {@link WINDOW_CLOSED}: no bound bot, a token WeChat rejected, no owner message yet, a window
 * past its time, or all replies of the window sent.
 */
export type WindowClosed = typeof WINDOW_CLOSED[number]

/** Where the long-poll stands. */
export type ChannelLink = 'idle' | 'starting' | 'connected' | 'retrying' | 'stale'

/** What the bot's latest message to the owner was; mirrors the channel's `SentKind`. */
export type OutboundKind = 'reply' | 'note' | 'file' | 'notice' | 'digest'

/** The bound bot, with ids masked. */
export type BindingView =
  | { readonly state: 'unbound' }
  | { readonly state: 'invalid'; readonly reason: string }
  | { readonly state: 'bound'; readonly botId: string; readonly ownerId: string; readonly boundAt: number | null }

/** The latest failure the channel met, with a sanitized one-line text. */
export interface ChannelError {
  /** Unix epoch milliseconds. */
  readonly at: number
  readonly where: 'poll' | 'send'
  readonly text: string
}

/** Channel health: the long-poll and the owner chat's latest traffic. */
export interface ChannelView {
  readonly link: ChannelLink
  /** Last long-poll that came back, in Unix epoch milliseconds; null before the first. */
  readonly lastPollAt: number | null
  /** Long-polls that failed in a row. */
  readonly failures: number
  readonly lastError: ChannelError | null
  /** When the owner last wrote, and when the bot last wrote to the owner. */
  readonly lastInboundAt: number | null
  readonly lastOutboundAt: number | null
  readonly lastOutboundKind: OutboundKind | null
}

/** The reply window the owner's latest message opened. */
export interface WindowView {
  readonly open: boolean
  /** Why it is closed; null while open. */
  readonly closed: WindowClosed | null
  /** Replies left in the window; null without a window record. */
  readonly repliesLeft: number | null
  readonly repliesPerToken: number
  /** When the window ends, in Unix epoch milliseconds; null without a window record. */
  readonly expiresAt: number | null
}

/** How the chat Session's words reach the owner, and how tool delivery has been doing since the process started. */
export interface DeliveryView {
  /** `text`: the final answer of each turn is sent. `tool`: only `wechat_send` reaches the owner. */
  readonly mode: 'text' | 'tool'
  /** `wechat_send` calls that delivered or queued a text. */
  readonly toolSends: number
  /** Owner messages whose turn ended without a `wechat_send`, answered by one reminder turn. */
  readonly nudges: number
  /** Owner messages that stayed unanswered even after the reminder: the owner got the fixed notice. */
  readonly silentNotices: number
}

/** Texts waiting for the next window. */
export interface OutboxView {
  readonly count: number
  readonly limit: number
  /** When the oldest was queued, in Unix epoch milliseconds. */
  readonly oldestAt: number | null
}

/** The channel's own part of the view. */
export interface ChannelStatus {
  readonly channel: ChannelView
  readonly window: WindowView
  readonly outbox: OutboxView
  readonly delivery: DeliveryView
}

/** Body of `GET api/fork.wechat`. */
export interface WechatView extends ChannelStatus {
  readonly binding: BindingView
  /** A QR login is running (started here, not yet bound, failed, or cancelled). */
  readonly loginActive: boolean
  /** IANA zone for showing times. */
  readonly timeZone: string
}

/** Phases of a QR login, in the order a good one passes through them. */
export const LOGIN_PHASES = ['waiting', 'scanned', 'needs-code', 'expired', 'done', 'failed'] as const
/** One of {@link LOGIN_PHASES}. */
export type LoginPhase = typeof LOGIN_PHASES[number]

/** Phases that still need polling. */
export const LOGIN_OPEN: readonly LoginPhase[] = ['waiting', 'scanned', 'needs-code']

/** Why a failed login failed; `expired` is a phase of its own. */
export type LoginFailureView = 'verify-blocked' | 'bound-elsewhere' | 'timeout' | 'poll-failed' | 'cancelled' | 'save-failed' | 'other'

/** The QR code to scan: its link and the modules to draw. */
export interface LoginQr {
  /** Link the code encodes; also a fallback for a code that cannot be scanned. */
  readonly url: string
  /** 1 for the first code, up one per refresh. */
  readonly attempt: number
  /** Modules per side. */
  readonly size: number
  /** One string per row, `'1'` for a dark module and `'0'` for a light one. */
  readonly rows: readonly string[]
}

/** One QR login as the page sees it. */
export interface LoginSnapshot {
  /** Opaque key naming this login in later requests. */
  readonly key: string
  readonly phase: LoginPhase
  /** The current code while the login is open. */
  readonly qr: LoginQr | null
  /** The last number entered did not match, so WeChat asks again. */
  readonly codeRetry: boolean
  /** Why the login failed, for `failed`. */
  readonly failure: LoginFailureView | null
}

/** Body of every `POST api/fork.wechat`. */
export interface WechatAnswer {
  readonly view: WechatView
  /** The login the request concerns; null for a request that has none. */
  readonly login: LoginSnapshot | null
}

/** Body of `POST api/fork.wechat`. */
export type WechatAction =
  | { readonly action: 'login.start' }
  | { readonly action: 'login.poll'; readonly key: string }
  | { readonly action: 'login.code'; readonly key: string; readonly code: string }
  | { readonly action: 'login.cancel'; readonly key: string }
  | { readonly action: 'unbind'; readonly confirm: 'unbind' }

/** The number WeChat shows: digits only, as many as it has used. */
export const VERIFY_CODE_PATTERN = /^\d{1,8}$/

/**
 * Show an id without giving it away: the start and end of the part before `@`, and the domain after it.
 * @param id - `ilink_bot_id` or `ilink_user_id`.
 * @returns for example `o9c…1f@im.wechat`.
 */
export function maskId(id: string): string {
  const at = id.lastIndexOf('@')
  const name = at < 0 ? id : id.slice(0, at)
  const domain = at < 0 ? '' : id.slice(at)
  const chars = Array.from(name)
  const shown = chars.length <= 6 ? `${chars[0] ?? ''}…` : `${chars.slice(0, 3).join('')}…${chars.slice(-2).join('')}`
  return `${shown}${domain}`
}
