/**
 * Wire types and paths of Settings → 邮箱: what `GET /api/gmail` answers, the actions `POST /api/gmail` takes,
 * the path of the page Google's sign-in returns to, and the path of the privacy statement.
 */

/** Host route path of the status and the actions. */
export const GMAIL_PATH = '/api/gmail'
/** Document-relative route of the status and the actions, for the browser. */
export const GMAIL_ROUTE = 'api/gmail'
/**
 * Path of the page Google's sign-in returns to; the redirect URI registered at Google is `<origin><GMAIL_OAUTH_PATH>`.
 * Equal to `OAUTH_PATH` of `@deepseek-ai/dsh-gmail`, which the browser bundle does not import.
 */
export const GMAIL_OAUTH_PATH = '/gmail.oauth'
/**
 * Path of the OAuth app's privacy statement, outside `/api` like the sign-in page. Google requires a privacy policy
 * link (and a home page) before an app can be published In production; Settings shows `<origin><GMAIL_PRIVACY_PATH>`.
 */
export const GMAIL_PRIVACY_PATH = '/gmail.privacy'

/**
 * Account ids the service accepts: lower-case letters, digits, and `-`, a letter first, at most 24 characters.
 * Equal to `ACCOUNT_ID` of `@deepseek-ai/dsh-gmail`, which refuses any other id; the page checks it before a sign-in.
 */
export const ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/u

/** Send policies, strictest first. */
export const POLICIES = ['read-only', 'confirm-all', 'confirm-untrusted', 'direct'] as const

/** How an account sends. */
export type PolicyView = typeof POLICIES[number]

/** The Google OAuth client; the secret never leaves the Host. */
export interface ClientView {
  readonly configured: boolean
  readonly clientId: string | null
  readonly secretConfigured: boolean
}

/** One connected account. */
export interface AccountRow {
  readonly id: string
  readonly email: string
  /** Display name of the account's main address; empty when Gmail has none. */
  readonly name: string
  readonly policy: PolicyView
  readonly addedAt: number
  readonly lastOkAt: number | null
  readonly lastError: string | null
  /** Google refused the stored sign-in: the owner signs in again. */
  readonly needsReconnect: boolean
  /** Messages sent in the last 24 hours. */
  readonly sentToday: number
}

/** One message held for the owner's confirmation, or a resolved one. */
export interface PendingRow {
  readonly code: string
  readonly account: string
  readonly from: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  /** The start of the text. */
  readonly preview: string
  /** Attachment file names. */
  readonly attachments: readonly string[]
  readonly createdAt: number
  /** Who started the turn that wrote it, e.g. `owner`, `scheduled`, `owner, read gmail_read`. */
  readonly origin: string
  /** Why it waits. */
  readonly reason: string
  readonly status: 'held' | 'sent' | 'discarded' | 'expired'
  readonly resolvedAt: number | null
  readonly resolvedBy: 'settings' | 'owner-turn' | 'expiry' | null
  /** Whether the owner's WeChat notice went out. */
  readonly noticeSent: boolean
}

/** One line of the activity list. */
export interface ActivityRow {
  readonly seq: number
  readonly at: number
  readonly account: string
  /** `connected`, `sent`, `held`, `confirmed`, `error`, and the like. */
  readonly kind: string
  readonly detail: string
}

/** The status, the `status` field of the answer of `GET /api/gmail` and of `POST /api/gmail`. */
export interface GmailView {
  readonly client: ClientView
  /** The redirect URI set in the configuration; null derives `<page origin><GMAIL_OAUTH_PATH>`. */
  readonly redirectUri: string | null
  readonly accounts: readonly AccountRow[]
  /** Held messages first (oldest first), then the latest resolved ones (newest first). */
  readonly pending: readonly PendingRow[]
  /** Newest first. */
  readonly activity: readonly ActivityRow[]
  readonly maxSendsPerDay: number
  /** Hours a held message waits before it expires. */
  readonly confirmTtlHours: number
  /** Addresses every account sends to at once. */
  readonly trustedRecipients: readonly string[]
}

/** Body of `POST /api/gmail` (JSON). */
export type GmailAction =
  /** Store the OAuth client from the JSON file Google Cloud gives. */
  | { readonly action: 'client'; readonly json: string }
  /** Start a Google sign-in; the answer carries the page to open. */
  | { readonly action: 'sign-in'; readonly account: string; readonly policy?: PolicyView | undefined; readonly loginHint?: string | undefined }
  | { readonly action: 'policy'; readonly account: string; readonly policy: PolicyView }
  /** Disconnect an account: revoke its sign-in at Google and drop its held messages. */
  | { readonly action: 'remove'; readonly account: string }
  /** Send a held message. */
  | { readonly action: 'confirm'; readonly code: string }
  /** Drop a held message and its draft. */
  | { readonly action: 'discard'; readonly code: string }

/** Answer of `POST /api/gmail`: the new status, and for `sign-in` the Google page to open. A refused action answers 400 `{ error }`. */
export interface GmailAnswer {
  readonly status: GmailView
  readonly signInUrl?: string
}
