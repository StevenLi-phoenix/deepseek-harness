import { Context } from '@deepseek-ai/cordis'
import type { WebResourceRoute } from '@deepseek-ai/dsh-host-webserver'
import { GmailError, OAUTH_PATH, type GmailStatus } from '@deepseek-ai/dsh-gmail'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { escapeHtml, GMAIL_OAUTH_PATH, GMAIL_PRIVACY_PATH, privacyPage, type GmailAnswer } from '../src/index.ts'
import { PAGE_HEADERS } from '../src/page.ts'

interface Route {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const STATUS: GmailStatus = {
  client: { configured: true, clientId: '123-abc.apps.googleusercontent.com', secretConfigured: true },
  redirectUri: null,
  accounts: [{ id: 'personal', email: 'owner@example.com', name: 'Owner', policy: 'confirm-untrusted', addedAt: 1, lastOkAt: 2, lastError: null, needsReconnect: false, sentToday: 3 }],
  pending: [{
    code: 'ABC234', account: 'personal', from: 'owner@example.com', draftId: 'r-draft', threadId: 't1', to: ['ann@example.com'], cc: [], bcc: ['bob@example.com'],
    subject: 'Hi', preview: 'Hello Ann', attachments: ['plan.pdf'], createdAt: 10, origin: 'owner, read gmail_read', reason: 'mail was read in this turn',
    sessionId: 'chat-1', status: 'held', resolvedAt: null, resolvedBy: null, messageId: null, noticeSent: true, fingerprint: 'secret-ish-hash',
  }],
  activity: [{ seq: 4, at: 11, account: 'personal', kind: 'held', detail: 'ann@example.com' }],
  maxSendsPerDay: 50,
  confirmTtlHours: 72,
  trustedRecipients: ['owner@example.com'],
}

function gmailStub() {
  return {
    status: vi.fn(async () => STATUS),
    setClient: vi.fn(async () => STATUS.client),
    beginSignIn: vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s', redirectUri: `https://dsh.example${OAUTH_PATH}` })),
    setPolicy: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
    confirm: vi.fn(async () => ({ account: 'personal', messageId: 'm1', threadId: 't1' })),
    discard: vi.fn(async () => {}),
    completeSignIn: vi.fn(async () => STATUS.accounts[0]),
  }
}

async function mount(options: { web?: boolean } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (entry) => { logs.push(`${entry.type}: ${String(entry.args[0])}`) } })
  const routes: Route[] = []
  const pages: WebResourceRoute[] = []
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); return Promise.resolve() } } } } as never)
  if (options.web !== false) {
    ctx.provide('webServer', { register: (route: WebResourceRoute) => { pages.push(route); return () => { pages.splice(pages.indexOf(route), 1) } } } as never)
  }
  const gmail = gmailStub()
  ctx.provide('gmail', gmail as never)
  const fiber = await ctx.plugin(plugin)
  const api = (init?: RequestInit) => {
    const route = routes.find(entry => entry.path === '/api/gmail')
    if (route === undefined) throw new Error('route missing')
    return route.fetch(new Request('http://127.0.0.1/api/gmail', init))
  }
  const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', origin: 'https://dsh.example' }) => api({ method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const page = async (query: string) => {
    const route = pages.find(entry => entry.path === OAUTH_PATH)
    if (route === undefined) throw new Error('page missing')
    return route.resource(new Request(`https://dsh.example${OAUTH_PATH}${query}`))
  }
  return { ctx, fiber, routes, pages, gmail, api, post, page, logs }
}

describe('gmail-settings Host routes', () => {
  it('registers /api/gmail under the /api sign-in and the sign-in and privacy pages outside it, and drops them on disposal', async () => {
    const { routes, pages, fiber } = await mount()
    expect(routes.map(route => [route.path, route.methods])).toEqual([['/api/gmail', ['GET', 'POST']]])
    expect(pages.map(route => [route.kind, route.path])).toEqual([['exact', '/gmail.oauth'], ['exact', '/gmail.privacy']])
    expect(GMAIL_OAUTH_PATH).toBe(OAUTH_PATH)
    await fiber.dispose()
    expect(routes).toEqual([])
    expect(pages).toEqual([])
  })

  it('serves the privacy statement as a static page in English and Chinese, with no script and no referrer', async () => {
    const { pages } = await mount()
    const route = pages.find(entry => entry.path === GMAIL_PRIVACY_PATH)
    if (route === undefined) throw new Error('privacy page missing')
    const response = await route.resource(new Request(`https://dsh.example${GMAIL_PRIVACY_PATH}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const html = await response.text()
    expect(html).toBe(privacyPage())
    expect(html).toContain('<title>DSH Mail privacy statement</title>')
    expect(html).toContain('it never deletes mail permanently')
    expect(html).toContain('the language model provider the owner has configured')
    expect(html).toContain('<section lang="zh-CN">')
    expect(html).toContain('它从不永久删除邮件')
    expect(html).toContain('owner&#39;s')
    expect(html).not.toContain('<script')
  })

  it('serves the status without a web server, and leaves the sign-in page out', async () => {
    const { routes, pages } = await mount({ web: false })
    expect(routes).toHaveLength(1)
    expect(pages).toEqual([])
  })

  it('answers the status field by field: no draft id, Session id, message id, or fingerprint reaches the page', async () => {
    const { api } = await mount()
    const response = await api()
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as GmailAnswer
    expect(body.status.accounts).toEqual(STATUS.accounts)
    expect(body.status.pending[0]).toEqual({
      code: 'ABC234', account: 'personal', from: 'owner@example.com', to: ['ann@example.com'], cc: [], bcc: ['bob@example.com'], subject: 'Hi', preview: 'Hello Ann',
      attachments: ['plan.pdf'], createdAt: 10, origin: 'owner, read gmail_read', reason: 'mail was read in this turn', status: 'held', resolvedAt: null, resolvedBy: null,
      noticeSent: true,
    })
    expect(JSON.stringify(body)).not.toMatch(/r-draft|chat-1|secret-ish-hash/u)
    expect(body.status).toMatchObject({ client: STATUS.client, redirectUri: null, maxSendsPerDay: 50, confirmTtlHours: 72, trustedRecipients: ['owner@example.com'] })
    expect(body.status.activity).toEqual(STATUS.activity)
    expect(body.signInUrl).toBeUndefined()
  })
})

describe('POST /api/gmail', () => {
  it('takes JSON only, so a cross-site form cannot reach an action', async () => {
    const { api, post, gmail } = await mount()
    const response = await post({ action: 'discard', code: 'ABC234' }, { 'content-type': 'application/x-www-form-urlencoded' })
    expect(response.status).toBe(415)
    expect((await api({ method: 'POST', body: new TextEncoder().encode('{"action":"discard","code":"ABC234"}') })).status).toBe(415)
    expect(gmail.discard).not.toHaveBeenCalled()
  })

  it('refuses a body that is not JSON or not an action', async () => {
    const { post } = await mount()
    expect(await (await post('{')).json()).toEqual({ error: 'the body is not JSON' })
    const unknown = await post({ action: 'send', code: 'ABC234' })
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as { error: string }).error).toMatch(/^not an action: action /u)
    const extra = await post({ action: 'remove', account: 'personal', force: true })
    expect(extra.status).toBe(400)
    const policy = await post({ action: 'policy', account: 'personal', policy: 'yolo' })
    expect(((await policy.json()) as { error: string }).error).toContain('policy')
  })

  it('stores the OAuth client and answers the new status', async () => {
    const { post, gmail, logs } = await mount()
    const response = await post({ action: 'client', json: '{"web":{}}' })
    expect(gmail.setClient).toHaveBeenCalledWith('{"web":{}}')
    expect(((await response.json()) as GmailAnswer).status.client.configured).toBe(true)
    expect(logs.some(line => /^info: gmail-settings: client done in \d+ ms$/u.test(line))).toBe(true)
  })

  it('starts a sign-in with the page\'s origin and answers the Google page to open', async () => {
    const { post, gmail } = await mount()
    const body = await (await post({ action: 'sign-in', account: ' work ', policy: 'confirm-all', loginHint: 'owner@work.example' })).json() as GmailAnswer
    expect(gmail.beginSignIn).toHaveBeenCalledWith({ account: 'work', policy: 'confirm-all', loginHint: 'owner@work.example', origin: 'https://dsh.example' })
    expect(body.signInUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=s')
  })

  it('falls back to the request\'s own origin when the browser sent none', async () => {
    const { post, gmail } = await mount()
    await post({ action: 'sign-in', account: 'bot' }, { 'content-type': 'application/json' })
    expect(gmail.beginSignIn).toHaveBeenCalledWith({ account: 'bot', policy: undefined, loginHint: undefined, origin: 'http://127.0.0.1' })
  })

  it('changes a policy, removes an account, and confirms or discards a held message by its code', async () => {
    const { post, gmail } = await mount()
    await post({ action: 'policy', account: 'personal', policy: 'read-only' })
    expect(gmail.setPolicy).toHaveBeenCalledWith('personal', 'read-only')
    await post({ action: 'remove', account: 'personal' })
    expect(gmail.removeAccount).toHaveBeenCalledWith('personal')
    await post({ action: 'confirm', code: ' abc234 ' })
    expect(gmail.confirm).toHaveBeenCalledWith('ABC234', { by: 'settings' })
    await post({ action: 'discard', code: 'abc234' })
    expect(gmail.discard).toHaveBeenCalledWith('ABC234')
  })

  it('answers a refusal of the service as 400 with its message, and any other failure as 500 without details', async () => {
    const { post, gmail, logs } = await mount()
    gmail.confirm.mockRejectedValueOnce(new GmailError('expired', 'ABC234 expired'))
    const refused = await post({ action: 'confirm', code: 'ABC234' })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: 'ABC234 expired' })
    expect(logs).toContain('info: gmail-settings: confirm refused (expired): ABC234 expired')
    gmail.removeAccount.mockRejectedValueOnce(new Error('disk full at /secret/path'))
    const failed = await post({ action: 'remove', account: 'personal' })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'the action failed; the DSH log has the details' })
    expect(logs).toContain('warn: gmail-settings: remove failed: disk full at /secret/path')
    gmail.discard.mockRejectedValueOnce('gone')
    expect((await post({ action: 'discard', code: 'ABC234' })).status).toBe(500)
    expect(logs).toContain('warn: gmail-settings: discard failed: gone')
  })
})

describe('the sign-in page', () => {
  it('connects the account with the redirect\'s state and code, and keeps the code out of any referrer', async () => {
    const { page, gmail } = await mount()
    const response = await page('?state=s1&code=c1&scope=x')
    expect(gmail.completeSignIn).toHaveBeenCalledWith({ state: 's1', code: 'c1', error: undefined })
    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers.entries())).toMatchObject(PAGE_HEADERS)
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('content-security-policy')).toContain('default-src \'none\'')
    const html = await response.text()
    expect(html).toContain('<h1>已连接 personal</h1>')
    expect(html).toContain('owner@example.com 已连接，发信规则为 confirm-untrusted。')
    expect(html).not.toContain('<script')
  })

  it('passes Google\'s error on, and shows the service\'s refusal escaped', async () => {
    const { page, gmail } = await mount()
    gmail.completeSignIn.mockRejectedValueOnce(new GmailError('denied', 'Google did not grant access (<img src=x onerror=alert(1)>)'))
    const response = await page('?state=s2&error=access_denied')
    expect(gmail.completeSignIn).toHaveBeenCalledWith({ state: 's2', code: undefined, error: 'access_denied' })
    expect(response.status).toBe(400)
    const html = await response.text()
    expect(html).toContain('<h1>没有连接</h1>')
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;')
    expect(html).not.toContain('<img')
  })

  it('refuses a request without a state, and hides an unexpected failure', async () => {
    const { page, gmail, logs } = await mount()
    const missing = await page('?code=c1')
    expect(missing.status).toBe(400)
    expect(gmail.completeSignIn).not.toHaveBeenCalled()
    gmail.completeSignIn.mockRejectedValueOnce(new Error('ECONNRESET token endpoint'))
    const failed = await page('?state=s3&code=c3')
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('ECONNRESET')
    expect(logs).toContain('warn: gmail-settings: sign-in page failed: ECONNRESET token endpoint')
  })

  it('escapes every HTML-special character', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&#60;a href=&#34;x&#34;&#62;&#38;&#39;&#60;/a&#62;')
  })
})
