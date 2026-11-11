import { readFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginSessions } from '../src/login-session.ts'
import { readAccountFile, type WechatAccount } from '../src/login.ts'
import { WechatSettings, type SettingsChannel } from '../src/settings.ts'
import { maskId, WECHAT_PATH, type ChannelStatus, type WechatAnswer, type WechatView } from '../src/view.ts'
import { FakeIlink } from './fake-ilink.ts'

/** Faults the real file system cannot produce: an error with no `code`. */
const fsFaults = vi.hoisted(() => ({ rename: undefined as Error | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsFaults.rename !== undefined) throw fsFaults.rename
      return actual.rename(...args)
    },
  }
})

const TOKEN = 'bot-token-secret'
const CONFIRMED = { status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'botabcdef123@im.bot', baseurl: 'https://idc.ilinkai.weixin.qq.com', ilink_user_id: 'owneruser456@im.wechat' }
const IDLE: ChannelStatus = {
  channel: { link: 'idle', lastPollAt: null, failures: 0, lastError: null, lastInboundAt: null, lastOutboundAt: null, lastOutboundKind: null },
  window: { open: false, closed: 'no-account', repliesLeft: null, repliesPerToken: 10, expiresAt: null },
  outbox: { count: 0, limit: 50, oldestAt: null },
  delivery: { mode: 'hybrid', toolSends: 0, repeatsSkipped: 0 },
}

let dir: string
let accountFile: string
const open: WechatSettings[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fork-wechat-settings-'))
  accountFile = join(dir, 'account.json')
})

afterEach(() => {
  fsFaults.rename = undefined
  for (const settings of open.splice(0)) settings.dispose()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Settings over a fake channel and the iLink double. */
function mount(status: ChannelStatus = IDLE) {
  const ilink = new FakeIlink()
  const logs: string[] = []
  const reloads: string[] = []
  const channel: SettingsChannel = { status: () => status, reloadAccount: (reason) => { reloads.push(reason) } }
  const settings = new WechatSettings({
    accountFile,
    timeZone: 'America/New_York',
    channel,
    logger: { info: (message) => { logs.push(`info ${message}`) }, warn: (message) => { logs.push(`warn ${message}`) } },
    login: { fetch: ilink.fetch, baseUrl: 'https://ilink.test', pollDelayMs: 0 },
  })
  open.push(settings)
  const route = settings.route()
  const bodies: string[] = []
  const call = async (body?: unknown, init: { contentType?: string; raw?: string; method?: string } = {}) => {
    const method = init.method ?? (body === undefined && init.raw === undefined ? 'GET' : 'POST')
    const response = await route.fetch(new Request(`http://127.0.0.1${WECHAT_PATH}`, {
      method,
      ...method === 'POST' ? { headers: { 'content-type': init.contentType ?? 'application/json' }, body: init.raw ?? JSON.stringify(body) } : {},
    }))
    const text = await response.text()
    bodies.push(text)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return { status: response.status, json: JSON.parse(text) as WechatAnswer & { error?: string } }
  }
  return { ilink, logs, reloads, settings, route, call, bodies }
}

function writeBound(overrides: Partial<WechatAccount> = {}): void {
  const account: WechatAccount = { botToken: TOKEN, botId: 'botabcdef123@im.bot', baseUrl: 'https://idc.ilinkai.weixin.qq.com', ownerUserId: 'owneruser456@im.wechat', boundAt: '2026-10-21T00:00:00.000Z', ...overrides }
  writeFileSync(accountFile, JSON.stringify(account), { mode: 0o600 })
}

/** Poll a login until `done` holds. */
async function until(call: ReturnType<typeof mount>['call'], key: string, done: (phase: string) => boolean) {
  let last = await call({ action: 'login.poll', key })
  await vi.waitFor(async () => {
    last = await call({ action: 'login.poll', key })
    expect(done(last.json.login?.phase ?? 'gone')).toBe(true)
  })
  return last
}

describe('Settings route: reads', () => {
  it('registers GET and POST under /api, buffered', () => {
    const { route } = mount()
    expect([route.path, route.methods, route.requestBody]).toEqual(['/api/fork.wechat', ['GET', 'POST'], 'buffered'])
  })

  it('answers an unbound channel', async () => {
    const { call } = mount()
    const { status, json } = await call()
    expect(status).toBe(200)
    expect(json.login).toBeNull()
    expect(json.view).toEqual({ ...IDLE, binding: { state: 'unbound' }, loginActive: false, timeZone: 'America/New_York' })
  })

  it('answers a bound channel with masked ids and the bound time, and never the token', async () => {
    writeBound()
    const { call, bodies } = mount({ ...IDLE, channel: { ...IDLE.channel, link: 'connected', lastPollAt: 5, lastError: { at: 4, where: 'poll', text: 'iLink ilink/bot/getupdates: HTTP 502' } } })
    const { json } = await call()
    expect(json.view.binding).toEqual({ state: 'bound', botId: 'bot…23@im.bot', ownerId: 'own…56@im.wechat', boundAt: Date.parse('2026-10-21T00:00:00.000Z') })
    expect(json.view.channel.link).toBe('connected')
    expect(bodies.join('')).not.toContain(TOKEN)
    expect(bodies.join('')).not.toContain('botabcdef123')
    expect(bodies.join('')).not.toContain('owneruser456')
  })

  it('names an unreadable account file without quoting it', async () => {
    writeFileSync(accountFile, `{"botToken":"${TOKEN}",`)
    const { call, bodies } = mount()
    expect((await call()).json.view.binding).toEqual({ state: 'invalid', reason: 'not valid JSON' })
    expect(bodies.join('')).not.toContain(TOKEN)
  })

  it('masks short ids to their first character and keeps the domain', () => {
    expect(maskId('ab@im.bot')).toBe('a…@im.bot')
    expect(maskId('abcdefgh@im.bot')).toBe('abc…gh@im.bot')
    expect(maskId('plain')).toBe('p…')
    expect(maskId('@im.bot')).toBe('…@im.bot')
    expect(maskId('')).toBe('…')
  })
})

describe('Settings route: request validation', () => {
  it('refuses a body that is not JSON, not an object of a known action, or short of a field', async () => {
    const { call, logs } = mount()
    expect((await call(undefined, { method: 'POST', raw: 'not json' })).status).toBe(400)
    expect((await call(undefined, { method: 'POST', raw: '{"action":"login.poll"}' })).status).toBe(400)
    expect((await call({ action: 'format-disk' })).status).toBe(400)
    expect((await call({ action: 'unbind', confirm: 'yes' })).status).toBe(400)
    expect((await call({ action: 'login.code', key: 'k' })).status).toBe(400)
    expect((await call('login.start')).status).toBe(400)
    expect((await call({ action: 'login.start' }, { contentType: 'text/plain' })).status).toBe(415)
    expect(logs).toEqual([])
  })

  it('does not repeat request data in a refusal', async () => {
    const { call } = mount()
    const { json } = await call({ action: 'login.code', key: 'k', code: 123_456 })
    expect(JSON.stringify(json)).not.toContain('123456')
    expect(json.error).toBe('unknown action or missing field')
  })
})

describe('Settings route: login', () => {
  it('starts with a QR code of the link and an opaque key', async () => {
    const { call, logs } = mount()
    const { status, json } = await call({ action: 'login.start' })
    expect(status).toBe(200)
    const login = json.login!
    expect(login.phase).toBe('waiting')
    expect(login.key).toMatch(/^[0-9a-f-]{36}$/)
    expect(login.qr!.url).toBe('https://liteapp.weixin.qq.com/q/1?qrcode=qr-1&bot_type=3')
    expect(login.qr!.attempt).toBe(1)
    expect(login.qr!.rows).toHaveLength(login.qr!.size)
    expect(login.qr!.rows.every(row => /^[01]+$/.test(row) && row.length === login.qr!.size)).toBe(true)
    // The three finder patterns put a dark corner module in three corners and none in the fourth.
    const { rows, size } = login.qr!
    expect([rows[0]![0], rows[0]![size - 1], rows[size - 1]![0], rows[size - 1]![size - 1]]).toEqual(['1', '1', '1', '0'])
    expect(json.view.loginActive).toBe(true)
    expect(logs.join('\n')).not.toContain('liteapp')
  })

  it('walks waiting, scanned, and done, writes the account file as the terminal login does, and has the channel read it', async () => {
    const { call, ilink, reloads, logs, bodies } = mount()
    const { json } = await call({ action: 'login.start' })
    const key = json.login!.key
    ilink.statuses({ status: 'wait' }, { status: 'scaned' })
    const scanned = await until(call, key, phase => phase === 'scanned')
    expect(scanned.json.login!.qr!.attempt).toBe(1)
    expect(existsSync(accountFile)).toBe(false)
    ilink.statuses(CONFIRMED)
    const done = await until(call, key, phase => phase === 'done')
    expect(done.json.login!.qr).toBeNull()
    expect(done.json.view.loginActive).toBe(false)
    expect(done.json.view.binding).toMatchObject({ state: 'bound', botId: 'bot…23@im.bot' })
    const read = readAccountFile(accountFile)
    expect(read.kind === 'ok' && read.account).toMatchObject({ botToken: TOKEN, botId: 'botabcdef123@im.bot', ownerUserId: 'owneruser456@im.wechat', baseUrl: 'https://idc.ilinkai.weixin.qq.com' })
    expect(statSync(accountFile).mode & 0o777).toBe(0o600)
    expect(reloads).toEqual(['bound bot botabcdef123@im.bot'])
    // Neither an answer nor a log line carries the token or the QR link.
    expect(bodies.join('\n').replaceAll(/"url":"[^"]*"/gu, '')).not.toContain(TOKEN)
    expect(logs.join('\n')).not.toContain(TOKEN)
    expect(logs.join('\n')).not.toContain('liteapp')
    expect(logs.some(line => /^info fork-wechat: settings login\.start ok \(\d+ ms\)$/.test(line))).toBe(true)
  })

  it('asks for the number WeChat shows, rejects a malformed one, and asks again after a wrong one', async () => {
    const { call, ilink } = mount()
    const key = (await call({ action: 'login.start' })).json.login!.key
    expect((await call({ action: 'login.code', key, code: '1234' })).status).toBe(409)
    ilink.statuses({ status: 'scaned' }, { status: 'need_verifycode' })
    const asked = await until(call, key, phase => phase === 'needs-code')
    expect(asked.json.login!.codeRetry).toBe(false)
    expect((await call({ action: 'login.code', key, code: 'abcd' })).status).toBe(400)
    expect((await call({ action: 'login.code', key, code: '' })).status).toBe(400)
    expect((await call({ action: 'login.code', key: 'other', code: '1234' })).status).toBe(404)
    ilink.statuses({ status: 'need_verifycode' })
    expect((await call({ action: 'login.code', key, code: ' 1234 ' })).json.login!.phase).toBe('scanned')
    const again = await until(call, key, phase => phase === 'needs-code')
    expect(again.json.login!.codeRetry).toBe(true)
    ilink.statuses({ status: 'scaned' }, CONFIRMED)
    expect((await call({ action: 'login.code', key, code: '5678' })).status).toBe(200)
    await until(call, key, phase => phase === 'done')
    // The numbers were sent to WeChat, in order, trimmed.
    expect(ilink.requestsTo('ilink/bot/get_qrcode_status').map(request => request.query['verify_code']).filter(Boolean)).toEqual(['1234', '5678'])
  })

  it('shows a refreshed code, then expired once the codes run out', async () => {
    const { call, ilink } = mount()
    const login = (await call({ action: 'login.start' })).json.login!
    ilink.statuses({ status: 'expired' })
    const refreshed = await until(call, login.key, () => true)
    expect(refreshed.json.login!.phase).toBe('waiting')
    await vi.waitFor(async () => { expect((await call({ action: 'login.poll', key: login.key })).json.login!.qr!.attempt).toBe(2) })
    ilink.statuses({ status: 'expired' }, { status: 'expired' })
    const expired = await until(call, login.key, phase => phase === 'expired')
    expect(expired.json.login).toMatchObject({ phase: 'expired', qr: null, failure: null })
    expect(existsSync(accountFile)).toBe(false)
    // Another start gives a fresh login, and the old key is gone.
    const next = (await call({ action: 'login.start' })).json.login!
    expect(next.key).not.toBe(login.key)
    expect((await call({ action: 'login.poll', key: login.key })).status).toBe(404)
  })

  it('reports why a login failed', async () => {
    const { call, ilink } = mount()
    const key = (await call({ action: 'login.start' })).json.login!.key
    ilink.statuses({ status: 'binded_redirect' })
    const failed = await until(call, key, phase => phase === 'failed')
    expect(failed.json.login).toMatchObject({ phase: 'failed', failure: 'bound-elsewhere', qr: null })
    expect(failed.json.view.loginActive).toBe(false)
  })

  it('reports a code that cannot be fetched as a failed login', async () => {
    const { call, ilink, logs } = mount()
    ilink.reply('ilink/bot/get_bot_qrcode', { status: 502 })
    const { status, json } = await call({ action: 'login.start' })
    expect(status).toBe(200)
    expect(json.login).toMatchObject({ phase: 'failed', failure: 'other', qr: null })
    expect(logs.some(line => line.startsWith('warn fork-wechat: settings login did not bind'))).toBe(true)
  })

  it('does not bind a login that ended while its last status call was in flight, and fails one whose file cannot be written', async () => {
    const { call, ilink, reloads } = mount()
    const key = (await call({ action: 'login.start' })).json.login!.key
    expect((await call({ action: 'login.cancel', key })).json.login).toMatchObject({ phase: 'failed', failure: 'cancelled' })
    ilink.statuses(CONFIRMED)
    await vi.waitFor(() => { expect(ilink.requestsTo('ilink/bot/get_qrcode_status').length).toBeLessThanOrEqual(1) })
    expect(existsSync(accountFile)).toBe(false)
    expect(reloads).toEqual([])
    expect((await call({ action: 'login.cancel', key })).status).toBe(404)

    // A directory where the file belongs makes the write fail after the confirmation.
    const blocked = mount()
    writeFileSync(join(dir, 'blocker'), '')
    const settings = new WechatSettings({
      accountFile: join(dir, 'blocker', 'account.json'), timeZone: 'UTC', channel: { status: () => IDLE, reloadAccount: () => {} },
      logger: { info: () => {}, warn: () => {} }, login: { fetch: blocked.ilink.fetch, baseUrl: 'https://ilink.test', pollDelayMs: 0 },
    })
    open.push(settings)
    blocked.ilink.statuses(CONFIRMED)
    const login = await settings.route().fetch(new Request('http://127.0.0.1/api/fork.wechat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"login.start"}' }))
    const start = await login.json() as WechatAnswer
    await vi.waitFor(async () => {
      const response = await settings.route().fetch(new Request('http://127.0.0.1/api/fork.wechat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'login.poll', key: start.login!.key }) }))
      expect(((await response.json()) as WechatAnswer).login).toMatchObject({ phase: 'failed', failure: 'save-failed' })
    })
  })

  it('gives up a login nobody finishes, even one waiting for a number', async () => {
    const ilink = new FakeIlink()
    const settings = new WechatSettings({
      accountFile, timeZone: 'UTC', channel: { status: () => IDLE, reloadAccount: () => {} }, logger: { info: () => {}, warn: () => {} },
      login: { fetch: ilink.fetch, baseUrl: 'https://ilink.test', pollDelayMs: 0 }, loginTimeoutMs: 80,
    })
    open.push(settings)
    const post = async (body: unknown) => (await (await settings.route().fetch(new Request('http://127.0.0.1/api/fork.wechat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json()) as WechatAnswer
    const key = (await post({ action: 'login.start' })).login!.key
    ilink.statuses({ status: 'need_verifycode' })
    await vi.waitFor(async () => { expect((await post({ action: 'login.poll', key })).login!.phase).toBe('needs-code') })
    await vi.waitFor(async () => { expect((await post({ action: 'login.poll', key })).login).toMatchObject({ phase: 'failed', failure: 'timeout' }) })
  })
})

describe('Settings route: unbind', () => {
  it('moves the account file to a timestamped backup next to it, keeps it, and has the channel read the file again', async () => {
    writeBound()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T15:04:05.678Z'))
    const { call, reloads, logs, bodies } = mount()
    const before = readFileSync(accountFile, 'utf8')
    const { status, json } = await call({ action: 'unbind', confirm: 'unbind' })
    expect(status).toBe(200)
    expect(json.view.binding).toEqual({ state: 'unbound' })
    expect(existsSync(accountFile)).toBe(false)
    expect(readdirSync(dir)).toEqual(['account.json.bak.20261101150405'])
    const backup = join(dir, 'account.json.bak.20261101150405')
    expect(readFileSync(backup, 'utf8')).toBe(before)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    expect(reloads).toEqual(['unbound from Settings'])
    expect(logs.some(line => /^info fork-wechat: settings unbind ok \(\d+ ms\)$/.test(line))).toBe(true)
    expect(logs.join('\n')).not.toContain(TOKEN)
    expect(bodies.join('\n')).not.toContain(TOKEN)
  })

  it('refuses when nothing is bound, and refuses without the confirmation', async () => {
    const { call, reloads } = mount()
    expect((await call({ action: 'unbind', confirm: 'unbind' })).status).toBe(409)
    writeBound()
    expect((await call({ action: 'unbind' })).status).toBe(400)
    expect(existsSync(accountFile)).toBe(true)
    expect(reloads).toEqual([])
  })

  it('never overwrites an earlier backup made in the same second', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T15:04:05.000Z'))
    const { call } = mount()
    writeBound({ botId: 'first@im.bot' })
    await call({ action: 'unbind', confirm: 'unbind' })
    writeBound({ botId: 'second@im.bot' })
    await call({ action: 'unbind', confirm: 'unbind' })
    expect(readdirSync(dir).sort()).toEqual(['account.json.bak.20261101150405', 'account.json.bak.20261101150405-1'])
    expect(readFileSync(join(dir, 'account.json.bak.20261101150405'), 'utf8')).toContain('first@im.bot')
    expect(readFileSync(join(dir, 'account.json.bak.20261101150405-1'), 'utf8')).toContain('second@im.bot')
  })

  it('ends an open login, so it cannot rebind behind the unbind', async () => {
    writeBound()
    const { call, ilink } = mount()
    const key = (await call({ action: 'login.start' })).json.login!.key
    await call({ action: 'unbind', confirm: 'unbind' })
    ilink.statuses(CONFIRMED)
    expect((await call({ action: 'login.poll', key })).json.login).toMatchObject({ phase: 'failed', failure: 'cancelled' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(existsSync(accountFile)).toBe(false)
  })
})

describe('view contents', () => {
  it('has no field that could hold a secret or a message text', async () => {
    writeBound()
    const { call } = mount()
    const view: WechatView = (await call()).json.view
    const keys = (value: unknown): string[] => (typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]) : [])
    expect(new Set(keys(view))).toEqual(new Set([
      'binding', 'state', 'botId', 'ownerId', 'boundAt', 'channel', 'link', 'lastPollAt', 'failures', 'lastError', 'lastInboundAt', 'lastOutboundAt', 'lastOutboundKind',
      'window', 'open', 'closed', 'repliesLeft', 'repliesPerToken', 'expiresAt', 'outbox', 'count', 'limit', 'oldestAt',
      'delivery', 'mode', 'toolSends', 'repeatsSkipped', 'loginActive', 'timeZone',
    ]))
  })
})

describe('wire types', () => {
  it('are shared with the browser half as a byte-identical copy', async () => {
    const host = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
    const client = await readFile(new URL('../../fork-wechat-settings/src/wechat-view.ts', import.meta.url), 'utf8')
    expect(host).toBe(client)
  })
})

describe('Settings route: account file edge cases', () => {
  it('answers no bound time for a time it cannot read', async () => {
    writeBound({ boundAt: 'not a time' })
    const { call } = mount()
    expect((await call()).json.view.binding).toMatchObject({ state: 'bound', boundAt: null })
  })

  it('refuses a POST that declares no content type', async () => {
    const { route } = mount()
    const request = new Request(`http://127.0.0.1${WECHAT_PATH}`, { method: 'POST', body: new Uint8Array([0x7b, 0x7d]) })
    const response = await route.fetch(request)
    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({ error: 'expected application/json' })
  })

  it('keeps the account and reports the code when the file cannot be moved aside', async () => {
    // The backup suffix pushes this name past the 255-byte name limit, so the rename fails for real.
    accountFile = join(dir, 'a'.repeat(240))
    writeBound()
    const { call, logs, reloads } = mount()
    const answer = await call({ action: 'unbind', confirm: 'unbind' })
    expect(answer).toMatchObject({ status: 500, json: { error: 'the account file could not be moved' } })
    expect(logs).toContain('warn fork-wechat: settings unbind failed to move the account file (ENAMETOOLONG)')
    expect(existsSync(accountFile)).toBe(true)
    expect(reloads).toEqual([])
  })

  it('logs a failed move plainly when the error names no code', async () => {
    writeBound()
    const { call, logs } = mount()
    fsFaults.rename = new Error('odd failure')
    expect((await call({ action: 'unbind', confirm: 'unbind' })).status).toBe(500)
    expect(logs).toContain('warn fork-wechat: settings unbind failed to move the account file (error)')
  })

  it('logs a confirmed login whose save failed plainly when the error names no code', async () => {
    const { call, ilink, logs } = mount()
    fsFaults.rename = new Error('odd failure')
    ilink.statuses(CONFIRMED)
    const key = (await call({ action: 'login.start' })).json.login!.key
    expect((await until(call, key, phase => phase === 'failed')).json.login).toMatchObject({ phase: 'failed', failure: 'save-failed' })
    expect(logs).toContain('warn fork-wechat: settings login confirmed but the account file was not written (error)')
  })
})

describe('LoginSessions on its own', () => {
  /** Sessions with no clock override, over the iLink double. */
  function sessions(onBound: () => void, fetch?: typeof globalThis.fetch) {
    const ilink = new FakeIlink()
    const logs: string[] = []
    const logins = new LoginSessions({
      accountFile,
      onBound,
      logger: { info: (message) => { logs.push(message) }, warn: (message) => { logs.push(message) } },
      login: { fetch: fetch ?? ilink.fetch, baseUrl: 'https://ilink.test', pollDelayMs: 0 },
    })
    return { ilink, logs, logins }
  }

  it('binds on the real clock when no clock is given', async () => {
    const bound: string[] = []
    const { ilink, logins, logs } = sessions(() => { bound.push('bound') })
    ilink.statuses(CONFIRMED)
    const { key } = await logins.start()
    await vi.waitFor(() => { expect(logins.poll(key)?.phase).toBe('done') })
    expect(bound).toEqual(['bound'])
    expect(logs.some(line => /^fork-wechat: settings login bound bot botabcdef123@im\.bot \(\d+ ms\)$/.test(line))).toBe(true)
  })

  it('keeps a saved login done when the bound hook throws, and logs the hook\'s failure', async () => {
    const { ilink, logins, logs } = sessions(() => { throw 'the channel refused' })
    ilink.statuses(CONFIRMED)
    const { key } = await logins.start()
    await vi.waitFor(() => { expect(logs).toContain('fork-wechat: the channel did not take the new account (the channel refused)') })
    expect(logins.poll(key)?.phase).toBe('done')
    expect(readAccountFile(accountFile).kind).toBe('ok')
  })

  it('ends at once when the status answer asking for a number arrives after a cancel', async () => {
    let onStatus = (): void => {}
    const relay: typeof globalThis.fetch = async (input, init) => {
      const response = await double.ilink.fetch(input, init)
      if ((input instanceof Request ? input.url : String(input)).includes('get_qrcode_status')) onStatus()
      return response
    }
    const double = sessions(() => { throw new Error('a cancelled login must not bind') }, relay)
    const { key } = await double.logins.start()
    onStatus = () => { double.logins.cancel(key) }
    double.ilink.statuses({ status: 'need_verifycode' })
    const ended = 'fork-wechat: settings login did not bind (cancelled: cancelled from Settings)'
    await vi.waitFor(() => { expect(double.logs).toContain(ended) })
    expect(double.logins.poll(key)).toMatchObject({ phase: 'failed', failure: 'cancelled' })
    expect(double.logins.code(key, '12')).toBe('not-waiting')
    expect(existsSync(accountFile)).toBe(false)
  })
})
