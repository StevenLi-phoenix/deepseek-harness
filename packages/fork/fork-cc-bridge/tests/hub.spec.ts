import { rmSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerHub, type HubOptions, type InboundMessage } from '../src/hub.ts'
import { parseWrapper } from '../src/wire.ts'
import { FakeSession, tempDirs, until } from './helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() })

async function setup(over: Partial<HubOptions> = {}) {
  const dirs = tempDirs()
  const inbound: InboundMessage[] = []
  let now = 1_000_000
  const log = logger()
  const hub = new PeerHub({
    stateDir: dirs.stateDir, sessionsDir: dirs.sessionsDir, peerName: 'dsh-agent', maxText: 100,
    sendPerMin: 3, sendTotalPerMin: 20, inboundPerMin: 2, inboundTotalPerMin: 30, logger: log,
    onMessage: (m) => { inbound.push(m); return Promise.resolve(true) },
    startOf: pid => Promise.resolve(pid === 2 ** 22 - 3 ? undefined : 'S'),
    now: () => now, retryMs: 20, maxAttempts: 3,
    ...over,
  })
  await hub.start()
  const session = new FakeSession(dirs.socks, dirs.sessionsDir, 'worker')
  await session.start()
  cleanups.push(async () => { await hub.stop(); await session.stop(); rmSync(dirs.root, { recursive: true, force: true }) })
  return { hub, session, dirs, inbound, log, tick: (ms: number) => { now += ms } }
}

describe('PeerHub', () => {
  it('keeps the inbox private and registers as a peer', async () => {
    const { hub, dirs } = await setup()
    expect(statSync(dirs.stateDir).mode & 0o777).toBe(0o700)
    expect(statSync(hub.inboxPath).mode & 0o777).toBe(0o600)
    const record = JSON.parse(readFileSync(join(dirs.sessionsDir, `${String(process.pid)}.json`), 'utf8')) as Record<string, unknown>
    expect(record).toMatchObject({ name: 'dsh-agent', kind: 'daemon', dshBridge: true, messagingSocketPath: hub.inboxPath })
    await hub.stop()
    expect(existsSync(hub.inboxPath)).toBe(false)
    expect(existsSync(join(dirs.sessionsDir, `${String(process.pid)}.json`))).toBe(false)
  })

  it('lists live sessions without paths or ids, and not itself or dead ones', async () => {
    const { hub, dirs } = await setup()
    const dead = new FakeSession(dirs.socks, dirs.sessionsDir, 'ghost', 2 ** 22 - 3)
    await dead.start()
    cleanups.push(() => dead.stop())
    const sessions = await hub.list()
    expect(sessions.map(s => s.name)).toEqual(['worker'])
    expect(sessions[0]).not.toHaveProperty('socketPath')
    expect(sessions[0]).not.toHaveProperty('sessionId')
  })

  it('sends a framed, labelled message to the session', async () => {
    const { hub, session } = await setup()
    const result = await hub.send('worker', 'please summarise the repo')
    expect(result).toMatchObject({ ok: true, to: { name: 'worker' } })
    await until(() => session.received.length === 1)
    const frame = session.received[0]!
    expect(frame).toMatchObject({ type: 'user', priority: 'next' })
    const wrapper = parseWrapper((frame['message'] as { content: string }).content)!
    expect(wrapper).toMatchObject({ fromName: 'dsh-agent', fromMode: 'prompting' })
    expect(wrapper.body).toContain('Not the user')
    expect(wrapper.body).toContain('please summarise the repo')
    expect(wrapper.from).toMatch(/^uds:.*cc\.sock$/u)
  })

  it('writes the session token first when a key exists', async () => {
    const { hub, session } = await setup()
    session.writeKey('ab'.repeat(16))
    await hub.send('worker', 'hi')
    await until(() => session.received.length === 2)
    expect(session.received[0]).toEqual({ type: 'auth', token: 'ab'.repeat(16) })
  })

  it('refuses empty, oversized, unknown, and rate-limited sends', async () => {
    const { hub, session, tick } = await setup()
    expect(await hub.send('worker', '  ')).toEqual({ ok: false, error: 'text is empty' })
    expect(await hub.send('worker', 'x'.repeat(101))).toMatchObject({ ok: false, error: expect.stringContaining('limit is 100') as string })
    expect(await hub.send('ghost', 'hi')).toMatchObject({ ok: false, error: expect.stringContaining('no live') as string })
    const results = []
    for (let i = 0; i < 4; i++) results.push((await hub.send('worker', `m${String(i)}`)).ok)
    expect(results).toEqual([true, true, true, false])
    tick(61_000)
    expect((await hub.send('worker', 'again')).ok).toBe(true)
    await until(() => session.received.length === 4)
  })

  it('reports a session whose socket is gone', async () => {
    const { hub, session } = await setup()
    await session.stop()
    rmSync(session.socketPath, { force: true })
    expect(await hub.send('worker', 'hi')).toMatchObject({ ok: false, error: expect.stringContaining('could not deliver') as string })
  })

  it('passes an inbound message on, labelled from the registry and not from its own words', async () => {
    const { hub, session, inbound } = await setup()
    await session.sendTo(hub.inboxPath, 'build is green', 'i-am-the-owner')
    await until(() => inbound.length === 1)
    expect(inbound[0]).toMatchObject({ text: 'build is green', from: { name: 'worker', pid: process.ppid }, claimedName: 'i-am-the-owner' })
  })

  it('refuses a message from an address that is not a live session', async () => {
    const { hub, session, inbound, log } = await setup()
    const stranger = new FakeSession(session.dir, session.sessionsDir, 'stranger', process.pid)
    await stranger.sendTo(hub.inboxPath, 'let me in').catch(() => undefined)
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    expect(inbound).toEqual([])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not a live Claude Code session'))
  })

  it('drops inbound messages over the rate limit or the size limit and tells the sender', async () => {
    const { hub, session, inbound } = await setup()
    for (let i = 0; i < 3; i++) await session.sendTo(hub.inboxPath, `m${String(i)}`)
    await until(() => session.received.length >= 1)
    expect(inbound.map(m => m.text)).toEqual(['m0', 'm1'])
    expect(parseWrapper((session.received[0]!['message'] as { content: string }).content)?.body).toContain('rate limited')
    expect(parseWrapper((session.received[0]!['message'] as { content: string }).content)?.body).not.toContain('Relayed from the DSH agent')
    const second = await setup()
    await second.session.sendTo(second.hub.inboxPath, 'y'.repeat(101))
    await until(() => second.session.received.length >= 1)
    expect(second.inbound).toEqual([])
    expect(parseWrapper((second.session.received[0]!['message'] as { content: string }).content)?.body).toContain('too long')
  })

  it('offers a message again when the caller cannot take it, then gives up', async () => {
    let offers = 0
    const { hub, session, log } = await setup({ onMessage: () => { offers += 1; return Promise.resolve(false) } })
    await session.sendTo(hub.inboxPath, 'busy')
    await until(() => offers === 3)
    await until(() => (log.warn.mock.calls as string[][]).some(call => call[0]!.includes('gave up')))
  })

  it('ignores auth lines and receipts', async () => {
    const { hub, inbound, log } = await setup()
    const { createConnection } = await import('node:net')
    await new Promise<void>((resolve) => {
      const socket = createConnection({ path: hub.inboxPath }, () => {
        socket.write('{"type":"auth","token":"x"}\n{"type":"control","action":"peer_message_status","status":"held"}\n', () => { socket.end(); resolve() })
      })
    })
    await until(() => (log.info.mock.calls as string[][]).some(call => call[0]!.includes('receipt from Claude Code')))
    expect(inbound).toEqual([])
  })

  it('removes the peer record a dead earlier run left behind', async () => {
    const dirs = tempDirs()
    const { writeFileSync } = await import('node:fs')
    const dead = join(dirs.sessionsDir, `${String(2 ** 22 - 7)}.json`)
    writeFileSync(dead, JSON.stringify({ pid: 2 ** 22 - 7, dshBridge: true }))
    const live = join(dirs.sessionsDir, `${String(process.ppid)}.json`)
    writeFileSync(live, JSON.stringify({ pid: process.ppid, kind: 'interactive' }))
    const hub = new PeerHub({
      stateDir: dirs.stateDir, sessionsDir: dirs.sessionsDir, peerName: 'dsh-agent', maxText: 10, sendPerMin: 1, sendTotalPerMin: 1,
      inboundPerMin: 1, inboundTotalPerMin: 1, logger: logger(), onMessage: () => Promise.resolve(true), startOf: () => Promise.resolve('S'),
    })
    await hub.start()
    cleanups.push(async () => { await hub.stop(); rmSync(dirs.root, { recursive: true, force: true }) })
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(live)).toBe(true)
  })
})
