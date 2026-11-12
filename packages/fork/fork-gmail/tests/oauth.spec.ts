import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizationUrl, exchangeCode, GOOGLE_AUTH_URL, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, newState, OAuthError, pkcePair, refreshAccess,
  revoke, type OAuthFailure, type PendingSignIn,
} from '../src/oauth.ts'

const CLIENT = { clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'client-secret-value' }
const PENDING: PendingSignIn = { account: 'work', verifier: 'verifier-value', redirectUri: 'https://dsh.example/fork.gmail.oauth', createdAt: 0 }
const NOW = 1_800_000_000_000

interface Seen {
  url: string
  init: RequestInit | undefined
  body: string
}

function fetchAnswering(answer: () => Response | Promise<Response>, seen: Seen[] = []): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push({ url, init, body: typeof init?.body === 'string' ? init.body : '' })
    return answer()
  }
}

async function failure(promise: Promise<unknown>): Promise<OAuthError> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(OAuthError)
  return error as OAuthError
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PKCE and state', () => {
  it('makes a verifier whose S256 challenge is its base64url SHA-256, fresh each time', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/u)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(pkcePair().verifier).not.toBe(verifier)
  })

  it('makes a 32-character base64url state, fresh each time', () => {
    const state = newState()
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/u)
    expect(newState()).not.toBe(state)
  })
})

describe('consent page address', () => {
  const request = { redirectUri: PENDING.redirectUri, scopes: ['scope-a', 'scope-b'], state: 'state-1', challenge: 'challenge-1' }

  it('asks for offline access with forced consent, the scopes, the state, and the S256 challenge, and never the secret', () => {
    const url = new URL(authorizationUrl(CLIENT, { ...request, loginHint: 'ada@example.com' }))
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT.clientId,
      redirect_uri: PENDING.redirectUri,
      response_type: 'code',
      scope: 'scope-a scope-b',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      login_hint: 'ada@example.com',
    })
    expect(url.toString()).not.toContain(CLIENT.clientSecret)
  })

  it('leaves out an empty or absent address hint', () => {
    expect(new URL(authorizationUrl(CLIENT, { ...request, loginHint: '' })).searchParams.has('login_hint')).toBe(false)
    expect(new URL(authorizationUrl(CLIENT, request)).searchParams.has('login_hint')).toBe(false)
  })
})

describe('code exchange and refresh', () => {
  it('posts the code, the verifier, and the redirect as a form, and reads the tokens with their expiry', async () => {
    const seen: Seen[] = []
    const call = fetchAnswering(() => Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3599, scope: 'scope-a' }), seen)
    expect(await exchangeCode(CLIENT, PENDING, 'code-1', { timeoutMs: 1000, fetch: call, now: () => NOW })).toEqual({
      accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: NOW + 3_599_000, scope: 'scope-a',
    })
    expect(seen[0]?.url).toBe(GOOGLE_TOKEN_URL)
    expect(seen[0]?.init?.method).toBe('POST')
    expect(new Headers(seen[0]?.init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(seen[0]?.body ?? ''))).toEqual({
      grant_type: 'authorization_code', code: 'code-1', client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret,
      redirect_uri: PENDING.redirectUri, code_verifier: 'verifier-value',
    })
  })

  it('refuses an exchange without a refresh token, since the account would stop working within an hour', async () => {
    const call = fetchAnswering(() => Response.json({ access_token: 'access-1', expires_in: 3599, scope: 'scope-a' }))
    expect(await failure(exchangeCode(CLIENT, PENDING, 'code-1', { timeoutMs: 1000, fetch: call }))).toMatchObject({
      failure: 'invalid', message: expect.stringContaining('Google returned no refresh token') as string,
    })
  })

  it('refreshes with the refresh token, keeping an absent refresh token and scope absent', async () => {
    const seen: Seen[] = []
    const call = fetchAnswering(() => Response.json({ access_token: 'access-2', expires_in: 60 }), seen)
    expect(await refreshAccess(CLIENT, 'refresh-1', { timeoutMs: 1000, fetch: call, now: () => NOW })).toEqual({
      accessToken: 'access-2', refreshToken: undefined, expiresAt: NOW + 60_000, scope: '',
    })
    expect(Object.fromEntries(new URLSearchParams(seen[0]?.body ?? ''))).toEqual({
      grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret,
    })
  })

  it('uses the global fetch and clock when none are injected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'access-3', expires_in: 10 })))
    const before = Date.now()
    const answer = await refreshAccess(CLIENT, 'refresh-1', { timeoutMs: 1000 })
    expect(answer.accessToken).toBe('access-3')
    expect(answer.expiresAt).toBeGreaterThanOrEqual(before + 10_000)
  })

  it('classifies Google\'s error answers without carrying a secret into the message', async () => {
    const cases: Array<[Response, OAuthFailure, string]> = [
      [Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 }),
        'invalid-grant', 'Google refused the grant (invalid_grant: Token has been expired or revoked.)'],
      [Response.json({ error: 'invalid_grant' }, { status: 400 }), 'invalid-grant', 'Google refused the grant (invalid_grant)'],
      [Response.json({ error: 'invalid_client', error_description: 'x'.repeat(300) }, { status: 401 }),
        'http', `Google's token endpoint answered invalid_client: ${'x'.repeat(200)}`],
      [new Response('<html>Bad gateway</html>', { status: 502 }), 'http', 'Google\'s token endpoint answered HTTP 502'],
      [new Response('not json', { status: 200 }), 'invalid', 'Google\'s token endpoint answered without an access token'],
      [Response.json({ token_type: 'Bearer', expires_in: 10 }), 'invalid', 'Google\'s token endpoint answered without an access token'],
    ]
    for (const [response, kind, message] of cases) {
      const error = await failure(refreshAccess(CLIENT, 'refresh-1', { timeoutMs: 1000, fetch: fetchAnswering(() => response) }))
      expect(error).toMatchObject({ name: 'OAuthError', failure: kind, message })
      expect(error.message).not.toContain('refresh-1')
      expect(error.message).not.toContain(CLIENT.clientSecret)
    }
  })

  it('reports an unreachable endpoint as network, with the cause\'s text', async () => {
    const thrown = async (value: unknown): Promise<OAuthError> => failure(refreshAccess(CLIENT, 'refresh-1', {
      timeoutMs: 1000, fetch: async () => { throw value },
    }))
    expect(await thrown(new Error('getaddrinfo ENOTFOUND'))).toMatchObject({
      failure: 'network', message: 'Google\'s token endpoint is unreachable: getaddrinfo ENOTFOUND',
    })
    expect(await thrown('socket hang up')).toMatchObject({ failure: 'network', message: 'Google\'s token endpoint is unreachable: socket hang up' })
  })

  it('reports a request that ran past timeoutMs, or was aborted, as timeout', async () => {
    const hanging: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const reason: unknown = init.signal?.reason
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      })
    })
    expect(await failure(refreshAccess(CLIENT, 'refresh-1', { timeoutMs: 5, fetch: hanging }))).toMatchObject({
      failure: 'timeout', message: 'Google\'s token endpoint did not answer within 5 ms',
    })
    const aborted = new Error('aborted')
    aborted.name = 'AbortError'
    expect(await failure(refreshAccess(CLIENT, 'refresh-1', { timeoutMs: 7, fetch: async () => { throw aborted } }))).toMatchObject({ failure: 'timeout' })
  })
})

describe('revocation', () => {
  it('reports success for 200 and 400 (already revoked), and the status otherwise', async () => {
    const seen: Seen[] = []
    expect(await revoke('refresh-1', { timeoutMs: 1000, fetch: fetchAnswering(() => new Response(null, { status: 200 }), seen) })).toBeNull()
    expect(seen[0]?.url).toBe(GOOGLE_REVOKE_URL)
    expect(seen[0]?.body ?? '').toBe('token=refresh-1')
    expect(await revoke('refresh-1', { timeoutMs: 1000, fetch: fetchAnswering(() => new Response(null, { status: 400 })) })).toBeNull()
    expect(await revoke('refresh-1', { timeoutMs: 1000, fetch: fetchAnswering(() => new Response(null, { status: 503 })) })).toBe('HTTP 503')
  })

  it('reports a failed request by its text instead of throwing', async () => {
    expect(await revoke('refresh-1', { timeoutMs: 1000, fetch: async () => { throw new Error('ECONNRESET') } })).toBe('ECONNRESET')
    expect(await revoke('refresh-1', { timeoutMs: 1000, fetch: async () => { throw 'offline' } })).toBe('offline')
  })

  it('uses the global fetch when none is injected', async () => {
    const globalFetch = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', globalFetch)
    expect(await revoke('refresh-1', { timeoutMs: 1000 })).toBeNull()
    expect(globalFetch).toHaveBeenCalledOnce()
  })
})
