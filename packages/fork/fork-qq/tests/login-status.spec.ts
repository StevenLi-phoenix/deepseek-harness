import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QqObserver, { Config, isPrivateAddress, QqObserver as Observer } from '../src/index.ts'
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

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fork-qq-panel-')) })
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
  const credentials = options.credentials ?? { FORK_QQ_ONEBOT_TOKEN: TOKEN }
  ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(credentials[ref] === undefined ? undefined : { value: credentials[ref] }) } as never)
  ctx.provide('sessionController', { create: vi.fn(), resolveAgent: vi.fn(), prompt: vi.fn(), selectModel: vi.fn() } as never)
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() } as never)
  ctx.provide('sessionTitle', { rename: vi.fn(), get: vi.fn() } as never)
  if (options.notifier !== undefined) ctx.provide('forkNotifier', options.notifier as never)
  const config = Config({
    url, groups: ['123456789'], dataDir: join(dir, 'data'), digest: { enabled: false, workspacePath: join(dir, 'digest') },
    login: { url: doorUrl, ...options.login },
    ...options.config,
  } as never)
  await ctx.plugin(Observer, config)
  const observer = ctx.forkQq
  return { ctx, observer, fake, door, logs, url }
}

const connected = (h: Awaited<ReturnType<typeof boot>>) => until(() => h.logs.some(line => line.text.includes('logged in as')), 'the connection')

describe('QQ login status', () => {
  it('reports the connection and, when NapCat is logged in, the account', async () => {
    const door = new FakeDoor()
    door.body = { v: 1, napcat: 'up', login: 'online', phase: 'ready', uin: '2153925085', nickname: '小号', qrUrl: null, error: null, at: 1 }
    const h = await boot({ door })
    await connected(h)
    expect(h.observer.connectionStatus()).toMatchObject({ state: 'connected', attempt: 0, lastError: null, selfId: '99999' })
    expect(h.observer.connectionStatus().since).toBeGreaterThan(0)
    expect(await h.observer.loginStatus({ fresh: true })).toEqual({ door: 'ok', state: 'online', uin: '2153925085', nickname: '小号', error: null, qrUrl: null })
    expect(h.observer.recordedGroups()).toBe(1)
    // The door is called with the OneBot token the observer already holds.
    expect(door.requests.at(-1)).toEqual({ method: 'GET', path: '/v1/login', authorization: `Bearer ${TOKEN}` })
  })

  it('passes on the waiting QR link, and nothing of it reaches a log line', async () => {
    const h = await boot({ oneBot: 'down' })
    expect(await h.observer.loginStatus({ fresh: true })).toMatchObject({ door: 'ok', state: 'qr', qrUrl: QR_URL })
  })

  it('reports a failing connection with the attempt count and the reason, and its start', async () => {
    const h = await boot({ oneBot: 'down' })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in')), 'the first failure')
    const connection = h.observer.connectionStatus()
    expect(connection.state).toBe('reconnecting')
    expect(connection.attempt).toBe(1)
    expect(connection.lastError).toEqual(expect.any(String))
    expect(connection.since).toBeGreaterThan(0)
    expect(connection.selfId).toBeNull()
  })

  it('says the token is missing instead of trying', async () => {
    const h = await boot({ credentials: {} })
    await until(() => h.logs.some(line => line.text.includes('is not set')), 'the token check')
    expect(h.observer.connectionStatus().state).toBe('waiting-token')
    expect((await h.observer.loginStatus({ fresh: true })).door).toBe('unauthorized')
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
    expect(await h.observer.loginStatus({ fresh: true })).toMatchObject({ door: expected, state: null, qrUrl: null })
  })

  it('does not call the door when login is disabled', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, login: { enabled: false }, oneBot: 'down' })
    expect(await h.observer.loginStatus({ fresh: true })).toMatchObject({ door: 'disabled', state: null })
    expect(door.requests).toEqual([])
  })

  it('shares one door call between callers within a second, and fresh bypasses it', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    await Promise.all([h.observer.loginStatus(), h.observer.loginStatus(), h.observer.loginStatus()])
    await h.observer.loginStatus()
    expect(door.requests).toHaveLength(1)
    await h.observer.loginStatus({ fresh: true })
    expect(door.requests).toHaveLength(2)
  })

  it('asks the door for a fresh code and passes its verdict on', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    const answer = await h.observer.refreshLogin()
    expect(answer.refreshed).toBe(true)
    expect(answer.login.state).toBe('qr')
    expect(door.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/v1/login/refresh'])
    door.refreshed = false
    expect((await h.observer.refreshLogin()).refreshed).toBe(false)
    expect(h.logs.filter(line => line.text.includes('asked NapCat for a fresh login QR'))).toHaveLength(2)
  })

  it('logs login state changes, once each, without the code', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    await h.observer.loginStatus({ fresh: true })
    await h.observer.loginStatus({ fresh: true })
    door.body = { ...door.body, login: 'scanned', qrUrl: null }
    await h.observer.loginStatus({ fresh: true })
    const changes = h.logs.filter(line => line.text.includes('NapCat login:')).map(line => line.text)
    expect(changes).toEqual(['fork-qq: NapCat login: waiting for a scan', 'fork-qq: NapCat login: scanned, completing'])
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
    await h.observer.loginStatus({ fresh: true })
    await until(() => revived.connections === 1, 'the immediate reconnect', 1500)
    expect(Date.now() - before).toBeLessThan(1500)
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

describe('QQ owner notice across reloads', () => {
  const noticeFile = () => join(dir, 'data', 'outage-notice.json')
  const seed = (lastNoticeAt: number) => {
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(noticeFile(), JSON.stringify({ lastNoticeAt }))
  }
  const check = (h: Awaited<ReturnType<typeof boot>>) => (h.observer as unknown as { checkOutage(): Promise<void> }).checkOutage()

  it('remembers on disk that the owner was told, so a reload or deploy mid-outage does not tell again', async () => {
    const notifier = { send: vi.fn(async () => {}) }
    const h = await boot({ notifier, oneBot: 'down' })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in')), 'the first failure')
    h.observer.now = () => Date.now() + 3_600_000
    await check(h)
    expect(notifier.send).toHaveBeenCalledTimes(1)
    const saved = JSON.parse(readFileSync(noticeFile(), 'utf8')) as { lastNoticeAt: number }
    expect(Object.keys(saved)).toEqual(['lastNoticeAt'])
    expect(Number.isFinite(saved.lastNoticeAt)).toBe(true)
  })

  it('stays quiet when an earlier process already told the owner within the repeat window', async () => {
    seed(Date.now() - 3_600_000)
    const notifier = { send: vi.fn(async () => {}) }
    const h = await boot({ notifier, oneBot: 'down' })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in')), 'the first failure')
    h.observer.now = () => Date.now() + 3_600_000
    await check(h)
    expect(notifier.send).not.toHaveBeenCalled()
  })

  it('reminds again once the outage has outlived the repeat window', async () => {
    seed(Date.now() - 2 * 86_400_000)
    const notifier = { send: vi.fn(async () => {}) }
    const h = await boot({ notifier, oneBot: 'down' })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in')), 'the first failure')
    h.observer.now = () => Date.now() + 3_600_000
    await check(h)
    expect(notifier.send).toHaveBeenCalledTimes(1)
  })

  it('never reminds within an outage when the repeat window is 0', async () => {
    seed(Date.now() - 2 * 86_400_000)
    const notifier = { send: vi.fn(async () => {}) }
    const h = await boot({ notifier, oneBot: 'down', config: { offlineRepeatMs: 0 } })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in')), 'the first failure')
    h.observer.now = () => Date.now() + 3_600_000
    await check(h)
    expect(notifier.send).not.toHaveBeenCalled()
  })

  it('forgets the notice when the connection comes back, so the next outage is told', async () => {
    seed(Date.now() - 3_600_000)
    const h = await boot()
    await connected(h)
    expect(existsSync(noticeFile())).toBe(false)
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
