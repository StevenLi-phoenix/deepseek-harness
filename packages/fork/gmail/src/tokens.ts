/**
 * Each account's Google sign-in, kept as a grant record in the credential store (`gmail/<account>`), and the access
 * tokens refreshed from it. Access tokens stay in memory, are refreshed a minute before they expire, and are
 * refreshed at most once at a time per account; a refresh token Google rotates is stored, and a removed account's is
 * revoked at Google. No token reaches a log line.
 */

import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { z as zod } from 'zod'
import { GmailApi } from './api.ts'
import { errorText, GmailError } from './errors.ts'
import { OAuthError, refreshAccess, revoke, type OAuthClient } from './oauth.ts'

/** Credential-store scope of the grant records. */
const GRANT_SCOPE = 'gmail'
/** Refresh an access token this long before it expires. */
const TOKEN_MARGIN_MS = 60_000

/** The grant record's payload. */
const grantSchema = zod.object({ email: zod.string(), refreshToken: zod.string().min(1), scope: zod.string(), grantedAt: zod.number() })
/** One account's stored sign-in. */
export type Grant = zod.infer<typeof grantSchema>

/** An access token and its expiry in Unix epoch milliseconds. */
export interface AccessToken {
  readonly token: string
  readonly expiresAt: number
}

/** What {@link AccountTokens} reads and calls. */
export interface TokenDeps {
  readonly credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord' | 'deleteRecord'>
  /**
   * The OAuth client for a refresh.
   * @returns the client; rejects with GmailError `not-configured` when it is not set up.
   */
  readonly client: () => Promise<OAuthClient>
  /** Timeout of one call to Google, in milliseconds. */
  readonly requestTimeoutMs: number
  /**
   * Mark an account whose sign-in is missing or refused as needing a new one.
   * @param account - account id.
   * @param why - the reason the owner reads.
   * @returns resolves once the mark is stored.
   */
  readonly needsReconnect: (account: string, why: string) => Promise<void>
  readonly logger: { info(message: string): void }
}

/** The grants of every account and the access tokens cached from them. */
export class AccountTokens {
  private readonly cached = new Map<string, AccessToken>()
  private readonly refreshing = new Map<string, Promise<string>>()

  /** @param deps - the credential store, the OAuth client, the timeout, the reconnect mark, and the logger. */
  constructor(private readonly deps: TokenDeps) {}

  /**
   * A Gmail API client authorized as one account.
   * @param account - account id.
   * @returns the client; each call reads the account's access token.
   */
  api(account: string): GmailApi {
    return new GmailApi({ timeoutMs: this.deps.requestTimeoutMs, accessToken: fresh => this.accessToken(account, fresh) })
  }

  /**
   * An account's access token: the cached one while it has more than a minute left, else a refreshed one.
   * @param account - account id.
   * @param fresh - refresh even when a cached token is valid.
   * @returns the token.
   * @throws GmailError `needs-reconnect` when no grant is stored or Google refuses it, `api` when the refresh fails.
   */
  accessToken(account: string, fresh: boolean): Promise<string> {
    const cached = this.cached.get(account)
    if (!fresh && cached !== undefined && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return Promise.resolve(cached.token)
    const running = this.refreshing.get(account)
    if (running !== undefined) return running
    const work = this.refresh(account).finally(() => this.refreshing.delete(account))
    this.refreshing.set(account, work)
    return work
  }

  /**
   * An account's stored grant.
   * @param account - account id.
   * @returns the grant, or undefined when none is stored or the record does not parse.
   */
  async grant(account: string): Promise<Grant | undefined> {
    const record = await this.deps.credentials.readRecord(credentialKey(GRANT_SCOPE, account))
    if (record?.kind !== 'grant') return undefined
    const parsed = grantSchema.safeParse(record.payload)
    return parsed.success ? parsed.data : undefined
  }

  /**
   * Store a new sign-in and cache its access token.
   * @param account - account id.
   * @param grant - the grant to store.
   * @param access - the access token the sign-in returned.
   * @returns resolves once the grant is stored.
   */
  async store(account: string, grant: Grant, access: AccessToken): Promise<void> {
    await this.deps.credentials.modifyRecord(credentialKey(GRANT_SCOPE, account), () => Promise.resolve({ kind: 'grant', payload: grant }))
    this.cached.set(account, access)
  }

  /**
   * Revoke an account's sign-in at Google, then delete its grant and cached access token whatever Google answered.
   * @param account - account id.
   * @returns null when Google revoked the token, else why not (`no token stored` when no grant was stored).
   */
  async remove(account: string): Promise<string | null> {
    const grant = await this.grant(account)
    const revoked = grant === undefined ? 'no token stored' : await revoke(grant.refreshToken, { timeoutMs: this.deps.requestTimeoutMs })
    await this.deps.credentials.deleteRecord(credentialKey(GRANT_SCOPE, account))
    this.cached.delete(account)
    return revoked
  }

  /**
   * Drop an account's cached access token; the next call refreshes.
   * @param account - account id.
   */
  forget(account: string): void {
    this.cached.delete(account)
  }

  private async refresh(account: string): Promise<string> {
    const client = await this.deps.client()
    const grant = await this.grant(account)
    if (grant === undefined) {
      await this.deps.needsReconnect(account, 'no stored sign-in')
      throw new GmailError('needs-reconnect', `Gmail account "${account}" has no stored sign-in; the owner signs in again in Settings → 邮箱`)
    }
    let answer
    try {
      answer = await refreshAccess(client, grant.refreshToken, { timeoutMs: this.deps.requestTimeoutMs })
    } catch (error: unknown) {
      if (error instanceof OAuthError && error.failure === 'invalid-grant') {
        await this.deps.needsReconnect(account, error.message)
        throw new GmailError('needs-reconnect', `Google no longer accepts the sign-in of Gmail account "${account}"; the owner signs in again in Settings → 邮箱`)
      }
      throw new GmailError('api', errorText(error))
    }
    this.cached.set(account, { token: answer.accessToken, expiresAt: answer.expiresAt })
    if (answer.refreshToken !== undefined && answer.refreshToken !== grant.refreshToken) {
      const rotated = answer.refreshToken
      await this.deps.credentials.modifyRecord(credentialKey(GRANT_SCOPE, account), () => Promise.resolve({ kind: 'grant', payload: { ...grant, refreshToken: rotated } }))
      this.deps.logger.info(`gmail: ${account}: Google rotated the refresh token; stored`)
    }
    return answer.accessToken
  }
}
