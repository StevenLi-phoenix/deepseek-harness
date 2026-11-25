/**
 * The request and result types of `ctx.gmail`'s methods; the package entry re-exports every type declared here.
 */

import type { SendPolicy } from './gate.ts'
import type { MessageView } from './message.ts'
import type { ActivityRecord, PendingRecord } from './storage.ts'

/** One connected account as the tools and Settings show it. */
export interface AccountView {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly policy: SendPolicy
  readonly addedAt: number
  readonly lastOkAt: number | null
  readonly lastError: string | null
  readonly needsReconnect: boolean
  /** Messages sent in the last 24 hours. */
  readonly sentToday: number
}

/** One thread in a search result. */
export interface ThreadSummary {
  readonly id: string
  readonly subject: string
  readonly from: string
  /** Unix epoch milliseconds of the newest message; null when unknown. */
  readonly date: number | null
  readonly snippet: string
  readonly messages: number
  readonly unread: boolean
  readonly labels: readonly string[]
}

/** Options of a search. */
export interface SearchOptions {
  /** Threads wanted; capped by `maxSearchResults`. */
  readonly max?: number | undefined
  /** The page token of a previous page. */
  readonly pageToken?: string | undefined
}

/** One page of search results. */
export interface SearchResult {
  readonly threads: readonly ThreadSummary[]
  readonly nextPageToken: string | null
  readonly estimate: number
}

/** A thread as the tools read it. */
export interface ThreadView {
  readonly id: string
  /** The newest messages, oldest first, in full. */
  readonly messages: readonly MessageView[]
  /** Older messages left out of `messages`. */
  readonly omitted: number
}

/** A message to draft or send. */
export interface Outgoing {
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  /** Required for a new message; a reply defaults to `Re: <subject>`. */
  readonly subject?: string | undefined
  /** Plain-text body. */
  readonly body: string
  /** Message id this one answers: the thread, the reply headers, and (when no recipient is given) the recipients come from it. */
  readonly replyTo?: string | undefined
  /** With `replyTo` and no recipients: also every other recipient of the original. */
  readonly replyAll?: boolean | undefined
  /** Files to attach, absolute or relative to `cwd`. */
  readonly attachments: readonly string[]
  /** The Session's working directory; required when `attachments` is not empty. */
  readonly cwd?: string | undefined
}

/** What a send asked for: a new message, or a draft that exists. */
export type SendRequest = { readonly kind: 'new'; readonly message: Outgoing } | { readonly kind: 'draft'; readonly draftId: string }

/** What a send did. */
export type SendOutcome =
  | { readonly kind: 'sent'; readonly messageId: string; readonly threadId: string; readonly recipients: readonly string[] }
  | { readonly kind: 'held'; readonly reason: string; readonly draftId: string; readonly noticeSent: boolean; readonly recipients: readonly string[] }

/** A draft that was written. */
export interface DraftOutcome {
  readonly draftId: string
  readonly threadId: string | null
  readonly recipients: readonly string[]
  readonly subject: string
}

/** A saved attachment. */
export interface SavedAttachment {
  readonly path: string
  readonly filename: string
  readonly mimeType: string
  readonly bytes: number
}

/** A sign-in Settings starts. */
export interface SignInRequest {
  /** Account id: `work`, `personal`, `bot`. */
  readonly account: string
  /** Policy of a new account; an existing one keeps its own. */
  readonly policy?: SendPolicy | undefined
  /** Address Google's account chooser starts with. */
  readonly loginHint?: string | undefined
  /** Origin the Settings page runs on, for the redirect URI. */
  readonly origin: string
}

/** Google's redirect back to DSH. */
export interface SignInAnswer {
  readonly state: string
  readonly code?: string | undefined
  readonly error?: string | undefined
  /** HTTP callers must supply the matched path and Host; trusted in-process callers may omit them. */
  readonly callback?: { readonly path: string; readonly authority: string } | undefined
}

/** The OAuth client as Settings shows it; the secret never leaves the credential store. */
export interface ClientInfo {
  readonly configured: boolean
  readonly clientId: string | null
  readonly secretConfigured: boolean
}

/** Everything Settings shows. */
export interface GmailStatus {
  readonly client: ClientInfo
  /** The configured redirect URI; null derives it from the Settings origin. */
  readonly redirectUri: string | null
  readonly accounts: readonly AccountView[]
  /** Held messages first (oldest first), then the latest resolved ones (newest first). */
  readonly pending: readonly PendingRecord[]
  /** Newest first. */
  readonly activity: readonly ActivityRecord[]
  readonly maxSendsPerDay: number
  readonly confirmTtlHours: number
  readonly trustedRecipients: readonly string[]
}
