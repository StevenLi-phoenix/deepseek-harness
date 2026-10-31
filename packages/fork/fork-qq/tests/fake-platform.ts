import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

/** A local stand-in for the QQ Open Platform: token endpoint, gateway URL, gateway WebSocket, message API. */
export class FakeOpenPlatform {
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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
