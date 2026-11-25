/**
 * The owner's Gmail accounts in DSH, as `ctx.gmail`: one Google sign-in per account (work, personal, a bot, any
 * number), the refresh tokens in the credential store, and every read, draft, send, and label change the tools make.
 * Whether a message goes out is decided here, by the send gate over the account's policy and the turn's origin; a
 * held message becomes a Gmail draft and a WeChat notice this service writes, and goes out only when the owner
 * confirms it in Settings or with the code in a turn of their own. A changed draft, an expired hold, or an account
 * over its daily send cap is never sent.
 *
 * @module @deepseek-ai/dsh-gmail
 */

import { Context, Service } from '@deepseek-ai/cordis'
// Type-only: ctx.credentials.
import type {} from '@deepseek-ai/dsh-credentials'
// Type-only: ctx.get('ownerNotifier').
import type {} from '@deepseek-ai/dsh-event-bus'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { ConnectedAccounts } from './accounts.ts'
import type { ModifyAction } from './actions.ts'
import { ActivityLog, latestActivity } from './activity.ts'
import { parseMailbox } from './address.ts'
import type { SendPolicy, TurnFacts } from './gate.ts'
import { Holds } from './holds.ts'
import type { MessageView } from './message.ts'
import { modifyThreads } from './modify.ts'
import { OwnerNotices } from './notices.ts'
import { OAuthClientStore } from './oauth-client.ts'
import { Outbox } from './outbox.ts'
import { MailReader } from './read.ts'
import { SendCap } from './send-cap.ts'
import { SerialQueue } from './serial.ts'
import { SignIns } from './sign-in.ts'
import { OAUTH_PATH, oauthRedirect } from './sign-in-store.ts'
import { gmailDomain, type PendingRecord } from './storage.ts'
import { AccountTokens } from './tokens.ts'
import type {
  AccountView, ClientInfo, DraftOutcome, GmailStatus, Outgoing, SavedAttachment, SearchOptions, SearchResult, SendOutcome, SendRequest,
  SignInAnswer, SignInRequest, ThreadView,
} from './types.ts'

export type * from './address.ts'
export { AddressProblem } from './address.ts'
export type * from './api.ts'
export { GmailApiError } from './api.ts'
export type * from './attachments.ts'
export { AttachmentProblem } from './attachments.ts'
export { GmailError, type GmailFailure } from './errors.ts'
export type * from './gate.ts'
export type * from './html.ts'
export type * from './message.ts'
export type * from './mime.ts'
export type { ModifyAction } from './actions.ts'
export type * from './oauth.ts'
export { OAuthError } from './oauth.ts'
export type * from './storage.ts'
export type * from './types.ts'

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  if (config.redirectUri !== '' && oauthRedirect(config.redirectUri) === undefined) {
    throw new Error(`gmail: redirectUri must be an https URL (or http on localhost) with path ${OAUTH_PATH} and no credentials, query or fragment`)
  }
  for (const address of config.trustedRecipients) {
    try {
      parseMailbox(address)
    } catch {
      // AddressProblem: reported as a load failure below, with the value.
      throw new Error(`gmail: trustedRecipients entry "${address}" is not an email address`)
    }
  }
}

/** Plugin configuration. */
export interface Config {
  /** Name of the OAuth client id in the credential store or `$DSH_HOME/.env`. */
  clientIdEnv: string
  /** Name of the OAuth client secret in the credential store or `$DSH_HOME/.env`. */
  clientSecretEnv: string
  /** Redirect URI registered at Google; empty derives `<Settings origin>/gmail.oauth`. */
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    gmail: Gmail
  }
}

/**
 * The owner's Gmail accounts.
 */
export class Gmail extends Service {
  static inject = ['storageDomain', 'credentials']
  /** Configuration schema. */
  static Config: z<Config> = z.object({
    clientIdEnv: z.string().default('GMAIL_CLIENT_ID').description('Name of the Google OAuth client id in the credential store or $DSH_HOME/.env.'),
    clientSecretEnv: z.string().default('GMAIL_CLIENT_SECRET').description('Name of the Google OAuth client secret in the credential store or $DSH_HOME/.env.'),
    redirectUri: z.string().default('').description('Redirect URI registered at Google; empty derives <Settings origin>/gmail.oauth.'),
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

  private readonly ready: Promise<Domain<typeof gmailDomain>>
  private domain: Domain<typeof gmailDomain> | undefined
  /** Storage writes that read and replace, one at a time: confirmations, discards, sign-ins, removals, policies, expiry. */
  private readonly writes = new SerialQueue()
  private readonly activity = new ActivityLog()
  private readonly oauthClient: OAuthClientStore
  private readonly tokens: AccountTokens
  private readonly holds: Holds
  private readonly connected: ConnectedAccounts
  private readonly reader: MailReader
  private readonly outbox: Outbox
  private readonly signIns: SignIns

  /**
   * @param ctx - Host with storage and credentials.
   * @param config - OAuth client names, limits, and trusted recipients.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'gmail')
    assertConfig(config)
    this.ready = ctx.storageDomain.open(gmailDomain)
    ctx.effect(() => async () => {
      await this.writes.idle()
      const domain = await this.ready
      await domain.close()
    }, 'gmail: domain lifetime')
    const { credentials, logger } = ctx
    const activity = this.activity
    const notices = new OwnerNotices({ notifier: () => ctx.get('ownerNotifier'), logger })
    const cap = new SendCap({ maxSendsPerDay: config.maxSendsPerDay, activity })
    this.oauthClient = new OAuthClientStore({
      credentials, clientIdEnv: config.clientIdEnv, clientSecretEnv: config.clientSecretEnv, logger,
    })
    const client = () => this.oauthClient.client()
    this.tokens = new AccountTokens({
      credentials, client, requestTimeoutMs: config.requestTimeoutMs, logger,
      needsReconnect: (account, why) => this.connected.markReconnect(account, why),
    })
    this.holds = new Holds({ confirmTtlHours: config.confirmTtlHours, api: account => this.tokens.api(account), activity, notices, logger })
    this.connected = new ConnectedAccounts({ ready: this.ready, tokens: this.tokens, cap, holds: this.holds, activity, notices, logger })
    this.reader = new MailReader(config)
    this.outbox = new Outbox({
      ready: this.ready, trustedRecipients: config.trustedRecipients, maxAttachmentBytes: config.maxAttachmentBytes,
      holds: this.holds, cap, activity,
    })
    this.signIns = new SignIns({
      ready: this.ready, client, redirectUri: config.redirectUri, requestTimeoutMs: config.requestTimeoutMs, logger,
    })
  }

  /** Prune unfinished sign-ins and expired holds before the service is ready. */
  async [Service.init](): Promise<void> {
    const domain = await this.ready
    await this.signIns.prune()
    this.domain = domain
    await this.holds.expire(domain, Date.now())
    const accounts = Array.from(domain.table('accounts').entries(), ([, row]) => row)
    const held = this.holds.held(domain).length
    this.ctx.logger.info(`gmail: ${accounts.length} account(s)${accounts.length === 0 ? '' : ` (${accounts.map(row => `${row.id} ${row.policy}${row.needsReconnect ? ' needs-reconnect' : ''}`).join(', ')})`}, ${held} held message(s), cap ${this.config.maxSendsPerDay}/day`)
  }

  // ── accounts ────────────────────────────────────────────────────────────────

  /**
   * Every connected account, in id order.
   * @returns the accounts without tokens.
   */
  accounts(): AccountView[] {
    const domain = this.domain
    if (domain === undefined) return []
    return this.connected.list(domain)
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
    return this.connected.run(account, 'search', api => this.reader.search(api, query, options), result => `${result.threads.length} thread(s)`)
  }

  /**
   * Read one thread: its newest messages in full.
   * @param account - account id.
   * @param threadId - thread id.
   * @param keepQuotes - keep the quoted history of each reply.
   * @returns the thread.
   */
  thread(account: string, threadId: string, keepQuotes: boolean = false): Promise<ThreadView> {
    return this.connected.run(account, 'read thread', api => this.reader.thread(api, threadId, keepQuotes), result => `${result.messages.length} message(s)`)
  }

  /**
   * Read one message.
   * @param account - account id.
   * @param messageId - message id.
   * @param keepQuotes - keep the quoted history.
   * @returns the message.
   */
  message(account: string, messageId: string, keepQuotes: boolean = false): Promise<MessageView> {
    return this.connected.run(account, 'read message', api => this.reader.message(api, messageId, keepQuotes))
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
    return this.connected.run(account, 'attachment', api => this.reader.download(api, messageId, part, cwd), result => `${result.bytes} bytes`)
  }

  // ── writing ─────────────────────────────────────────────────────────────────

  /**
   * Write a draft, or replace one.
   * @param account - account id.
   * @param message - the message.
   * @param draftId - the draft to replace; a held one cannot be changed.
   * @returns the draft.
   */
  draft(account: string, message: Outgoing, draftId?: string): Promise<DraftOutcome> {
    return this.connected.run(
      account, draftId === undefined ? 'draft' : 'update draft', (api, row) => this.outbox.draft(api, row, message, draftId),
      result => `${result.draftId} to ${result.recipients.length} recipient(s)`,
    )
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
    return this.connected.run(
      account, request.kind === 'new' ? 'send' : 'send draft', (api, row) => this.outbox.send(api, row, request, turn),
      result => `${result.kind} to ${result.recipients.join(', ')}`,
    )
  }

  /**
   * Send a held message the owner confirmed.
   * @param code - the held message's code, in any case.
   * @param how - from Settings, or from the owner's own turn (whose words must hold the code).
   * @returns the sent message.
   * @throws GmailError when the code is unknown, resolved, or expired, the turn does not confirm, the draft changed, or the cap is reached.
   */
  confirm(code: string, how: { readonly by: 'settings' } | { readonly by: 'owner-turn'; readonly turn: TurnFacts }): Promise<{ readonly account: string; readonly messageId: string; readonly threadId: string }> {
    return this.writes.run(async () => {
      const domain = await this.ready
      const { key, record } = await this.holds.claim(domain, code, how)
      return this.connected.run(record.account, 'confirm', (api, row) => this.outbox.confirm(api, row, domain, key, record, how.by), () => `${key} via ${how.by}`)
    })
  }

  /**
   * Drop a held message: its draft is deleted from Gmail.
   * @param code - the held message's code.
   */
  discard(code: string): Promise<void> {
    return this.writes.run(async () => this.holds.discard(await this.ready, code))
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
    const recordActivity = async (detail: string): Promise<void> => this.activity.record(await this.ready, account, 'modified', detail)
    return this.connected.run(
      account, `modify ${action}`, (api, row) => modifyThreads(api, row, threadIds, action, label, recordActivity), result => `${result.changed} thread(s)`,
    )
  }

  // ── sign-in and Settings ───────────────────────────────────────────────────

  /**
   * Start a Google sign-in for one account.
   * @param request - the account id, its policy when new, an address hint, and the origin Settings runs on.
   * @returns the consent page address.
   */
  async beginSignIn(request: SignInRequest): Promise<{ readonly url: string; readonly redirectUri: string }> {
    return await this.signIns.begin(request)
  }

  /**
   * Finish a sign-in from Google's redirect.
   * @param answer - the redirect's `state`, `code`, and `error` parameters.
   * @returns the connected account.
   */
  async completeSignIn(answer: SignInAnswer): Promise<AccountView> {
    const signedIn = await this.signIns.complete(answer)
    return await this.writes.run(() => this.connected.connect(signedIn))
  }

  /**
   * Disconnect an account: revoke its token at Google, delete it, and drop its held messages.
   * @param account - account id.
   */
  removeAccount(account: string): Promise<void> {
    return this.writes.run(() => this.connected.remove(account))
  }

  /**
   * Change an account's send policy.
   * @param account - account id.
   * @param policy - the new policy.
   */
  setPolicy(account: string, policy: SendPolicy): Promise<void> {
    return this.writes.run(() => this.connected.setPolicy(account, policy))
  }

  /**
   * Store the OAuth client from Google's downloaded JSON.
   * @param text - the JSON file's text.
   * @returns the client as Settings shows it.
   */
  async setClient(text: string): Promise<ClientInfo> {
    return await this.oauthClient.set(text)
  }

  /**
   * The OAuth client's state.
   * @returns whether it is set, and its id (not secret).
   */
  async clientInfo(): Promise<ClientInfo> {
    return await this.oauthClient.info()
  }

  /**
   * Everything Settings shows.
   * @returns a snapshot.
   */
  async status(): Promise<GmailStatus> {
    const domain = await this.ready
    await this.writes.run(() => this.holds.expire(domain, Date.now()))
    const pending = this.holds.forSettings(domain)
    return {
      client: await this.clientInfo(),
      redirectUri: this.config.redirectUri === '' ? null : this.config.redirectUri,
      accounts: this.accounts(),
      pending,
      activity: latestActivity(domain),
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
    await this.writes.run(() => this.holds.expire(domain, Date.now()))
    return this.holds.held(domain)
  }
}

export default Gmail
