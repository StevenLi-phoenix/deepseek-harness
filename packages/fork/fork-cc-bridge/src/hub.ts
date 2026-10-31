/**
 * The agent's end of Claude Code's peer messaging, inside the DSH process. The Claude Code sessions run
 * under the same account (`dsh-runtime`), so their 0600 sockets are reachable directly; filesystem
 * permissions are the boundary and no second process or account is involved.
 *
 *   - Outbound: write a frame to a session's socket (`send`), after checking the recipient is a live
 *     session of this account and the rate and size limits allow it.
 *   - Inbound: listen on one socket (0600, in a 0700 directory) that Claude Code's `SendMessage` can
 *     address, and register as the peer `dsh-agent` so `ListAgents` lists it. A message is attributed to
 *     the session whose registry record owns the `from` socket, never to the name it gives itself.
 *
 * Node cannot read the peer pid of a connection, so the attribution relies on the account boundary: any
 * process of this account could claim to be a session, and the account is the agent's own.
 */

import { mkdir, chmod, rename, stat, unlink, writeFile, readdir, readFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Registry, processStart, publicView, type SessionRecord, type SessionView, type StartOf } from './registry.ts'
import { LINE_LIMIT, addressPath, buildFrame, encodeAddress, parseWrapper, readPeerToken } from './wire.ts'

export interface HubLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
}

/** A message a Claude Code session sent. */
export interface InboundMessage {
  id: string
  at: number
  from: SessionView
  text: string
  /** The name the message gives itself, kept apart because the sender wrote it. */
  claimedName: string | undefined
}

export interface HubOptions {
  /** Directory for the inbox socket; created 0700. */
  stateDir: string
  /** Claude Code's session registry of this account. */
  sessionsDir: string
  peerName: string
  maxText: number
  /** Sends per minute to one session, and in total. */
  sendPerMin: number
  sendTotalPerMin: number
  /** Messages per minute from one session, and in total. */
  inboundPerMin: number
  inboundTotalPerMin: number
  logger: HubLogger
  /** Take one inbound message; false means "not now", and it is offered again later. */
  onMessage(message: InboundMessage): Promise<boolean>
  startOf?: StartOf
  now?: () => number
  /** Pause before a message the caller could not take is offered again, and how many offers it gets. */
  retryMs?: number
  maxAttempts?: number
}

export type SendResult = { ok: true; to: SessionView; msgId: string } | { ok: false; error: string }

/** `capacity` events at once, refilled evenly over a minute. */
class Bucket {
  private tokens: number
  private at: number
  constructor(private readonly capacity: number, private readonly now: () => number) {
    this.tokens = capacity
    this.at = now()
  }

  take(): boolean {
    const t = this.now()
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.at) * (this.capacity / 60_000))
    this.at = t
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

/** One bucket per key, the oldest dropped past `max` keys. */
class Keyed {
  private readonly buckets = new Map<string, Bucket>()
  constructor(private readonly capacity: number, private readonly now: () => number, private readonly max = 256) {}

  take(key: string): boolean {
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      if (this.buckets.size >= this.max) this.buckets.delete(this.buckets.keys().next().value as string)
      bucket = new Bucket(this.capacity, this.now)
      this.buckets.set(key, bucket)
    }
    return bucket.take()
  }
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const preview = (text: string, n = 60): string => {
  const flat = text.split(/\s+/u).filter(Boolean).join(' ')
  return flat.length <= n ? flat : `${flat.slice(0, n)}...`
}

export class PeerHub {
  readonly registry: Registry
  readonly inboxPath: string
  private server: Server | undefined
  private peerRecord: string | undefined
  private readonly now: () => number
  private readonly startOf: StartOf
  private readonly sendByTarget: Keyed
  private readonly sendTotal: Bucket
  private readonly inBySender: Keyed
  private readonly inTotal: Bucket
  private readonly notices: Keyed
  private readonly attempts = new Map<string, number>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private stopped = false
  readonly stats = { sent: 0, received: 0, droppedIn: 0, refusedOut: 0 }

  constructor(private readonly o: HubOptions) {
    this.now = o.now ?? Date.now
    this.startOf = o.startOf ?? processStart
    this.registry = new Registry(o.sessionsDir, process.pid, this.startOf, 15_000, this.now)
    this.inboxPath = join(o.stateDir, 'cc.sock')
    this.sendByTarget = new Keyed(o.sendPerMin, this.now)
    this.sendTotal = new Bucket(o.sendTotalPerMin, this.now)
    this.inBySender = new Keyed(o.inboundPerMin, this.now)
    this.inTotal = new Bucket(o.inboundTotalPerMin, this.now)
    this.notices = new Keyed(1, this.now)
  }

  async start(): Promise<void> {
    this.stopped = false
    await mkdir(this.o.stateDir, { recursive: true, mode: 0o700 })
    const info = await stat(this.o.stateDir)
    if (info.uid !== process.getuid?.()) throw new Error(`${this.o.stateDir} is not owned by this user`)
    await chmod(this.o.stateDir, 0o700)
    await unlink(this.inboxPath).catch(() => undefined)
    const server = createServer((socket) => { this.onConnection(socket) })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.inboxPath, () => { server.off('error', reject); resolve() })
    })
    await chmod(this.inboxPath, 0o600)
    await this.sweepPeerRecords()
    await this.writePeerRecord()
    this.o.logger.info(`cc-bridge: inbox ${this.inboxPath}; peer record ${this.peerRecord ?? 'not written'}`)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    const server = this.server
    await new Promise<void>((resolve) => {
      if (server === undefined) resolve()
      else server.close(() => { resolve() })
    })
    for (const path of [this.inboxPath, this.peerRecord]) if (path !== undefined) await unlink(path).catch(() => undefined)
    this.peerRecord = undefined
    this.o.logger.info(`cc-bridge: stopped (${JSON.stringify(this.stats)})`)
  }

  // ── registry presence ────────────────────────────────────────────────────

  private async writePeerRecord(): Promise<void> {
    const start = await this.startOf(process.pid)
    if (start === undefined) return
    const stamp = this.now()
    const path = join(this.o.sessionsDir, `${String(process.pid)}.json`)
    const record = {
      pid: process.pid, sessionId: randomUUID(), cwd: '/', startedAt: stamp, procStart: start, peerProtocol: 1, peerFeatures: [],
      kind: 'daemon', entrypoint: 'dsh-cc-bridge', pidDomain: 'darwin', messagingSocketPath: this.inboxPath,
      name: this.o.peerName, nameSource: 'user', nameSince: stamp, status: 'idle', updatedAt: stamp, statusUpdatedAt: stamp, dshBridge: true,
    }
    try {
      await mkdir(this.o.sessionsDir, { recursive: true, mode: 0o700 })
      await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o644 })
      await rename(`${path}.tmp`, path)
      this.peerRecord = path
    } catch (error: unknown) {
      this.o.logger.warn(`cc-bridge: peer record not written, ListAgents will not list "${this.o.peerName}": ${errorText(error)}`)
    }
  }

  /** Remove records an earlier run of this plugin left behind (its process is gone). */
  private async sweepPeerRecords(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.o.sessionsDir)
    } catch {
      return
    }
    for (const name of names) {
      const m = /^(\d+)\.json$/u.exec(name)
      if (m === null || Number(m[1]) === process.pid) continue
      const path = join(this.o.sessionsDir, name)
      try {
        const rec = JSON.parse(await readFile(path, 'utf8')) as { dshBridge?: unknown }
        if (rec.dshBridge !== true) continue
        try {
          process.kill(Number(m[1]), 0)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
          await unlink(path)
          this.o.logger.info(`cc-bridge: removed the peer record of a dead run: ${name}`)
        }
      } catch {
        // unreadable or not ours: leave it
      }
    }
  }

  // ── listing and sending ──────────────────────────────────────────────────

  async list(): Promise<SessionView[]> {
    return (await this.registry.sessions(true)).map(publicView)
  }

  /**
   * Hand one message to a session's inbox.
   * @param selector - session name, pid, or session id prefix.
   * @param text - the message; the recipient sees it labelled as coming from the agent, not the user.
   */
  async send(selector: string, text: string): Promise<SendResult> {
    if (text.trim() === '') return { ok: false, error: 'text is empty' }
    if (text.length > this.o.maxText) return { ok: false, error: `text is ${String(text.length)} characters; the limit is ${String(this.o.maxText)}` }
    const found = await this.registry.resolve(selector)
    if ('error' in found) return { ok: false, error: found.error }
    const rec = found.session
    if (!this.sendTotal.take() || !this.sendByTarget.take(String(rec.pid))) {
      this.stats.refusedOut += 1
      this.o.logger.warn(`cc-bridge: send rate limit for ${rec.name} (pid ${String(rec.pid)})`)
      return { ok: false, error: `rate limit: too many messages to ${rec.name} just now; batch them into one and wait a minute` }
    }
    try {
      const header = 'Relayed from the DSH agent (the always-on agent on this Mac). Not the user; answer with SendMessage to this sender if a reply is wanted.\n\n'
      const msgId = await this.deliver(rec, `${header}${text}`)
      this.stats.sent += 1
      this.o.logger.info(`cc-bridge: send to ${rec.name} (pid ${String(rec.pid)}): ${String(text.length)} chars "${preview(text)}" msg ${msgId.slice(0, 8)}`)
      return { ok: true, to: publicView(rec), msgId }
    } catch (error: unknown) {
      this.stats.refusedOut += 1
      this.o.logger.warn(`cc-bridge: send to ${rec.name} (pid ${String(rec.pid)}) failed: ${errorText(error)}`)
      return { ok: false, error: `could not deliver to ${rec.name}: ${errorText(error)}` }
    }
  }

  private async deliver(rec: SessionRecord, text: string): Promise<string> {
    const token = await readPeerToken(this.o.sessionsDir, rec.pid, rec.socketPath)
    const frame = buildFrame(text, encodeAddress(this.inboxPath), this.o.peerName)
    const payload = `${token === undefined ? '' : `${JSON.stringify({ type: 'auth', token })}\n`}${JSON.stringify(frame)}\n`
    if (payload.length > LINE_LIMIT) throw new Error('message too large for cross-session delivery')
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ path: rec.socketPath })
      const fail = (error: Error): void => { socket.destroy(); reject(error) }
      socket.setTimeout(5000, () => { fail(new Error('timed out connecting to the session')) })
      socket.once('error', fail)
      socket.once('connect', () => {
        socket.write(payload, (error) => {
          if (error !== undefined && error !== null) { fail(error); return }
          // Claude Code's own senders linger before closing on macOS: the receiver reads the peer at accept time.
          setTimeout(() => { socket.end(); resolve() }, 150)
        })
      })
    })
    return frame['msg_id'] as string
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private onConnection(socket: Socket): void {
    socket.setEncoding('utf8')
    let buffer = ''
    const deadline = setTimeout(() => { this.o.logger.info('cc-bridge: closed a silent inbox connection'); socket.destroy() }, 5000)
    deadline.unref()
    socket.on('close', () => { clearTimeout(deadline) })
    socket.on('error', () => { /* a peer that vanishes mid-line is not news */ })
    socket.on('data', (chunk: string) => {
      clearTimeout(deadline)
      buffer += chunk
      if (buffer.length > LINE_LIMIT) {
        this.o.logger.warn(`cc-bridge: inbox line over ${String(LINE_LIMIT)} characters, dropped the connection`)
        socket.destroy()
        return
      }
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim() !== '') void this.onLine(line)
      }
    })
  }

  private async onLine(line: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.o.logger.warn(`cc-bridge: unparseable inbox line (${String(line.length)} chars)`)
      return
    }
    const type = frame['type']
    if (type === 'auth') return // the account boundary is the check; no key is published for this inbox
    if (type === 'control') {
      const reason = frame['reason'] ?? frame['drop_reason']
      this.o.logger.info(`cc-bridge: receipt from Claude Code: action=${String(frame['action'])} status=${String(frame['status'])} reason=${typeof reason === 'string' ? reason : ''}`)
      return
    }
    if (type !== 'user') {
      this.o.logger.info(`cc-bridge: ignored inbox frame type ${String(type)}`)
      return
    }
    const content = (frame['message'] as { content?: unknown } | undefined)?.content
    if (typeof content !== 'string') return
    const wrapper = parseWrapper(content)
    const fromPath = addressPath(wrapper?.from ?? (typeof frame['from'] === 'string' ? frame['from'] : ''))
    const rec = fromPath === undefined ? undefined : await this.registry.bySocket(fromPath)
    if (rec === undefined) {
      this.stats.droppedIn += 1
      this.o.logger.warn(`cc-bridge: refused a message from ${fromPath ?? 'an unknown address'}, which is not a live Claude Code session of this account`)
      return
    }
    const body = wrapper?.body ?? content
    const label = publicView(rec)
    if (!this.inTotal.take() || !this.inBySender.take(String(rec.pid))) {
      this.stats.droppedIn += 1
      this.o.logger.warn(`cc-bridge: rate limit, dropped a ${String(body.length)}-char message from ${rec.name} (pid ${String(rec.pid)})`)
      await this.notice(rec, 'rate limited: too many messages to DSH just now; wait a minute and send one combined message')
      return
    }
    if (body.length > this.o.maxText) {
      this.stats.droppedIn += 1
      this.o.logger.warn(`cc-bridge: dropped a ${String(body.length)}-char message from ${rec.name} (limit ${String(this.o.maxText)})`)
      await this.notice(rec, `too long: ${String(body.length)} characters, the limit is ${String(this.o.maxText)}; send a shorter message`)
      return
    }
    const message: InboundMessage = { id: randomUUID(), at: this.now(), from: label, text: body, claimedName: wrapper?.fromName }
    this.stats.received += 1
    this.o.logger.info(`cc-bridge: message ${message.id.slice(0, 8)} from ${rec.name} (pid ${String(rec.pid)}): ${String(body.length)} chars "${preview(body)}"`)
    await this.offer(message)
  }

  /** Offer a message to the caller; one it cannot take yet is offered again after a pause, a few times. */
  private async offer(message: InboundMessage): Promise<void> {
    let taken = false
    try {
      taken = await this.o.onMessage(message)
    } catch (error: unknown) {
      this.o.logger.warn(`cc-bridge: taking message ${message.id.slice(0, 8)} failed: ${errorText(error)}`)
    }
    if (taken || this.stopped) {
      this.attempts.delete(message.id)
      return
    }
    const tries = (this.attempts.get(message.id) ?? 0) + 1
    this.attempts.set(message.id, tries)
    if (tries >= (this.o.maxAttempts ?? 5)) {
      this.attempts.delete(message.id)
      this.o.logger.warn(`cc-bridge: gave up on message ${message.id.slice(0, 8)} from ${message.from.name} after ${String(tries)} attempts`)
      return
    }
    const timer = setTimeout(() => { this.timers.delete(timer); void this.offer(message) }, this.o.retryMs ?? 30_000)
    timer.unref()
    this.timers.add(timer)
  }

  /** Tell a session why its message was not passed on; at most one notice a minute per session. */
  private async notice(rec: SessionRecord, text: string): Promise<void> {
    if (!this.notices.take(String(rec.pid))) return
    try {
      await this.deliver(rec, `[dsh-cc-bridge] ${text}`)
    } catch (error: unknown) {
      this.o.logger.info(`cc-bridge: notice to pid ${String(rec.pid)} failed: ${errorText(error)}`)
    }
  }
}
