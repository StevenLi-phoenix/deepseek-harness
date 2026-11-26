import { createServer, IncomingMessage, request as httpRequest, ServerResponse, type Server } from 'node:http'
import { Socket, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallId, CallView, DeviceId } from '../src/protocol.ts'
import { CallHttpError, callRoutes, ROUTE_PREFIX, type CallApi } from '../src/routes.ts'

const TOKEN = 'route-token-must-not-leak-0123456789'
const DEVICE = '6a1f1e2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b' as DeviceId
const CALL = '0f9e8d7c-6b5a-4938-8271-605f4e3d2c1b' as CallId
const VOIP = 'ab'.repeat(32)

const view: CallView = { callId: CALL, initiator: 'owner', state: 'ringing', reason: null, createdAt: 1, answeredAt: null, endedAt: null, outcome: null }

function fakeApi(configured = true) {
  const token = configured ? TOKEN : undefined
  return {
    token: vi.fn(async () => token),
    health: vi.fn(async () => ({ v: 1 as const, enabled: true, speech: { stt: 'device' as const, tts: 'server' as const } })),
    registerDevice: vi.fn(async (deviceId: DeviceId, body: { name: string; environment: 'sandbox' | 'production' }) => ({ deviceId, name: body.name, environment: body.environment, registeredAt: 5 })),
    unregisterDevice: vi.fn(async () => {}),
    placeCall: vi.fn(async () => view),
    call: vi.fn(async () => view),
    connect: vi.fn(async () => 'v=0 answer'),
    decline: vi.fn(async () => {}),
    hangup: vi.fn(async () => {}),
  } satisfies CallApi
}

const servers: Server[] = []
const warnings: string[] = []

async function serve(api: CallApi, maxBodyBytes = 1024) {
  const handler = callRoutes(api, maxBodyBytes, (message) => { warnings.push(message) })
  const server = createServer((request, response) => { void handler(request, response) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  /** One request; `body` is sent as given (a string) or as JSON. */
  type Options = { body?: unknown; token?: string | null; contentType?: string; chunked?: boolean }
  type Answer = { status: number; body: unknown; headers: Record<string, unknown> }
  return (method: string, path: string, options: Options = {}) => new Promise<Answer>((resolve, reject) => {
    const raw = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    const headers: Record<string, string> = {}
    if (options.token !== null) headers['authorization'] = `Bearer ${options.token ?? TOKEN}`
    if (raw !== undefined) headers['content-type'] = options.contentType ?? 'application/json'
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const body: unknown = text === '' ? undefined : JSON.parse(text)
        resolve({ status: response.statusCode ?? 0, body, headers: response.headers })
      })
    })
    request.on('error', reject)
    // Writing before end without a length sends the body chunked.
    if (options.chunked === true && raw !== undefined) {
      request.write(raw.slice(0, 10))
      request.end(raw.slice(10))
    } else {
      request.end(raw)
    }
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  expect(warnings.filter(line => line.includes(TOKEN))).toEqual([])
  warnings.length = 0
})

describe('voice-call routes', () => {
  it('answers 503 until a token is configured, and 401 without the right one', async () => {
    const unset = await serve(fakeApi(false))
    expect(await unset('GET', `${ROUTE_PREFIX}/health`)).toMatchObject({ status: 503, body: { error: 'no voice-call token is configured' } })
    const call = await serve(fakeApi())
    expect(await call('GET', `${ROUTE_PREFIX}/health`, { token: null })).toMatchObject({ status: 401 })
    expect(await call('GET', `${ROUTE_PREFIX}/health`, { token: 'wrong' })).toMatchObject({ status: 401, body: { error: 'bearer token required' } })
    expect(warnings).toEqual(['voice-call: refused a request without the right token', 'voice-call: refused a request without the right token'])
  })

  it('reports health', async () => {
    const call = await serve(fakeApi())
    const answer = await call('GET', `${ROUTE_PREFIX}/health`)
    expect(answer).toMatchObject({ status: 200, body: { v: 1, enabled: true, speech: { stt: 'device', tts: 'server' } } })
    expect(answer.headers['cache-control']).toBe('no-store')
  })

  it('registers and unregisters a device', async () => {
    const api = fakeApi()
    const call = await serve(api)
    const body = { voipToken: VOIP, environment: 'sandbox', name: 'iPhone' }
    expect(await call('PUT', `${ROUTE_PREFIX}/devices/${DEVICE}`, { body, contentType: 'application/json; charset=utf-8' })).toEqual(expect.objectContaining({
      status: 200, body: { device: { deviceId: DEVICE, name: 'iPhone', environment: 'sandbox', registeredAt: 5 } },
    }))
    expect(api.registerDevice).toHaveBeenCalledWith(DEVICE, body)
    expect(await call('DELETE', `${ROUTE_PREFIX}/devices/${DEVICE}`)).toMatchObject({ status: 204, body: undefined })
    expect(api.unregisterDevice).toHaveBeenCalledWith(DEVICE)
  })

  it('refuses bad device ids, bodies, and content types without quoting them', async () => {
    const call = await serve(fakeApi())
    expect(await call('PUT', `${ROUTE_PREFIX}/devices/bad!id`, { body: {} })).toMatchObject({ status: 400, body: { error: 'invalid device id' } })
    expect(await call('PUT', `${ROUTE_PREFIX}/devices/${DEVICE}`, { body: { voipToken: 'XYZ', environment: 'sandbox', name: 'a' } })).toMatchObject({ status: 400, body: { error: 'invalid device body' } })
    expect(await call('PUT', `${ROUTE_PREFIX}/devices/${DEVICE}`, { body: '{nope' })).toMatchObject({ status: 400, body: { error: 'body is not UTF-8 JSON' } })
    expect(await call('PUT', `${ROUTE_PREFIX}/devices/${DEVICE}`, { body: 'x', contentType: 'text/plain' })).toMatchObject({ status: 415 })
    expect(await call('PUT', `${ROUTE_PREFIX}/devices/${DEVICE}`)).toMatchObject({ status: 415 })
  })

  it('refuses a body over the limit, by its declared length or as it streams', async () => {
    const call = await serve(fakeApi(), 64)
    const big = JSON.stringify({ deviceId: DEVICE, sdp: 'x'.repeat(200) })
    expect(await call('POST', `${ROUTE_PREFIX}/calls/${CALL}/connect`, { body: big })).toMatchObject({ status: 413, body: { error: 'body too large' } })
    // Chunked: no content-length, so the size is only known while reading.
    const chunked = await serve(fakeApi(), 64)
    expect(await chunked('POST', `${ROUTE_PREFIX}/calls/${CALL}/connect`, { body: big, chunked: true })).toMatchObject({ status: 413 })
  })

  it('places, reads, connects, declines, and hangs up calls', async () => {
    const api = fakeApi()
    const call = await serve(api)
    expect(await call('POST', `${ROUTE_PREFIX}/calls`, { body: { deviceId: DEVICE } })).toMatchObject({ status: 201, body: { call: view } })
    expect(await call('GET', `${ROUTE_PREFIX}/calls/${CALL}`)).toMatchObject({ status: 200, body: { call: view } })
    expect(await call('POST', `${ROUTE_PREFIX}/calls/${CALL}/connect`, { body: { deviceId: DEVICE, sdp: 'v=0 offer sdp' } })).toMatchObject({ status: 200, body: { sdp: 'v=0 answer' } })
    expect(api.connect).toHaveBeenCalledWith(CALL, DEVICE, 'v=0 offer sdp')
    expect(await call('POST', `${ROUTE_PREFIX}/calls/${CALL}/decline`, { body: { deviceId: DEVICE } })).toMatchObject({ status: 204 })
    expect(await call('POST', `${ROUTE_PREFIX}/calls/${CALL}/hangup`, { body: { deviceId: DEVICE } })).toMatchObject({ status: 204 })
    expect(api.decline).toHaveBeenCalledWith(CALL, DEVICE)
    expect(api.hangup).toHaveBeenCalledWith(CALL, DEVICE)
  })

  it('answers 404 for unknown paths and call ids, and 405 with the allowed methods', async () => {
    const call = await serve(fakeApi())
    expect(await call('GET', `${ROUTE_PREFIX}/nope`)).toMatchObject({ status: 404 })
    expect(await call('GET', '/elsewhere')).toMatchObject({ status: 404 })
    expect(await call('GET', `${ROUTE_PREFIX}/calls/${CALL}/connect/extra`)).toMatchObject({ status: 404 })
    expect(await call('GET', `${ROUTE_PREFIX}/calls/NOT-A-UUID`)).toMatchObject({ status: 404, body: { error: 'no such call' } })
    expect(await call('POST', `${ROUTE_PREFIX}/calls/${CALL}/transfer`, { body: {} })).toMatchObject({ status: 404 })
    const wrong = await call('POST', `${ROUTE_PREFIX}/health`)
    expect(wrong).toMatchObject({ status: 405, body: { error: 'method not allowed' } })
    expect(wrong.headers['allow']).toBe('GET')
    expect((await call('GET', `${ROUTE_PREFIX}/calls/${CALL}/connect`)).headers['allow']).toBe('POST')
    expect((await call('POST', `${ROUTE_PREFIX}/devices/${DEVICE}`)).headers['allow']).toBe('PUT,DELETE')
    expect((await call('GET', `${ROUTE_PREFIX}/calls`)).headers['allow']).toBe('POST')
  })

  it('passes the service\'s refusals through and hides unexpected failures', async () => {
    const api = fakeApi()
    api.connect.mockRejectedValueOnce(new CallHttpError(409, 'the call was already picked up'))
    api.placeCall.mockRejectedValueOnce(new Error('storage broke'))
    api.call.mockRejectedValueOnce('odd')
    const call = await serve(api)
    expect(await call('POST', `${ROUTE_PREFIX}/calls/${CALL}/connect`, { body: { deviceId: DEVICE, sdp: 'v=0 offer sdp' } })).toMatchObject({ status: 409, body: { error: 'the call was already picked up' } })
    expect(await call('POST', `${ROUTE_PREFIX}/calls`, { body: { deviceId: DEVICE } })).toMatchObject({ status: 500, body: { error: 'voice-call failed' } })
    expect(await call('GET', `${ROUTE_PREFIX}/calls/${CALL}`)).toMatchObject({ status: 500 })
    expect(warnings).toEqual(['voice-call: request failed: storage broke', 'voice-call: request failed: odd'])
  })
})

describe('callRoutes without a URL or method', () => {
  it('treats them as GET /', async () => {
    const handler = callRoutes(fakeApi(), 1024, () => {})
    const request = new IncomingMessage(new Socket())
    request.headers = { authorization: `Bearer ${TOKEN}` }
    delete request.url
    request.push(null)
    expect(request.method).toBeNull()
    const response = new ServerResponse(request)
    const end = vi.spyOn(response, 'end')
    await handler(request, response)
    expect(response.statusCode).toBe(404)
    expect(end).toHaveBeenCalledWith(JSON.stringify({ error: 'not found' }))
  })
})

describe('CallHttpError', () => {
  it('carries its status', () => {
    const error = new CallHttpError(410, 'the call has ended')
    expect(error).toMatchObject({ name: 'CallHttpError', status: 410, message: 'the call has ended' })
  })
})
