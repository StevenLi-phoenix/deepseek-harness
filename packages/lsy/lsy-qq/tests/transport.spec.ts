import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { createSdkTransport, GROUP_AND_C2C_INTENT, scrub, toInbound, type QqInbound } from '../src/transport.ts'

const APP_ID = '1020304050'
const APP_SECRET = 'app-secret-must-not-leak-0123456789'
const USER = 'E4D1A2B3C4D5E6F708192A3B4C5D6E7F'
const GROUP = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'
const MEMBER = '9F8E7D6C5B4A39281706F5E4D3C2B1A0'

describe('toInbound', () => {
  it('normalizes a private message', () => {
    expect(toInbound({ kind: 'c2c', senderId: USER, messageId: 'm1', content: ' hi ', timestamp: '2026-10-30T18:00:00+08:00', attachments: [{}] }, 5)).toEqual({
      scope: 'c2c', senderId: USER, messageId: 'm1', text: 'hi', at: Date.parse('2026-10-30T18:00:00+08:00'), attachments: 1,
    })
  })
  it('normalizes a group message and keeps the group id', () => {
    expect(toInbound({ kind: 'group', senderId: MEMBER, groupOpenid: GROUP, messageId: 'g1', content: '', timestamp: 'garbage' }, 7)).toEqual({
      scope: 'group', senderId: MEMBER, groupId: GROUP, messageId: 'g1', text: '', at: 7, attachments: 0,
    })
  })
  it('refuses guild messages, guild DMs, and malformed events', () => {
    expect(toInbound({ kind: 'guild', senderId: 'u', messageId: 'm', content: 'x' })).toBeUndefined()
    expect(toInbound({ kind: 'dm', senderId: 'u', messageId: 'm', content: 'x' })).toBeUndefined()
    expect(toInbound({ kind: 'c2c', messageId: 'm' })).toBeUndefined()
    expect(toInbound({ kind: 'group', senderId: 'u', messageId: 'm' })).toBeUndefined()
    expect(toInbound(null)).toBeUndefined()
  })
})

describe('scrub', () => {
  it('removes the secret and bearer tokens from SDK log text', () => {
    expect(scrub(`secret ${APP_SECRET} header QQBot abcdefghijklmnop1234`, APP_SECRET)).toBe('secret *** header QQBot ***')
    expect(scrub('{"access_token": "abcdefghijklmnop1234"}', APP_SECRET)).toBe('{"access_token": "***"}')
  })
})

/** A local stand-in for the QQ Open Platform: token endpoint, gateway URL, gateway WebSocket, message API. */
class FakeOpenPlatform {
  readonly http: Server
  readonly ws: WebSocketServer
  readonly requests: { method: string; url: string; auth: string | undefined; body: unknown }[] = []
  readonly identifies: unknown[] = []
  socket: WebSocket | undefined

  constructor() {
    this.http = createServer((request, response) => { void this.handle(request, response) })
    this.ws = new WebSocketServer({ server: this.http, path: '/ws' })
    this.ws.on('connection', (socket) => {
      this.socket = socket
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
      socket.on('message', (raw) => {
        const payload = JSON.parse(String(raw)) as { op: number; d: unknown }
        if (payload.op === 2) {
          this.identifies.push(payload.d)
          socket.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess-1', user: { id: 'bot', username: 'bot' } } }))
        }
      })
    })
  }

  private async handle(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    const body: unknown = text === '' ? undefined : JSON.parse(text)
    const url = request.url ?? ''
    this.requests.push({ method: request.method ?? '', url, auth: request.headers.authorization, body })
    response.setHeader('content-type', 'application/json')
    if (url === '/app/getAppAccessToken') {
      response.end(JSON.stringify({ access_token: 'tok-0123456789abcdef', expires_in: '7200' }))
    } else if (url === '/gateway') {
      response.end(JSON.stringify({ url: `ws://127.0.0.1:${this.port}/ws` }))
    } else if (/^\/v2\/(users|groups)\/[^/]+\/messages$/.test(url)) {
      response.end(JSON.stringify({ id: 'sent-1', timestamp: 1 }))
    } else {
      response.statusCode = 404
      response.end('{}')
    }
  }

  get port(): number { return (this.http.address() as AddressInfo).port }
  get origin(): string { return `http://127.0.0.1:${this.port}` }
  listen(): Promise<void> { return new Promise(resolve => this.http.listen(0, '127.0.0.1', resolve)) }
  close(): Promise<void> {
    for (const client of this.ws.clients) client.terminate()
    return new Promise(resolve => this.ws.close(() => this.http.close(() => { resolve() })))
  }

  dispatch(type: string, data: unknown, seq: number): void {
    this.socket?.send(JSON.stringify({ op: 0, s: seq, t: type, d: data }))
  }
}

const platforms: FakeOpenPlatform[] = []
afterEach(async () => { await Promise.all(platforms.splice(0).map(platform => platform.close())) })

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('createSdkTransport against a local Open Platform', () => {
  it('identifies for group and private messages only, delivers both kinds of event, and sends replies', async () => {
    const platform = new FakeOpenPlatform()
    platforms.push(platform)
    await platform.listen()
    const warnings: string[] = []
    const transport = createSdkTransport({
      appId: APP_ID,
      appSecret: APP_SECRET,
      baseUrl: platform.origin,
      tokenBaseUrl: platform.origin,
      log: { debug: () => {}, warn: (message) => { warnings.push(message) } },
    })
    const received: QqInbound[] = []
    let ready = 0
    const controller = new AbortController()
    const handlers = { message: (m: QqInbound) => { received.push(m) }, ready: () => { ready += 1 }, disconnected: () => {} }
    const running = transport.run(handlers, controller.signal)

    await until(() => ready > 0, 'READY')
    expect(platform.identifies).toEqual([{ token: 'QQBot tok-0123456789abcdef', intents: GROUP_AND_C2C_INTENT, shard: [0, 1] }])
    expect(platform.requests[0]).toMatchObject({ method: 'POST', url: '/app/getAppAccessToken', body: { appId: APP_ID, clientSecret: APP_SECRET } })

    platform.dispatch('C2C_MESSAGE_CREATE', { id: 'ROBOT1.0_c2c-1', content: '你好', timestamp: '2026-10-30T10:00:00+08:00', author: { user_openid: USER, id: USER, union_openid: 'u' } }, 2)
    platform.dispatch('GROUP_AT_MESSAGE_CREATE', { id: 'ROBOT1.0_grp-1', content: ' 帮我查一下', timestamp: '2026-10-30T10:00:01+08:00', group_openid: GROUP, author: { member_openid: MEMBER, id: MEMBER } }, 3)
    platform.dispatch('AT_MESSAGE_CREATE', { id: 'guild-1', content: 'guild noise', timestamp: '2026-10-30T10:00:02+08:00', channel_id: 'c', guild_id: 'g', author: { id: 'u', username: 'x' } }, 4)
    await until(() => received.length >= 2, 'both messages')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(received).toEqual([
      { scope: 'c2c', senderId: USER, messageId: 'ROBOT1.0_c2c-1', text: '你好', at: Date.parse('2026-10-30T10:00:00+08:00'), attachments: 0 },
      { scope: 'group', senderId: MEMBER, groupId: GROUP, messageId: 'ROBOT1.0_grp-1', text: '帮我查一下', at: Date.parse('2026-10-30T10:00:01+08:00'), attachments: 0 },
    ])

    await transport.send({ scope: 'c2c', id: USER, msgId: 'ROBOT1.0_c2c-1' }, '你好呀')
    await transport.send({ scope: 'group', id: GROUP, msgId: 'ROBOT1.0_grp-1' }, '好的')
    await transport.send({ scope: 'c2c', id: USER }, '主动消息')
    const sends = platform.requests.filter(request => request.url.includes('/messages'))
    expect(sends.map(request => [request.url, request.auth, request.body])).toEqual([
      [`/v2/users/${USER}/messages`, 'QQBot tok-0123456789abcdef', expect.objectContaining({ content: '你好呀', msg_type: 0, msg_id: 'ROBOT1.0_c2c-1', msg_seq: expect.any(Number) as unknown })],
      [`/v2/groups/${GROUP}/messages`, 'QQBot tok-0123456789abcdef', expect.objectContaining({ content: '好的', msg_type: 0, msg_id: 'ROBOT1.0_grp-1' })],
      [`/v2/users/${USER}/messages`, 'QQBot tok-0123456789abcdef', expect.objectContaining({ content: '主动消息', msg_type: 0 })],
    ])
    expect((sends[2]!.body as Record<string, unknown>).msg_id).toBeUndefined()

    controller.abort()
    await running
    expect(warnings.join('\n')).not.toContain(APP_SECRET)
  })

  it('rejects when the platform refuses the credentials', async () => {
    const platform = new FakeOpenPlatform()
    platforms.push(platform)
    await platform.listen()
    const transport = createSdkTransport({
      appId: APP_ID, appSecret: APP_SECRET, baseUrl: platform.origin, tokenBaseUrl: `${platform.origin}/nowhere`, log: { debug: () => {}, warn: () => {} },
    })
    const controller = new AbortController()
    await expect(transport.run({ message: () => {}, ready: () => {}, disconnected: () => {} }, controller.signal)).rejects.toThrow()
    controller.abort()
  })
})
