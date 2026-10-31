import { afterEach, describe, expect, it } from 'vitest'
import { isPrivateUrl, OneBotClient, OneBotError, scrubToken, type OneBotEvent } from '../src/onebot.ts'
import { FakeOneBot, groupMessage } from './fake-onebot.ts'

const TOKEN = 'onebot-token-0123456789abcdef'
const servers: FakeOneBot[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

async function server(): Promise<FakeOneBot> {
  const fake = new FakeOneBot(TOKEN)
  servers.push(fake)
  await fake.listen()
  return fake
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('isPrivateUrl', () => {
  it('accepts this machine and the tailnet only', () => {
    for (const ok of ['ws://127.0.0.1:3001', 'ws://localhost:3001', 'ws://[::1]:3001', 'ws://100.95.26.63:3001', 'wss://mini.tailc2559b.ts.net/ws', 'ws://100.127.255.255:1']) expect(isPrivateUrl(ok)).toBe(true)
    for (const bad of ['ws://192.168.1.2:3001', 'ws://10.0.0.5:3001', 'ws://100.128.0.1:3001', 'ws://example.com:3001', 'http://127.0.0.1:3001', 'ws://0.0.0.0:3001', 'not a url']) expect(isPrivateUrl(bad)).toBe(false)
  })
})

describe('scrubToken', () => {
  it('removes the token from text', () => {
    expect(scrubToken(`connect ws://x?access_token=${TOKEN} failed`, TOKEN)).toBe('connect ws://x?access_token=*** failed')
    expect(scrubToken('plain', '')).toBe('plain')
  })
})

describe('OneBotClient', () => {
  it('authenticates with a Bearer token, delivers events, and correlates API calls', async () => {
    const fake = await server()
    fake.handlers.set('get_login_info', () => ({ user_id: 99999, nickname: 'bot' }))
    const client = new OneBotClient({ url: fake.url, token: TOKEN })
    const events: OneBotEvent[] = []
    let opened = 0
    const controller = new AbortController()
    const running = client.run({ event: (e) => { events.push(e) }, open: () => { opened += 1 }, close: () => {} }, controller.signal)
    await until(() => opened === 1, 'open')
    expect(fake.authorizations).toEqual([`Bearer ${TOKEN}`])
    expect(client.connected).toBe(true)
    fake.push(groupMessage('123456', '10001', 'hello'))
    fake.push({ post_type: 'meta_event', meta_event_type: 'heartbeat' })
    await until(() => events.length === 2, 'events')
    expect(events[0]!.post_type).toBe('message')
    expect(await client.call('get_login_info')).toEqual({ user_id: 99999, nickname: 'bot' })
    await expect(client.call('nope')).rejects.toMatchObject({ message: 'nope failed: no handler for nope', retcode: 1404 })
    controller.abort()
    await running
    expect(client.connected).toBe(false)
    await expect(client.call('get_login_info')).rejects.toBeInstanceOf(OneBotError)
  })

  it('rejects when the token is wrong, without printing it', async () => {
    const fake = await server()
    const client = new OneBotClient({ url: fake.url, token: 'wrong-token-zzzzzzzz' })
    const handlers = { event: () => {}, open: () => {}, close: () => {} }
    const error = await client.run(handlers, new AbortController().signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OneBotError)
    expect((error as Error).message).not.toContain('wrong-token-zzzzzzzz')
  })

  it('reports a close from the server and fails calls that were waiting', async () => {
    const fake = await server()
    fake.handlers.set('slow', () => { throw new Error('unused') })
    const client = new OneBotClient({ url: fake.url, token: TOKEN, requestTimeoutMs: 200 })
    const reasons: string[] = []
    let opened = false
    const handlers = { event: () => {}, open: () => { opened = true }, close: (r: string) => { reasons.push(r) } }
    const running = client.run(handlers, new AbortController().signal)
    await until(() => opened, 'open')
    // Swallow the request on the server side so the call stays pending until the timeout.
    fake.socket!.removeAllListeners('message')
    await expect(client.call('slow')).rejects.toThrow('slow timed out')
    fake.drop()
    await running
    expect(reasons).toEqual(['closed with code 1005'])
  })

  it('drops a socket that goes silent', async () => {
    const fake = await server()
    const client = new OneBotClient({ url: fake.url, token: TOKEN, idleTimeoutMs: 100 })
    const reasons: string[] = []
    await client.run({ event: () => {}, open: () => {}, close: (r) => { reasons.push(r) } }, new AbortController().signal)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/^closed with code/)
  })
})
