import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto'
import { constants, createServer, type Http2Server, type IncomingHttpHeaders, type ServerHttp2Session, type ServerHttp2Stream } from 'node:http2'
import type { AddressInfo, Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { APPLE_HOSTS, ApnsClient, providerToken, type ApnsOptions } from '../src/apns.ts'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

interface Received {
  headers: IncomingHttpHeaders
  body: string
}

type Handler = (stream: ServerHttp2Stream, received: Received) => void

let server: Http2Server
let base = ''
let handler: Handler = (stream) => { stream.respond({ ':status': 200 }); stream.end() }
const received: Received[] = []
const serverSessions: ServerHttp2Session[] = []
const sockets: Socket[] = []
const clients: ApnsClient[] = []

beforeAll(async () => {
  server = createServer()
  server.on('connection', (socket: Socket) => { sockets.push(socket) })
  server.on('session', (session) => { serverSessions.push(session) })
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = []
    // A stream the handler resets reports that reset as an error on this side too.
    stream.on('error', () => undefined)
    stream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    stream.on('end', () => {
      const entry = { headers, body: Buffer.concat(chunks).toString('utf8') }
      received.push(entry)
      handler(stream, entry)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  received.length = 0
  handler = (stream) => { stream.respond({ ':status': 200 }); stream.end() }
})

afterAll(async () => {
  for (const session of serverSessions) session.destroy()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
})

function client(overrides: Partial<ApnsOptions> = {}): ApnsClient {
  const made = new ApnsClient({
    keyId: 'ABC123DEFG',
    teamId: 'TEAM123456',
    privateKeyPem,
    topic: 'com.example.dsh.voip',
    hosts: { sandbox: base, production: base },
    timeoutMs: 5000,
    ...overrides,
  })
  clients.push(made)
  return made
}

function respond(status: number, body?: string, headers: Record<string, string> = {}): Handler {
  return (stream) => {
    stream.respond({ ':status': status, ...headers })
    stream.end(body)
  }
}

/** The decoded parts of a bearer JWT, after checking its ES256 signature. */
interface DecodedJwt {
  header: Record<string, string>
  claims: { iss: string; iat: number }
}

function decodeJwt(authorization: string | undefined, key: KeyObject): DecodedJwt {
  const token = (authorization ?? '').replace(/^bearer /u, '')
  const [header, claims, signature] = token.split('.')
  if (header === undefined || claims === undefined || signature === undefined) throw new Error(`not a JWT: ${token}`)
  const valid = verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  if (!valid) throw new Error('the JWT signature does not verify')
  const part = (text: string): string => Buffer.from(text, 'base64url').toString('utf8')
  return { header: JSON.parse(part(header)) as DecodedJwt['header'], claims: JSON.parse(part(claims)) as DecodedJwt['claims'] }
}

const token = 'ab'.repeat(32)

describe('the provider token', () => {
  it('is an ES256 JWT naming the key and the team, signed in IEEE P1363 form', () => {
    const jwt = providerToken(privateKey, 'KEY1234567', 'TEAM765432', 1_700_000_000)
    expect(decodeJwt(`bearer ${jwt}`, publicKey)).toEqual({ header: { alg: 'ES256', kid: 'KEY1234567' }, claims: { iss: 'TEAM765432', iat: 1_700_000_000 } })
    expect(Buffer.from(jwt.split('.')[2] ?? '', 'base64url')).toHaveLength(64)
  })

  it('points at Apple by default', () => {
    expect(APPLE_HOSTS).toEqual({ sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' })
  })
})

describe('the APNs client', () => {
  it('refuses a key that is not an EC private key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => new ApnsClient({ keyId: 'k', teamId: 't', privateKeyPem: rsa, topic: 'x.voip', hosts: APPLE_HOSTS, timeoutMs: 1 })).toThrow('EC (ES256)')
    expect(() => new ApnsClient({ keyId: 'k', teamId: 't', privateKeyPem: 'not a key', topic: 'x.voip', hosts: APPLE_HOSTS, timeoutMs: 1 })).toThrow()
  })

  it('posts an immediate VoIP push to the device path with a bearer token and returns the apns-id', async () => {
    handler = respond(200, undefined, { 'apns-id': 'push-id-1' })
    const apns = client({ now: () => 1_700_000_000_500 })
    const result = await apns.send(token, 'sandbox', { aps: {}, dsh: { v: 1 } })
    expect(result).toEqual({ ok: true, apnsId: 'push-id-1' })
    const [request] = received
    expect(request?.headers[':method']).toBe('POST')
    expect(request?.headers[':path']).toBe(`/3/device/${token}`)
    expect(request?.headers['apns-push-type']).toBe('voip')
    expect(request?.headers['apns-topic']).toBe('com.example.dsh.voip')
    expect(request?.headers['apns-priority']).toBe('10')
    expect(request?.headers['apns-expiration']).toBe('0')
    expect(request?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request?.body ?? '')).toEqual({ aps: {}, dsh: { v: 1 } })
    expect(decodeJwt(request?.headers.authorization, publicKey)).toEqual({ header: { alg: 'ES256', kid: 'ABC123DEFG' }, claims: { iss: 'TEAM123456', iat: 1_700_000_000 } })
  })

  it('returns no apns-id when the answer carries none, and uses the wall clock by default', async () => {
    const before = Math.floor(Date.now() / 1000)
    const apns = client()
    await expect(apns.send(token, 'production', {})).resolves.toEqual({ ok: true, apnsId: undefined })
    const { claims } = decodeJwt(received[0]?.headers.authorization, publicKey)
    expect(claims.iat).toBeGreaterThanOrEqual(before)
    expect(claims.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
  })

  it('reports a dead token as unregistered', async () => {
    const apns = client()
    handler = respond(410, '{"reason":"Unregistered","timestamp":1}')
    await expect(apns.send(token, 'sandbox', {})).resolves.toEqual({ ok: false, status: 410, reason: 'Unregistered', unregistered: true })
    handler = respond(410, '')
    await expect(apns.send(token, 'sandbox', {})).resolves.toEqual({ ok: false, status: 410, reason: 'HTTP 410', unregistered: true })
    handler = respond(400, '{"reason":"BadDeviceToken"}')
    await expect(apns.send(token, 'sandbox', {})).resolves.toEqual({ ok: false, status: 400, reason: 'BadDeviceToken', unregistered: true })
    handler = respond(400, '{"reason":"Unregistered"}')
    await expect(apns.send(token, 'sandbox', {})).resolves.toEqual({ ok: false, status: 400, reason: 'Unregistered', unregistered: true })
  })

  it('reports other refusals with their reason, or the HTTP status when the body has none', async () => {
    const apns = client()
    handler = respond(400, '{"reason":"BadTopic"}')
    await expect(apns.send(token, 'sandbox', {})).resolves.toEqual({ ok: false, status: 400, reason: 'BadTopic', unregistered: false })
    handler = respond(500, '<html>oops</html>')
    await expect(apns.send(token, 'sandbox', {})).resolves.toEqual({ ok: false, status: 500, reason: 'HTTP 500', unregistered: false })
    handler = respond(429, '{"reason":7}')
    await expect(apns.send(token, 'sandbox', {})).resolves.toEqual({ ok: false, status: 429, reason: 'HTTP 429', unregistered: false })
    handler = respond(503, 'null')
    await expect(apns.send(token, 'sandbox', {})).resolves.toEqual({ ok: false, status: 503, reason: 'HTTP 503', unregistered: false })
  })

  it('reuses a token for fifty minutes and signs a new one after', async () => {
    let now = 1_700_000_000_000
    const apns = client({ now: () => now })
    await apns.send(token, 'sandbox', {})
    now += 49 * 60_000
    await apns.send(token, 'sandbox', {})
    now += 60_000
    await apns.send(token, 'sandbox', {})
    const [first, second, third] = received.map(request => request.headers.authorization)
    expect(second).toBe(first)
    expect(third).not.toBe(first)
    expect(decodeJwt(third, publicKey).claims.iat).toBe(1_700_000_000 + 50 * 60)
  })

  it('signs a new token after APNs refuses the cached one with 403', async () => {
    let now = 1_700_000_000_000
    const apns = client({ now: () => now })
    handler = respond(403, '{"reason":"ExpiredProviderToken"}')
    await expect(apns.send(token, 'sandbox', {})).resolves.toMatchObject({ ok: false, status: 403, reason: 'ExpiredProviderToken', unregistered: false })
    now += 1000
    handler = respond(200)
    await expect(apns.send(token, 'sandbox', {})).resolves.toMatchObject({ ok: true })
    const [refused, fresh] = received.map(request => request.headers.authorization)
    expect(fresh).not.toBe(refused)
    expect(decodeJwt(fresh, publicKey).claims.iat).toBe(1_700_000_001)
  })

  it('keeps one connection per environment until closed', async () => {
    const apns = client()
    const before = serverSessions.length
    await apns.send(token, 'sandbox', {})
    await apns.send(token, 'sandbox', {})
    expect(serverSessions.length - before).toBe(1)
    await apns.send(token, 'production', {})
    expect(serverSessions.length - before).toBe(2)
    apns.close()
    await apns.send(token, 'sandbox', {})
    expect(serverSessions.length - before).toBe(3)
  })

  it('rejects when APNs does not answer in time', async () => {
    handler = () => undefined
    const apns = client({ timeoutMs: 100 })
    await expect(apns.send(token, 'sandbox', {})).rejects.toThrow('APNs sandbox request closed without an answer')
  })

  it('rejects when APNs resets the stream', async () => {
    const apns = client()
    handler = (stream) => { stream.close(constants.NGHTTP2_INTERNAL_ERROR) }
    await expect(apns.send(token, 'production', {})).rejects.toThrow()
    handler = (stream) => { stream.close(constants.NGHTTP2_CANCEL) }
    await expect(apns.send(token, 'production', {})).rejects.toThrow('APNs production request closed without an answer')
  })

  it('rejects when APNs cannot be reached and connects again for the next push', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
    const deadPort = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
    let host = `http://127.0.0.1:${deadPort}`
    const apns = client({ hosts: { get sandbox() { return host }, production: base } })
    await expect(apns.send(token, 'sandbox', {})).rejects.toThrow()
    host = base
    await expect(apns.send(token, 'sandbox', {})).resolves.toMatchObject({ ok: true })
  })

  it('opens a new connection after APNs sends GOAWAY or drops the socket', async () => {
    const apns = client()
    await apns.send(token, 'sandbox', {})
    serverSessions.at(-1)?.goaway(constants.NGHTTP2_NO_ERROR)
    await new Promise(resolve => setTimeout(resolve, 100))
    const before = serverSessions.length
    await apns.send(token, 'sandbox', {})
    expect(serverSessions.length).toBe(before + 1)

    const dropped = new Promise<void>((resolve) => { sockets.at(-1)?.once('close', () => { resolve() }) })
    sockets.at(-1)?.destroy()
    await dropped
    await new Promise(resolve => setTimeout(resolve, 50))
    await apns.send(token, 'sandbox', {})
    expect(serverSessions.length).toBe(before + 2)
  })

  it('lets a push in flight finish after close, ignoring the late GOAWAY of the old connection', async () => {
    const apns = client()
    let answer = (): void => undefined
    const arrived = new Promise<void>((resolve) => {
      handler = (stream) => {
        answer = () => {
          stream.session?.goaway(constants.NGHTTP2_NO_ERROR)
          stream.respond({ ':status': 200, 'apns-id': 'late' })
          stream.end()
        }
        resolve()
      }
    })
    const pending = apns.send(token, 'sandbox', {})
    await arrived
    apns.close()
    answer()
    await expect(pending).resolves.toEqual({ ok: true, apnsId: 'late' })
  })
})
