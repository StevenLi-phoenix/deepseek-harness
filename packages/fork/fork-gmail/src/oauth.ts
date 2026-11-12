/**
 * Google OAuth 2.0 for one Gmail account at a time: an authorization-code request with PKCE (S256), a random
 * `state` kept only in memory for ten minutes, offline access with forced consent so Google returns a refresh token,
 * the code exchange, the refresh, and the revocation. The client id and secret come from the credential store; no
 * token, code, or secret reaches a log line or an error message.
 */

import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

/** Google's endpoints (external protocol constants). */
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
/** Token endpoint. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** Revocation endpoint. */
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

/** The OAuth client of the owner's Google Cloud project. */
export interface OAuthClient {
  readonly clientId: string
  readonly clientSecret: string
}

/** Why an OAuth step failed. */
export type OAuthFailure = 'not-configured' | 'denied' | 'invalid-grant' | 'http' | 'network' | 'timeout' | 'invalid'

/** A failed OAuth step; the message holds no secret. */
export class OAuthError extends Error {
  /**
   * @param failure - the failure class.
   * @param message - what went wrong.
   */
  constructor(readonly failure: OAuthFailure, message: string) {
    super(message)
    this.name = 'OAuthError'
  }
}

/** A sign-in that is under way. */
export interface PendingSignIn {
  /** Account id the sign-in will create or replace. */
  readonly account: string
  readonly verifier: string
  readonly redirectUri: string
  readonly createdAt: number
}

/** What Google answers a code exchange or a refresh. */
export interface TokenAnswer {
  readonly accessToken: string
  /** Absent on a refresh, which keeps the old refresh token. */
  readonly refreshToken?: string | undefined
  readonly expiresAt: number
  readonly scope: string
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
})

const errorSchema = z.object({ error: z.string(), error_description: z.string().optional() })

/** Longest Google error text carried into a message. */
const MAX_ERROR_CHARS = 200

/**
 * A PKCE verifier and its S256 challenge.
 * @returns both, base64url.
 */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/**
 * A random `state` value.
 * @returns 32 base64url characters.
 */
export function newState(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * The consent page address for one account.
 * @param client - the OAuth client (only the id is used).
 * @param request - redirect URI, scopes, state, PKCE challenge, and an optional address hint.
 * @returns the URL to open in the owner's browser.
 */
export function authorizationUrl(client: OAuthClient, request: {
  readonly redirectUri: string
  readonly scopes: readonly string[]
  readonly state: string
  readonly challenge: string
  readonly loginHint?: string | undefined
}): string {
  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', request.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', request.scopes.join(' '))
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'false')
  url.searchParams.set('state', request.state)
  url.searchParams.set('code_challenge', request.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (request.loginHint !== undefined && request.loginHint !== '') url.searchParams.set('login_hint', request.loginHint)
  return url.toString()
}

/** Options of a token request. */
export interface TokenRequestOptions {
  readonly timeoutMs: number
  readonly fetch?: typeof fetch | undefined
  readonly now?: (() => number) | undefined
}

/** POST a form to the token endpoint and read the answer. */
async function tokenRequest(form: Record<string, string>, options: TokenRequestOptions): Promise<TokenAnswer> {
  const call = options.fetch ?? fetch
  const now = options.now ?? Date.now
  let response: Response
  try {
    response = await call(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') throw new OAuthError('timeout', `Google's token endpoint did not answer within ${options.timeoutMs} ms`)
    throw new OAuthError('network', `Google's token endpoint is unreachable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body)
    const code = parsed.success ? parsed.data.error : `HTTP ${response.status}`
    const detail = parsed.success && parsed.data.error_description !== undefined ? `: ${parsed.data.error_description.slice(0, MAX_ERROR_CHARS)}` : ''
    if (code === 'invalid_grant') throw new OAuthError('invalid-grant', `Google refused the grant (invalid_grant${detail})`)
    throw new OAuthError('http', `Google's token endpoint answered ${code}${detail}`)
  }
  const parsed = tokenSchema.safeParse(body)
  if (!parsed.success) throw new OAuthError('invalid', 'Google\'s token endpoint answered without an access token')
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: now() + parsed.data.expires_in * 1000,
    scope: parsed.data.scope ?? '',
  }
}

/**
 * Exchange an authorization code.
 * @param client - the OAuth client.
 * @param pending - the sign-in the code answers.
 * @param code - the code from the redirect.
 * @param options - timeout and fetch.
 * @returns the tokens; a missing refresh token is an error, since the account could not be used after an hour.
 */
export async function exchangeCode(
  client: OAuthClient, pending: PendingSignIn, code: string, options: TokenRequestOptions,
): Promise<TokenAnswer & { readonly refreshToken: string }> {
  const answer = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  }, options)
  if (answer.refreshToken === undefined) throw new OAuthError('invalid', 'Google returned no refresh token; remove the app at myaccount.google.com/permissions and sign in again')
  return { ...answer, refreshToken: answer.refreshToken }
}

/**
 * Refresh an access token.
 * @param client - the OAuth client.
 * @param refreshToken - the account's refresh token.
 * @param options - timeout and fetch.
 * @returns the new access token (and a rotated refresh token when Google sends one).
 */
export function refreshAccess(client: OAuthClient, refreshToken: string, options: TokenRequestOptions): Promise<TokenAnswer> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret }, options)
}

/**
 * Revoke a token at Google; a failure is reported, not thrown, since the local record goes either way.
 * @param token - the refresh token.
 * @param options - timeout and fetch.
 * @returns null on success, else why it failed.
 */
export async function revoke(token: string, options: TokenRequestOptions): Promise<string | null> {
  const call = options.fetch ?? fetch
  try {
    const response = await call(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    return response.ok || response.status === 400 ? null : `HTTP ${response.status}`
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}
