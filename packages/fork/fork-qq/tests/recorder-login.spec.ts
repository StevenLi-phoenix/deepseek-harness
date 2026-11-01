import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeOneBot } from './fake-onebot.ts'
import { TOKEN, bootRecorder, connected, shutdown, until, type Booted } from './recorder-harness.ts'

const QR_URL = 'https://txz.qq.com/p?k=SECRETQRLINK&f=1'

/** The login door as the recorder sees it. */
class FakeDoor {
  server: Server
  requests: Array<{ method: string; path: string; authorization: string | undefined }> = []
  body: Record<string, unknown> = { v: 1, napcat: 'up', login: 'qr', phase: 'waiting_qrcode', uin: null, nickname: null, qrUrl: QR_URL, error: null, at: 1 }
  status = 200
  refreshed = true
  reason: string | undefined
  constructor() {
    this.server = createServer((request, response) => {
      this.requests.push({ method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization })
      response.statusCode = this.status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(request.method === 'POST' ? { ...this.body, refreshed: this.refreshed, ...this.reason === undefined ? {} : { reason: this.reason } } : this.body))
    })
  }

  async listen(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  close(): Promise<void> { return new Promise(resolve => this.server.close(() => { resolve() })) }
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
  // Neither the token nor the QR link may reach a log line.
  expect(await shutdown()).toEqual([])
})

async function boot(options: { door?: FakeDoor | 'unreachable'; login?: { enabled?: boolean }; oneBot?: 'up' | 'down'; secrets?: Record<string, string> } = {}) {
  const fake = new FakeOneBot(TOKEN)
  await fake.listen()
  const url = fake.url
  if (options.oneBot === 'down') await fake.close()
  else closers.push(() => fake.close())
  fake.handlers.set('get_group_list', () => [])
  const door = options.door === undefined ? new FakeDoor() : options.door
  const doorUrl = door === 'unreachable' ? 'http://127.0.0.1:9' : await door.listen()
  if (door !== 'unreachable') closers.push(() => door.close())
  const h = await bootRecorder({
    config: { url, login: { enabled: options.login?.enabled ?? true, url: doorUrl, timeoutMs: 5000 } },
    ...options.secrets === undefined ? {} : { secrets: options.secrets },
    ...options.oneBot === 'down' ? {} : { fake },
  })
  return Object.assign(h, { door, url, fake: options.oneBot === 'down' ? h.fake : fake })
}

const reachable = (h: Booted) => connected(h)

describe('QQ login through the recorder', () => {
  it('reports the connection and, when NapCat is logged in, the account, asking the door with the OneBot token', async () => {
    const door = new FakeDoor()
    door.body = { v: 1, napcat: 'up', login: 'online', phase: 'ready', uin: '2153925085', nickname: '小号', qrUrl: null, error: null, at: 1 }
    const h = await boot({ door })
    await reachable(h)
    expect(h.recorder.status().connection).toMatchObject({ state: 'connected', attempt: 0, lastError: null, selfId: '99999' })
    expect(await h.recorder.loginStatus({ fresh: true })).toEqual({ door: 'ok', state: 'online', uin: '2153925085', nickname: '小号', error: null, qrUrl: null })
    expect(door.requests.at(-1)).toEqual({ method: 'GET', path: '/v1/login', authorization: `Bearer ${TOKEN}` })
  })

  it.each(['restarting', 'logging-in', 'preparing', 'unknown'] as const)(
    'shows NapCat as online while the OneBot socket is up, though its own login phase says %s', async (phase) => {
      const door = new FakeDoor()
      door.body = { v: 1, napcat: 'up', login: phase, phase: 'reconnecting', uin: null, nickname: null, qrUrl: null, error: null, at: 1 }
      const h = await boot({ door })
      await reachable(h)
      expect(await h.recorder.loginStatus({ fresh: true })).toMatchObject({ door: 'ok', state: 'online', uin: '99999', qrUrl: null })
    },
  )

  it('keeps what the door says while the socket is down, and a waiting code even when the socket is up', async () => {
    const door = new FakeDoor()
    door.body = { v: 1, napcat: 'up', login: 'restarting', phase: 'reconnecting', uin: null, nickname: null, qrUrl: null, error: null, at: 1 }
    const down = await boot({ door, oneBot: 'down' })
    expect(await down.recorder.loginStatus({ fresh: true })).toMatchObject({ state: 'restarting' })
    const up = await boot()
    await reachable(up)
    expect(await up.recorder.loginStatus({ fresh: true })).toMatchObject({ state: 'qr', qrUrl: QR_URL })
  })

  it('says the token is missing instead of trying', async () => {
    const h = await boot({ secrets: {}, oneBot: 'down' })
    await until(() => h.recorder.status().connection.state === 'waiting-token', 'the token check')
    expect((await h.recorder.loginStatus({ fresh: true })).door).toBe('unauthorized')
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
    expect(await h.recorder.loginStatus({ fresh: true })).toMatchObject({ door: expected, state: null, qrUrl: null })
  })

  it('does not call the door when login is disabled', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, login: { enabled: false }, oneBot: 'down' })
    expect(await h.recorder.loginStatus({ fresh: true })).toMatchObject({ door: 'disabled', state: null })
    expect(door.requests).toEqual([])
  })

  it('shares one door call between callers within a second, and fresh bypasses it', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    await Promise.all([h.recorder.loginStatus(), h.recorder.loginStatus(), h.recorder.loginStatus()])
    await h.recorder.loginStatus()
    expect(door.requests).toHaveLength(1)
    await h.recorder.loginStatus({ fresh: true })
    expect(door.requests).toHaveLength(2)
  })

  it('asks the door for a fresh code, passes its verdict on, and carries the reason when it declines', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    const answer = await h.recorder.refreshLogin()
    expect(answer.refreshed).toBe(true)
    expect(answer.login.state).toBe('qr')
    expect(door.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/v1/login/refresh'])
    door.refreshed = false
    door.reason = 'too-soon'
    expect(await h.recorder.refreshLogin()).toMatchObject({ refreshed: false, reason: 'too-soon' })
    expect(h.logs.filter(line => line.text.includes('asked NapCat for a fresh login QR'))).toHaveLength(2)
  })

  it('does not ask for a fresh code while the socket is up, nor within ten minutes of it coming up', async () => {
    const door = new FakeDoor()
    const h = await boot({ door })
    await reachable(h)
    expect(await h.recorder.refreshLogin()).toMatchObject({ refreshed: false, reason: 'logged-in' })
    h.fake.drop()
    await until(() => h.recorder.status().connection.state === 'reconnecting', 'the drop')
    expect(await h.recorder.refreshLogin()).toMatchObject({ refreshed: false, reason: 'recently-logged-in' })
    expect(door.requests.filter(request => request.method === 'POST')).toEqual([])
    h.recorder.now = () => Date.now() + 11 * 60_000
    expect(await h.recorder.refreshLogin()).toMatchObject({ refreshed: true, reason: null })
    expect(door.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  })

  it('asks the door about a connected account once a minute, and about an unconnected one every 1.5 s', async () => {
    const door = new FakeDoor()
    const h = await boot({ door })
    await reachable(h)
    const base = Date.now()
    h.recorder.now = () => base
    await h.recorder.loginStatus()
    h.recorder.now = () => base + 30_000
    await h.recorder.loginStatus()
    expect(door.requests).toHaveLength(1)
    h.recorder.now = () => base + 61_000
    await h.recorder.loginStatus()
    expect(door.requests).toHaveLength(2)
    const down = await boot({ door: new FakeDoor(), oneBot: 'down' })
    const t0 = Date.now()
    down.recorder.now = () => t0
    await down.recorder.loginStatus()
    down.recorder.now = () => t0 + 2000
    await down.recorder.loginStatus()
    expect((down.door as FakeDoor).requests).toHaveLength(2)
  })

  it('logs login state changes, once each, without the code', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    await h.recorder.loginStatus({ fresh: true })
    await h.recorder.loginStatus({ fresh: true })
    door.body = { ...door.body, login: 'scanned', qrUrl: null }
    await h.recorder.loginStatus({ fresh: true })
    const changes = h.logs.filter(line => line.text.includes('NapCat login:')).map(line => line.text)
    expect(changes).toEqual(['qq-recorder: NapCat login: waiting for a scan', 'qq-recorder: NapCat login: scanned, completing'])
    expect(h.logs.filter(line => line.text.includes('SECRETQRLINK'))).toEqual([])
  })

  it('reconnects at once when NapCat turns out to be logged in again, instead of waiting out the backoff', async () => {
    const door = new FakeDoor()
    const h = await boot({ door, oneBot: 'down' })
    await until(() => h.logs.some(line => line.text.includes('reconnecting in 2 s')), 'the first failure')
    const port = Number(new URL(h.url).port)
    const revived = new FakeOneBot(TOKEN)
    revived.handlers.set('get_login_info', () => ({ user_id: 99999 }))
    revived.handlers.set('get_group_list', () => [])
    await new Promise<void>(resolve => revived.http.listen(port, '127.0.0.1', resolve))
    closers.push(() => revived.close())
    door.body = { ...door.body, login: 'online', qrUrl: null, uin: '99999', nickname: 'bot' }
    const before = Date.now()
    await h.recorder.loginStatus({ fresh: true })
    await until(() => revived.connections === 1, 'the immediate reconnect', 1500)
    expect(Date.now() - before).toBeLessThan(1500)
  })
})
