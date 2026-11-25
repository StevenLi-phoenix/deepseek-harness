/**
 * The Google sign-in of one account: the consent page address with PKCE and a stored single-use transaction, then
 * Google's redirect checked against that transaction, the code exchanged, and the account's address and display name
 * read. Neither the code nor a token reaches a log line or an error message.
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { GmailApi } from './api.ts'
import { errorText, GmailError } from './errors.ts'
import { SEND_POLICIES, type SendPolicy } from './gate.ts'
import { authorizationUrl, exchangeCode, GMAIL_SCOPE, newState, pkcePair, type OAuthClient, type TokenAnswer } from './oauth.ts'
import { ACCOUNT_ID, OAUTH_PATH, oauthRedirect, SignInStore } from './sign-in-store.ts'
import type { gmailDomain } from './storage.ts'
import type { SignInAnswer, SignInRequest } from './types.ts'

/** A finished sign-in, before its account is stored. */
export interface SignedIn {
  /** The account id the sign-in was started for. */
  readonly account: string
  /** Policy of a new account; an existing one keeps its own. */
  readonly policy: SendPolicy
  readonly email: string
  /** Display name of the primary send-as address, cleaned; empty when Gmail has none. */
  readonly name: string
  readonly tokens: TokenAnswer & { readonly refreshToken: string }
}

/** What {@link SignIns} reads and calls. */
export interface SignInDeps {
  readonly ready: Promise<Domain<typeof gmailDomain>>
  /**
   * The OAuth client.
   * @returns the client; rejects with GmailError `not-configured` when it is not set up.
   */
  readonly client: () => Promise<OAuthClient>
  /** Redirect URI registered at Google; empty derives `<Settings origin>/gmail.oauth`. */
  readonly redirectUri: string
  /** Timeout of one call to Google, in milliseconds. */
  readonly requestTimeoutMs: number
  readonly logger: { info(message: string): void }
}

/** Starts and finishes Google sign-ins. */
export class SignIns {
  private readonly store = new SignInStore()

  /** @param deps - the domain, the OAuth client, the redirect URI, the timeout, and the logger. */
  constructor(private readonly deps: SignInDeps) {}

  /**
   * Remove expired open sign-ins.
   * @returns resolves once the store is pruned.
   */
  prune(): Promise<void> {
    return this.store.prune()
  }

  /**
   * Start a Google sign-in for one account.
   * @param request - the account id, its policy when new, an address hint, and the origin Settings runs on.
   * @returns the consent page address and the redirect URI it returns to.
   * @throws GmailError `invalid` for a bad account id, policy, or origin; `limit` when too many sign-ins are open.
   */
  async begin(request: SignInRequest): Promise<{ readonly url: string; readonly redirectUri: string }> {
    if (!ACCOUNT_ID.test(request.account)) throw new GmailError('invalid', 'an account id is lower-case letters, digits, and -, a letter first, at most 24 characters (work, personal, bot)')
    if (request.policy !== undefined && !SEND_POLICIES.includes(request.policy)) throw new GmailError('invalid', `unknown policy ${request.policy}`)
    const redirectUri = this.redirectFor(request.origin)
    const client = await this.deps.client()
    const domain = await this.deps.ready
    const existing = domain.table('accounts').get(request.account)
    const { verifier, challenge } = pkcePair()
    const state = newState()
    const saved = await this.store.insert({ state, account: request.account, verifier, redirectUri, policy: request.policy ?? existing?.policy ?? 'confirm-untrusted' })
    if (!saved) throw new GmailError('limit', 'too many sign-ins are open; finish one or wait ten minutes')
    const loginHint = request.loginHint?.trim() || existing?.email
    this.deps.logger.info(`gmail: sign-in started for ${request.account}${existing === undefined ? ' (new)' : ''}, redirect ${redirectUri}`)
    return { url: authorizationUrl(client, { redirectUri, scopes: [GMAIL_SCOPE], state, challenge, loginHint }), redirectUri }
  }

  /**
   * Finish a sign-in from Google's redirect: claim its transaction, exchange the code, and read the account's address.
   * @param answer - the redirect's `state`, `code`, and `error` parameters.
   * @returns the sign-in, for the account's row and grant.
   * @throws GmailError `invalid` for a redirect to another address, `expired` for an unknown state, `denied` when Google
   * granted no Gmail access, `api` when a call to Google fails.
   */
  async complete(answer: SignInAnswer): Promise<SignedIn> {
    const open = await this.store.consume(answer.state, (signIn) => {
      const callback = answer.callback
      if (callback === undefined) return
      const expected = new URL(signIn.redirectUri)
      const actual = URL.parse(`${expected.protocol}//${callback.authority}`)
      if (callback.path !== OAUTH_PATH || !/^[^\s/?#@\\]+$/u.test(callback.authority) || actual?.host !== expected.host) {
        throw new GmailError('invalid', 'this is not the registered sign-in address; start again in Settings → 邮箱')
      }
    })
    if (open === undefined) throw new GmailError('expired', 'this sign-in link expired or was already used; start again in Settings → 邮箱')
    if (answer.error !== undefined || !answer.code) {
      const detail = answer.error === 'access_denied' ? 'access_denied' : answer.error === undefined ? 'no code' : 'authorization error'
      throw new GmailError('denied', `Google did not grant access (${detail})`)
    }
    const client = await this.deps.client()
    let tokens
    try {
      tokens = await exchangeCode(client, open, answer.code, { timeoutMs: this.deps.requestTimeoutMs })
    } catch (error: unknown) {
      throw new GmailError('api', errorText(error))
    }
    if (!tokens.scope.split(' ').includes(GMAIL_SCOPE)) {
      throw new GmailError('denied', 'Google granted no Gmail access: on the consent page, tick the box that lets the app read, compose, and send mail')
    }
    const access = tokens.accessToken
    const api = new GmailApi({ timeoutMs: this.deps.requestTimeoutMs, accessToken: () => Promise.resolve(access) })
    let email: string
    let name: string
    try {
      email = (await api.profile()).emailAddress
      name = cleanName(await api.displayName())
    } catch (error: unknown) {
      throw new GmailError('api', errorText(error))
    }
    return { account: open.account, policy: open.policy, email, name, tokens }
  }

  private redirectFor(origin: string): string {
    if (this.deps.redirectUri !== '') return this.deps.redirectUri
    if (oauthRedirect(`${origin}${OAUTH_PATH}`) === undefined) {
      throw new GmailError('invalid', `Google signs in only to an https page (or localhost); this page runs on ${origin.slice(0, 100)}. Open Settings over https or set redirectUri`)
    }
    return `${origin}${OAUTH_PATH}`
  }
}

/** Remove control characters and the characters a display name may not hold. */
function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001F\u007F<>"\\]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 100)
}
