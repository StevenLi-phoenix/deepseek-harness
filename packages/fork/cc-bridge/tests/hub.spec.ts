import { chmodSync, mkdirSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection, Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerHub, type HubOptions, type InboundMessage } from '../src/hub.ts'
import { LINE_LIMIT, encodeAddress, parseWrapper } from '../src/wire.ts'
import { FakeSession, tempDirs, until } from './helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
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

/** A hub that is not started, in fresh temp directories removed in teardown. */
function bareHub(over: Partial<HubOptions> = {}) {
  const dirs = tempDirs()
  const log = logger()
  const hub = new PeerHub({
    stateDir: dirs.stateDir, sessionsDir: dirs.sessionsDir, peerName: 'dsh-agent', maxText: 100,
    sendPerMin: 3, sendTotalPerMin: 20, inboundPerMin: 2, inboundTotalPerMin: 30, logger: log,
    onMessage: () => Promise.resolve(true), startOf: () => Promise.resolve('S'),
    ...over,
  })
  cleanups.push(async () => { await hub.stop(); rmSync(dirs.root, { recursive: true, force: true }) })
  return { hub, dirs, log }
}

const logged = (fn: ReturnType<typeof vi.fn>): string[] => (fn.mock.calls as string[][]).map(call => call[0]!)

/** Connect to the inbox, write `lines`, and close the connection. */
async function writeLines(inbox: string, ...lines: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: inbox })
    socket.once('error', reject)
    socket.once('connect', () => { socket.write(lines.map(line => `${line}\n`).join(''), () => { socket.end(); resolve() }) })
  })
}

const closed = (socket: Socket): Promise<void> => new Promise((resolve) => { socket.once('close', () => { resolve() }) })

describe('PeerHub start and stop', () => {
  it('refuses a state directory another user owns and leaves its mode alone', async () => {
    const { hub, dirs } = bareHub()
    mkdirSync(dirs.stateDir)
    chmodSync(dirs.stateDir, 0o755)
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
    await expect(hub.start()).rejects.toThrow(`${dirs.stateDir} is not owned by this user`)
    expect(statSync(dirs.stateDir).mode & 0o777).toBe(0o755)
  })

  it('stops cleanly when it never started', async () => {
    const { hub, log } = bareHub()
    await hub.stop()
    expect(logged(log.info)).toContain('cc-bridge: stopped ({"sent":0,"received":0,"droppedIn":0,"refusedOut":0})')
  })

  it('starts unlisted when its own start time cannot be read', async () => {
    const { hub, dirs, log } = bareHub({ startOf: () => Promise.resolve(undefined) })
    await hub.start()
    expect(existsSync(join(dirs.sessionsDir, `${String(process.pid)}.json`))).toBe(false)
    expect(logged(log.info)).toContain(`cc-bridge: inbox ${hub.inboxPath}; peer record not written`)
  })

  it('still listens when the sessions directory is unusable, and warns that ListAgents will not list it', async () => {
    const dirs = tempDirs()
    cleanups.push(() => { rmSync(dirs.root, { recursive: true, force: true }) })
    const sessionsDir = join(dirs.root, 'a-file')
    writeFileSync(sessionsDir, '')
    const { hub, log } = bareHub({ sessionsDir })
    await hub.start()
    expect(existsSync(hub.inboxPath)).toBe(true)
    expect(logged(log.warn)).toEqual([expect.stringContaining('peer record not written, ListAgents will not list "dsh-agent"')])
    expect(await hub.list()).toEqual([])
  })

  it('removes only the records of dead bridge runs', async () => {
    const { hub, dirs, log } = bareHub()
    const path = (name: string): string => join(dirs.sessionsDir, name)
    const dead = 2 ** 22 - 11
    const denied = 2 ** 22 - 13
    writeFileSync(path('notes.txt'), 'not a record')
    writeFileSync(path(`${String(2 ** 22 - 15)}.json`), '{ not json')
    writeFileSync(path(`${String(dead)}.json`), JSON.stringify({ dshBridge: true }))
    writeFileSync(path(`${String(denied)}.json`), JSON.stringify({ dshBridge: true }))
    writeFileSync(path(`${String(process.ppid)}.json`), JSON.stringify({ dshBridge: true }))
    const realKill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === denied) throw Object.assign(new Error('denied'), { code: 'EPERM' })
      return realKill(pid, signal)
    })
    await hub.start()
    expect(existsSync(path(`${String(dead)}.json`))).toBe(false)
    expect(existsSync(path(`${String(denied)}.json`))).toBe(true)
    expect(existsSync(path(`${String(process.ppid)}.json`))).toBe(true)
    expect(existsSync(path(`${String(2 ** 22 - 15)}.json`))).toBe(true)
    expect(existsSync(path('notes.txt'))).toBe(true)
    expect(logged(log.info).filter(line => line.includes('removed the peer record'))).toEqual([
      `cc-bridge: removed the peer record of a dead run: ${String(dead)}.json`,
    ])
  })
})

describe('PeerHub.send', () => {
  it('logs a long message as a flattened preview', async () => {
    const { hub, log } = await setup()
    await hub.send('worker', `first\n${'a'.repeat(80)}`)
    const expected = `"first ${'a'.repeat(54)}..."`
    expect(logged(log.info).find(line => line.includes('cc-bridge: send to worker'))).toContain(expected)
  })

  it('refuses a message that would not fit on one line of the peer protocol', async () => {
    const { hub, session } = await setup({ maxText: 2 * LINE_LIMIT })
    expect(await hub.send('worker', 'x'.repeat(LINE_LIMIT))).toEqual({
      ok: false, error: 'could not deliver to worker: message too large for cross-session delivery',
    })
    expect(hub.stats.refusedOut).toBe(1)
    expect(session.received).toEqual([])
  })

  it('reports a session that does not accept the connection in 5 seconds', async () => {
    const { hub } = await setup()
    const setTimeoutSpy = vi.spyOn(Socket.prototype, 'setTimeout').mockImplementation(function (this: Socket, _ms, callback) {
      callback?.()
      return this
    })
    expect(await hub.send('worker', 'hi')).toEqual({ ok: false, error: 'could not deliver to worker: timed out connecting to the session' })
    expect(setTimeoutSpy.mock.calls[0]![0]).toBe(5000)
  })

  it('reports a write that fails after the connection is up', async () => {
    const { hub, session } = await setup()
    vi.spyOn(Socket.prototype, 'write').mockImplementationOnce((...args: Parameters<Socket['write']>) => {
      const done = args.find((arg): arg is (error?: Error | null) => void => typeof arg === 'function')
      done?.(new Error('broken pipe'))
      return false
    })
    expect(await hub.send('worker', 'hi')).toEqual({ ok: false, error: 'could not deliver to worker: broken pipe' })
    expect(session.received).toEqual([])
  })

  it('forgets the rate limit of the oldest target past 256 targets', async () => {
    const { hub, dirs } = await setup({ sendPerMin: 1, sendTotalPerMin: 1000 })
    const recordPath = (pid: number): string => join(dirs.sessionsDir, `${String(pid)}.json`)
    const sendTo = async (pid: number) => {
      writeFileSync(recordPath(pid), JSON.stringify({
        pid, kind: 'interactive', procStart: 'S', name: `s-${String(pid)}`, messagingSocketPath: join(dirs.socks, 'nobody.sock'),
      }))
      const result = await hub.send(String(pid), 'hi')
      rmSync(recordPath(pid))
      return result
    }
    const oldest = 100_000
    expect(await sendTo(oldest)).toMatchObject({ error: expect.stringContaining('could not deliver') as string })
    expect(await sendTo(oldest)).toMatchObject({ error: expect.stringContaining('rate limit') as string })
    for (let i = 1; i <= 256; i++) await sendTo(oldest + i)
    expect(await sendTo(oldest)).toMatchObject({ error: expect.stringContaining('could not deliver') as string })
  })
})

describe('PeerHub inbox', () => {
  it('closes a connection that stays silent for 5 seconds', async () => {
    const { hub, log } = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const socket = createConnection({ path: hub.inboxPath })
    socket.on('error', () => { /* the inbox ends this connection */ })
    while (vi.getTimerCount() === 0) await new Promise((resolve) => { setImmediate(resolve) })
    const ended = closed(socket)
    vi.advanceTimersByTime(5000)
    await ended
    expect(logged(log.info)).toContain('cc-bridge: closed a silent inbox connection')
  })

  it('keeps a connection that has written something past the silence deadline', async () => {
    const { hub, log } = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const socket = createConnection({ path: hub.inboxPath })
    socket.on('error', () => { /* the test ends this connection */ })
    while (vi.getTimerCount() === 0) await new Promise((resolve) => { setImmediate(resolve) })
    socket.write('{"partial":')
    while (vi.getTimerCount() > 0) await new Promise((resolve) => { setImmediate(resolve) })
    vi.advanceTimersByTime(5000)
    expect(socket.destroyed).toBe(false)
    expect(logged(log.info)).not.toContain('cc-bridge: closed a silent inbox connection')
    socket.destroy()
    await closed(socket)
  })

  it('keeps working after a peer connection fails', async () => {
    const { hub, session, inbound, log } = await setup()
    const setEncoding = vi.spyOn(Socket.prototype, 'setEncoding')
    const client = createConnection({ path: hub.inboxPath })
    client.on('error', () => { /* the other end fails on purpose */ })
    await until(() => setEncoding.mock.calls.length === 1)
    const peer = setEncoding.mock.contexts[0] as Socket
    const gone = closed(peer)
    peer.destroy(new Error('peer vanished'))
    await gone
    expect(peer.errored?.message).toBe('peer vanished')
    expect(log.warn).not.toHaveBeenCalled()
    await session.sendTo(hub.inboxPath, 'still here')
    await until(() => inbound.length === 1)
    client.destroy()
  })

  it('drops a connection whose line grows past the protocol limit', async () => {
    const { hub, inbound, log } = await setup()
    const socket = createConnection({ path: hub.inboxPath })
    socket.on('error', () => { /* the inbox drops this connection while it writes */ })
    const ended = closed(socket)
    socket.write('x'.repeat(LINE_LIMIT + 1))
    await ended
    expect(logged(log.warn)).toEqual([`cc-bridge: inbox line over ${String(LINE_LIMIT)} characters, dropped the connection`])
    expect(inbound).toEqual([])
  })

  it('skips blank lines, and logs malformed lines and frames it does not know', async () => {
    const { hub, inbound, log } = await setup()
    await writeLines(hub.inboxPath, '   ', 'not json', '{"type":"mystery"}')
    await until(() => logged(log.info).includes('cc-bridge: ignored inbox frame type mystery'))
    expect(logged(log.warn)).toEqual(['cc-bridge: unparseable inbox line (8 chars)'])
    expect(inbound).toEqual([])
  })

  it('ignores a user frame without text content', async () => {
    const { hub, inbound, log } = await setup()
    await writeLines(hub.inboxPath, '{"type":"user"}', '{"type":"user","message":{"content":7}}', '{"type":"done"}')
    await until(() => logged(log.info).includes('cc-bridge: ignored inbox frame type done'))
    expect(log.warn).not.toHaveBeenCalled()
    expect(hub.stats).toMatchObject({ received: 0, droppedIn: 0 })
    expect(inbound).toEqual([])
  })

  it('logs why Claude Code held or dropped a message', async () => {
    const { hub, log } = await setup()
    await writeLines(
      hub.inboxPath,
      '{"type":"control","action":"a","status":"held","reason":"busy"}',
      '{"type":"control","action":"b","status":"dropped","drop_reason":"full"}',
      '{"type":"control","action":"c","status":"odd","reason":7}',
    )
    const receipts = () => logged(log.info).filter(line => line.includes('receipt from Claude Code'))
    await until(() => receipts().length === 3)
    expect(receipts()).toEqual([
      'cc-bridge: receipt from Claude Code: action=a status=held reason=busy',
      'cc-bridge: receipt from Claude Code: action=b status=dropped reason=full',
      'cc-bridge: receipt from Claude Code: action=c status=odd reason=',
    ])
  })

  it('attributes plain content to the frame\'s from address and passes it on whole', async () => {
    const { hub, session, inbound } = await setup()
    const from = encodeAddress(session.socketPath)
    await writeLines(hub.inboxPath, JSON.stringify({ type: 'user', message: { content: 'plain words' }, from }))
    await until(() => inbound.length === 1)
    expect(inbound[0]).toMatchObject({ text: 'plain words', from: { name: 'worker' }, claimedName: undefined })
  })

  it('takes the sender from the frame when the wrapper names none', async () => {
    const { hub, session, inbound } = await setup()
    const content = '<cross-session-message>\nwrapped words\n</cross-session-message>'
    await writeLines(hub.inboxPath, JSON.stringify({ type: 'user', message: { content }, from: encodeAddress(session.socketPath) }))
    await until(() => inbound.length === 1)
    expect(inbound[0]).toMatchObject({ text: 'wrapped words', from: { name: 'worker' } })
  })

  it('refuses a message with no usable sender address', async () => {
    const { hub, inbound, log } = await setup()
    const message = { content: 'anon' }
    const frames = [{ message }, { message, from: 7 }, { message, from: 'uds:%ZZ' }]
    await writeLines(hub.inboxPath, ...frames.map(frame => JSON.stringify({ type: 'user', ...frame })))
    await until(() => hub.stats.droppedIn === 3)
    const refusal = 'cc-bridge: refused a message from an unknown address, which is not a live Claude Code session of this account'
    expect(logged(log.warn)).toEqual([refusal, refusal, refusal])
    expect(inbound).toEqual([])
  })

  it('logs a caller failure that is not an Error and retries as usual', async () => {
    const onMessage = vi.fn<HubOptions['onMessage']>().mockRejectedValueOnce('chat offline').mockResolvedValue(true)
    const { hub, session, log } = await setup({ onMessage })
    await session.sendTo(hub.inboxPath, 'hello')
    await until(() => onMessage.mock.calls.length === 2)
    expect(logged(log.warn)).toEqual([expect.stringMatching(/taking message \S+ failed: chat offline$/u)])
  })

  it('tells a rate-limited session once a minute', async () => {
    const { hub, session, tick } = await setup()
    for (const text of ['m0', 'm1', 'm2']) await session.sendTo(hub.inboxPath, text)
    await until(() => session.received.length === 1)
    await session.sendTo(hub.inboxPath, 'm3')
    await until(() => hub.stats.droppedIn === 2)
    const body = (index: number): string | undefined =>
      parseWrapper((session.received[index]!['message'] as { content: string }).content)?.body
    await hub.send('worker', 'marker')
    await until(() => session.received.length >= 2)
    expect(session.received).toHaveLength(2)
    expect(body(0)).toContain('rate limited')
    expect(body(1)).toContain('marker')
    tick(61_000)
    for (const text of ['m4', 'm5', 'm6']) await session.sendTo(hub.inboxPath, text)
    await until(() => session.received.length === 3)
    expect(body(2)).toContain('rate limited')
  })

  it('logs a notice it could not deliver', async () => {
    const { hub, session, log } = await setup()
    await session.stop()
    rmSync(session.socketPath, { force: true })
    await session.sendTo(hub.inboxPath, 'y'.repeat(101))
    await until(() => logged(log.info).some(line => line.includes(`notice to pid ${String(session.pid)} failed`)))
    expect(hub.stats.droppedIn).toBe(1)
  })
})
