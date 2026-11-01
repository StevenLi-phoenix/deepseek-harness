/**
 * The qq-recorder's API: HTTP/1.1 and JSON on a unix socket (mode 0600, in a 0700 directory), a bearer token on every
 * request, and the DTOs of {@link ./protocol.ts} parsed on the way in and checked on the way out. A second listener on
 * 127.0.0.1 answers only `GET /healthz` for AMS's probe: no data, no token, and no statement about QQ being online.
 */

import { timingSafeEqual, createHash } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { z, ZodError } from 'zod'
import {
  ConfigAppliedDto, ErrorDto, EventDto, GroupDto, HelloDto, LegacyDigestStateDto, LoginDto, LookupRequestDto, MembersDto,
  MessageListDto, MessagePageDto, PATHS, PROTOCOL, PROTOCOL_HEADER, RecorderConfigDto, RefreshDto, SearchRequestDto, StatusDto,
  parseProtocolTag, protocolTag,
} from './protocol.ts'
import { ConfigRejected, type QqRecorder, type RecorderLogger } from './recorder.ts'

/** Longest request body accepted, in bytes. */
const MAX_BODY_BYTES = 256 * 1024
/** Heartbeat of the event stream. */
const PING_MS = 15_000

/** Options of {@link startRecorderServer}. */
export interface RecorderServerOptions {
  recorder: QqRecorder
  logger: RecorderLogger
  socketPath: string
  /** Bearer token every request must carry. */
  token: string
  /** Port of the `/healthz` listener on 127.0.0.1; 0 picks a free one; undefined opens none. */
  healthPort?: number
  /** Fingerprint of the build, reported by `hello`. */
  build?: string
  /** Heartbeat period of the event stream; tests shorten it. */
  pingMs?: number
  /** The minor version this server announces; tests lower it to play an older recorder. */
  protocolMinor?: number
  /** The major version this server announces; tests raise it to play a recorder from the future. */
  protocolMajor?: number
}

/** A running API server. */
export interface RecorderServer {
  readonly socketPath: string
  /** The port of the health listener, when there is one. */
  readonly healthPort: number | undefined
  /** How many event streams are open. */
  streamCount(): number
  /** Stop accepting, end the event streams, and wait for requests in flight. */
  close(): Promise<void>
}

/** What a handler returns once it has answered. */
type Handled = true

/** Failure with an HTTP status and a stable code. */
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

/** Whether something already listens on a unix socket. */
function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { resolve(false) })
  })
}

function listen(server: Server, ...args: [string] | [number, string]): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => { reject(error) }
    server.once('error', failed)
    server.listen(...args as [string], () => { server.off('error', failed); resolve() })
  })
}

/**
 * Start the API.
 * @param options - the recorder it fronts, where it listens, and the token.
 * @returns the running server.
 * @throws when another recorder already listens on the socket.
 */
export async function startRecorderServer(options: RecorderServerOptions): Promise<RecorderServer> {
  const { recorder, logger, socketPath } = options
  const minor = options.protocolMinor ?? PROTOCOL.minor
  const major = options.protocolMajor ?? PROTOCOL.major
  const expected = digest(options.token)
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  chmodSync(dirname(socketPath), 0o700)
  if (await isLive(socketPath)) throw new Error(`another process already listens on ${socketPath}`)
  rmSync(socketPath, { force: true })

  const streams = new Set<ServerResponse>()
  const active = new Set<Promise<void>>()

  const send = <T extends z.ZodType>(res: ServerResponse, status: number, schema: T, value: z.input<T>): Handled => {
    // The recorder's own answers are checked too: a drift between the schema and the code fails here, not in DSH.
    let body: string
    try {
      body = JSON.stringify(schema.parse(value))
    } catch (error: unknown) {
      logger.error(`qq-recorder: an answer did not match its schema: ${error instanceof ZodError ? error.issues[0]?.path.join('.') ?? '' : String(error)}`)
      sendError(res, 500, 'internal', 'the answer did not match its schema')
      return true
    }
    res.writeHead(status, { 'content-type': 'application/json', [PROTOCOL_HEADER]: protocolTag({ major, minor }), 'cache-control': 'no-store' })
    res.end(body)
    return true
  }
  const sendError = (res: ServerResponse, status: number, code: string, message: string): void => {
    if (res.headersSent) { res.end(); return }
    res.writeHead(status, { 'content-type': 'application/json', [PROTOCOL_HEADER]: protocolTag({ major, minor }), 'cache-control': 'no-store' })
    res.end(JSON.stringify(ErrorDto.parse({ error: { code, message } })))
  }

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too-large', `the body is larger than ${MAX_BODY_BYTES} bytes`)
      chunks.push(chunk)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new HttpError(400, 'invalid-json', 'the body is not JSON')
    }
  }

  const query = <T extends z.ZodType>(url: URL, schema: T): z.output<T> => schema.parse(Object.fromEntries(url.searchParams))

  const GroupQuery = z.object({ groupId: z.string().regex(/^[0-9]{3,20}$/) })
  const ListQuery = GroupQuery.extend({
    sinceMs: z.coerce.number().int().nonnegative(),
    limit: z.coerce.number().int().min(1).max(1000),
    userId: z.string().regex(/^[0-9]{1,30}$/).optional(),
  })
  const PageQuery = GroupQuery.extend({ after: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(5000) })
  const LoginQuery = z.object({ fresh: z.enum(['1', '0']).optional() })

  const events = (req: IncomingMessage, res: ServerResponse): Handled => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', [PROTOCOL_HEADER]: protocolTag({ major, minor }), 'cache-control': 'no-store' })
    streams.add(res)
    const write = (event: z.input<typeof EventDto>): void => {
      if (res.writableEnded) return
      res.write(`${JSON.stringify(EventDto.parse(event))}\n`)
    }
    write({ type: 'status', status: recorder.status() })
    const off = recorder.subscribe(write)
    const timer = setInterval(() => { write({ type: 'ping', at: Date.now() }) }, options.pingMs ?? PING_MS)
    timer.unref()
    const done = (): void => { clearInterval(timer); off(); streams.delete(res) }
    req.on('close', done)
    res.on('close', done)
    return true
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<Handled> => {
    const url = new URL(req.url ?? '/', 'http://recorder')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const supplied = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (supplied === undefined || !timingSafeEqual(digest(supplied), expected)) throw new HttpError(401, 'unauthorized', 'a valid bearer token is required')
    const client = parseProtocolTag(req.headers[PROTOCOL_HEADER] as string | undefined)
    if (req.headers[PROTOCOL_HEADER] !== undefined && (client === undefined || client.major !== major)) {
      throw new HttpError(426, 'protocol-mismatch', `this recorder speaks ${protocolTag({ major, minor })}`)
    }
    const only = (allowed: string): void => {
      if (method !== allowed) throw new HttpError(405, 'method-not-allowed', `${path} takes ${allowed}`)
    }

    if (path === PATHS.hello) {
      only('GET')
      return send(res, 200, HelloDto, { protocol: { name: PROTOCOL.name, major, minor }, build: options.build ?? 'dev', startedAt: recorder.startedAt })
    }
    if (path === PATHS.status) {
      only('GET')
      return send(res, 200, StatusDto, recorder.status())
    }
    if (path === PATHS.events) {
      only('GET')
      return events(req, res)
    }
    if (path === PATHS.groups) {
      only('GET')
      return send(res, 200, GroupDto.array(), recorder.groups())
    }
    if (path === PATHS.messages) {
      only('GET')
      if (url.searchParams.has('sinceMs')) {
        const q = query(url, ListQuery)
        return send(res, 200, MessageListDto,
          recorder.recent(q.groupId, { sinceMs: q.sinceMs, limit: q.limit, ...q.userId === undefined ? {} : { userId: q.userId } }))
      }
      const q = query(url, PageQuery)
      try {
        return send(res, 200, MessagePageDto, recorder.page(q.groupId, q.after, q.limit))
      } catch (error: unknown) {
        if (error instanceof RangeError) throw new HttpError(400, 'invalid-cursor', error.message)
        throw error
      }
    }
    if (path === PATHS.search) {
      only('POST')
      const body = SearchRequestDto.parse(await readBody(req))
      return send(res, 200, MessageListDto,
        recorder.search(body.query, { ...body.groupId === undefined ? {} : { groupId: body.groupId }, limit: body.limit }))
    }
    if (path === PATHS.lookup) {
      only('POST')
      const body = LookupRequestDto.parse(await readBody(req))
      return send(res, 200, MessageListDto, recorder.lookup(body.groupId, body.messageIds))
    }
    const members = /^\/v1\/groups\/([0-9]{3,20})\/members$/.exec(path)
    if (members !== null) {
      only('GET')
      return send(res, 200, MembersDto, recorder.members(members[1] ?? ''))
    }
    if (path === PATHS.config) {
      only('PUT')
      const body = RecorderConfigDto.parse(await readBody(req))
      try {
        return send(res, 200, ConfigAppliedDto, recorder.applyConfig(body))
      } catch (error: unknown) {
        if (error instanceof ConfigRejected) throw new HttpError(422, 'config-rejected', error.message)
        throw error
      }
    }
    if (path === PATHS.login) {
      only('GET')
      const q = query(url, LoginQuery)
      return send(res, 200, LoginDto, await recorder.loginStatus({ fresh: q.fresh === '1' }))
    }
    if (path === PATHS.loginRefresh) {
      only('POST')
      return send(res, 200, RefreshDto, await recorder.refreshLogin())
    }
    if (path === PATHS.legacy) {
      only('GET')
      return send(res, 200, LegacyDigestStateDto, recorder.legacyState())
    }
    throw new HttpError(404, 'not-found', `no such path ${path}`)
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const work = route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return sendError(res, error.status, error.code, error.message)
      if (error instanceof ZodError) return sendError(res, 400, 'invalid-request', `${error.issues[0]?.path.join('.') || 'request'}: ${error.issues[0]?.message ?? 'invalid'}`)
      logger.error(`qq-recorder: request failed: ${error instanceof Error ? error.message : String(error)}`)
      return sendError(res, 500, 'internal', 'the recorder failed to answer')
    }).finally(() => active.delete(work))
    active.add(work)
  }

  const server = createServer(handle)
  const previousMask = process.umask(0o177)
  try {
    await listen(server, socketPath)
  } finally {
    process.umask(previousMask)
  }
  chmodSync(socketPath, 0o600)
  if ((statSync(socketPath).mode & 0o777) !== 0o600) throw new Error(`${socketPath} is not mode 0600`)

  let health: Server | undefined
  let healthPort: number | undefined
  if (options.healthPort !== undefined) {
    health = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      } else {
        res.writeHead(404).end()
      }
    })
    await listen(health, options.healthPort, '127.0.0.1')
    const address = health.address()
    healthPort = typeof address === 'object' && address !== null ? address.port : undefined
  }
  logger.info(`qq-recorder: listening on ${socketPath}${healthPort === undefined ? '' : `; health on 127.0.0.1:${healthPort}`}; protocol ${protocolTag({ major, minor })}`)

  return {
    socketPath,
    healthPort,
    streamCount: () => streams.size,
    async close() {
      for (const stream of streams) stream.end()
      streams.clear()
      const closing = [server, health].filter(entry => entry !== undefined).map(entry => new Promise<void>((resolve) => {
        entry.close(() => { resolve() })
        entry.closeAllConnections()
      }))
      await Promise.all(closing)
      await Promise.allSettled([...active])
      rmSync(socketPath, { force: true })
    },
  }
}
