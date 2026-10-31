import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayClient, type InboundMessage } from '../src/client.ts'
import { FakeRelay, message, until } from './fake-relay.ts'

const relays: FakeRelay[] = []
const clients: RelayClient[] = []
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop()
  for (const relay of relays.splice(0)) await relay.stop()
  vi.clearAllMocks()
})

type Options = ConstructorParameters<typeof RelayClient>[0]

async function setup(onMessage: (m: InboundMessage) => Promise<boolean> = () => Promise.resolve(true), extra: Partial<Options> = {}) {
  const relay = new FakeRelay()
  relays.push(relay)
  await relay.start()
  const client = new RelayClient({
    path: relay.path, requestTimeoutMs: 500, logger, onMessage, reconnectMinMs: 20, reconnectMaxMs: 40,
    retryMs: 20, maxAttempts: 3, ...extra,
  })
  clients.push(client)
  return { relay, client }
}

describe('RelayClient', () => {
  it('connects with hello and answers requests by id', async () => {
    const { relay, client } = await setup()
    relay.sessions = [{ name: 'worker', pid: 7 }]
    client.start()
    await until(() => client.connected)
    expect(await client.request('list')).toMatchObject({ ok: true, sessions: [{ name: 'worker', pid: 7 }] })
    expect(await client.request('send', { to: 'worker', text: 'hi' })).toMatchObject({ ok: true, msg_id: 'm1' })
    expect(relay.requests.map(request => request['op'])).toEqual(['hello', 'list', 'send'])
  })

  it('reports an unreachable relay as a failed request, not a throw', async () => {
    const { relay, client } = await setup()
    await relay.stop()
    relays.pop()
    client.start()
    expect(await client.request('list')).toMatchObject({ ok: false, error: expect.stringContaining('not connected') as string })
  })

  it('gives up on a relay that refuses hello and keeps retrying', async () => {
    const { relay, client } = await setup()
    relay.helloError = 'uid not allowed'
    client.start()
    await until(() => relay.requests.length >= 2)
    expect(client.connected).toBe(false)
    expect(client.problem).toBe('uid not allowed')
  })

  it('acknowledges a message once it was taken', async () => {
    const taken: string[] = []
    const { relay, client } = await setup((m) => { taken.push(m.text); return Promise.resolve(true) })
    client.start()
    await until(() => client.connected)
    relay.push(message('a1', 'build is green'))
    await until(() => relay.requests.some(request => request['op'] === 'ack'))
    expect(taken).toEqual(['build is green'])
    expect(relay.requests.find(request => request['op'] === 'ack')).toMatchObject({ ids: ['a1'] })
  })

  it('takes replayed messages that arrive before the hello response, and acknowledges them', async () => {
    const taken: string[] = []
    const { relay, client } = await setup((m) => { taken.push(m.id); return Promise.resolve(true) })
    relay.pending = [message('p1', 'while away')]
    client.start()
    await until(() => relay.pending.length === 0)
    expect(taken).toEqual(['p1'])
  })

  it('offers a message again when it could not be taken, then gives up', async () => {
    let offers = 0
    const { relay, client } = await setup(() => { offers += 1; return Promise.resolve(false) })
    client.start()
    await until(() => client.connected)
    relay.push(message('r1', 'busy'))
    await until(() => relay.requests.some(request => request['op'] === 'ack'))
    expect(offers).toBe(3)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('gave up on message r1'))
  })

  it('does not take the same message twice', async () => {
    const taken: string[] = []
    const { relay, client } = await setup((m) => { taken.push(m.id); return Promise.resolve(true) })
    client.start()
    await until(() => client.connected)
    relay.push(message('d1', 'once'))
    await until(() => taken.length === 1)
    relay.push(message('d1', 'once'))
    await until(() => relay.requests.filter(request => request['op'] === 'ack').length === 2)
    expect(taken).toEqual(['d1'])
  })

  it('reconnects after the relay drops the connection', async () => {
    const { relay, client } = await setup()
    client.start()
    await until(() => client.connected)
    relay.dropClients()
    await until(() => !client.connected)
    await until(() => client.connected)
    expect(relay.requests.filter(request => request['op'] === 'hello')).toHaveLength(2)
  })

  it('answers a request the relay never answers with a timeout error', async () => {
    const { relay, client } = await setup(undefined, { requestTimeoutMs: 80 })
    client.start()
    await until(() => client.connected)
    relay.silent.add('list')
    expect(await client.request('list')).toMatchObject({ ok: false, error: expect.stringContaining('did not answer list within 80 ms') as string })
  })
})
