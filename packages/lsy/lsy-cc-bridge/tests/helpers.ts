import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFrame, encodeAddress, keyPath, wrapMessage } from '../src/wire.ts'

/** A fake Claude Code session: a unix socket that records the JSON lines written to it, and its registry record. */
export class FakeSession {
  readonly received: Record<string, unknown>[] = []
  private server: Server | undefined

  constructor(readonly dir: string, readonly sessionsDir: string, readonly name: string, readonly pid = process.ppid) {}

  get socketPath(): string { return join(this.dir, `${this.name}.sock`) }

  async start(extra: Record<string, unknown> = {}): Promise<void> {
    this.server = createServer((socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffer += chunk
        for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
          this.received.push(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>)
          buffer = buffer.slice(nl + 1)
        }
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => { this.server!.listen(this.socketPath, resolve) })
    writeFileSync(join(this.sessionsDir, `${String(this.pid)}.json`), JSON.stringify({
      pid: this.pid, sessionId: `aaaaaaaa-1111-2222-3333-${String(this.pid).padStart(12, '0')}`, cwd: '/work/app', kind: 'interactive',
      status: 'idle', name: this.name, procStart: 'S', messagingSocketPath: this.socketPath, updatedAt: Date.now() - 5000, ...extra,
    }))
  }

  writeKey(token: string): void {
    writeFileSync(keyPath(this.sessionsDir, this.pid, this.socketPath), JSON.stringify({ peerToken: token }))
  }

  /** What this session would write to the agent's inbox, as Claude Code's SendMessage does. */
  async sendTo(inbox: string, text: string, claimedName = this.name): Promise<void> {
    const from = encodeAddress(this.socketPath)
    const frame = { ...buildFrame('x', from, claimedName), message: { role: 'user', content: wrapMessage(text, from, claimedName) } }
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ path: inbox })
      socket.once('error', reject)
      socket.once('connect', () => { socket.write(`${JSON.stringify(frame)}\n`, () => { setTimeout(() => { socket.end(); resolve() }, 20) }) })
    })
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => { if (this.server?.listening === true) this.server.close(() => { resolve() }); else resolve() })
  }
}

export function tempDirs(): { root: string; stateDir: string; sessionsDir: string; socks: string } {
  const root = mkdtempSync(join(tmpdir(), 'ccb-'))
  const stateDir = join(root, 'state')
  const sessionsDir = join(root, 'sessions')
  const socks = join(root, 'socks')
  mkdirSync(sessionsDir)
  mkdirSync(socks)
  return { root, stateDir, sessionsDir, socks }
}

export async function until(predicate: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}
