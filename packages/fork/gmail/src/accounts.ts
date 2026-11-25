/**
 * The connected accounts' rows in the `gmail` domain: lookup, views, the health each Gmail call records, the reconnect
 * mark, the row a finished sign-in writes, policy changes, and removal. Every Gmail call on an account runs through
 * {@link ConnectedAccounts.run}, which logs its account, operation, duration, and outcome.
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ActivityLog } from './activity.ts'
import { GmailApiError, type GmailApi } from './api.ts'
import { errorText, GmailError } from './errors.ts'
import { SEND_POLICIES, type SendPolicy } from './gate.ts'
import type { Holds } from './holds.ts'
import { reconnectNotice, type OwnerNotices } from './notices.ts'
import type { SendCap } from './send-cap.ts'
import type { SignedIn } from './sign-in.ts'
import type { AccountRecord, gmailDomain } from './storage.ts'
import type { AccountTokens, Grant } from './tokens.ts'
import type { AccountView } from './types.ts'

/** A success is recorded on the account row at most this often. */
const HEALTH_INTERVAL_MS = 300_000

/** What {@link ConnectedAccounts} reads and calls. */
export interface AccountDeps {
  readonly ready: Promise<Domain<typeof gmailDomain>>
  readonly tokens: Pick<AccountTokens, 'api' | 'forget' | 'store' | 'remove'>
  readonly cap: Pick<SendCap, 'recent'>
  readonly holds: Pick<Holds, 'discardAccount'>
  readonly activity: Pick<ActivityLog, 'record'>
  readonly notices: Pick<OwnerNotices, 'send'>
  readonly logger: { info(message: string): void; warn(message: string): void }
}

/** The rows of the connected accounts. */
export class ConnectedAccounts {
  /** @param deps - the domain, the tokens, the send cap, the holds, the activity list, the notices, and the logger. */
  constructor(private readonly deps: AccountDeps) {}

  /**
   * Every connected account, in id order.
   * @param domain - the open `gmail` domain.
   * @returns the accounts without tokens.
   */
  list(domain: Domain<typeof gmailDomain>): AccountView[] {
    const now = Date.now()
    return Array.from(domain.table('accounts').entries(), ([, row]) => this.view(domain, row, now)).sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Run one operation on an account: record its health and log its outcome. A Gmail API failure becomes a GmailError.
   * @param account - account id.
   * @param op - the operation's name in the log.
   * @param work - the operation, given the account's API client and row.
   * @param describe - the log line's detail of a result.
   * @returns the operation's result.
   * @throws GmailError `unknown-account` or `needs-reconnect` before the operation runs, else what the operation threw.
   */
  async run<T>(account: string, op: string, work: (api: GmailApi, row: AccountRecord) => Promise<T>, describe: (result: T) => string = () => ''): Promise<T> {
    const row = await this.get(account)
    const started = Date.now()
    try {
      const result = await work(this.deps.tokens.api(account), row)
      const detail = describe(result)
      this.deps.logger.info(`gmail: ${account} ${op} ok in ${Date.now() - started} ms${detail === '' ? '' : `: ${detail}`}`)
      await this.health(account, null)
      return result
    } catch (error: unknown) {
      const apiFailure = error instanceof GmailApiError || (error instanceof GmailError && error.failure === 'api')
      this.deps.logger.warn(`gmail: ${account} ${op} failed in ${Date.now() - started} ms: ${errorText(error)}`)
      if (apiFailure) await this.health(account, errorText(error))
      if (error instanceof GmailApiError) throw new GmailError(error.failure === 'not-found' ? 'not-found' : 'api', error.message)
      throw error
    }
  }

  /**
   * Mark an account as needing a new sign-in and tell the owner once; runs inside serialized work, so it is not
   * serialized itself.
   * @param account - account id.
   * @param why - Google's reason.
   * @returns resolves once the mark is stored; at once for an unknown or already marked account.
   */
  async markReconnect(account: string, why: string): Promise<void> {
    const domain = await this.deps.ready
    const row = domain.table('accounts').get(account)
    if (row === undefined || row.needsReconnect) return
    this.deps.tokens.forget(account)
    const noticed = await this.deps.notices.send(reconnectNotice(account, row.email, why))
    await domain.table('accounts').put(account, { ...row, needsReconnect: true, lastError: why.slice(0, 300), reconnectNoticeAt: noticed ? Date.now() : null })
    await this.deps.activity.record(domain, account, 'reconnect', why.slice(0, 300))
    this.deps.logger.warn(`gmail: ${account}: needs a new sign-in (${why.slice(0, 200)})`)
  }

  /**
   * Store a finished sign-in: its grant, and the account's row with a cleared reconnect mark.
   * @param signedIn - the sign-in.
   * @returns the connected account.
   * @throws GmailError `invalid` when the address is connected as another account, or the account is another address.
   */
  async connect(signedIn: SignedIn): Promise<AccountView> {
    const { account, email } = signedIn
    const domain = await this.deps.ready
    const accounts = domain.table('accounts')
    const lower = email.toLowerCase()
    const clash = Array.from(accounts.entries()).find(([id, row]) => id !== account && row.email.toLowerCase() === lower)
    if (clash !== undefined) throw new GmailError('invalid', `${email} is already connected as "${clash[0]}"`)
    const existing = accounts.get(account)
    if (existing !== undefined && existing.email.toLowerCase() !== email.toLowerCase()) {
      throw new GmailError('invalid', `account "${account}" is ${existing.email}; sign in as that address, or remove the account first`)
    }
    const grant: Grant = { email, refreshToken: signedIn.tokens.refreshToken, scope: signedIn.tokens.scope, grantedAt: Date.now() }
    await this.deps.tokens.store(account, grant, { token: signedIn.tokens.accessToken, expiresAt: signedIn.tokens.expiresAt })
    const row: AccountRecord = {
      id: account, email, name: signedIn.name, policy: existing?.policy ?? signedIn.policy, addedAt: existing?.addedAt ?? Date.now(),
      lastOkAt: Date.now(), lastError: null, needsReconnect: false, reconnectNoticeAt: null,
    }
    await accounts.put(account, row)
    await this.deps.activity.record(domain, account, 'connected', `${email}, policy ${row.policy}`)
    this.deps.logger.info(`gmail: ${account} connected as ${email} (policy ${row.policy})`)
    return this.view(domain, row, Date.now())
  }

  /**
   * Change an account's send policy.
   * @param account - account id.
   * @param policy - the new policy.
   * @returns resolves once the row is stored.
   * @throws GmailError `invalid` for an unknown policy, `unknown-account` for an unknown account.
   */
  async setPolicy(account: string, policy: SendPolicy): Promise<void> {
    if (!SEND_POLICIES.includes(policy)) throw new GmailError('invalid', `unknown policy ${policy}`)
    const domain = await this.deps.ready
    const row = domain.table('accounts').get(account)
    if (row === undefined) throw new GmailError('unknown-account', `no Gmail account "${account}"`)
    await domain.table('accounts').put(account, { ...row, policy })
    await this.deps.activity.record(domain, account, 'policy', `${row.policy} → ${policy}`)
    this.deps.logger.info(`gmail: ${account} policy ${row.policy} → ${policy}`)
  }

  /**
   * Disconnect an account: revoke its token at Google, delete it, and drop its held messages and send count.
   * @param account - account id.
   * @returns resolves once the account is gone; a failed revocation is logged, not thrown.
   * @throws GmailError `unknown-account` for an unknown account.
   */
  async remove(account: string): Promise<void> {
    const domain = await this.deps.ready
    const row = domain.table('accounts').get(account)
    if (row === undefined) throw new GmailError('unknown-account', `no Gmail account "${account}"`)
    const revoked = await this.deps.tokens.remove(account)
    await this.deps.holds.discardAccount(domain, account)
    await domain.table('accounts').deleteMany([account])
    await domain.table('sends').deleteMany([account])
    await this.deps.activity.record(domain, account, 'removed', `${row.email}${revoked === null ? '' : ` (revocation: ${revoked})`}`)
    this.deps.logger.info(`gmail: ${account} (${row.email}) removed${revoked === null ? ', token revoked' : `; revocation: ${revoked}`}`)
  }

  private view(domain: Domain<typeof gmailDomain>, row: AccountRecord, now: number): AccountView {
    return { ...row, sentToday: this.deps.cap.recent(domain, row.id, now).length }
  }

  private async get(id: string): Promise<AccountRecord> {
    const domain = await this.deps.ready
    const row = domain.table('accounts').get(id)
    if (row === undefined) {
      const known = Array.from(domain.table('accounts').keys())
      throw new GmailError('unknown-account', `no Gmail account "${id}"; connected: ${known.length === 0 ? 'none (the owner adds them in Settings → 邮箱)' : known.join(', ')}`)
    }
    if (row.needsReconnect) throw new GmailError('needs-reconnect', `Gmail account "${id}" (${row.email}) must be signed in again by the owner in Settings → 邮箱`)
    return row
  }

  /** Record the outcome of a call on the account row (a success at most every five minutes). */
  private async health(account: string, error: string | null): Promise<void> {
    const domain = await this.deps.ready
    const row = domain.table('accounts').get(account)
    if (row === undefined) return
    const now = Date.now()
    if (error === null && row.lastError === null && row.lastOkAt !== null && now - row.lastOkAt < HEALTH_INTERVAL_MS) return
    await domain.table('accounts').put(account, error === null ? { ...row, lastOkAt: now, lastError: null } : { ...row, lastError: error.slice(0, 300) })
  }
}
