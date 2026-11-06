import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RecorderClient, RecorderError, RecorderUnavailable, type ClientListener, type RecorderClientOptions,
} from '../src/client.ts'
import { FEATURE_MINOR, type RecorderConfig } from '../src/protocol.ts'
import { FakeRecorder, fixture, json } from './client-fake-recorder.ts'
import { recorderConfig } from './recorder-harness.ts'

interface Logged { level: 'debug' | 'info' | 'warn'; text: string }

const fakes: FakeRecorder[] = []
const clients: RecorderClient[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.stop()))
  await Promise.all(fakes.splice(0).map(fake => fake.close()))
  vi.useRealTimers()
})

async function recorder(): Promise<FakeRecorder> {
  const fake = new FakeRecorder()
  fakes.push(fake)
  await fake.listen()
  return fake
}

function build(socketPath: string, over: Partial<RecorderClientOptions> = {}) {
  const logs: Logged[] = []
  const client = new RecorderClient({
    socketPath,
    token: () => 'secret-token',
    logger: {
      debug: (text) => { logs.push({ level: 'debug', text }) },
      info: (text) => { logs.push({ level: 'info', text }) },
      warn: (text) => { logs.push({ level: 'warn', text }) },
    },
    timeoutMs: 2000,
    retryMs: { first: 5, max: 20 },
    ...over,
  })
  clients.push(client)
  return { client, logs }
}

/** Wait for a condition without a timer, so fake timers stay untouched. */
async function settled(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
}

const config = (revision: string): RecorderConfig => ({ ...recorderConfig('ws://127.0.0.1:1'), revision })

const statusEvent = (revision: string | null): string => {
  const status = fixture('v1.0', 'status') as { configRevision: string | null }
  return `${JSON.stringify({ type: 'status', status: { ...status, configRevision: revision } })}\n`
}

/** The link is ok and the client has read from its event stream (a marker status event proves the response arrived). */
async function streamUp(fake: FakeRecorder, client: RecorderClient, mark = 77): Promise<void> {
  await settled(() => client.link() === 'ok' && fake.streams.length > 0, 'the event stream')
  const marker = fake.status as Record<string, unknown>
  fake.emit(`${JSON.stringify({ type: 'status', status: { ...marker, recordedGroups: mark } })}\n`)
  await settled(() => client.status()?.recordedGroups === mark, 'the marker status event')
}

async function connected(over: Partial<RecorderClientOptions> = {}) {
  const fake = await recorder()
  const built = build(fake.socketPath, over)
  built.client.start()
  await streamUp(fake, built.client)
  return { fake, ...built }
}

describe('RecorderClient state before and after the first hello', () => {
  it('starts as connecting with nothing known, uses its defaults, and ignores a second start', async () => {
    const fake = await recorder()
    const logs: string[] = []
    const client = new RecorderClient({
      socketPath: fake.socketPath, token: () => 'secret-token',
      logger: { debug: () => {}, info: (text) => { logs.push(text) }, warn: () => {} },
    })
    clients.push(client)
    expect(client.link()).toBe('connecting')
    expect(client.helloOf()).toBeUndefined()
    expect(client.status()).toBeUndefined()
    expect(client.supports('events')).toBe(false)
    expect(client.connection()).toEqual({ state: 'starting', since: null, attempt: 0, lastError: null, selfId: null })
    client.start()
    client.start()
    await streamUp(fake, client)
    expect(fake.count('/v1/hello')).toBe(1)
    expect(client.helloOf()).toMatchObject({ build: '3f9a1c0d7b2e' })
    expect(client.supports('events')).toBe(true)
    expect(client.supports('media')).toBe(true)
    expect(client.supports('no-such-feature')).toBe(false)
    expect(client.connection()).toEqual({ state: 'connected', since: 1790000000000, attempt: 0, lastError: null, selfId: '99999' })
    expect(logs).toContain('lsy-qq: the recorder is ok')
  })

  it('reports a recorder still waiting for its configuration as starting', async () => {
    const fake = await recorder()
    const status = fixture('v1.0', 'status') as { connection: Record<string, unknown> }
    fake.status = { ...status, connection: { ...status.connection, state: 'waiting-config', selfId: null } }
    const { client } = build(fake.socketPath)
    client.start()
    await streamUp(fake, client)
    expect(client.connection()).toMatchObject({ state: 'starting', selfId: null })
  })

  it('supports a feature only when the recorder\'s minor is high enough', async () => {
    const fake = await recorder()
    fake.hello = fixture('v1.0', 'hello')
    const { client } = build(fake.socketPath)
    client.start()
    await streamUp(fake, client)
    expect(client.supports('events')).toBe(true)
    expect(client.supports('media')).toBe(false)
  })

  it('stamps state changes with the injected clock', async () => {
    const fake = await recorder()
    let now = 100
    const { client } = build(fake.socketPath, { now: () => now })
    now = 250
    client.start()
    await streamUp(fake, client)
    expect(client.connection().since).toBe(1790000000000)
    fake.unlinkSocket()
    await expect(client.groups()).rejects.toThrow('the recorder is not listening')
    expect(client.connection()).toMatchObject({ state: 'recorder-down', since: 250 })
  })
})

describe('RecorderClient listeners', () => {
  it('tells listeners about status events, messages and a bot going offline, and skips what it does not know', async () => {
    const { fake, client } = await connected()
    const changes: number[] = []
    const messages: unknown[] = []
    const offline: number[] = []
    const stop = client.listen({
      change: () => { changes.push(1) },
      messages: (event) => { messages.push(event) },
      botOffline: (at) => { offline.push(at) },
    })
    // A listener with no handlers at all is fine.
    client.listen({})
    const line = (value: unknown): string => `${JSON.stringify(value)}\n`
    fake.emit(line({ type: 'messages', groupId: '123456789', count: 3, lastCursor: 'c45' }))
    fake.emit(line({ type: 'bot-offline', at: 1790000000123 }))
    fake.emit(line({ type: 'ping', at: 1 }))
    fake.emit(line({ type: 'from-the-future', x: 1 }))
    fake.emit('this is not json\n')
    // A line may arrive in pieces.
    const status = statusEvent('a1b2c3d4e5f6')
    fake.emit(status.slice(0, 20))
    fake.emit(status.slice(20))
    await settled(() => changes.length === 1, 'the status event')
    expect(messages).toEqual([{ type: 'messages', groupId: '123456789', count: 3, lastCursor: 'c45' }])
    expect(offline).toEqual([1790000000123])
    stop()
    fake.emit(line({ type: 'bot-offline', at: 2 }))
    fake.emit(statusEvent('a1b2c3d4e5f6'))
    await settled(() => client.status()?.configRevision === 'a1b2c3d4e5f6' && fake.seen.length > 0, 'the second status event')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(offline).toEqual([1790000000123])
    expect(changes).toHaveLength(1)
  })

  it('keeps going when a listener throws, whatever it throws', async () => {
    const { fake, client, logs } = await connected()
    let calls = 0
    const throwing: ClientListener = {
      change: () => {
        calls += 1
        throw calls === 1 ? new Error('listener broke') : 'plain failure'
      },
    }
    client.listen(throwing)
    fake.emit(statusEvent('a1b2c3d4e5f6'))
    await settled(() => calls === 1, 'the first change')
    fake.emit(statusEvent('a1b2c3d4e5f6'))
    await settled(() => calls === 2, 'the second change')
    expect(logs.map(entry => entry.text)).toContain('lsy-qq: a recorder listener threw: listener broke')
    expect(logs.map(entry => entry.text)).toContain('lsy-qq: a recorder listener threw: plain failure')
  })
})

describe('RecorderClient configuration push', () => {
  it('waits for the link, pushes once, says when the recorder reconnected, and pushes again on a new revision', async () => {
    const fake = await recorder()
    fake.route('PUT /v1/config', (_req, res, body) => {
      json(res, 200, { revision: (JSON.parse(body) as { revision: string }).revision, reconnect: true })
    })
    const { client, logs } = build(fake.socketPath)
    await client.setConfig(config('rev-1'))
    expect(fake.count('/v1/config')).toBe(0)
    client.start()
    await settled(() => fake.count('/v1/config') === 1, 'the first push')
    await client.setConfig(config('rev-1'))
    expect(fake.count('/v1/config')).toBe(1)
    await client.setConfig(config('rev-2'))
    expect(fake.count('/v1/config')).toBe(2)
    expect(JSON.parse(fake.seen.filter(entry => entry.path === '/v1/config').at(-1)!.body)).toMatchObject({ revision: 'rev-2' })
    expect(logs.map(entry => entry.text)).toContain('lsy-qq: pushed configuration rev-1 to the recorder (it reconnected to QQ)')
  })

  it('pushes the configuration again when a status event shows the recorder runs another revision', async () => {
    const { fake, client } = await connected()
    await client.setConfig(config('rev-1'))
    expect(fake.count('/v1/config')).toBe(1)
    fake.emit(statusEvent('rev-1'))
    fake.emit(statusEvent('something-else'))
    await settled(() => fake.count('/v1/config') === 2, 'the repeated push')
    expect(client.status()?.configRevision).toBe('something-else')
  })

  it('does not push on a status event before any configuration is set', async () => {
    const { fake } = await connected()
    fake.emit(statusEvent('whatever'))
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    await settled(() => fake.streams.length === 1, 'the stream')
    expect(fake.count('/v1/config')).toBe(0)
  })

  it('does not push a revision the recorder refused until the configuration changes', async () => {
    const { fake, client, logs } = await connected()
    fake.route('PUT /v1/config', (_req, res) => { json(res, 422, { error: { code: 'invalid-config', message: 'url is not allowed' } }) })
    await client.setConfig(config('bad'))
    await client.setConfig(config('bad'))
    expect(fake.count('/v1/config')).toBe(1)
    expect(logs.map(entry => entry.text)).toContain('lsy-qq: could not push the configuration to the recorder: url is not allowed')
    fake.route('PUT /v1/config', (_req, res, body) => { json(res, 200, { revision: (JSON.parse(body) as { revision: string }).revision, reconnect: false }) })
    await client.setConfig(config('good'))
    expect(fake.count('/v1/config')).toBe(2)
  })

  it('retries after a refusal that is not a 422, and reports a failure that is not an Error', async () => {
    const fake = await recorder()
    let failToken = false
    const { client, logs } = build(fake.socketPath, {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the subject is a token reader that fails with a non-Error
      token: () => (failToken ? Promise.reject('token store offline') : 'secret-token'),
    })
    client.start()
    await streamUp(fake, client)
    fake.route('PUT /v1/config', (_req, res) => { json(res, 500, { error: { code: 'busy', message: 'try later' } }) })
    await client.setConfig(config('rev-1'))
    await client.setConfig(config('rev-1'))
    expect(fake.count('/v1/config')).toBe(2)
    failToken = true
    await client.setConfig(config('rev-2'))
    expect(logs.map(entry => entry.text)).toContain('lsy-qq: could not push the configuration to the recorder: token store offline')
  })
})

describe('RecorderClient when the token disappears mid-connection', () => {
  it('opens the event stream with an empty bearer credential when the token went away after the status read', async () => {
    const fake = await recorder()
    let reads = 0
    const { client, logs } = build(fake.socketPath, { token: () => { reads += 1; return reads <= 2 ? 'secret-token' : undefined } })
    await client.setConfig(config('rev-1'))
    client.start()
    await streamUp(fake, client)
    expect(fake.seen.find(entry => entry.path === '/v1/events')?.auth).toBe('Bearer')
    expect(fake.count('/v1/config')).toBe(0)
    expect(logs.map(entry => entry.text)).toContain('lsy-qq: could not push the configuration to the recorder: the recorder token is not set')
  })
})

describe('RecorderClient when the recorder is not there or not right', () => {
  it('counts attempts while the socket does not exist, tells listeners, and refuses reads fast', async () => {
    const fake = await recorder()
    fake.unlinkSocket()
    const { client, logs } = build(fake.socketPath)
    const changes: number[] = []
    client.listen({ change: () => { changes.push(client.connection().attempt) } })
    client.start()
    await settled(() => client.connection().attempt >= 3, 'three attempts')
    expect(client.link()).toBe('recorder-down')
    expect(client.connection()).toMatchObject({ state: 'recorder-down', lastError: 'the recorder is not listening', selfId: null })
    expect(client.connection().attempt).toBeGreaterThanOrEqual(3)
    expect(client.status()).toBeUndefined()
    expect(logs.filter(entry => entry.text.startsWith('lsy-qq: the recorder is recorder-down'))).toHaveLength(1)
    await expect(client.groups()).rejects.toMatchObject({ reason: 'recorder-down', message: 'the QQ recorder is recorder-down' })
    await expect(client.groups()).rejects.toBeInstanceOf(RecorderUnavailable)
  })

  it('says the QQ recorder is connecting before the first answer, without touching the socket', async () => {
    const fake = await recorder()
    const { client } = build(fake.socketPath)
    await expect(client.groups()).rejects.toThrow('the QQ recorder is connecting')
    expect(fake.seen).toEqual([])
  })

  it('stays down, naming the missing token, while the token is not set, and recovers when it is', async () => {
    const fake = await recorder()
    const creds: { token: string | undefined } = { token: undefined }
    const { client } = build(fake.socketPath, { token: () => creds.token })
    client.start()
    await settled(() => client.link() === 'recorder-down', 'the link to go down')
    expect(client.connection().lastError).toBe('the recorder token is not set')
    expect(fake.seen).toEqual([])
    creds.token = 'secret-token'
    await streamUp(fake, client)
  })

  it('records a token reader that fails with something that is not an Error as the reason', async () => {
    const fake = await recorder()
    const { client } = build(fake.socketPath, {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the subject is a token reader that fails with a non-Error
      token: () => Promise.reject('token store offline'),
    })
    client.start()
    await settled(() => client.link() === 'recorder-down', 'the link to go down')
    expect(client.connection().lastError).toBe('token store offline')
  })

  it('moves to protocol-mismatch when the hello names another major or another protocol, and recovers when it matches', async () => {
    const fake = await recorder()
    const hello = fixture('v1.1', 'hello') as { protocol: Record<string, unknown> }
    fake.hello = { ...hello, protocol: { ...hello.protocol, major: 2, minor: 0 } }
    const { client } = build(fake.socketPath)
    client.start()
    await settled(() => client.link() === 'protocol-mismatch', 'the mismatch')
    expect(client.connection()).toMatchObject({
      state: 'protocol-mismatch', lastError: 'the recorder speaks qq-recorder/2.0, this DSH speaks qq-recorder/1.1', selfId: null,
    })
    await expect(client.groups()).rejects.toMatchObject({ reason: 'protocol-mismatch', message: 'the QQ recorder is protocol-mismatch' })
    fake.hello = { ...hello, protocol: { ...hello.protocol, name: 'something-else' } }
    await settled(() => fake.count('/v1/hello') >= 2, 'a second hello')
    expect(client.link()).toBe('protocol-mismatch')
    fake.hello = hello
    await streamUp(fake, client)
  })

  it('moves to protocol-mismatch when the recorder answers 426, with or without naming its protocol', async () => {
    const fake = await recorder()
    fake.route('GET /v1/hello', (_req, res) => { json(res, 426, { error: { code: 'protocol-mismatch', message: 'no' } }, 'qq-recorder/2.0') })
    const { client } = build(fake.socketPath)
    client.start()
    await settled(() => client.link() === 'protocol-mismatch', 'the mismatch')
    expect(client.connection().lastError).toBe('the recorder speaks qq-recorder/2.0')
    fake.route('GET /v1/hello', (_req, res) => { json(res, 426, { error: { code: 'protocol-mismatch', message: 'no' } }, null) })
    await settled(() => client.connection().lastError === 'the recorder speaks another protocol', 'the untagged refusal')
  })

  it('goes down when the event stream ends, and reconnects', async () => {
    const { fake, client, logs } = await connected()
    for (const stream of fake.streams.splice(0)) stream.end()
    await streamUp(fake, client, 78)
    expect(logs.map(entry => entry.text)).toContain('lsy-qq: the recorder is recorder-down (the event stream ended)')
    expect(fake.count('/v1/hello')).toBe(2)
  })

  it('goes down when the recorder refuses the event stream or resets it', async () => {
    const fake = await recorder()
    let mode: 'refuse' | 'reset' | 'cut' = 'refuse'
    fake.route('GET /v1/events', (req, res) => {
      if (mode === 'refuse') json(res, 500, { error: { code: 'busy', message: 'later' } })
      else if (mode === 'reset') req.socket.destroy()
      else {
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'transfer-encoding': 'chunked' })
        res.write('\n')
        setImmediate(() => { res.socket?.destroy() })
      }
    })
    const { client, logs } = build(fake.socketPath)
    client.start()
    await settled(() => fake.count('/v1/events') >= 2, 'a refused stream and its retry')
    mode = 'reset'
    const afterRefused = fake.count('/v1/events')
    await settled(() => fake.count('/v1/events') >= afterRefused + 2, 'a reset stream and its retry')
    mode = 'cut'
    const afterReset = fake.count('/v1/events')
    await settled(() => fake.count('/v1/events') >= afterReset + 2, 'a cut stream and its retry')
    expect(logs.filter(entry => entry.text === 'lsy-qq: the recorder is recorder-down (the event stream ended)').length).toBeGreaterThan(0)
  })
})

describe('RecorderClient requests', () => {
  it('goes down at once when the socket disappears under an ok link, and wakes the loop to reconnect', async () => {
    const { fake, client, logs } = await connected()
    fake.unlinkSocket()
    await expect(client.groups()).rejects.toThrow('the recorder is not listening')
    expect(client.link()).toBe('recorder-down')
    expect(logs.map(entry => entry.text)).toContain('lsy-qq: the recorder is recorder-down (the recorder is not listening)')
  })

  it('reports a dropped connection by the transport\'s own message', async () => {
    const { fake, client } = await connected()
    fake.route('GET /v1/groups', (req) => { req.socket.destroy() })
    await expect(client.groups()).rejects.toThrow('socket hang up')
    expect(client.link()).toBe('recorder-down')
  })

  it('gives up on a recorder that does not answer in time', async () => {
    const { fake, client } = await connected({ timeoutMs: 50 })
    fake.route('GET /v1/groups', () => {})
    await expect(client.groups()).rejects.toThrow('the recorder did not answer in time')
    expect(client.link()).toBe('recorder-down')
  })

  it('sends the bearer token and the protocol tag on every request, and the body only when there is one', async () => {
    const { fake, client } = await connected()
    fake.route('GET /v1/groups', (_req, res) => { json(res, 200, fixture('v1.0', 'groups')) })
    await client.groups()
    const sent = fake.seen.filter(entry => entry.path === '/v1/groups')
    expect(sent).toEqual([{ method: 'GET', path: '/v1/groups', query: '', auth: 'Bearer secret-token', protocol: 'qq-recorder/1.1', body: '' }])
    expect(fake.seen.find(entry => entry.path === '/v1/events')).toMatchObject({ auth: 'Bearer secret-token', protocol: 'qq-recorder/1.1' })
  })

  it('turns a refusal into a RecorderError with the recorder\'s code, or a generic one when the body has none', async () => {
    const { fake, client } = await connected()
    fake.route('GET /v1/groups', (_req, res) => { json(res, 403, { error: { code: 'forbidden', message: 'not yours' } }) })
    await expect(client.groups()).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'not yours' })
    fake.route('GET /v1/groups', (_req, res) => { json(res, 500, { oops: true }) })
    const error = await client.groups().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RecorderError)
    expect(error).toMatchObject({ status: 500, code: 'error', message: 'HTTP 500' })
    expect(client.link()).toBe('ok')
  })

  it('answers a protocol refusal on a read as a mismatch, with or without the recorder\'s tag', async () => {
    const { fake, client } = await connected()
    fake.route('GET /v1/groups', (_req, res) => { json(res, 426, { error: { code: 'protocol-mismatch', message: 'no' } }, 'qq-recorder/3.0') })
    await expect(client.groups()).rejects.toMatchObject({ reason: 'protocol-mismatch', message: 'the recorder speaks qq-recorder/3.0' })
    fake.route('GET /v1/groups', (_req, res) => { json(res, 426, {}, null) })
    await expect(client.groups()).rejects.toMatchObject({ reason: 'protocol-mismatch', message: 'the recorder speaks another protocol' })
  })

  it('rejects an answer that is not JSON or does not match the protocol, naming where it differs', async () => {
    const { fake, client } = await connected()
    fake.route('GET /v1/groups', (_req, res) => { res.writeHead(200); res.end('<html>') })
    await expect(client.groups()).rejects.toMatchObject({ status: 200, code: 'invalid-response', message: 'the recorder did not answer with JSON' })
    fake.route('GET /v1/groups', (_req, res) => { json(res, 200, [{ groupId: '1' }]) })
    const mismatch = await client.groups().catch((e: unknown) => e)
    expect(mismatch).toMatchObject({ code: 'invalid-response' })
    expect((mismatch as Error).message).toMatch(
      /^the recorder's answer for \/v1\/groups does not match protocol qq-recorder\/1\.1: 0\.\w+$/,
    )
    fake.route('GET /v1/groups', (_req, res) => { json(res, 200, 7) })
    await expect(client.groups()).rejects.toMatchObject({
      code: 'invalid-response', message: 'the recorder\'s answer for /v1/groups does not match protocol qq-recorder/1.1: ',
    })
  })

  it('reads every query of the API with the arguments the recorder needs', async () => {
    const { fake, client } = await connected()
    const answer = (name: string, version: 'v1.0' | 'v1.1' = 'v1.0') => (_req: unknown, res: Parameters<typeof json>[0]): void => {
      json(res, 200, fixture(version, name))
    }
    fake.route('GET /v1/groups', answer('groups'))
    fake.route('GET /v1/messages', (req, res) => {
      const query = new URL(req.url ?? '', 'http://x').searchParams
      json(res, 200, query.has('sinceMs') ? fixture('v1.0', 'messages') : fixture('v1.0', 'message-page'))
    })
    fake.route('POST /v1/messages/search', answer('messages'))
    fake.route('POST /v1/messages/lookup', answer('messages'))
    fake.route('GET /v1/groups/123456789/members', answer('members'))
    fake.route('GET /v1/login', answer('login'))
    fake.route('POST /v1/login/refresh', answer('refresh'))
    fake.route('GET /v1/legacy/digest-state', answer('legacy-state'))

    expect(await client.groups()).toHaveLength(2)
    expect(await client.recent('123456789', { sinceMs: -5, limit: 10 })).toHaveLength(1)
    expect(await client.recent('123456789', { sinceMs: 3600000.4, limit: 10, userId: '10001' })).toHaveLength(1)
    expect((await client.page('123456789', undefined, 50)).nextCursor).toBe('c42')
    expect((await client.page('123456789', 'c42', 50)).items).toHaveLength(1)
    expect(await client.search('部署', { limit: 20 })).toHaveLength(1)
    expect(await client.search('部署', { groupId: '123456789', limit: 20 })).toHaveLength(1)
    const ids = Array.from({ length: 250 }, (_unused, index) => String(index))
    expect(await client.lookup('123456789', ids)).toHaveLength(1)
    expect(await client.members('123456789')).toEqual([{ userId: '10001', nickname: '昵称', card: '名片' }])
    expect((await client.login(false)).state).toBe('qr')
    expect((await client.login(true)).state).toBe('qr')
    expect((await client.refreshLogin()).reason).toBe('logged-in')
    expect((await client.legacyState()).aliasSalt).toBe('salt-uuid')

    const queryOf = (entry: { query: string }): string => entry.query
    const messages = fake.seen.filter(entry => entry.path === '/v1/messages').map(queryOf)
    expect(messages).toEqual([
      '?groupId=123456789&sinceMs=0&limit=10',
      '?groupId=123456789&sinceMs=3600000&limit=10&userId=10001',
      '?groupId=123456789&limit=50',
      '?groupId=123456789&limit=50&after=c42',
    ])
    const bodies = fake.seen.filter(entry => entry.method === 'POST').map(entry => JSON.parse(entry.body) as Record<string, unknown>)
    expect(bodies[0]).toEqual({ query: '部署', limit: 20 })
    expect(bodies[1]).toEqual({ query: '部署', groupId: '123456789', limit: 20 })
    expect((bodies[2]!['messageIds'] as string[])).toHaveLength(200)
    expect(bodies[3]).toEqual({})
    expect(fake.seen.filter(entry => entry.path === '/v1/login').map(queryOf)).toEqual(['', '?fresh=1'])
  })
})

describe('RecorderClient.media', () => {
  const png = Buffer.from('not really a png')
  const described = (over: Record<string, unknown> = {}): string => JSON.stringify({ contentType: 'image/png', bytes: png.length, groupId: '123456789', ...over })

  it('returns the bytes with the recorder\'s description of them', async () => {
    const { fake, client } = await connected()
    fake.route('GET /v1/media/m12ab', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'x-lsy-media': described() })
      res.end(png)
    })
    const media = await client.media('m12ab')
    expect(media.bytes.equals(png)).toBe(true)
    expect(media.header).toEqual({ contentType: 'image/png', bytes: png.length, groupId: '123456789' })
  })

  it('refuses a file whose description is missing or does not match it', async () => {
    const { fake, client } = await connected()
    fake.route('GET /v1/media/m1', (_req, res) => { res.writeHead(200); res.end(png) })
    await expect(client.media('m1')).rejects.toMatchObject({ status: 200, code: 'invalid-response' })
    fake.route('GET /v1/media/m1', (_req, res) => { res.writeHead(200, { 'x-lsy-media': described({ bytes: 3 }) }); res.end(png) })
    await expect(client.media('m1')).rejects.toMatchObject({ code: 'invalid-response', message: 'the recorder\'s description of the image does not match the file' })
  })

  it('refuses a description that is not JSON like any other wrong answer', async () => {
    const { fake, client } = await connected()
    fake.route('GET /v1/media/m1', (_req, res) => { res.writeHead(200, { 'x-lsy-media': '{not json' }); res.end(png) })
    await expect(client.media('m1')).rejects.toMatchObject({ status: 200, code: 'invalid-response' })
  })

  it('reports an image the recorder does not hold with the recorder\'s own code', async () => {
    const { fake, client } = await connected()
    fake.route('GET /v1/media/gone', (_req, res) => { json(res, 404, { error: { code: 'not-saved', message: 'image was not saved' } }) })
    await expect(client.media('gone')).rejects.toMatchObject({ status: 404, code: 'not-saved', message: 'image was not saved' })
    fake.route('GET /v1/media/odd', (_req, res) => { res.writeHead(500); res.end('boom') })
    await expect(client.media('odd')).rejects.toMatchObject({ status: 500, code: 'invalid-response' })
  })

  it('does not ask while the link is down', async () => {
    const fake = await recorder()
    const { client } = build(fake.socketPath)
    await expect(client.media('m1')).rejects.toBeInstanceOf(RecorderUnavailable)
    expect(fake.seen).toEqual([])
  })
})

describe('RecorderClient shutdown', () => {
  it('stops cleanly while a request is in flight, without reporting a failure', async () => {
    const fake = await recorder()
    let release: (() => void) | undefined
    fake.route('GET /v1/hello', (_req, res) => { release = () => { json(res, 500, { error: { code: 'busy', message: 'later' } }) } })
    const { client, logs } = build(fake.socketPath)
    client.start()
    await settled(() => release !== undefined, 'the hello request')
    const stopping = client.stop()
    release!()
    await stopping
    expect(client.link()).toBe('connecting')
    expect(logs.filter(entry => entry.level === 'info')).toEqual([])
  })

  it('stops without waiting for an event stream the recorder has not answered yet', async () => {
    const fake = await recorder()
    let asked = false
    fake.route('GET /v1/events', () => { asked = true })
    const { client } = build(fake.socketPath)
    client.start()
    await settled(() => asked, 'the event stream request')
    await client.stop()
    expect(asked).toBe(true)
  })

  it('closes the event stream and unsubscribes every listener', async () => {
    const { fake, client } = await connected()
    const changes: number[] = []
    client.listen({ change: () => { changes.push(1) } })
    await client.stop()
    fake.emit(statusEvent('late'))
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(changes).toEqual([])
    expect(client.link()).toBe('ok')
  })
})

describe('RecorderClient against a recorder without the event stream', () => {
  it('polls the status every five seconds, tells listeners, and pushes a stale configuration', async () => {
    const original = FEATURE_MINOR['events']
    FEATURE_MINOR['events'] = 99
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const fake = await recorder()
      const { client } = build(fake.socketPath)
      const changes: number[] = []
      client.listen({ change: () => { changes.push(1) } })
      await client.setConfig(config('rev-1'))
      client.start()
      await settled(() => client.link() === 'ok' && fake.count('/v1/config') === 1, 'the first push')
      expect(fake.count('/v1/events')).toBe(0)
      expect(fake.count('/v1/status')).toBe(1)
      const status = fixture('v1.0', 'status') as Record<string, unknown>
      fake.status = { ...status, recordedGroups: 9, configRevision: 'rev-1' }
      await vi.advanceTimersByTimeAsync(5000)
      await settled(() => client.status()?.recordedGroups === 9, 'the polled status')
      expect(fake.count('/v1/status')).toBe(2)
      expect(fake.count('/v1/config')).toBe(1)
      expect(changes.length).toBeGreaterThan(0)
      fake.status = { ...status, recordedGroups: 10, configRevision: 'other' }
      await vi.advanceTimersByTimeAsync(5000)
      await settled(() => fake.count('/v1/config') === 2, 'the repeated push')
    } finally {
      FEATURE_MINOR['events'] = original!
    }
  })

  it('stops waiting between polls when the client stops', async () => {
    const original = FEATURE_MINOR['events']
    FEATURE_MINOR['events'] = 99
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const fake = await recorder()
      const { client } = build(fake.socketPath)
      client.start()
      await settled(() => client.link() === 'ok', 'the link')
      await client.stop()
      expect(fake.count('/v1/status')).toBe(1)
    } finally {
      FEATURE_MINOR['events'] = original!
    }
  })
})
