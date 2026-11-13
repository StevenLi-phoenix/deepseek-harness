import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Gmail, { Config, GMAIL_SCOPE, GmailError, OAUTH_PATH, type SendPolicy } from '../src/index.ts'
import {
  CLIENT_ID, CLIENT_ID_REF, CLIENT_SECRET, CLIENT_SECRET_REF, connect, disposeAll, googleError, host, HOUR, mount, ORIGIN,
  ownerTurn, rejection, START,
} from './fixture.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(async () => {
  await disposeAll()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function gmailFailure(promise: Promise<unknown>): Promise<GmailError> {
  const error = await rejection(promise)
  expect(error).toBeInstanceOf(GmailError)
  return error as GmailError
}

const MESSAGE = { to: ['ada@example.com'], cc: [], bcc: [], subject: 'Plan', body: 'Shall we meet?', attachments: [] }

describe('configuration', () => {
  it('defaults to the GMAIL_CLIENT_* names, a derived redirect, 50 sends a day, and a 72-hour hold', () => {
    expect(Config({} as Config)).toEqual({
      clientIdEnv: 'GMAIL_CLIENT_ID', clientSecretEnv: 'GMAIL_CLIENT_SECRET', redirectUri: '', trustedRecipients: [],
      maxSendsPerDay: 50, confirmTtlHours: 72, requestTimeoutMs: 30_000, maxSearchResults: 20, maxBodyChars: 20_000,
      maxHtmlChars: 500_000, maxThreadMessages: 10, maxAttachmentBytes: 18 * 1_048_576, maxDownloadBytes: 25 * 1_048_576,
    })
  })

  it('fails at load on a redirect that is not https (or http on localhost) and on a trusted entry that is not an address', async () => {
    await expect(mount({ config: { redirectUri: 'http://dsh.example/gmail.oauth' } })).rejects.toThrow('gmail: redirectUri must be an https URL (or http on localhost)')
    await expect(mount({ config: { redirectUri: 'https://dsh.example' } })).rejects.toThrow('redirectUri must be an https URL')
    await expect(mount({ config: { trustedRecipients: ['boss@example.com', 'the boss'] } })).rejects.toThrow('gmail: trustedRecipients entry "the boss" is not an email address')
    const local = await mount({ config: { redirectUri: 'http://localhost:8080/gmail.oauth', trustedRecipients: ['Boss <boss@example.com>'] } })
    expect((await local.gmail.status()).redirectUri).toBe('http://localhost:8080/gmail.oauth')
  })
})

describe('OAuth client', () => {
  it('stores the client from Google\'s web, installed, or bare JSON, trimming the secret', async () => {
    const { gmail, credentials, logs } = await mount({ noClient: true })
    const forms = [
      { web: { client_id: CLIENT_ID, client_secret: ` ${CLIENT_SECRET} `, project_id: 'p' } },
      { installed: { client_id: 'desktop.apps.googleusercontent.com', client_secret: 'desktop-secret' } },
      { client_id: 'bare-1.apps.googleusercontent.com', client_secret: 'bare-secret' },
    ]
    const ids: string[] = []
    for (const form of forms) {
      const info = await gmail.setClient(JSON.stringify(form))
      expect(info).toMatchObject({ configured: true, secretConfigured: true })
      ids.push(info.clientId ?? '')
    }
    expect(ids).toEqual([CLIENT_ID, 'desktop.apps.googleusercontent.com', 'bare-1.apps.googleusercontent.com'])
    expect(credentials.values.get(CLIENT_SECRET_REF)).toBe('bare-secret')
    await gmail.setClient(JSON.stringify(forms[0]))
    expect(credentials.values.get(CLIENT_SECRET_REF)).toBe(CLIENT_SECRET)
    expect(logs).toContain('info gmail: OAuth client stored (client-1.app…)')
    expect(logs.join('\n')).not.toContain(CLIENT_SECRET)
  })

  it('refuses text that is not JSON, JSON without the id and secret, a foreign client id, and an empty secret', async () => {
    const { gmail, credentials } = await mount({ noClient: true })
    const cases: Array<[string, string]> = [
      ['client_id=x', 'that is not JSON; paste the whole client file Google gave you'],
      [JSON.stringify({ web: { client_id: CLIENT_ID } }), 'the JSON has no client_id and client_secret (download it from Google Cloud → Credentials → OAuth client)'],
      [JSON.stringify({ client_id: 'client.example.com', client_secret: 's' }), 'the client id must end in .apps.googleusercontent.com and the secret must not be empty'],
      [JSON.stringify({ client_id: CLIENT_ID, client_secret: '   ' }), 'the client id must end in .apps.googleusercontent.com and the secret must not be empty'],
    ]
    for (const [text, message] of cases) expect(await gmailFailure(gmail.setClient(text))).toMatchObject({ failure: 'invalid', message })
    expect(credentials.values.size).toBe(0)
  })

  it('shows an unconfigured client, and one with only an id as unconfigured', async () => {
    const { gmail, credentials } = await mount({ noClient: true })
    expect(await gmail.clientInfo()).toEqual({ configured: false, clientId: null, secretConfigured: false })
    credentials.values.set(CLIENT_ID_REF, CLIENT_ID)
    expect(await gmail.clientInfo()).toEqual({ configured: false, clientId: CLIENT_ID, secretConfigured: false })
    expect(await gmailFailure(gmail.beginSignIn({ account: 'work', origin: ORIGIN }))).toMatchObject({
      failure: 'not-configured', message: 'the Google OAuth client is not set up; the owner pastes its JSON in Settings → 邮箱',
    })
  })
})

describe('sign-in', () => {
  it('opens the consent page with PKCE S256 and a state, and stores the grant as the credential record gmail/<account>', async () => {
    const env = await mount()
    env.google.mailbox('owner@example.com').displayName = 'Owner Name'
    const begun = await env.gmail.beginSignIn({ account: 'work', origin: ORIGIN, loginHint: ' owner@example.com ' })
    expect(begun.redirectUri).toBe(`${ORIGIN}${OAUTH_PATH}`)
    const url = new URL(begun.url)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${OAUTH_PATH}`)
    expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPE)
    expect(url.searchParams.get('login_hint')).toBe('owner@example.com')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(begun.url).not.toContain(CLIENT_SECRET)
    const state = url.searchParams.get('state') ?? ''
    env.google.signInEmail = 'owner@example.com'
    const account = await env.gmail.completeSignIn({ state, code: 'code-1' })
    expect(account).toEqual({
      id: 'work', email: 'owner@example.com', name: 'Owner Name', policy: 'confirm-untrusted', addedAt: START, lastOkAt: START,
      lastError: null, needsReconnect: false, reconnectNoticeAt: null, sentToday: 0,
    })
    const [exchange] = env.google.tokenCalls('authorization_code')
    expect(exchange?.get('code')).toBe('code-1')
    expect(exchange?.get('redirect_uri')).toBe(`${ORIGIN}${OAUTH_PATH}`)
    expect(createHash('sha256').update(exchange?.get('code_verifier') ?? '').digest('base64url')).toBe(url.searchParams.get('code_challenge'))
    expect(env.credentials.records.get('gmail/work')).toEqual({
      kind: 'grant', payload: { email: 'owner@example.com', refreshToken: expect.stringMatching(/^refresh-/u) as string, scope: GMAIL_SCOPE, grantedAt: START },
    })
    expect(env.logs).toContain('info gmail: work connected as owner@example.com (policy confirm-untrusted)')
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'connected', account: 'work', detail: 'owner@example.com, policy confirm-untrusted' })
    expect(await gmailFailure(env.gmail.completeSignIn({ state, code: 'code-1' }))).toMatchObject({
      failure: 'expired', message: 'this sign-in link expired or was already used; start again in Settings → 邮箱',
    })
    expect(env.google.tokenCalls('authorization_code')).toHaveLength(1)
  })

  it('takes the policy given for a new account and uses the access token of the sign-in without a refresh', async () => {
    const env = await mount()
    expect(await connect(env, 'bot', 'bot@example.com', 'direct')).toMatchObject({ id: 'bot', policy: 'direct' })
    await env.gmail.send('bot', { kind: 'new', message: MESSAGE }, ownerTurn())
    expect(env.google.tokenCalls('refresh_token')).toHaveLength(0)
  })

  it('refuses an unknown state and a state older than ten minutes', async () => {
    const env = await mount()
    expect(await gmailFailure(env.gmail.completeSignIn({ state: 'made-up', code: 'c' }))).toMatchObject({ failure: 'expired' })
    const { url } = await env.gmail.beginSignIn({ account: 'work', origin: ORIGIN })
    vi.setSystemTime(START + 10 * 60_000 + 1)
    expect(await gmailFailure(env.gmail.completeSignIn({ state: new URL(url).searchParams.get('state') ?? '', code: 'c' }))).toMatchObject({ failure: 'expired' })
    expect(env.google.tokenCalls('authorization_code')).toHaveLength(0)
  })

  it('reports a refused consent, or a redirect without a code, as denied', async () => {
    const env = await mount()
    const state = async (): Promise<string> => new URL((await env.gmail.beginSignIn({ account: 'work', origin: ORIGIN })).url).searchParams.get('state') ?? ''
    expect(await gmailFailure(env.gmail.completeSignIn({ state: await state(), error: 'access_denied' }))).toMatchObject({
      failure: 'denied', message: 'Google did not grant access (access_denied)',
    })
    expect(await gmailFailure(env.gmail.completeSignIn({ state: await state() }))).toMatchObject({ failure: 'denied', message: 'Google did not grant access (no code)' })
  })

  it('refuses a grant without the gmail.modify scope and stores nothing', async () => {
    const env = await mount()
    env.google.scope = 'openid email'
    expect(await gmailFailure(connect(env, 'work', 'owner@example.com'))).toMatchObject({
      failure: 'denied', message: expect.stringContaining('Google granted no Gmail access') as string,
    })
    expect(env.credentials.records.size).toBe(0)
    expect(env.gmail.accounts()).toEqual([])
  })

  it('reports a failed code exchange or a failed profile read as an api failure', async () => {
    const env = await mount()
    env.google.intercept = call => (call.url.pathname === '/token' ? new Response('oops', { status: 500 }) : undefined)
    expect(await gmailFailure(connect(env, 'work', 'owner@example.com'))).toMatchObject({ failure: 'api', message: 'Google\'s token endpoint answered HTTP 500' })
    env.google.intercept = call => (call.url.pathname.endsWith('/profile') ? googleError(403, 'Gmail API has not been used', 'accessNotConfigured') : undefined)
    expect(await gmailFailure(connect(env, 'work', 'owner@example.com'))).toMatchObject({
      failure: 'api', message: 'Gmail GET /profile failed with HTTP 403 accessNotConfigured: Gmail API has not been used',
    })
    expect(env.credentials.records.size).toBe(0)
  })

  it('refuses an address already connected under another id, and another address for the same id', async () => {
    const env = await mount()
    await connect(env, 'work', 'owner@example.com')
    expect(await gmailFailure(connect(env, 'personal', 'Owner@Example.com'))).toMatchObject({
      failure: 'invalid', message: 'Owner@Example.com is already connected as "work"',
    })
    expect(await gmailFailure(connect(env, 'work', 'someone@example.com'))).toMatchObject({
      failure: 'invalid', message: 'account "work" is owner@example.com; sign in as that address, or remove the account first',
    })
    expect(env.gmail.accounts().map(row => row.id)).toEqual(['work'])
  })

  it('keeps the policy and the first connection time of an account that signs in again, hinting its address', async () => {
    const env = await mount()
    await connect(env, 'work', 'owner@example.com', 'direct')
    vi.setSystemTime(START + HOUR)
    const { url } = await env.gmail.beginSignIn({ account: 'work', origin: ORIGIN, policy: 'read-only' })
    expect(new URL(url).searchParams.get('login_hint')).toBe('owner@example.com')
    expect(env.logs).toContain(`info gmail: sign-in started for work, redirect ${ORIGIN}${OAUTH_PATH}`)
    expect(await env.gmail.completeSignIn({ state: new URL(url).searchParams.get('state') ?? '', code: 'again' })).toMatchObject({
      policy: 'direct', addedAt: START, lastOkAt: START + HOUR,
    })
    const second = await env.gmail.beginSignIn({ account: 'work', origin: ORIGIN })
    expect(new URL(second.url).searchParams.get('login_hint')).toBe('owner@example.com')
    const fresh = await env.gmail.beginSignIn({ account: 'personal', origin: ORIGIN, loginHint: '' })
    expect(new URL(fresh.url).searchParams.has('login_hint')).toBe(false)
    expect(env.logs).toContain(`info gmail: sign-in started for personal (new), redirect ${ORIGIN}${OAUTH_PATH}`)
  })

  it('derives the redirect from an https or localhost origin, refuses any other, and prefers a configured redirect', async () => {
    const env = await mount()
    const redirect = async (origin: string): Promise<string> => (await env.gmail.beginSignIn({ account: 'work', origin })).redirectUri
    expect(await redirect('https://dsh.example:8443')).toBe(`https://dsh.example:8443${OAUTH_PATH}`)
    expect(await redirect('http://localhost:5173')).toBe(`http://localhost:5173${OAUTH_PATH}`)
    expect(await redirect('http://127.0.0.1')).toBe(`http://127.0.0.1${OAUTH_PATH}`)
    for (const origin of ['http://dsh.example', 'https://dsh.example/settings', 'http://localhost.evil.example']) {
      expect(await gmailFailure(redirect(origin))).toMatchObject({
        failure: 'invalid', message: `Google signs in only to an https page (or localhost); this page runs on ${origin}. Open Settings over https or set redirectUri`,
      })
    }
    const configured = await mount({ config: { redirectUri: 'https://auth.example/cb' } })
    expect((await configured.gmail.beginSignIn({ account: 'work', origin: 'http://192.168.1.2:5140' })).redirectUri).toBe('https://auth.example/cb')
    expect((await configured.gmail.status()).redirectUri).toBe('https://auth.example/cb')
    expect((await env.gmail.status()).redirectUri).toBeNull()
  })

  it('refuses an account id that is not a credential key segment and an unknown policy', async () => {
    const env = await mount()
    for (const account of ['Work', '1st', 'a'.repeat(25), 'work/x', '']) {
      expect(await gmailFailure(env.gmail.beginSignIn({ account, origin: ORIGIN }))).toMatchObject({ failure: 'invalid', message: expect.stringContaining('an account id is') as string })
    }
    expect(await gmailFailure(env.gmail.beginSignIn({ account: 'work', origin: ORIGIN, policy: 'yolo' as string as SendPolicy }))).toMatchObject({
      failure: 'invalid', message: 'unknown policy yolo',
    })
  })

  it('keeps at most 20 open sign-ins, and frees the ones older than ten minutes', async () => {
    const env = await mount()
    for (let index = 0; index < 20; index++) await env.gmail.beginSignIn({ account: `a${index}`, origin: ORIGIN })
    expect(await gmailFailure(env.gmail.beginSignIn({ account: 'work', origin: ORIGIN }))).toMatchObject({
      failure: 'limit', message: 'too many sign-ins are open; finish one or wait ten minutes',
    })
    vi.setSystemTime(START + 5 * 60_000)
    const late = await env.gmail.beginSignIn({ account: 'late', origin: ORIGIN }).catch((error: unknown) => error)
    expect(late).toBeInstanceOf(GmailError)
    vi.setSystemTime(START + 10 * 60_000 + 1)
    const { url } = await env.gmail.beginSignIn({ account: 'work', origin: ORIGIN })
    env.google.signInEmail = 'owner@example.com'
    expect(await env.gmail.completeSignIn({ state: new URL(url).searchParams.get('state') ?? '', code: 'c' })).toMatchObject({ id: 'work' })
  })

  it('cleans the display name of control characters and quoting characters, at most 100 characters', async () => {
    const env = await mount()
    env.google.mailbox('ada@example.com').displayName = '  Ada "The" <Lovelace>\u0007\\ '
    expect((await connect(env, 'ada', 'ada@example.com')).name).toBe('Ada The Lovelace')
    env.google.mailbox('long@example.com').displayName = 'n'.repeat(150)
    expect((await connect(env, 'long', 'long@example.com')).name).toBe('n'.repeat(100))
  })
})

describe('Settings status', () => {
  it('shows the client, the accounts in id order, and the limits, and never the client secret or a token', async () => {
    const env = await mount({ config: { trustedRecipients: ['boss@example.com'], maxSendsPerDay: 7, confirmTtlHours: 12 } })
    await connect(env, 'work', 'work@example.com')
    await connect(env, 'bot', 'bot@example.com')
    await connect(env, 'personal', 'me@example.com')
    const status = await env.gmail.status()
    expect(status).toMatchObject({
      client: { configured: true, clientId: CLIENT_ID, secretConfigured: true }, redirectUri: null, pending: [],
      maxSendsPerDay: 7, confirmTtlHours: 12, trustedRecipients: ['boss@example.com'],
    })
    expect(status.accounts.map(row => row.id)).toEqual(['bot', 'personal', 'work'])
    const text = JSON.stringify(status)
    expect(text).not.toContain(CLIENT_SECRET)
    const secrets = [...['work', 'bot', 'personal'].map(account => env.credentials.refreshToken(account) ?? 'missing'), ...env.google.accessEmail.keys()]
    expect(secrets).toHaveLength(6)
    for (const secret of secrets) expect(text).not.toContain(`"${secret}"`)
    expect(JSON.stringify(env.gmail.accounts())).not.toMatch(/refresh-|access-/u)
  })

  it('lists the newest 50 activity lines, newest first', async () => {
    const env = await mount()
    await connect(env, 'work', 'work@example.com')
    for (let index = 0; index < 30; index++) {
      await env.gmail.setPolicy('work', 'direct')
      await env.gmail.setPolicy('work', 'confirm-all')
    }
    const { activity } = await env.gmail.status()
    expect(activity).toHaveLength(50)
    expect(activity[0]).toMatchObject({ seq: 61, kind: 'policy', detail: 'direct → confirm-all' })
    expect(activity.at(-1)?.seq).toBe(12)
  })
})

describe('policy changes', () => {
  it('changes the policy, records it, and refuses an unknown policy or account', async () => {
    const env = await mount()
    await connect(env, 'work', 'work@example.com')
    await env.gmail.setPolicy('work', 'direct')
    expect(env.gmail.accounts()[0]?.policy).toBe('direct')
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'policy', detail: 'confirm-untrusted → direct' })
    expect(env.logs).toContain('info gmail: work policy confirm-untrusted → direct')
    expect(await gmailFailure(env.gmail.setPolicy('work', 'loose' as string as SendPolicy))).toMatchObject({ failure: 'invalid', message: 'unknown policy loose' })
    expect(await gmailFailure(env.gmail.setPolicy('nobody', 'direct'))).toMatchObject({ failure: 'unknown-account', message: 'no Gmail account "nobody"' })
  })
})

describe('removing an account', () => {
  it('revokes its token, deletes its grant and send count, and discards only its held messages', async () => {
    const env = await mount()
    await connect(env, 'work', 'work@example.com', 'confirm-all')
    await connect(env, 'personal', 'me@example.com', 'confirm-all')
    const refresh = env.credentials.refreshToken('work')
    const work = await env.gmail.send('work', { kind: 'new', message: MESSAGE }, ownerTurn())
    const personal = await env.gmail.send('personal', { kind: 'new', message: MESSAGE }, ownerTurn())
    expect([work.kind, personal.kind]).toEqual(['held', 'held'])
    await env.gmail.removeAccount('work')
    const revocations = env.google.calls.filter(call => call.url.href === 'https://oauth2.googleapis.com/revoke')
    expect(revocations.map(call => call.body)).toEqual([`token=${refresh}`])
    expect(env.credentials.records.has('gmail/work')).toBe(false)
    expect(env.credentials.records.has('gmail/personal')).toBe(true)
    const { pending, accounts, activity } = await env.gmail.status()
    expect(accounts.map(row => row.id)).toEqual(['personal'])
    expect(pending.map(row => [row.account, row.status, row.resolvedBy])).toEqual([['personal', 'held', null], ['work', 'discarded', 'settings']])
    expect(activity[0]).toMatchObject({ kind: 'removed', account: 'work', detail: 'work@example.com' })
    expect(env.logs).toContain('info gmail: work (work@example.com) removed, token revoked')
    expect(await gmailFailure(env.gmail.search('work', 'x'))).toMatchObject({
      failure: 'unknown-account', message: 'no Gmail account "work"; connected: personal',
    })
  })

  it('removes the account when the revocation fails or no grant is stored, and says so', async () => {
    const env = await mount()
    await connect(env, 'work', 'work@example.com')
    await connect(env, 'bot', 'bot@example.com')
    env.google.revokeStatus = 500
    await env.gmail.removeAccount('work')
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'removed', detail: 'work@example.com (revocation: HTTP 500)' })
    expect(env.logs).toContain('info gmail: work (work@example.com) removed; revocation: HTTP 500')
    await env.credentials.deleteRecord('gmail/bot')
    const before = env.google.calls.length
    await env.gmail.removeAccount('bot')
    expect(env.google.calls.length).toBe(before)
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'removed', detail: 'bot@example.com (revocation: no token stored)' })
    expect(await gmailFailure(env.gmail.removeAccount('bot'))).toMatchObject({ failure: 'unknown-account', message: 'no Gmail account "bot"' })
    expect(await gmailFailure(env.gmail.search('bot', 'x'))).toMatchObject({
      message: 'no Gmail account "bot"; connected: none (the owner adds them in Settings → 邮箱)',
    })
  })
})

describe('lifecycle', () => {
  it('answers no accounts before its storage has opened', async () => {
    const { ctx } = await host()
    const loading = ctx.plugin(Gmail, Config({} as Config))
    while (ctx.get('gmail') === undefined) await Promise.resolve()
    expect(ctx.gmail.accounts()).toEqual([])
    await loading
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.gmail.accounts()).toEqual([])
  })

  it('logs its accounts, held messages, and cap on start, and expires the holds that ran out while it was stopped', async () => {
    const first = await mount()
    expect(first.logs).toContain('info gmail: 0 account(s), 0 held message(s), cap 50/day')
    await connect(first, 'work', 'work@example.com', 'confirm-all')
    await connect(first, 'bot', 'bot@example.com')
    await first.gmail.send('work', { kind: 'new', message: MESSAGE }, ownerTurn())
    first.google.refused.add(first.credentials.refreshToken('bot') ?? '')
    vi.setSystemTime(START + 2 * HOUR)
    expect(await gmailFailure(first.gmail.search('bot', 'x'))).toMatchObject({ failure: 'needs-reconnect' })
    await first.fiber.dispose()

    const second = await mount({ pool: first.pool, credentials: first.credentials, google: first.google })
    const started = second.logs.find(line => line.startsWith('info gmail: 2 account(s) (')) ?? ''
    expect(started.endsWith('), 1 held message(s), cap 50/day')).toBe(true)
    expect(started).toContain('work confirm-all')
    expect(started).toContain('bot confirm-untrusted needs-reconnect')
    await second.fiber.dispose()

    vi.setSystemTime(START + 73 * HOUR)
    const third = await mount({ pool: first.pool, credentials: first.credentials, google: first.google })
    expect(third.logs.some(line => line.endsWith(', 0 held message(s), cap 50/day'))).toBe(true)
    expect(third.logs.some(line => /^info gmail: work: held [A-Z2-9]{6} expired$/u.test(line))).toBe(true)
    expect((await third.gmail.status()).pending.map(row => [row.status, row.resolvedBy])).toEqual([['expired', 'expiry']])
  })

  it('closes its domain and leaves when its fiber is disposed, and mounts again on the same host', async () => {
    const env = await mount()
    await connect(env, 'work', 'work@example.com')
    expect(env.facility.get('gmail')).toBeDefined()
    await env.fiber.dispose()
    expect(env.ctx.get('gmail')).toBeUndefined()
    expect(env.facility.get('gmail')).toBeUndefined()
    await env.ctx.plugin(Gmail, Config({} as Config))
    await vi.advanceTimersByTimeAsync(0)
    expect(env.ctx.gmail.accounts().map(row => row.email)).toEqual(['work@example.com'])
  })
})
