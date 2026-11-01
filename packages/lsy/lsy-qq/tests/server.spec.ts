import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_HEADER, StatusDto, type RecorderEvent } from '../src/protocol.ts'
import { startRecorderServer, type RecorderServer } from '../src/server.ts'
import { groupMessage } from './fake-onebot.ts'
import { bootRecorder, connected, recorderConfig, shutdown, until, type Booted } from './recorder-harness.ts'

const SECRET = 'recorder-token-fedcba9876543210'
const GROUP = '123456789'

const servers: RecorderServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  expect(await shutdown()).toEqual([])
})

async function boot(options: Parameters<typeof bootRecorder>[0] = {}, server: { pingMs?: number; protocolMinor?: number } = {}) {
  const h = await bootRecorder(options)
  const socketPath = join(h.dir, 'run', 'qq-recorder.sock')
  const running = await startRecorderServer({ recorder: h.recorder, logger: { debug() {}, info: () => {}, error: (m) => { h.logs.push({ type: 'error', text: m }) } }, socketPath, token: SECRET, healthPort: 0, build: 'test-build', ...server })
  servers.push(running)
  return Object.assign(h, { socketPath, running })
}

interface Answer { status: number; body: unknown; headers: Record<string, string | string[] | undefined> }

function call(socketPath: string, method: string, path: string, options: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const req = request({
      socketPath, path, method,
      headers: {
        ...options.token === null ? {} : { authorization: `Bearer ${options.token ?? SECRET}` },
        ...payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, body: text === '' ? undefined : JSON.parse(text) as unknown, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

describe('qq-recorder server', () => {
  it('listens on a socket only its owner can use, in a directory only its owner can enter', async () => {
    const h = await boot({ config: false })
    expect(statSync(h.socketPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(h.dir, 'run')).mode & 0o777).toBe(0o700)
  })

  it('refuses a request without the token, or with another one, and says nothing about the data', async () => {
    const h = await boot({ config: false })
    expect(await call(h.socketPath, 'GET', '/v1/status', { token: null })).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } })
    expect(await call(h.socketPath, 'GET', '/v1/groups', { token: 'wrong' })).toMatchObject({ status: 401 })
    expect(await call(h.socketPath, 'PUT', '/v1/config', { token: 'wrong', body: recorderConfig('ws://127.0.0.1:1') })).toMatchObject({ status: 401 })
    expect(h.recorder.status().configRevision).toBeNull()
  })

  it('answers hello with its protocol, build, and start time, and tags every answer with the protocol', async () => {
    const h = await boot({ config: false })
    const answer = await call(h.socketPath, 'GET', '/v1/hello', { headers: { [PROTOCOL_HEADER]: 'qq-recorder/1.0' } })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ protocol: { name: 'qq-recorder', major: 1, minor: 0 }, build: 'test-build', startedAt: h.recorder.startedAt })
    expect(answer.headers[PROTOCOL_HEADER]).toBe('qq-recorder/1.0')
    expect((await call(h.socketPath, 'GET', '/v1/status', { token: null })).headers[PROTOCOL_HEADER]).toBe('qq-recorder/1.0')
  })

  it('refuses another major protocol with 426, and a request that is not valid with 400 and a structured error', async () => {
    const h = await boot({ config: false })
    expect(await call(h.socketPath, 'GET', '/v1/hello', { headers: { [PROTOCOL_HEADER]: 'qq-recorder/2.0' } })).toMatchObject({ status: 426, body: { error: { code: 'protocol-mismatch' } } })
    expect(await call(h.socketPath, 'GET', '/v1/hello', { headers: { [PROTOCOL_HEADER]: 'garbage' } })).toMatchObject({ status: 426 })
    expect(await call(h.socketPath, 'GET', '/v1/messages?groupId=abc&limit=5')).toMatchObject({ status: 400, body: { error: { code: 'invalid-request' } } })
    expect(await call(h.socketPath, 'GET', `/v1/messages?groupId=${GROUP}&limit=99999`)).toMatchObject({ status: 400 })
    expect(await call(h.socketPath, 'GET', `/v1/messages?groupId=${GROUP}&limit=5&after=zzz%20zz`)).toMatchObject({ status: 400 })
    expect(await call(h.socketPath, 'POST', '/v1/messages/search', { body: { query: '', limit: 5 } })).toMatchObject({ status: 400 })
    expect(await call(h.socketPath, 'PUT', '/v1/config', { body: { revision: 'x' } })).toMatchObject({ status: 400 })
    expect(await call(h.socketPath, 'GET', '/v1/nope')).toMatchObject({ status: 404 })
    expect(await call(h.socketPath, 'POST', '/v1/status')).toMatchObject({ status: 405 })
  })

  it('applies a pushed configuration, validated, and answers 422 for one that cannot work', async () => {
    const h = await boot({ config: false })
    const config = recorderConfig(h.fake.url, { groups: [GROUP] })
    expect(await call(h.socketPath, 'PUT', '/v1/config', { body: config })).toMatchObject({ status: 200, body: { revision: config.revision, reconnect: false } })
    await connected(h)
    expect((await call(h.socketPath, 'GET', '/v1/status')).body).toMatchObject({ configRevision: config.revision, connection: { state: 'connected', selfId: '99999' }, recordedGroups: 1 })
    expect(await call(h.socketPath, 'PUT', '/v1/config', { body: { ...config, revision: 'bad', url: 'ws://192.168.1.50:3001' } })).toMatchObject({ status: 422, body: { error: { code: 'config-rejected' } } })
    expect(h.recorder.status().configRevision).toBe(config.revision)
  })

  it('serves reads: groups, recent messages, pages, search, lookup, members, and the legacy state', async () => {
    const h = await boot()
    await connected(h)
    h.fake.push(groupMessage(GROUP, '10001', '关于迁移的讨论', { message_id: 501 }))
    h.fake.push(groupMessage(GROUP, '10002', '另一条消息', { message_id: 502 }))
    await until(() => h.recorder.recent(GROUP, { sinceMs: 0, limit: 10 }).length === 2, 'the rows')
    const recent = (await call(h.socketPath, 'GET', `/v1/messages?groupId=${GROUP}&sinceMs=0&limit=10`)).body as Array<{ text: string }>
    expect(recent.map(m => m.text)).toEqual(['关于迁移的讨论', '另一条消息'])
    const page = (await call(h.socketPath, 'GET', `/v1/messages?groupId=${GROUP}&limit=1`)).body as { items: Array<{ cursor: string }>; nextCursor: string }
    expect(page.nextCursor).toBe(page.items[0]!.cursor)
    expect(((await call(h.socketPath, 'POST', '/v1/messages/search', { body: { query: '迁移', limit: 5 } })).body as unknown[])).toHaveLength(1)
    expect(((await call(h.socketPath, 'POST', '/v1/messages/lookup', { body: { groupId: GROUP, messageIds: ['502', 'nope'] } })).body as Array<{ messageId: string }>).map(m => m.messageId)).toEqual(['502'])
    expect(((await call(h.socketPath, 'GET', `/v1/groups/${GROUP}/members`)).body as unknown[])).toHaveLength(2)
    expect(((await call(h.socketPath, 'GET', '/v1/groups')).body as Array<{ groupId: string; recorded: boolean }>).find(g => g.groupId === GROUP)).toMatchObject({ recorded: true, messages: 2 })
    expect(await call(h.socketPath, 'GET', '/v1/legacy/digest-state')).toMatchObject({ status: 200, body: { digests: [], notes: [], aliasSalt: null } })
    expect(await call(h.socketPath, 'GET', '/v1/login')).toMatchObject({ status: 200, body: { door: 'disabled' } })
  })

  it('checks its own answers against the schema, so a drift fails here and not in DSH', async () => {
    const h = await boot({ config: false })
    ;(h.recorder as unknown as { status(): unknown }).status = () => ({ connection: { state: 'connected' } })
    const answer = await call(h.socketPath, 'GET', '/v1/status')
    expect(answer.status).toBe(500)
    expect(h.logs.some(line => line.type === 'error' && line.text.includes('did not match its schema'))).toBe(true)
  })

  it('streams events as NDJSON: the status first, then messages and heartbeats, and ends the stream on close', async () => {
    const h = await boot({}, { pingMs: 40 })
    await connected(h)
    const events: RecorderEvent[] = []
    let ended = false
    await new Promise<void>((resolve) => {
      const req = request({ socketPath: h.socketPath, path: '/v1/events', headers: { authorization: `Bearer ${SECRET}` } }, (res) => {
        expect(res.headers['content-type']).toContain('ndjson')
        let rest = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          rest += chunk
          const lines = rest.split('\n')
          rest = lines.pop() ?? ''
          for (const line of lines) events.push(JSON.parse(line) as RecorderEvent)
        })
        res.on('end', () => { ended = true })
        resolve()
      })
      req.end()
    })
    h.fake.push(groupMessage(GROUP, '10001', '推送一条'))
    await until(() => events.some(event => event.type === 'messages') && events.filter(event => event.type === 'ping').length >= 2, 'a message event and two pings')
    expect(events[0]!.type).toBe('status')
    expect(StatusDto.safeParse((events[0] as { status: unknown }).status).success).toBe(true)
    const message = events.find(event => event.type === 'messages')
    expect(message).toMatchObject({ type: 'messages', groupId: GROUP, count: 1 })
    // The event carries a count and a cursor, never the text.
    expect(JSON.stringify(message)).not.toContain('推送一条')
    await h.running.close()
    await until(() => ended, 'the stream to end')
  })

  it('answers the health probe without a token and without saying anything about QQ', async () => {
    const h = await boot({ config: false })
    const answer = await fetch(`http://127.0.0.1:${h.running.healthPort}/healthz`)
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ ok: true })
    expect((await fetch(`http://127.0.0.1:${h.running.healthPort}/v1/status`)).status).toBe(404)
  })

  it('refuses to start while another recorder listens on the same socket, and replaces a stale socket file', async () => {
    const h = await boot({ config: false })
    await expect(startRecorderServer({ recorder: h.recorder, logger: { debug() {}, info() {}, error() {} }, socketPath: h.socketPath, token: SECRET })).rejects.toThrow('already listens')
    await h.running.close()
    mkdirSync(join(h.dir, 'run'), { recursive: true })
    const again = await startRecorderServer({ recorder: h.recorder, logger: { debug() {}, info() {}, error() {} }, socketPath: h.socketPath, token: SECRET })
    servers.push(again)
    expect((await call(h.socketPath, 'GET', '/v1/status')).status).toBe(200)
  })

  it('keeps the pushed configuration across a restart of the whole service', async () => {
    const first = await boot({ config: { groups: [GROUP] } })
    await connected(first)
    const revision = first.recorder.status().configRevision
    await first.running.close()
    await first.recorder.stop()
    const second = await boot({ fake: first.fake, dir: first.dir, config: false })
    expect((await call(second.socketPath, 'GET', '/v1/status')).body).toMatchObject({ configRevision: revision, recordedGroups: 1 })
  })

  it('notes the last moment the connection was alive and closes the database when it stops', async () => {
    const h = await boot()
    await connected(h)
    const before = Date.now()
    await h.running.close()
    await h.recorder.stop()
    const state = JSON.parse(readFileSync(join(h.dataDir, 'connection-state.json'), 'utf8')) as { lastAliveAt: number }
    expect(state.lastAliveAt).toBeGreaterThanOrEqual(before)
    expect(() => h.recorder.store.stats()).toThrow()
  })

  it('announces the minor it is told to, so tests can play an older recorder', async () => {
    const h = await boot({ config: false }, { protocolMinor: 0 })
    expect(((await call(h.socketPath, 'GET', '/v1/hello')).body as Booted | { protocol: { minor: number } })).toMatchObject({ protocol: { minor: 0 } })
  })
})
