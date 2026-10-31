/** A stand-in for NapCat's OneBot v11 WebSocket server: checks the Bearer token, answers API calls, and pushes events. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

export type ApiHandler = (params: Record<string, unknown>) => unknown

export class FakeOneBot {
  readonly http: Server
  readonly wss: WebSocketServer
  /** API calls received, as [action, params]. */
  readonly calls: Array<[string, Record<string, unknown>]> = []
  /** Authorization headers of the connection attempts. */
  readonly authorizations: Array<string | undefined> = []
  /** How API actions answer; an action without a handler fails with retcode 1404. */
  readonly handlers = new Map<string, ApiHandler>()
  socket: WebSocket | undefined
  connections = 0

  constructor(private readonly token: string) {
    this.http = createServer()
    this.wss = new WebSocketServer({
      server: this.http,
      verifyClient: (info: { req: { headers: Record<string, string | string[] | undefined> } }) => {
        const header = info.req.headers['authorization']
        this.authorizations.push(typeof header === 'string' ? header : undefined)
        return header === `Bearer ${this.token}`
      },
    })
    this.wss.on('connection', (socket) => {
      this.socket = socket
      this.connections += 1
      socket.on('message', (raw) => {
        const request = JSON.parse(String(raw)) as { action: string; params: Record<string, unknown>; echo: string }
        this.calls.push([request.action, request.params])
        const handler = this.handlers.get(request.action)
        if (handler === undefined) {
          socket.send(JSON.stringify({ status: 'failed', retcode: 1404, wording: `no handler for ${request.action}`, echo: request.echo }))
          return
        }
        try {
          socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: handler(request.params), echo: request.echo }))
        } catch (error: unknown) {
          socket.send(JSON.stringify({ status: 'failed', retcode: 1200, wording: error instanceof Error ? error.message : 'failed', echo: request.echo }))
        }
      })
    })
  }

  get url(): string { return `ws://127.0.0.1:${(this.http.address() as AddressInfo).port}` }
  listen(): Promise<void> { return new Promise(resolve => this.http.listen(0, '127.0.0.1', resolve)) }
  close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate()
    return new Promise(resolve => this.wss.close(() => this.http.close(() => { resolve() })))
  }

  /** Push an event to the connected client. */
  push(event: Record<string, unknown>): void { this.socket?.send(JSON.stringify(event)) }
  /** Close the connection from the server side. */
  drop(): void { this.socket?.close() }
  callsOf(action: string): Array<Record<string, unknown>> {
    return this.calls.filter(([name]) => name === action).map(([, params]) => params)
  }
}

let counter = 1000

/** A group message event as NapCat reports it (array format). */
type Segments = Array<{ type: string; data: Record<string, unknown> }>

export function groupMessage(
  groupId: string, userId: string, segments: Segments | string, overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  counter += 1
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal', time: 1_790_000_000 + counter, self_id: 99999, group_id: Number(groupId), user_id: Number(userId),
    message_id: counter, message_seq: counter, sender: { user_id: Number(userId), nickname: `昵称${userId.slice(-2)}`, card: `名片${userId.slice(-2)}`, role: 'member' },
    message: typeof segments === 'string' ? [{ type: 'text', data: { text: segments } }] : segments,
    ...overrides,
  }
}
