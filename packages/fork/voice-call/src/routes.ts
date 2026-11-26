/**
 * The HTTP side of protocol version 1, under `/voice-call/v1/`. Every request carries the app's
 * bearer token, compared in constant time; the body is JSON of at most a configured size.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { z } from 'zod'
import {
  connectBody, deviceBody, isCallId, isDeviceId, placeCallBody, registerDeviceBody,
  type CallId, type CallView, type DeviceId, type DeviceView, type HealthView,
} from './protocol.ts'

/** Path prefix of every route. */
export const ROUTE_PREFIX = '/voice-call/v1'

/** A refusal with its HTTP status and a message safe to show the app. */
export class CallHttpError extends Error {
  override readonly name = 'CallHttpError'
  /**
   * @param status - HTTP status.
   * @param message - reason; never repeats request data.
   */
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** What the routes ask of the service. */
export interface CallApi {
  /** The bearer token, or undefined while none is configured (every request then gets 503). */
  token(): Promise<string | undefined>
  health(): Promise<HealthView>
  registerDevice(deviceId: DeviceId, body: z.infer<typeof registerDeviceBody>): Promise<DeviceView>
  unregisterDevice(deviceId: DeviceId): Promise<void>
  placeCall(deviceId: DeviceId): Promise<CallView>
  call(callId: CallId): Promise<CallView>
  connect(callId: CallId, deviceId: DeviceId, offerSdp: string): Promise<string>
  decline(callId: CallId, deviceId: DeviceId): Promise<void>
  hangup(callId: CallId, deviceId: DeviceId): Promise<void>
}

/** Compare digests so neither length nor content leaks through timing. */
function sameToken(given: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

function reply(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!/^application\/json\s*(?:;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(request.headers['content-type'] ?? '')) {
    throw new CallHttpError(415, 'content type must be application/json')
  }
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume()
    throw new CallHttpError(413, 'body too large')
  }
  const chunks: Buffer[] = []
  let size = 0
  // Without setEncoding, a request yields Buffer chunks.
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > maxBytes) {
      request.resume()
      throw new CallHttpError(413, 'body too large')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
  } catch {
    // The parser's message may quote the body; the answer names the problem only.
    throw new CallHttpError(400, 'body is not UTF-8 JSON')
  }
}

/** Parse a body; the schema's message may quote the body (an SDP, a token), so it is not returned. */
function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new CallHttpError(400, `invalid ${what} body`)
  return parsed.data
}

/**
 * The request handler of the prefix route.
 * @param api - the service.
 * @param maxBodyBytes - largest accepted body.
 * @param warn - logs refused credentials and unexpected failures.
 * @returns the handler.
 */
export function callRoutes(
  api: CallApi, maxBodyBytes: number, warn: (message: string) => void,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const expected = await api.token()
      if (expected === undefined) throw new CallHttpError(503, 'no voice-call token is configured')
      const token = /^Bearer (\S+)$/u.exec(request.headers.authorization ?? '')?.[1]
      if (token === undefined || !sameToken(token, expected)) throw new CallHttpError(401, 'bearer token required')
      const url = new URL(request.url ?? '/', 'http://voice-call.invalid')
      const rest = url.pathname.startsWith(`${ROUTE_PREFIX}/`) ? url.pathname.slice(ROUTE_PREFIX.length + 1).split('/') : []
      const method = request.method ?? 'GET'
      const allow = (methods: string): void => {
        if (!methods.split(',').includes(method)) {
          response.setHeader('allow', methods)
          throw new CallHttpError(405, 'method not allowed')
        }
      }
      const [resource, id, action, extra] = rest
      if (extra !== undefined) throw new CallHttpError(404, 'not found')
      if (resource === 'health' && id === undefined) {
        allow('GET')
        reply(response, 200, await api.health())
        return
      }
      if (resource === 'devices' && id !== undefined && action === undefined) {
        if (!isDeviceId(id)) throw new CallHttpError(400, 'invalid device id')
        allow('PUT,DELETE')
        if (method === 'PUT') {
          const device = await api.registerDevice(id, parse(registerDeviceBody, await readJson(request, maxBodyBytes), 'device'))
          reply(response, 200, { device })
        } else {
          await api.unregisterDevice(id)
          reply(response, 204)
        }
        return
      }
      if (resource === 'calls' && id === undefined) {
        allow('POST')
        const body = parse(placeCallBody, await readJson(request, maxBodyBytes), 'call')
        reply(response, 201, { call: await api.placeCall(body.deviceId as DeviceId) })
        return
      }
      if (resource === 'calls' && id !== undefined) {
        if (!isCallId(id)) throw new CallHttpError(404, 'no such call')
        if (action === undefined) {
          allow('GET')
          reply(response, 200, { call: await api.call(id) })
          return
        }
        allow('POST')
        if (action === 'connect') {
          const body = parse(connectBody, await readJson(request, maxBodyBytes), 'connect')
          reply(response, 200, { sdp: await api.connect(id, body.deviceId as DeviceId, body.sdp) })
          return
        }
        if (action === 'decline' || action === 'hangup') {
          const body = parse(deviceBody, await readJson(request, maxBodyBytes), action)
          await (action === 'decline' ? api.decline(id, body.deviceId as DeviceId) : api.hangup(id, body.deviceId as DeviceId))
          reply(response, 204)
          return
        }
      }
      throw new CallHttpError(404, 'not found')
    } catch (error: unknown) {
      if (error instanceof CallHttpError) {
        if (error.status === 401) warn('voice-call: refused a request without the right token')
        reply(response, error.status, { error: error.message })
        return
      }
      warn(`voice-call: request failed: ${error instanceof Error ? error.message : String(error)}`)
      reply(response, 500, { error: 'voice-call failed' })
    }
  }
}
