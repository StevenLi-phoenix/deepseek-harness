/**
 * The owner's Gmail accounts in DSH, as `ctx.forkGmail`: one Google sign-in per account (work, personal, a bot, any
 * number), the refresh tokens in the credential store, and every read, draft, send, and label change the tools make.
 * Whether a message goes out is decided here, by the send gate over the account's policy and the turn's origin; a
 * held message becomes a Gmail draft and a WeChat notice this service writes, and goes out only when the owner
 * confirms it in Settings or with the code in a turn of their own. A changed draft, an expired hold, or an account
 * over its daily send cap is never sent.
 *
 * @module @deepseek-ai/dsh-fork-gmail
 */

import { createHash, randomInt } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: ctx.credentials.
import type {} from '@deepseek-ai/dsh-credentials'
// Type-only: ctx.get('forkNotifier').
import type {} from '@deepseek-ai/dsh-fork-event-bus'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { AddressProblem, addressesIn, parseMailbox, parseMailboxes, type Mailbox } from './address.ts'
import { GmailApi, GmailApiError } from './api.ts'
import { AttachmentProblem, readAttachments, saveAttachment } from './attachments.ts'
import { decideSend, namedByOwner, ownerConfirms, SEND_POLICIES, type SendPolicy, type TurnFacts } from './gate.ts'
import { compose, messageIds } from './mime.ts'
import { decodeEntities } from './html.ts'
import { attachmentPart, attachmentsOf, header, messageView, type MessageView } from './message.ts'
import { authorizationUrl, exchangeCode, newState, OAuthError, pkcePair, refreshAccess, revoke, type OAuthClient, type PendingSignIn } from './oauth.ts'
import { gmailDomain, type AccountRecord, type ActivityRecord, type PendingRecord } from './storage.ts'

export * from './address.ts'
export * from './api.ts'
export * from './attachments.ts'
export * from './gate.ts'
export * from './html.ts'
export * from './message.ts'
export * from './mime.ts'
export * from './oauth.ts'
export type * from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    forkGmail: ForkGmail
  }
}

/** The one permission asked for: read, draft, send, and change labels; never permanent deletion. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
/**
 * Path of the OAuth redirect under the DSH origin. It lies outside `/api`: the DSH sign-in cookie is `SameSite=Strict`,
 * so Google's cross-site redirect arrives without it, and the one-use `state` of an open sign-in authenticates the
 * request instead.
 */
export const OAUTH_PATH = '/fork.gmail.oauth'
/** Credential-store scope of the grant records. */
const GRANT_SCOPE = 'fork-gmail'
/** Account ids: lower-case, a letter first, at most 24 characters (they are credential key segments). */
const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,23}$/u
/** Code alphabet: no 0/O, 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
/** Characters of a held message's code. */
const CODE_LENGTH = 6
/** How long a sign-in link stays valid (OAuth state lifetime, a security invariant). */
const SIGN_IN_TTL_MS = 10 * 60_000
/** Open sign-ins kept at most. */
const MAX_SIGN_INS = 20
/** Refresh an access token this long before it expires. */
const TOKEN_MARGIN_MS = 60_000
/** Activity lines kept. */
const ACTIVITY_KEPT = 200
/** Resolved held messages kept for Settings. */
const RESOLVED_KEPT = 50
/** Characters of a held message's body in the owner's notice. */
const PREVIEW_CHARS = 400
/** Threads one modify call may change. */
const MAX_MODIFY_THREADS = 50
/** A day, in milliseconds. */
const DAY_MS = 86_400_000

/** Plugin configuration. */
export interface Config {
  /** Name of the OAuth client id in the credential store or `$DSH_HOME/.env`. */
  clientIdEnv: string
  /** Name of the OAuth client secret in the credential store or `$DSH_HOME/.env`. */
  clientSecretEnv: string
  /** Redirect URI registered at Google; empty derives `<Settings origin>/fork.gmail.oauth`. */
  redirectUri: string
  /** Addresses that never need a confirmation, besides the connected accounts themselves. */
  trustedRecipients: string[]
  /** Messages one account may send in 24 hours; more are refused. */
  maxSendsPerDay: number
  /** Hours a held message waits for the owner before it expires (its draft stays in Gmail). */
  confirmTtlHours: number
  /** Timeout of one call to Google, in milliseconds. */
  requestTimeoutMs: number
  /** Threads one search returns at most. */
  maxSearchResults: number
  /** Characters of one message body shown to the model. */
  maxBodyChars: number
  /** Characters of an HTML body read at most. */
  maxHtmlChars: number
  /** Newest messages of one thread shown; older ones are only counted. */
  maxThreadMessages: number
  /** Bytes of all attachments of one outgoing message. */
  maxAttachmentBytes: number
  /** Bytes of one received attachment saved. */
  maxDownloadBytes: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  clientIdEnv: z.string().default('FORK_GMAIL_CLIENT_ID').description('Name of the Google OAuth client id in the credential store or $DSH_HOME/.env.'),
  clientSecretEnv: z.string().default('FORK_GMAIL_CLIENT_SECRET').description('Name of the Google OAuth client secret in the credential store or $DSH_HOME/.env.'),
  redirectUri: z.string().default('').description('Redirect URI registered at Google; empty derives <Settings origin>/fork.gmail.oauth.'),
  trustedRecipients: z.array(z.string()).default([]).description('Addresses that never need a confirmation, besides the connected accounts.'),
  maxSendsPerDay: z.natural().min(1).default(50).description('Messages one account may send in 24 hours; more are refused.'),
  confirmTtlHours: z.natural().min(1).default(72).description('Hours a held message waits for the owner before it expires.'),
  requestTimeoutMs: z.natural().min(1000).default(30_000).description('Timeout of one call to Google, in milliseconds.'),
  maxSearchResults: z.natural().min(1).max(50).default(20).description('Threads one search returns at most.'),
  maxBodyChars: z.natural().min(500).default(20_000).description('Characters of one message body shown to the model.'),
  maxHtmlChars: z.natural().min(10_000).default(500_000).description('Characters of an HTML body read at most.'),
  maxThreadMessages: z.natural().min(1).default(10).description('Newest messages of one thread shown; older ones are only counted.'),
  maxAttachmentBytes: z.natural().min(1).default(18 * 1_048_576).description('Bytes of all attachments of one outgoing message (Gmail caps a message at 25 MB encoded).'),
  maxDownloadBytes: z.natural().min(1).default(25 * 1_048_576).description('Bytes of one received attachment saved.'),
})

/** Why a Gmail operation failed, beyond the API's own failures. */
export type GmailFailure =
  | 'unknown-account' | 'not-configured' | 'needs-reconnect' | 'refused' | 'limit' | 'invalid' | 'expired' | 'denied' | 'not-found' | 'api'

/** A failed operation; the message is safe to log and to show to the model or the owner. */
export class GmailError extends Error {
  /**
   * @param failure - the failure class.
   * @param message - what went wrong.
   */
  constructor(readonly failure: GmailFailure, message: string) {
    super(message)
    this.name = 'GmailError'
  }
}

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

/** What a label change does. */
export type ModifyAction = 'read' | 'unread' | 'archive' | 'inbox' | 'star' | 'unstar' | 'trash' | 'untrash' | 'label' | 'unlabel'

/** Every label change, in the order the tool lists them. */
export const MODIFY_ACTIONS: readonly ModifyAction[] = ['read', 'unread', 'archive', 'inbox', 'star', 'unstar', 'trash', 'untrash', 'label', 'unlabel']

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

/** The grant record's payload. */
const grantSchema = zod.object({ email: zod.string(), refreshToken: zod.string().min(1), scope: zod.string(), grantedAt: zod.number() })
/** One grant. */
type Grant = zod.infer<typeof grantSchema>

/** A Google OAuth client JSON file (`web` or `installed`), or its inner object. */
const clientFileSchema = zod.union([
  zod.object({ web: zod.object({ client_id: zod.string(), client_secret: zod.string() }) }).transform(file => file.web),
  zod.object({ installed: zod.object({ client_id: zod.string(), client_secret: zod.string() }) }).transform(file => file.installed),
  zod.object({ client_id: zod.string(), client_secret: zod.string() }),
])

/** An open sign-in. */
interface SignIn extends PendingSignIn {
  readonly policy: SendPolicy
}

/** Human-readable error text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Remove control characters and the characters a display name may not hold. */
function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001F\u007F<>"\\]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 100)
}

/** A header value from a received message, made safe for a new header. */
function cleanHeader(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim()
}

/** The mailboxes a received header names, the ones that are plain addresses. */
function mailboxesOf(value: string): Mailbox[] {
  const out: Mailbox[] = []
  for (const address of addressesIn(value)) {
    try {
      out.push(parseMailbox(address))
    } catch {
      // AddressProblem: an address outside the plain form is left out of the reply rather than written as is.
      continue
    }
  }
  return out
}

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (config.redirectUri !== '' && !/^https:\/\/[^\s/]+\/\S*$|^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/\S*$/u.test(config.redirectUri)) {
    throw new Error('fork-gmail: redirectUri must be an https URL (or http on localhost)')
  }
  for (const address of config.trustedRecipients) {
    try {
      parseMailbox(address)
    } catch {
      // AddressProblem: reported as a load failure below, with the value.
      throw new Error(`fork-gmail: trustedRecipients entry "${address}" is not an email address`)
    }
  }
}

/** A composed message, before it is sent or drafted. */
interface Prepared {
  /** The RFC 5322 text. */
  readonly raw: string
  readonly threadId: string | undefined
  /** Every To, Cc, and Bcc address, lower-cased. */
  readonly recipients: string[]
  readonly subject: string
}

/** A draft's recipients, subject, text, and attachments as the gate and the notice read them. */
interface DraftFacts {
  readonly draftId: string
  readonly threadId: string | null
  readonly from: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  readonly text: string
  readonly attachments: readonly string[]
  readonly fingerprint: string
}

/**
 * The owner's Gmail accounts.
 */
export class ForkGmail extends Service {
  static inject = ['storageDomain', 'credentials']
  static Config = Config

  private readonly ready: Promise<Domain<typeof gmailDomain>>
  private domain: Domain<typeof gmailDomain> | undefined
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>()
  private readonly refreshing = new Map<string, Promise<string>>()
  private readonly signIns = new Map<string, SignIn>()
  private chain: Promise<unknown> = Promise.resolve()
  private activityChain: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - Host with storage and credentials.
   * @param config - OAuth client names, limits, and trusted recipients.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'forkGmail')
    assertConfig(config)
    this.ready = ctx.storageDomain.open(gmailDomain)
    ctx.effect(async () => {
      const domain = await this.ready
      this.domain = domain
      await this.expire(domain, Date.now())
      const accounts = Array.from(domain.table('accounts').entries(), ([, row]) => row)
      const held = Array.from(domain.table('pending').entries()).filter(([, row]) => row.status === 'held').length
      this.ctx.logger.info(`fork-gmail: ${accounts.length} account(s)${accounts.length === 0 ? '' : ` (${accounts.map(row => `${row.id} ${row.policy}${row.needsReconnect ? ' needs-reconnect' : ''}`).join(', ')})`}, ${held} held message(s), cap ${config.maxSendsPerDay}/day`)
      return async () => {
        await this.chain
        await domain.close()
      }
    }, 'forkGmail.init()')
  }

  /** Run storage writes that read and replace one at a time. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work)
    this.chain = result.catch(() => undefined)
    return result
  }

  // ── accounts ────────────────────────────────────────────────────────────────

  /**
   * Every connected account, in id order.
   * @returns the accounts without tokens.
   */
  accounts(): AccountView[] {
    const domain = this.domain
    if (domain === undefined) return []
    const now = Date.now()
    return Array.from(domain.table('accounts').entries(), ([, row]) => this.view(domain, row, now)).sort((a, b) => a.id.localeCompare(b.id))
  }

  private view(domain: Domain<typeof gmailDomain>, row: AccountRecord, now: number): AccountView {
    return { ...row, sentToday: this.recentSends(domain, row.id, now).length }
  }

  private recentSends(domain: Domain<typeof gmailDomain>, account: string, now: number): number[] {
    return (domain.table('sends').get(account)?.at ?? []).filter(at => now - at < DAY_MS)
  }

  private async account(id: string): Promise<AccountRecord> {
    const domain = await this.ready
    const row = domain.table('accounts').get(id)
    if (row === undefined) {
      const known = Array.from(domain.table('accounts').keys())
      throw new GmailError('unknown-account', `no Gmail account "${id}"; connected: ${known.length === 0 ? 'none (the owner adds them in Settings → 邮箱)' : known.join(', ')}`)
    }
    if (row.needsReconnect) throw new GmailError('needs-reconnect', `Gmail account "${id}" (${row.email}) must be signed in again by the owner in Settings → 邮箱`)
    return row
  }

  /** The owner's own addresses and the configured list, lower-cased. */
  private trusted(domain: Domain<typeof gmailDomain>): Set<string> {
    return new Set([
      ...Array.from(domain.table('accounts').entries(), ([, row]) => row.email.toLowerCase()),
      ...this.config.trustedRecipients.map(address => parseMailbox(address).address.toLowerCase()),
    ])
  }

  // ── tokens ──────────────────────────────────────────────────────────────────

  private async client(): Promise<OAuthClient> {
    const [id, secret] = await Promise.all([
      this.ctx.credentials.resolve(credentialRef(this.config.clientIdEnv)),
      this.ctx.credentials.resolve(credentialRef(this.config.clientSecretEnv)),
    ])
    if (id === undefined || secret === undefined) throw new GmailError('not-configured', 'the Google OAuth client is not set up; the owner pastes its JSON in Settings → 邮箱')
    return { clientId: id.value, clientSecret: secret.value }
  }

  private async grant(account: string): Promise<Grant | undefined> {
    const record = await this.ctx.credentials.readRecord(credentialKey(GRANT_SCOPE, account))
    if (record?.kind !== 'grant') return undefined
    const parsed = grantSchema.safeParse(record.payload)
    return parsed.success ? parsed.data : undefined
  }

  private accessToken(account: string, fresh: boolean): Promise<string> {
    const cached = this.tokens.get(account)
    if (!fresh && cached !== undefined && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return Promise.resolve(cached.token)
    const running = this.refreshing.get(account)
    if (running !== undefined) return running
    const work = this.refresh(account).finally(() => this.refreshing.delete(account))
    this.refreshing.set(account, work)
    return work
  }

  private async refresh(account: string): Promise<string> {
    const client = await this.client()
    const grant = await this.grant(account)
    if (grant === undefined) {
      await this.markReconnect(account, 'no stored sign-in')
      throw new GmailError('needs-reconnect', `Gmail account "${account}" has no stored sign-in; the owner signs in again in Settings → 邮箱`)
    }
    let answer
    try {
      answer = await refreshAccess(client, grant.refreshToken, { timeoutMs: this.config.requestTimeoutMs })
    } catch (error: unknown) {
      if (error instanceof OAuthError && error.failure === 'invalid-grant') {
        await this.markReconnect(account, error.message)
        throw new GmailError('needs-reconnect', `Google no longer accepts the sign-in of Gmail account "${account}"; the owner signs in again in Settings → 邮箱`)
      }
      throw new GmailError('api', errorText(error))
    }
    this.tokens.set(account, { token: answer.accessToken, expiresAt: answer.expiresAt })
    if (answer.refreshToken !== undefined && answer.refreshToken !== grant.refreshToken) {
      const rotated = answer.refreshToken
      await this.ctx.credentials.modifyRecord(credentialKey(GRANT_SCOPE, account), () => Promise.resolve({ kind: 'grant', payload: { ...grant, refreshToken: rotated } }))
      this.ctx.logger.info(`fork-gmail: ${account}: Google rotated the refresh token; stored`)
    }
    return answer.accessToken
  }

  /** Mark an account as needing a new sign-in and tell the owner once; runs inside serialized work, so it is not serialized itself. */
  private async markReconnect(account: string, why: string): Promise<void> {
    const domain = await this.ready
    const row = domain.table('accounts').get(account)
    if (row === undefined || row.needsReconnect) return
    this.tokens.delete(account)
    const noticed = await this.notify({
      title: `⚠️ Gmail ${account}（${row.email}）要重新登录`,
      body: `Google 不再接受这个账号的登录（${why.slice(0, 200)}）。在 设置 → 邮箱 里点「重新登录」；在那之前不能读信或发信。`,
      kinds: ['gmail.reconnect'],
    })
    await domain.table('accounts').put(account, { ...row, needsReconnect: true, lastError: why.slice(0, 300), reconnectNoticeAt: noticed ? Date.now() : null })
    await this.activity(domain, account, 'reconnect', why.slice(0, 300))
    this.ctx.logger.warn(`fork-gmail: ${account}: needs a new sign-in (${why.slice(0, 200)})`)
  }

  private api(account: string): GmailApi {
    return new GmailApi({ timeoutMs: this.config.requestTimeoutMs, accessToken: fresh => this.accessToken(account, fresh) })
  }

  /** Run one operation on an account: record its health and log its outcome. */
  private async run<T>(account: string, op: string, work: (api: GmailApi, row: AccountRecord) => Promise<T>, describe: (result: T) => string = () => ''): Promise<T> {
    const row = await this.account(account)
    const started = Date.now()
    try {
      const result = await work(this.api(account), row)
      const detail = describe(result)
      this.ctx.logger.info(`fork-gmail: ${account} ${op} ok in ${Date.now() - started} ms${detail === '' ? '' : `: ${detail}`}`)
      await this.health(account, null)
      return result
    } catch (error: unknown) {
      const apiFailure = error instanceof GmailApiError || (error instanceof GmailError && error.failure === 'api')
      this.ctx.logger.warn(`fork-gmail: ${account} ${op} failed in ${Date.now() - started} ms: ${errorText(error)}`)
      if (apiFailure) await this.health(account, errorText(error))
      if (error instanceof GmailApiError) throw new GmailError(error.failure === 'not-found' ? 'not-found' : 'api', error.message)
      throw error
    }
  }

  /** Record the outcome of a call on the account row (a success at most every five minutes). */
  private async health(account: string, error: string | null): Promise<void> {
    const domain = await this.ready
    const row = domain.table('accounts').get(account)
    if (row === undefined) return
    const now = Date.now()
    if (error === null && row.lastError === null && row.lastOkAt !== null && now - row.lastOkAt < 300_000) return
    await domain.table('accounts').put(account, error === null ? { ...row, lastOkAt: now, lastError: null } : { ...row, lastError: error.slice(0, 300) })
  }

  // ── reading ─────────────────────────────────────────────────────────────────

  /**
   * Search an account's mail.
   * @param account - account id.
   * @param query - Gmail search syntax.
   * @param options - threads wanted (capped by config) and the page token of a previous page.
   * @returns one summary per thread.
   */
  search(account: string, query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const max = Math.max(1, Math.min(options.max ?? 10, this.config.maxSearchResults))
    return this.run(account, 'search', async (api) => {
      const page = await api.listThreads(query, max, options.pageToken)
      const threads = await Promise.all((page.threads ?? []).map(async (entry): Promise<ThreadSummary> => {
        const thread = await api.thread(entry.id, 'metadata')
        const messages = thread.messages ?? []
        const first = messages[0]
        const last = messages.at(-1)
        const labels = [...new Set(messages.flatMap(message => message.labelIds ?? []))]
        const date = Number(last?.internalDate)
        return {
          id: entry.id,
          subject: header(first?.payload, 'Subject'),
          from: header(last?.payload, 'From'),
          date: Number.isFinite(date) && last?.internalDate !== undefined ? date : null,
          snippet: decodeEntities(last?.snippet ?? entry.snippet ?? ''),
          messages: messages.length,
          unread: labels.includes('UNREAD'),
          labels,
        }
      }))
      return { threads, nextPageToken: page.nextPageToken ?? null, estimate: page.resultSizeEstimate ?? threads.length }
    }, result => `${result.threads.length} thread(s)`)
  }

  /**
   * Read one thread: its newest messages in full.
   * @param account - account id.
   * @param threadId - thread id.
   * @param keepQuotes - keep the quoted history of each reply.
   * @returns the thread.
   */
  thread(account: string, threadId: string, keepQuotes = false): Promise<ThreadView> {
    return this.run(account, 'read thread', async (api) => {
      const thread = await api.thread(threadId, 'full')
      const all = thread.messages ?? []
      const shown = all.slice(-this.config.maxThreadMessages)
      return {
        id: thread.id,
        messages: shown.map(message => messageView(message, this.viewOptions(keepQuotes))),
        omitted: all.length - shown.length,
      }
    }, result => `${result.messages.length} message(s)`)
  }

  /**
   * Read one message.
   * @param account - account id.
   * @param messageId - message id.
   * @param keepQuotes - keep the quoted history.
   * @returns the message.
   */
  message(account: string, messageId: string, keepQuotes = false): Promise<MessageView> {
    return this.run(account, 'read message', async api => messageView(await api.message(messageId, 'full'), this.viewOptions(keepQuotes)))
  }

  private viewOptions(keepQuotes: boolean): { maxChars: number; maxHtmlChars: number; keepQuotes: boolean } {
    return { maxChars: this.config.maxBodyChars, maxHtmlChars: this.config.maxHtmlChars, keepQuotes }
  }

  /**
   * Save one attachment of a received message under `<cwd>/.gmail-inbox/`.
   * @param account - account id.
   * @param messageId - message id.
   * @param part - the attachment's part id.
   * @param cwd - the Session's working directory.
   * @returns where it was saved.
   */
  download(account: string, messageId: string, part: string, cwd: string): Promise<SavedAttachment> {
    return this.run(account, 'attachment', async (api) => {
      const message = await api.message(messageId, 'full')
      const found = attachmentPart(message.payload, part)
      if (found === undefined) {
        const listed = attachmentsOf(message.payload).map(entry => `${entry.part} (${entry.filename})`)
        throw new GmailError('not-found', `message ${messageId} has no attachment part "${part}"; its attachments: ${listed.length === 0 ? 'none' : listed.join(', ')}`)
      }
      const size = found.body?.size ?? 0
      if (size > this.config.maxDownloadBytes) throw new GmailError('limit', `the attachment holds ${size} bytes, over the ${this.config.maxDownloadBytes}-byte limit`)
      const inline = found.body?.data ?? ''
      const data = found.body?.attachmentId !== undefined ? await api.attachment(messageId, found.body.attachmentId) : Buffer.from(inline, 'base64url')
      if (data.length > this.config.maxDownloadBytes) throw new GmailError('limit', `the attachment holds ${data.length} bytes, over the ${this.config.maxDownloadBytes}-byte limit`)
      const filename = found.filename
      const path = await saveAttachment(cwd, messageId.slice(-8), filename, data)
      return { path, filename, mimeType: found.mimeType ?? 'application/octet-stream', bytes: data.length }
    }, result => `${result.bytes} bytes`)
  }

  // ── writing ─────────────────────────────────────────────────────────────────

  /** Compose an outgoing message: recipients, reply headers, attachments. */
  private async prepare(api: GmailApi, row: AccountRecord, message: Outgoing): Promise<Prepared> {
    let to = parseMailboxes(message.to)
    let cc = parseMailboxes(message.cc)
    const bcc = parseMailboxes(message.bcc)
    let subject = message.subject
    let threadId: string | undefined
    let inReplyTo: string | undefined
    let references: string | undefined
    if (message.replyTo !== undefined) {
      const original = await api.message(message.replyTo, 'metadata')
      const payload = original.payload
      threadId = original.threadId
      inReplyTo = messageIds(header(payload, 'Message-ID'))
      references = [messageIds(header(payload, 'References')), inReplyTo].filter(part => part !== '').join(' ')
      if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
        const own = row.email.toLowerCase()
        const sender = mailboxesOf(header(payload, 'Reply-To') || header(payload, 'From'))
        const fromSelf = sender.every(mailbox => mailbox.address.toLowerCase() === own)
        to = fromSelf ? mailboxesOf(header(payload, 'To')) : sender
        if (message.replyAll === true) {
          const taken = new Set([own, ...to.map(mailbox => mailbox.address.toLowerCase())])
          cc = [...mailboxesOf(header(payload, 'To')), ...mailboxesOf(header(payload, 'Cc'))].filter((mailbox) => {
            const key = mailbox.address.toLowerCase()
            if (taken.has(key)) return false
            taken.add(key)
            return true
          })
        }
      }
      const originalSubject = cleanHeader(header(payload, 'Subject'))
      subject ??= /^re:/iu.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`
    }
    if (subject === undefined || subject.trim() === '') throw new AddressProblem('a new message needs a subject')
    const attachments = message.attachments.length === 0
      ? []
      : await readAttachments(message.attachments, this.cwdOf(message), this.config.maxAttachmentBytes)
    const raw = compose({
      from: { address: row.email, name: row.name }, to, cc, bcc, subject, text: message.body, inReplyTo, references, attachments,
    })
    const recipients = [...to, ...cc, ...bcc].map(mailbox => mailbox.address.toLowerCase())
    return { raw, threadId, recipients, subject }
  }

  private cwdOf(message: Outgoing): string {
    if (message.cwd === undefined) throw new AttachmentProblem('this Session has no working directory to attach files from')
    return message.cwd
  }

  /**
   * Read a draft back: what Gmail holds is what the gate decides on, what the owner is asked about, and what the
   * fingerprint covers. The recipients come from the draft's RFC 5322 text, which `drafts.send` sends from.
   */
  private static async draftFacts(api: GmailApi, draftId: string): Promise<DraftFacts> {
    const [draft, raw] = await Promise.all([api.draft(draftId), api.draftRaw(draftId)])
    const headers = rawHeaders(raw)
    const payload = draft.message?.payload
    const view = messageView({ id: draft.message?.id ?? draft.id, threadId: draft.message?.threadId ?? '', payload }, { maxChars: Number.MAX_SAFE_INTEGER, maxHtmlChars: 1_000_000, keepQuotes: true })
    return {
      draftId: draft.id,
      threadId: draft.message?.threadId ?? null,
      from: header(payload, 'From'),
      to: addressesIn(headers('To')),
      cc: addressesIn(headers('Cc')),
      bcc: addressesIn(headers('Bcc')),
      subject: header(payload, 'Subject'),
      text: view.text,
      attachments: view.attachments.map(entry => `${entry.filename} (${entry.size} B)`),
      fingerprint: createHash('sha256').update(raw, 'latin1').digest('hex'),
    }
  }

  /**
   * Write a draft, or replace one.
   * @param account - account id.
   * @param message - the message.
   * @param draftId - the draft to replace; a held one cannot be changed.
   * @returns the draft.
   */
  draft(account: string, message: Outgoing, draftId?: string): Promise<DraftOutcome> {
    return this.run(account, draftId === undefined ? 'draft' : 'update draft', async (api, row) => {
      if (row.policy === 'read-only') throw new GmailError('refused', 'this account is read-only: the owner allows no drafts, sends, or changes from you')
      if (draftId !== undefined) this.assertNotHeld(await this.ready, draftId)
      const prepared = await this.prepare(api, row, message)
      const draft = draftId === undefined
        ? await api.createDraft(prepared.raw, prepared.threadId)
        : await api.updateDraft(draftId, prepared.raw, prepared.threadId)
      const domain = await this.ready
      await this.activity(domain, account, 'drafted', `${prepared.recipients.join(', ') || '(no recipients)'}: ${prepared.subject.slice(0, 120)}`)
      const threadId = draft.message?.threadId ?? prepared.threadId ?? null
      return { draftId: draft.id, threadId, recipients: prepared.recipients, subject: prepared.subject }
    }, result => `${result.draftId} to ${result.recipients.length} recipient(s)`)
  }

  private assertNotHeld(domain: Domain<typeof gmailDomain>, draftId: string): void {
    const held = Array.from(domain.table('pending').entries()).find(([, row]) => row.draftId === draftId && row.status === 'held')
    if (held !== undefined) throw new GmailError('refused', 'this draft waits for the owner\'s confirmation and cannot be changed or sent by you; write a new one instead')
  }

  /**
   * Send a message or a draft, or hold it for the owner, by the account's policy and the turn.
   * @param account - account id.
   * @param request - a new message, or a draft id.
   * @param turn - the turn's facts, read from the Session log.
   * @returns sent, or held with its reason.
   * @throws GmailError `refused` on a read-only account, `limit` over the daily cap.
   */
  send(account: string, request: SendRequest, turn: TurnFacts): Promise<SendOutcome> {
    return this.run(account, request.kind === 'new' ? 'send' : 'send draft', async (api, row) => {
      const domain = await this.ready
      if (row.policy === 'read-only') {
        await this.activity(domain, account, 'refused', `read-only account (${turn.origin})`)
        throw new GmailError('refused', 'this account is read-only: the owner allows no drafts, sends, or changes from you')
      }
      if (request.kind === 'draft') this.assertNotHeld(domain, request.draftId)
      const outgoing: Prepared | DraftFacts = request.kind === 'new' ? await this.prepare(api, row, request.message) : await ForkGmail.draftFacts(api, request.draftId)
      const recipients = 'raw' in outgoing ? outgoing.recipients : [...outgoing.to, ...outgoing.cc, ...outgoing.bcc]
      if (recipients.length === 0) throw new AddressProblem('the message has no recipient')
      const trusted = this.trusted(domain)
      const vouched = row.policy === 'confirm-untrusted' && turn.clean ? await this.vouched(api, turn, recipients, trusted) : new Set<string>()
      const decision = decideSend(row.policy, turn, recipients, { trusted, vouched })
      switch (decision.kind) {
        /* v8 ignore next 3 -- the read-only refusal above returns first; decideSend refuses nothing else today. */
        case 'refuse':
          await this.activity(domain, account, 'refused', decision.reason)
          throw new GmailError('refused', decision.reason)
        case 'send': {
          await this.assertCap(domain, account, turn.origin)
          const sent = 'raw' in outgoing ? await api.send(outgoing.raw, outgoing.threadId) : await api.sendDraft(outgoing.draftId)
          await this.recordSend(domain, account, `${recipients.join(', ')} (${turn.origin})`)
          return { kind: 'sent', messageId: sent.id, threadId: sent.threadId, recipients }
        }
        case 'hold': {
          const facts = 'raw' in outgoing ? await ForkGmail.draftFacts(api, (await api.createDraft(outgoing.raw, outgoing.threadId)).id) : outgoing
          const noticeSent = await this.hold(domain, row, facts, decision.reason, turn)
          return { kind: 'held', reason: decision.reason, draftId: facts.draftId, noticeSent, recipients }
        }
        /* v8 ignore next 2 -- GateDecision is a closed union; the default only makes a new kind a compile error. */
        default:
          return assertNever(decision)
      }
    }, result => `${result.kind} to ${result.recipients.join(', ')}`)
  }

  /** The recipients the owner vouched for: named this turn, or written to from this account before. */
  private async vouched(api: GmailApi, turn: TurnFacts, recipients: readonly string[], trusted: ReadonlySet<string>): Promise<Set<string>> {
    const vouched = new Set<string>()
    for (const address of recipients) {
      if (trusted.has(address)) continue
      if (namedByOwner(turn, address)) {
        vouched.add(address)
        continue
      }
      const sent = await api.listThreads(`in:sent (to:"${address}" OR cc:"${address}" OR bcc:"${address}")`, 1)
      if ((sent.threads ?? []).length > 0) vouched.add(address)
    }
    return vouched
  }

  private async assertCap(domain: Domain<typeof gmailDomain>, account: string, origin: string): Promise<void> {
    const recent = this.recentSends(domain, account, Date.now())
    if (recent.length < this.config.maxSendsPerDay) return
    await this.activity(domain, account, 'refused', `daily cap of ${this.config.maxSendsPerDay} reached (${origin})`)
    throw new GmailError('limit', `this account already sent ${recent.length} messages in 24 hours, the owner's limit; nothing was sent`)
  }

  private async recordSend(domain: Domain<typeof gmailDomain>, account: string, detail: string): Promise<void> {
    const now = Date.now()
    await domain.table('sends').put(account, { at: [...this.recentSends(domain, account, now), now] })
    await this.activity(domain, account, 'sent', detail)
  }

  /** Store a held message and tell the owner. */
  private async hold(
    domain: Domain<typeof gmailDomain>, row: AccountRecord, facts: DraftFacts, reason: string, turn: TurnFacts,
  ): Promise<boolean> {
    const table = domain.table('pending')
    let code: string
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
    } while (table.get(code) !== undefined)
    const preview = Array.from(facts.text).slice(0, PREVIEW_CHARS).join('')
    const record: PendingRecord = {
      code, account: row.id, from: facts.from || row.email, draftId: facts.draftId, threadId: facts.threadId,
      to: [...facts.to], cc: [...facts.cc], bcc: [...facts.bcc], subject: facts.subject, preview, attachments: [...facts.attachments],
      createdAt: Date.now(), origin: turn.origin, reason, sessionId: turn.sessionId ?? null, status: 'held',
      resolvedAt: null, resolvedBy: null, messageId: null, noticeSent: false, fingerprint: facts.fingerprint,
    }
    const lines = [
      `发件：${record.from}`,
      `收件：${record.to.join(', ') || '（无）'}`,
      ...record.cc.length > 0 ? [`抄送：${record.cc.join(', ')}`] : [],
      ...record.bcc.length > 0 ? [`密送：${record.bcc.join(', ')}`] : [],
      `主题：${record.subject}`,
      ...record.attachments.length > 0 ? [`附件：${record.attachments.join('，')}`] : [],
      `为什么要确认：${reason}`,
      '',
      '正文开头：',
      `${preview}${Array.from(facts.text).length > PREVIEW_CHARS ? '…' : ''}`,
      '',
      `要发就回复「发送 ${code}」；不发就不用管，${this.config.confirmTtlHours} 小时后作废（草稿留在 Gmail）。也可以在 设置 → 邮箱 里确认或丢弃。`,
    ]
    await table.put(code, record)
    const noticeSent = await this.notify({ title: `✉️ 待你确认：${row.id} 发给 ${record.to[0] ?? record.cc[0] ?? record.bcc[0] ?? ''}${record.to.length + record.cc.length + record.bcc.length > 1 ? ' 等' : ''}`, body: lines.join('\n'), kinds: ['gmail.send.held'] })
    if (noticeSent) await table.put(code, { ...record, noticeSent })
    await this.activity(domain, row.id, 'held', `${[...record.to, ...record.cc, ...record.bcc].join(', ')}: ${reason}`)
    await this.prune(domain)
    return noticeSent
  }

  /**
   * Send a held message the owner confirmed.
   * @param code - the held message's code, in any case.
   * @param how - from Settings, or from the owner's own turn (whose words must hold the code).
   * @returns the sent message.
   * @throws GmailError when the code is unknown, resolved, or expired, the turn does not confirm, the draft changed, or the cap is reached.
   */
  confirm(code: string, how: { readonly by: 'settings' } | { readonly by: 'owner-turn'; readonly turn: TurnFacts }): Promise<{ readonly account: string; readonly messageId: string; readonly threadId: string }> {
    return this.serialize(async () => {
      const domain = await this.ready
      await this.expire(domain, Date.now())
      const key = code.trim().toUpperCase()
      const record = domain.table('pending').get(key)
      if (record === undefined) throw new GmailError('not-found', `no held message has the code ${key}`)
      if (record.status !== 'held') throw new GmailError('expired', `the message with the code ${key} was already ${record.status}`)
      if (how.by === 'owner-turn' && !ownerConfirms(how.turn, key)) {
        throw new GmailError('refused', `only the owner confirms a held message: in a turn the owner started alone whose own message holds ${key}, before any mail or web page is read in it, or in Settings → 邮箱`)
      }
      return this.run(record.account, 'confirm', async (api, row) => {
        if (row.policy === 'read-only') throw new GmailError('refused', 'the account became read-only; the held message was not sent')
        let facts: DraftFacts
        try {
          facts = await ForkGmail.draftFacts(api, record.draftId)
        } catch (error: unknown) {
          if (!(error instanceof GmailApiError && error.failure === 'not-found')) throw error
          await this.resolve(domain, record, 'discarded', how.by)
          throw new GmailError('not-found', 'the held draft is no longer in Gmail; nothing was sent')
        }
        if (facts.fingerprint !== record.fingerprint) {
          await this.resolve(domain, record, 'discarded', how.by)
          await this.activity(domain, record.account, 'refused', `held draft ${key} changed after the notice`)
          throw new GmailError('refused', 'the held draft was changed after the owner was asked; nothing was sent, and the hold is discarded')
        }
        await this.assertCap(domain, record.account, how.by)
        const sent = await api.sendDraft(record.draftId)
        await this.resolve(domain, record, 'sent', how.by, sent.id)
        await this.recordSend(domain, record.account, `${[...record.to, ...record.cc, ...record.bcc].join(', ')} (confirmed ${key} via ${how.by})`)
        return { account: record.account, messageId: sent.id, threadId: sent.threadId }
      }, () => `${key} via ${how.by}`)
    })
  }

  /**
   * Drop a held message: its draft is deleted from Gmail.
   * @param code - the held message's code.
   */
  discard(code: string): Promise<void> {
    return this.serialize(async () => {
      const domain = await this.ready
      const key = code.trim().toUpperCase()
      const record = domain.table('pending').get(key)
      if (record?.status !== 'held') throw new GmailError('not-found', `no held message has the code ${key}`)
      try {
        await this.api(record.account).deleteDraft(record.draftId)
      } catch (error: unknown) {
        this.ctx.logger.info(`fork-gmail: ${record.account}: the draft of ${key} could not be deleted (${errorText(error)}); the hold is dropped anyway`)
      }
      await this.resolve(domain, record, 'discarded', 'settings')
      this.ctx.logger.info(`fork-gmail: ${record.account}: held ${key} discarded`)
    })
  }

  private async resolve(domain: Domain<typeof gmailDomain>, record: PendingRecord, status: 'sent' | 'discarded' | 'expired', by: 'settings' | 'owner-turn' | 'expiry', messageId?: string): Promise<void> {
    await domain.table('pending').put(record.code, { ...record, status, resolvedAt: Date.now(), resolvedBy: by, messageId: messageId ?? null })
    const kind = status === 'sent' ? 'confirmed' : status
    await this.activity(domain, record.account, kind, `${record.code}: ${record.subject.slice(0, 120)}`)
  }

  /** Expire held messages past their time. */
  private async expire(domain: Domain<typeof gmailDomain>, now: number): Promise<void> {
    const ttl = this.config.confirmTtlHours * 3_600_000
    for (const [, record] of Array.from(domain.table('pending').entries())) {
      if (record.status === 'held' && now - record.createdAt > ttl) {
        await this.resolve(domain, record, 'expired', 'expiry')
        this.ctx.logger.info(`fork-gmail: ${record.account}: held ${record.code} expired`)
      }
    }
  }

  /** Keep the latest resolved holds and activity lines. */
  private async prune(domain: Domain<typeof gmailDomain>): Promise<void> {
    const resolved = Array.from(domain.table('pending').entries()).filter(([, row]) => row.status !== 'held')
    const staleHolds = resolved.sort(([, a], [, b]) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(RESOLVED_KEPT).map(([key]) => key)
    if (staleHolds.length > 0) await domain.table('pending').deleteMany(staleHolds)
  }

  /**
   * Change labels on threads: read state, inbox, star, trash, or a label of the account's own.
   * @param account - account id.
   * @param threadIds - threads to change.
   * @param action - the change.
   * @param label - the label name, for `label` and `unlabel`.
   * @returns how many threads changed.
   */
  modify(account: string, threadIds: readonly string[], action: ModifyAction, label?: string): Promise<{ readonly changed: number }> {
    return this.run(account, `modify ${action}`, async (api, row) => {
      if (row.policy === 'read-only') throw new GmailError('refused', 'this account is read-only: the owner allows no drafts, sends, or changes from you')
      if (threadIds.length === 0 || threadIds.length > MAX_MODIFY_THREADS) throw new GmailError('invalid', `give between 1 and ${MAX_MODIFY_THREADS} thread ids`)
      let add: string[] = []
      let remove: string[] = []
      switch (action) {
        case 'read': remove = ['UNREAD']; break
        case 'unread': add = ['UNREAD']; break
        case 'archive': remove = ['INBOX']; break
        case 'inbox': add = ['INBOX']; break
        case 'star': add = ['STARRED']; break
        case 'unstar': remove = ['STARRED']; break
        case 'trash':
        case 'untrash':
          for (const id of threadIds) await api.trashThread(id, action === 'untrash')
          return { changed: threadIds.length }
        case 'label':
        case 'unlabel': {
          const wanted = (label ?? '').trim().toLowerCase()
          if (wanted === '') throw new GmailError('invalid', 'label and unlabel need the label name')
          const labels = await api.labels()
          const found = labels.find(entry => entry.name.toLowerCase() === wanted || entry.id.toLowerCase() === wanted)
          if (found === undefined) throw new GmailError('not-found', `no label "${label}"; the account has: ${labels.filter(entry => entry.type !== 'system').map(entry => entry.name).slice(0, 40).join(', ') || 'no labels of its own'}`)
          if (action === 'label') add = [found.id]
          else remove = [found.id]
          break
        }
        /* v8 ignore next 2 -- ModifyAction is a closed union; the default only makes a new action a compile error. */
        default:
          return assertNever(action)
      }
      for (const id of threadIds) await api.modifyThread(id, add, remove)
      await this.activity(await this.ready, account, 'modified', `${action}${label === undefined ? '' : ` ${label}`} on ${threadIds.length} thread(s)`)
      return { changed: threadIds.length }
    }, result => `${result.changed} thread(s)`)
  }

  // ── sign-in and Settings ───────────────────────────────────────────────────

  /**
   * Start a Google sign-in for one account.
   * @param request - the account id, its policy when new, an address hint, and the origin Settings runs on.
   * @returns the consent page address.
   */
  async beginSignIn(request: SignInRequest): Promise<{ readonly url: string; readonly redirectUri: string }> {
    if (!ACCOUNT_ID.test(request.account)) throw new GmailError('invalid', 'an account id is lower-case letters, digits, and -, a letter first, at most 24 characters (work, personal, bot)')
    if (request.policy !== undefined && !SEND_POLICIES.includes(request.policy)) throw new GmailError('invalid', `unknown policy ${request.policy}`)
    const redirectUri = this.redirectUri(request.origin)
    const client = await this.client()
    const now = Date.now()
    for (const [state, open] of this.signIns) if (now - open.createdAt > SIGN_IN_TTL_MS) this.signIns.delete(state)
    if (this.signIns.size >= MAX_SIGN_INS) throw new GmailError('limit', 'too many sign-ins are open; finish one or wait ten minutes')
    const domain = await this.ready
    const existing = domain.table('accounts').get(request.account)
    const { verifier, challenge } = pkcePair()
    const state = newState()
    this.signIns.set(state, { account: request.account, verifier, redirectUri, createdAt: now, policy: request.policy ?? existing?.policy ?? 'confirm-untrusted' })
    const loginHint = request.loginHint?.trim() || existing?.email
    this.ctx.logger.info(`fork-gmail: sign-in started for ${request.account}${existing === undefined ? ' (new)' : ''}, redirect ${redirectUri}`)
    return { url: authorizationUrl(client, { redirectUri, scopes: [GMAIL_SCOPE], state, challenge, loginHint }), redirectUri }
  }

  private redirectUri(origin: string): string {
    if (this.config.redirectUri !== '') return this.config.redirectUri
    if (!/^https:\/\/[^\s/]+$|^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u.test(origin)) {
      throw new GmailError('invalid', `Google signs in only to an https page (or localhost); this page runs on ${origin.slice(0, 100)}. Open Settings over https or set redirectUri`)
    }
    return `${origin}${OAUTH_PATH}`
  }

  /**
   * Finish a sign-in from Google's redirect.
   * @param answer - the redirect's `state`, `code`, and `error` parameters.
   * @returns the connected account.
   */
  async completeSignIn(answer: SignInAnswer): Promise<AccountView> {
    const open = this.signIns.get(answer.state)
    this.signIns.delete(answer.state)
    if (open === undefined || Date.now() - open.createdAt > SIGN_IN_TTL_MS) throw new GmailError('expired', 'this sign-in link expired or was already used; start again in Settings → 邮箱')
    if (answer.error !== undefined || answer.code === undefined) throw new GmailError('denied', `Google did not grant access (${(answer.error ?? 'no code').slice(0, 80)})`)
    const client = await this.client()
    let tokens
    try {
      tokens = await exchangeCode(client, open, answer.code, { timeoutMs: this.config.requestTimeoutMs })
    } catch (error: unknown) {
      throw new GmailError('api', errorText(error))
    }
    if (!tokens.scope.split(' ').includes(GMAIL_SCOPE)) {
      throw new GmailError('denied', 'Google granted no Gmail access: on the consent page, tick the box that lets the app read, compose, and send mail')
    }
    const access = tokens.accessToken
    const api = new GmailApi({ timeoutMs: this.config.requestTimeoutMs, accessToken: () => Promise.resolve(access) })
    let email: string
    let name: string
    try {
      email = (await api.profile()).emailAddress
      name = cleanName(await api.displayName())
    } catch (error: unknown) {
      throw new GmailError('api', errorText(error))
    }
    return this.serialize(async () => {
      const domain = await this.ready
      const accounts = domain.table('accounts')
      const lower = email.toLowerCase()
      const clash = Array.from(accounts.entries()).find(([id, row]) => id !== open.account && row.email.toLowerCase() === lower)
      if (clash !== undefined) throw new GmailError('invalid', `${email} is already connected as "${clash[0]}"`)
      const existing = accounts.get(open.account)
      if (existing !== undefined && existing.email.toLowerCase() !== email.toLowerCase()) {
        throw new GmailError('invalid', `account "${open.account}" is ${existing.email}; sign in as that address, or remove the account first`)
      }
      const grant: Grant = { email, refreshToken: tokens.refreshToken, scope: tokens.scope, grantedAt: Date.now() }
      await this.ctx.credentials.modifyRecord(credentialKey(GRANT_SCOPE, open.account), () => Promise.resolve({ kind: 'grant', payload: grant }))
      this.tokens.set(open.account, { token: access, expiresAt: tokens.expiresAt })
      const row: AccountRecord = {
        id: open.account, email, name, policy: existing?.policy ?? open.policy, addedAt: existing?.addedAt ?? Date.now(),
        lastOkAt: Date.now(), lastError: null, needsReconnect: false, reconnectNoticeAt: null,
      }
      await accounts.put(open.account, row)
      await this.activity(domain, open.account, 'connected', `${email}, policy ${row.policy}`)
      this.ctx.logger.info(`fork-gmail: ${open.account} connected as ${email} (policy ${row.policy})`)
      return this.view(domain, row, Date.now())
    })
  }

  /**
   * Disconnect an account: revoke its token at Google, delete it, and drop its held messages.
   * @param account - account id.
   */
  removeAccount(account: string): Promise<void> {
    return this.serialize(async () => {
      const domain = await this.ready
      const row = domain.table('accounts').get(account)
      if (row === undefined) throw new GmailError('unknown-account', `no Gmail account "${account}"`)
      const grant = await this.grant(account)
      const revoked = grant === undefined ? 'no token stored' : await revoke(grant.refreshToken, { timeoutMs: this.config.requestTimeoutMs })
      await this.ctx.credentials.deleteRecord(credentialKey(GRANT_SCOPE, account))
      this.tokens.delete(account)
      for (const [, record] of Array.from(domain.table('pending').entries())) {
        if (record.account === account && record.status === 'held') await this.resolve(domain, record, 'discarded', 'settings')
      }
      await domain.table('accounts').deleteMany([account])
      await domain.table('sends').deleteMany([account])
      await this.activity(domain, account, 'removed', `${row.email}${revoked === null ? '' : ` (revocation: ${revoked})`}`)
      this.ctx.logger.info(`fork-gmail: ${account} (${row.email}) removed${revoked === null ? ', token revoked' : `; revocation: ${revoked}`}`)
    })
  }

  /**
   * Change an account's send policy.
   * @param account - account id.
   * @param policy - the new policy.
   */
  setPolicy(account: string, policy: SendPolicy): Promise<void> {
    return this.serialize(async () => {
      if (!SEND_POLICIES.includes(policy)) throw new GmailError('invalid', `unknown policy ${policy}`)
      const domain = await this.ready
      const row = domain.table('accounts').get(account)
      if (row === undefined) throw new GmailError('unknown-account', `no Gmail account "${account}"`)
      await domain.table('accounts').put(account, { ...row, policy })
      await this.activity(domain, account, 'policy', `${row.policy} → ${policy}`)
      this.ctx.logger.info(`fork-gmail: ${account} policy ${row.policy} → ${policy}`)
    })
  }

  /**
   * Store the OAuth client from Google's downloaded JSON.
   * @param text - the JSON file's text.
   * @returns the client as Settings shows it.
   */
  async setClient(text: string): Promise<ClientInfo> {
    let parsed: { client_id: string; client_secret: string }
    try {
      const result = clientFileSchema.safeParse(JSON.parse(text))
      if (!result.success) throw new GmailError('invalid', 'the JSON has no client_id and client_secret (download it from Google Cloud → Credentials → OAuth client)')
      parsed = result.data
    } catch (error: unknown) {
      if (error instanceof GmailError) throw error
      throw new GmailError('invalid', 'that is not JSON; paste the whole client file Google gave you')
    }
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/u.test(parsed.client_id) || parsed.client_secret.trim() === '') {
      throw new GmailError('invalid', 'the client id must end in .apps.googleusercontent.com and the secret must not be empty')
    }
    await this.ctx.credentials.set(credentialRef(this.config.clientIdEnv), parsed.client_id)
    await this.ctx.credentials.set(credentialRef(this.config.clientSecretEnv), parsed.client_secret.trim())
    this.ctx.logger.info(`fork-gmail: OAuth client stored (${parsed.client_id.slice(0, 12)}…)`)
    return this.clientInfo()
  }

  /**
   * The OAuth client's state.
   * @returns whether it is set, and its id (not secret).
   */
  async clientInfo(): Promise<ClientInfo> {
    const [id, secret] = await Promise.all([
      this.ctx.credentials.resolve(credentialRef(this.config.clientIdEnv)),
      this.ctx.credentials.describe(credentialRef(this.config.clientSecretEnv)),
    ])
    return { configured: id !== undefined && secret.configured, clientId: id?.value ?? null, secretConfigured: secret.configured }
  }

  /**
   * Everything Settings shows.
   * @returns a snapshot.
   */
  async status(): Promise<GmailStatus> {
    const domain = await this.ready
    await this.serialize(() => this.expire(domain, Date.now()))
    const pending = Array.from(domain.table('pending').entries(), ([, row]) => row)
    return {
      client: await this.clientInfo(),
      redirectUri: this.config.redirectUri === '' ? null : this.config.redirectUri,
      accounts: this.accounts(),
      pending: [
        ...pending.filter(row => row.status === 'held').sort((a, b) => a.createdAt - b.createdAt),
        ...pending.filter(row => row.status !== 'held').sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)),
      ],
      activity: Array.from(domain.table('activity').entries(), ([, row]) => row).sort((a, b) => b.seq - a.seq).slice(0, 50),
      maxSendsPerDay: this.config.maxSendsPerDay,
      confirmTtlHours: this.config.confirmTtlHours,
      trustedRecipients: this.config.trustedRecipients,
    }
  }

  /**
   * The held messages, oldest first.
   * @returns every message waiting for the owner.
   */
  async held(): Promise<PendingRecord[]> {
    const domain = await this.ready
    await this.serialize(() => this.expire(domain, Date.now()))
    return Array.from(domain.table('pending').entries(), ([, row]) => row).filter(row => row.status === 'held').sort((a, b) => a.createdAt - b.createdAt)
  }

  // ── shared helpers ─────────────────────────────────────────────────────────

  private activity(domain: Domain<typeof gmailDomain>, account: string, kind: ActivityRecord['kind'], detail: string): Promise<void> {
    const result = this.activityChain.then(() => this.appendActivity(domain, account, kind, detail))
    this.activityChain = result.catch(() => undefined)
    return result
  }

  private async appendActivity(domain: Domain<typeof gmailDomain>, account: string, kind: ActivityRecord['kind'], detail: string): Promise<void> {
    const table = domain.table('activity')
    const entries = Array.from(table.entries())
    const seq = Math.max(0, ...entries.map(([, row]) => row.seq)) + 1
    await table.put(String(seq).padStart(10, '0'), { seq, at: Date.now(), account, kind, detail: detail.slice(0, 500) })
    if (entries.length + 1 > ACTIVITY_KEPT) {
      await table.deleteMany(entries.sort(([, a], [, b]) => a.seq - b.seq).slice(0, entries.length + 1 - ACTIVITY_KEPT).map(([key]) => key))
    }
  }

  /** Send the owner a notice; false (and a warning) when it could not be handed over. */
  private async notify(note: { readonly title: string; readonly body: string; readonly kinds: readonly string[] }): Promise<boolean> {
    const notifier = this.ctx.get('forkNotifier')
    if (notifier === undefined) {
      this.ctx.logger.warn(`fork-gmail: could not send "${note.title}": no forkNotifier service is mounted`)
      return false
    }
    try {
      await notifier.send({ ...note, origin: NOTE_ORIGIN })
      return true
    } catch (error: unknown) {
      this.ctx.logger.warn(`fork-gmail: could not send "${note.title}": ${errorText(error)}`)
      return false
    }
  }
}

/** Who the copy of a notice in the owner's chat Session comes from; never shown to the owner. */
const NOTE_ORIGIN = 'the Gmail send gate (fork-gmail: fixed rules, not a model); a held message goes out only when the owner\'s own next message holds its code and you then call gmail_send with that code, or when the owner confirms it in Settings'

/**
 * The header lookup of an RFC 5322 text: folded lines joined, names compared without case.
 * @param raw - the message text.
 * @returns a function from a header name to its values joined by `, `.
 */
function rawHeaders(raw: string): (name: string) => string {
  const end = raw.search(/\r?\n\r?\n/u)
  const lines = (end === -1 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/gu, ' ').split(/\r?\n/u)
  return (name) => {
    const wanted = `${name.toLowerCase()}:`
    return lines.filter(line => line.toLowerCase().startsWith(wanted)).map(line => line.slice(wanted.length).trim()).join(', ')
  }
}

/** A closed union ran out of cases. */
/* v8 ignore next 3 -- closed-union backstop; its only call sites are the ignored defaults above. */
function assertNever(value: never): never {
  throw new Error(`unhandled case ${String(value)}`)
}

export default ForkGmail
