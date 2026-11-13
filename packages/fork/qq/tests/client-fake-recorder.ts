/** A scripted qq-recorder on a unix socket, for the client specs: every request is recorded, every route can be replaced. */
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_HEADER } from '../src/protocol.ts'

export type Route = (req: IncomingMessage, res: ServerResponse, body: string) => void

export interface Seen { method: string; path: string; query: string; auth: string | undefined; protocol: string | undefined; body: string }

/** @returns a frozen sample of the protocol, as JSON. */
export function fixture(version: 'v1.0' | 'v1.1', name: string): unknown {
  const raw: unknown = JSON.parse(readFileSync(join(import.meta.dirname, 'protocol-fixtures', version, `${name}.json`), 'utf8'))
  return raw
}

/** Answer with JSON and the protocol tag. */
export function json(res: ServerResponse, status: number, body: unknown, tag: string | null = 'qq-recorder/1.1'): void {
  res.writeHead(status, { 'content-type': 'application/json', ...tag === null ? {} : { [PROTOCOL_HEADER]: tag } })
  res.end(JSON.stringify(body))
}

export class FakeRecorder {
  readonly dir = mkdtempSync(join(tmpdir(), 'qqc-'))
  readonly socketPath = join(this.dir, 's.sock')
  readonly seen: Seen[] = []
  /** Open event streams. */
  readonly streams: ServerResponse[] = []
  hello: unknown = fixture('v1.1', 'hello')
  status: unknown = fixture('v1.0', 'status')
  private readonly routes = new Map<string, Route>()
  private readonly server: Server

  constructor() {
    this.routes.set('GET /v1/hello', (_req, res) => { json(res, 200, this.hello) })
    this.routes.set('GET /v1/status', (_req, res) => { json(res, 200, this.status) })
    this.routes.set('PUT /v1/config', (_req, res, body) => {
      json(res, 200, { revision: (JSON.parse(body) as { revision: string }).revision, reconnect: false })
    })
    this.routes.set('GET /v1/events', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', [PROTOCOL_HEADER]: 'qq-recorder/1.1' })
      res.write('\n')
      this.streams.push(res)
    })
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://recorder')
        const body = Buffer.concat(chunks).toString('utf8')
        this.seen.push({
          method: req.method ?? '', path: url.pathname, query: url.search, auth: req.headers.authorization,
          protocol: req.headers[PROTOCOL_HEADER] as string | undefined, body,
        })
        const route = this.routes.get(`${req.method ?? ''} ${url.pathname}`)
        if (route === undefined) json(res, 404, { error: { code: 'not-found', message: 'no such route' } })
        else route(req, res, body)
      })
    })
  }

  /** Replace the answer of `METHOD /path`. */
  route(key: string, handler: Route): void { this.routes.set(key, handler) }

  /** Requests to a path so far. */
  count(path: string): number { return this.seen.filter(entry => entry.path === path).length }

  /** Write raw text to every open event stream. */
  emit(text: string): void { for (const stream of this.streams) stream.write(text) }

  listen(): Promise<void> { return new Promise((resolve) => { this.server.listen(this.socketPath, resolve) }) }

  /** Remove the socket file while the server keeps running: later connections fail with ENOENT. */
  unlinkSocket(): void { unlinkSync(this.socketPath) }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    if (this.server.listening) await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    rmSync(this.dir, { recursive: true, force: true })
  }
}
