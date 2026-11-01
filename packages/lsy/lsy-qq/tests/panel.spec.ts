import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { encode } from 'uqr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QqObserver, { Config, isPrivateAddress, QqObserver as Observer } from '../src/index.ts'
import { QQ_PATH, QQ_REFRESH_PATH, type QqPanel, type QqRefreshAnswer } from '../src/panel-view.ts'
import { FakeOneBot } from './fake-onebot.ts'

const TOKEN = 'onebot-token-0123456789abcdef'
const QR_URL = 'https://txz.qq.com/p?k=SECRETQRLINK&f=1'

interface LogLine { type: string; text: string }

/** The login door as the observer sees it. */
class FakeDoor {
  server: Server
  requests: Array<{ method: string; path: string; authorization: string | undefined }> = []
  body: Record<string, unknown> = { v: 1, napcat: 'up', login: 'qr', phase: 'waiting_qrcode', uin: null, nickname: null, qrUrl: QR_URL, error: null, at: 1 }
  status = 200
  refreshed = true
  constructor() {
    this.server = createServer((request, response) => {
      this.requests.push({ method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization })
      response.statusCode = this.status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(request.method === 'POST' ? { ...this.body, refreshed: this.refreshed } : this.body))
    })
  }

  async listen(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  close(): Promise<void> { return new Promise(resolve => this.server.close(() => { resolve() })) }
}

let dir: string
const contexts: Context[] = []
const closers: Array<() => Promise<void>> = []
const allLogs: LogLine[] = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsy-qq-panel-')) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(closers.splice(0).map(close => close()))
  rmSync(dir, { recursive: true, force: true })
  // Neither the token nor the QR link may reach a log line.
  expect(allLogs.splice(0).filter(line => line.text.includes(TOKEN) || line.text.includes('SECRETQRLINK'))).toEqual([])
})

async function until(check: () => boolean, what: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

interface Route { path: string; methods: readonly string[]; requestBody: string; fetch: (request: Request) => Promise<Response> }

async function boot(options: {
  door?: FakeDoor | 'unreachable'
  login?: Record<string, unknown>
  config?: Record<string, unknown>
  credentials?: Record<string, string>
  notifier?: { send: ReturnType<typeof vi.fn> }
  oneBot?: 'up' | 'down'
} = {}) {
  const fake = new FakeOneBot(TOKEN)
  await fake.listen()
  const url = fake.url
  if (options.oneBot === 'down') await fake.close()
  else closers.push(() => fake.close())
  fake.handlers.set('get_login_info', () => ({ user_id: 99999, nickname: 'bot' }))
  fake.handlers.set('get_group_list', () => [])
  const door = options.door === undefined ? new FakeDoor() : options.door
  const doorUrl = door === 'unreachable' ? 'http://127.0.0.1:9' : await door.listen()
  if (door !== 'unreachable') closers.push(() => door.close())
  const ctx = new Context()
  contexts.push(ctx)
  const logs: LogLine[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (m) => {
      const line = { type: m.type, text: String(m.args[0]) }
      logs.push(line)
      allLogs.push(line)
    },
  })
  const credentials = options.credentials ?? { LSY_QQ_ONEBOT_TOKEN: TOKEN }
  ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(credentials[ref] === undefined ? undefined : { value: credentials[ref] }) } as never)
  ctx.provide('sessionController', { create: vi.fn(), resolveAgent: vi.fn(), prompt: vi.fn(), selectModel: vi.fn() } as never)
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() } as never)
  ctx.provide('sessionTitle', { rename: vi.fn(), get: vi.fn() } as never)
  if (options.notifier !== undefined) ctx.provide('lsyNotifier', options.notifier as never)
  const routes: Route[] = []
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
  const config = Config({
    url, groups: ['123456789'], dataDir: join(dir, 'data'), digest: { enabled: false, workspacePath: join(dir, 'digest') },
    login: { url: doorUrl, ...options.login },
    ...options.config,
  } as never)
  await ctx.plugin(Observer, config)
  const observer = ctx.lsyQq
  return { ctx, observer, fake, door, logs, routes, url }
}

const connected = (h: Awaited<ReturnType<typeof boot>>) => until(() => h.logs.some(line => line.text.includes('logged in as')), 'the connection')

describe('QQ panel', () => {
  it('shows the connection and, when NapCat is logged in, the account', async () => {
    const door = new FakeDoor()
    door.body = { v: 1, napcat: 'up', login: 'online', phase: 'ready', uin: '2153925085', nickname: '小号', qrUrl: null, error: null, at: 1 }
    const h = await boot({ door })
    await connected(h)
    const panel = await h.observer.panel({ fresh: true })
    expect(panel.connection).toMatchObject({ state: 'connected', attempt: 0, lastError: null, selfId: '99999' })
    expect(panel.connection.since).toBeGreaterThan(0)
    expect(panel.login).toEqual({ door: 'ok', state: 'online', uin: '2153925085', nickname: '小号', error: null, qr: null })
    expect(panel.groupsRecorded).toBe(1)
    // The door is called with the OneBot token the observer already holds.
    expect(door.requests.at(-1)).toEqual({ method: 'GET', path: '/v1/login', authorization: `Bearer ${TOKEN}` })
  })

  it('draws the waiting QR code as a module matrix and never passes the link on', async () => {
    const h = await boot({ oneBot: 'down' })
    const panel = await h.observer.panel({ fresh: true })
    expect(panel.login.state).toBe('qr')
    const expected = encode(QR_URL, { ecc: 'M' })
    expect(panel.login.qr).toEqual({ size: expected.size, rows: expected.data.map(row => row.map(dark => (dark ? '1' : '0')).join('')) })
    expect(panel.login.qr?.rows.every(row => /^[01]+$/.test(row) && row.length === expected.size)).toBe(true)
    expect(JSON.stringify(panel)).not.toContain('SECRETQRLINK')
    expect(JSON.stringify(panel)).not.toContain(TOKEN)
  })

  it('reports a failing connection with the attempt count and the reason, and its start', async () => {
    const h = await boot({ oneBot: 'down' })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in')), 'the first failure')
    const panel = await h.observer.panel()
    expect(panel.connection.state).toBe('reconnecting')
    expect(panel.connection.attempt).toBe(1)
    expect(panel.connection.lastError).toEqual(expect.any(String))
    expect(panel.connection.since).toBeGreaterThan(0)
    expect(panel.connection.selfId).toBeNull()
  })

  it('says the token is missing instead of trying', async () => {
    const h = await boot({ credentials: {} })
    await until(() => h.logs.some(line => line.text.includes('is not set')), 'the token check')
    const panel = await h.observer.panel({ fresh: true })
    expect(panel.connection.state).toBe('waiting-token')
    expect(panel.login.door).toBe('unauthorized')
  })

  it.each([
    ['an unreachable door', 'unreachable', undefined, 'unreachable'],
    ['a door that refuses the token', undefined, { status: 401 }, 'unauthorized'],
    ['a door that answers nonsense', undefined, { body: { nonsense: true } }, 'invalid'],
    ['NapCat down behind the door', undefined, { body: { v: 1, napcat: 'down', reason: 'unreachable', at: 1 } }, 'napcat-down'],
  ] as const)('names %s', async (_name, door, tweak, expected) => {
    const fakeDoor = door === undefined ? new FakeDoor() : door
    if (fakeDoor !== 'unreachable' && tweak !== undefined) {
      if ('status' in tweak) fakeDoor.status = tweak.status
      if ('body' in tweak) fakeDoor.body = tweak.body
    }
    const h = await boot({ door: fakeDoor, oneBot: 'down' })
    const panel = await h.observer.panel({ fresh: true })
    expect(panel.login).toMatchObject({ door: expected, state: null, qr: null })
  })

  it('does not call the door when login is disabled', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, login: { enabled: false }, oneBot: 'down' })
    expect((await h.observer.panel({ fresh: true })).login).toMatchObject({ door: 'disabled', state: null })
    expect(door.requests).toEqual([])
  })

  it('shares one door call between callers within a second, and fresh bypasses it', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    await Promise.all([h.observer.panel(), h.observer.panel(), h.observer.panel()])
    await h.observer.panel()
    expect(door.requests).toHaveLength(1)
    await h.observer.panel({ fresh: true })
    expect(door.requests).toHaveLength(2)
  })

  it('asks the door for a fresh code and passes its verdict on', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    const answer = await h.observer.refreshLoginQr()
    expect(answer.refreshed).toBe(true)
    expect(door.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/v1/login/refresh'])
    door.refreshed = false
    expect((await h.observer.refreshLoginQr()).refreshed).toBe(false)
    expect(h.logs.filter(line => line.text.includes('asked NapCat for a fresh login QR'))).toHaveLength(2)
  })

  it('logs login state changes, once each, without the code', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    await h.observer.panel({ fresh: true })
    await h.observer.panel({ fresh: true })
    door.body = { ...door.body, login: 'scanned', qrUrl: null }
    await h.observer.panel({ fresh: true })
    const changes = h.logs.filter(line => line.text.includes('NapCat login:')).map(line => line.text)
    expect(changes).toEqual(['lsy-qq: NapCat login: waiting for a scan', 'lsy-qq: NapCat login: scanned, completing'])
  })

  it('reconnects at once when NapCat turns out to be logged in again, instead of waiting out the backoff', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in 2 s')), 'the first failure')
    // The protocol end comes back on the same port, as it does after a scan.
    const port = Number(new URL(h.url).port)
    const revived = new FakeOneBot(TOKEN)
    revived.handlers.set('get_login_info', () => ({ user_id: 99999 }))
    revived.handlers.set('get_group_list', () => [])
    await new Promise<void>(resolve => revived.http.listen(port, '127.0.0.1', resolve))
    closers.push(() => revived.close())
    door.body = { ...door.body, login: 'online', qrUrl: null, uin: '99999', nickname: 'bot' }
    const before = Date.now()
    await h.observer.panel({ fresh: true })
    await until(() => revived.connections === 1, 'the immediate reconnect', 1500)
    expect(Date.now() - before).toBeLessThan(1500)
  })

  it('registers the status and refresh routes under /api, with no-store answers', async () => {
    const h = await boot({ oneBot: 'down' })
    expect(h.routes.map(route => [route.path, route.methods, route.requestBody])).toEqual([
      [QQ_PATH, ['GET'], 'buffered'],
      [QQ_REFRESH_PATH, ['POST'], 'buffered'],
    ])
    const status = await h.routes[0]!.fetch(new Request(`http://127.0.0.1${QQ_PATH}`))
    expect(status.status).toBe(200)
    expect(status.headers.get('cache-control')).toBe('no-store')
    const panel = await status.json() as QqPanel
    expect(panel.login.state).toBe('qr')
    expect(JSON.stringify(panel)).not.toContain(TOKEN)
    const refreshed = await (await h.routes[1]!.fetch(new Request(`http://127.0.0.1${QQ_REFRESH_PATH}`, { method: 'POST' }))).json() as QqRefreshAnswer
    expect(refreshed.refreshed).toBe(true)
  })
})

describe('QQ owner notices', () => {
  it('sends one notice per outage however long it lasts, pointing at the Settings page', async () => {
    const notifier = { send: vi.fn(async () => {}) }
    const h = await boot({ notifier, oneBot: 'down', config: { settingsUrl: 'https://dsh.example.test/' } })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in')), 'the first failure')
    h.observer.now = () => Date.now() + 3_600_000
    const check = () => (h.observer as unknown as { checkOutage(): Promise<void> }).checkOutage()
    await check()
    await check()
    await check()
    expect(notifier.send).toHaveBeenCalledTimes(1)
    const sent = JSON.stringify(notifier.send.mock.calls[0])
    expect(sent).toContain('QQ 协议端连不上')
    expect(sent).toContain('设置')
    expect(sent).toContain('https://dsh.example.test/')
    expect(h.logs.filter(line => line.text.includes('told the owner'))).toHaveLength(1)
  })

  it('names the Settings page even without a configured address', async () => {
    const notifier = { send: vi.fn(async () => {}) }
    const h = await boot({ notifier, oneBot: 'down' })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in')), 'the first failure')
    h.observer.now = () => Date.now() + 3_600_000
    await (h.observer as unknown as { checkOutage(): Promise<void> }).checkOutage()
    expect(JSON.stringify(notifier.send.mock.calls[0])).toContain('设置')
    expect(JSON.stringify(notifier.send.mock.calls[0])).not.toContain('napcat.sh')
  })
})

describe('QQ panel configuration', () => {
  it('refuses a door address that is not on this machine or the tailnet', () => {
    const make = (login: Record<string, unknown>) => () => new QqObserver(new Context(), Config({ dataDir: join(dir, 'x'), digest: { workspacePath: join(dir, 'd') }, login } as never))
    expect(make({ url: 'http://192.168.1.50:3002' })).toThrow('login.url')
    expect(make({ url: 'ftp://127.0.0.1:3002' })).toThrow('login.url')
    expect(isPrivateAddress('http://127.0.0.1:3002', ['http:', 'https:'])).toBe(true)
    expect(isPrivateAddress('https://dsh.tailc2559b.ts.net', ['http:', 'https:'])).toBe(true)
  })

  it('refuses a settings address that is not http(s)', () => {
    const make = (settingsUrl: string) => () => new QqObserver(new Context(), Config({ dataDir: join(dir, 'x'), digest: { workspacePath: join(dir, 'd') }, settingsUrl } as never))
    expect(make('javascript:alert(1)')).toThrow('settingsUrl')
  })
})
