import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionView } from '../src/client.ts'

/** A stand-in for the dsh-cc-bridge relay: it answers hello, list, send, and ack, and can push events. */
export class FakeRelay {
  readonly dir = mkdtempSync(join(tmpdir(), 'ccb-'))
  readonly path = join(this.dir, 'dsh.sock')
  readonly requests: Record<string, unknown>[] = []
  sessions: SessionView[] = []
  /** Events replayed to every new connection until acknowledged, like the real relay's pending queue. */
  pending: Record<string, unknown>[] = []
  sendError: string | undefined
  helloError: string | undefined
  /** Ops that get no answer at all. */
  readonly silent = new Set<string>()
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket)
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => {})
      socket.on('data', (chunk: string) => {
        buffer += chunk
        for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          this.handle(socket, JSON.parse(line) as Record<string, unknown>)
        }
      })
    })
    await new Promise<void>((resolve) => { this.server!.listen(this.path, resolve) })
  }

  private handle(socket: Socket, request: Record<string, unknown>): void {
    this.requests.push(request)
    if (this.silent.has(request['op'] as string)) return
    const reply = (body: Record<string, unknown>): void => { socket.write(`${JSON.stringify({ ...body, id: request['id'] })}\n`) }
    switch (request['op']) {
      case 'hello':
        if (this.helloError !== undefined) {
          reply({ ok: false, error: this.helloError })
          return
        }
        for (const event of this.pending) socket.write(`${JSON.stringify(event)}\n`)
        reply({ ok: true, version: 'test', pending: this.pending.length })
        return
      case 'list':
        reply({ ok: true, sessions: this.sessions })
        return
      case 'send':
        if (this.sendError !== undefined) {
          reply({ ok: false, error: this.sendError })
          return
        }
        reply({ ok: true, to: this.sessions.find(session => session.name === request['to']) ?? { name: String(request['to']), pid: 1 }, msg_id: 'm1' })
        return
      case 'ack': {
        const ids = new Set(request['ids'] as string[])
        this.pending = this.pending.filter(event => !ids.has(event['id'] as string))
        reply({ ok: true, pending: this.pending.length })
        return
      }
      default:
        reply({ ok: false, error: 'unknown op' })
    }
  }

  push(event: Record<string, unknown>): void {
    for (const socket of this.sockets) socket.write(`${JSON.stringify(event)}\n`)
  }

  dropClients(): void {
    for (const socket of this.sockets) socket.destroy()
  }

  async stop(): Promise<void> {
    this.dropClients()
    const server = this.server
    if (server?.listening === true) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/** Poll until `predicate` holds. */
export async function until(predicate: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

export const message = (id: string, text: string, name = 'worker'): Record<string, unknown> => ({
  event: 'message', id, at: Date.now(), from: { name, pid: 42, cwd: '/work/app' }, text,
})
