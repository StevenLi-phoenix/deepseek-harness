/**
 * `POST <path>`: the owner's own services push events into the lsy event bus.
 * Each source has its own bearer token in the credential store; the matching
 * token, never the body, decides the source, and kinds must stay inside it, so
 * a leaked token cannot impersonate GitHub or another service.
 *
 * @module @deepseek-ai/dsh-lsy-event-ingest
 */

import { timingSafeEqual, createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-lsy-event-bus'
import z from '@deepseek-ai/schemastery'
import { eventFrom, InvalidEvent } from './event.ts'

export { eventFrom, InvalidEvent, LIMITS } from './event.ts'

/** Plugin name. */
export const name = 'lsy-event-ingest'

/** Host services the route needs. */
export const inject = ['webServer', 'credentials', 'lsyEventBus']

/** One service allowed to push. */
export interface IngestSource {
  /** Source id on the bus, e.g. `kaorou`; event kinds must start with `<id>.`. */
  id: string
  /** Credential reference of this source's bearer token. */
  tokenEnv: string
}

/** Route, sources, and body ceiling. */
export interface Config {
  /** Route path; must start with `/hooks/` and not end with `/`. */
  path?: string
  /** Services allowed to push, each with its own bearer token; with none configured every request gets 503. */
  sources?: IngestSource[]
  /** Largest accepted request body, in bytes. */
  maxBodyBytes?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  path: z.string().default('/hooks/lsy'),
  sources: z.array(z.object({
    id: z.string().required(),
    tokenEnv: z.string().role('credential-ref').required(),
  })).default([]),
  maxBodyBytes: z.natural().min(1024).default(65_536),
})

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u
const RESERVED = new Set(['github', 'schedule'])

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function reply(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume()
    throw new HttpError(413, 'body too large')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string)
    size += chunk.byteLength
    if (size > maxBytes) {
      request.resume()
      throw new HttpError(413, 'body too large')
    }
    chunks.push(chunk)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
  } catch {
    throw new HttpError(400, 'body is not UTF-8')
  }
}

/** Compare digests so neither length nor content leaks through timing. */
function sameToken(given: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

/**
 * Register the ingest route.
 * @param ctx - Host context with the web server, credentials, and the event bus.
 * @param config - route, sources, and body ceiling.
 */
export function apply(ctx: Context, config: Config): void {
  const path = config.path ?? '/hooks/lsy'
  const sources = config.sources ?? []
  const maxBodyBytes = config.maxBodyBytes ?? 65_536
  if (!path.startsWith('/hooks/') || path.endsWith('/')) throw new Error(`lsy-event-ingest: path must be under /hooks/, got ${path}`)
  const ids = new Set<string>()
  for (const source of sources) {
    if (!SOURCE_ID.test(source.id) || RESERVED.has(source.id) || ids.has(source.id)) {
      throw new Error(`lsy-event-ingest: source id ${JSON.stringify(source.id)} must be unique lowercase letters, digits, or hyphens, and not ${[...RESERVED].join(' or ')}`)
    }
    ids.add(source.id)
  }

  /** The source whose configured token equals the bearer token, checking every source. */
  const sourceFor = async (token: string): Promise<string | undefined> => {
    let match: string | undefined
    let configured = false
    for (const source of sources) {
      const credential = await ctx.credentials.resolve(credentialRef(source.tokenEnv))
      if (credential === undefined || credential.value === '') continue
      configured = true
      if (sameToken(token, credential.value)) match = source.id
    }
    if (!configured) throw new HttpError(503, 'no ingest token is configured')
    return match
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          throw new HttpError(405, 'method not allowed')
        }
        const authorization = request.headers.authorization ?? ''
        const token = /^Bearer (\S+)$/u.exec(authorization)?.[1]
        if (token === undefined) throw new HttpError(401, 'bearer token required')
        const source = await sourceFor(token)
        if (source === undefined) throw new HttpError(401, 'unknown token')
        if (!/^application\/json\s*(?:;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(request.headers['content-type'] ?? '')) {
          throw new HttpError(415, 'content type must be application/json')
        }
        const raw = await readBody(request, maxBodyBytes)
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          throw new HttpError(400, 'body is not JSON')
        }
        let event
        try {
          event = eventFrom(source, parsed)
        } catch (error: unknown) {
          if (error instanceof InvalidEvent) throw new HttpError(400, error.message)
          throw error
        }
        const outcome = await ctx.lsyEventBus.publish(event)
        ctx.logger.info('%s %s (%s): %s', source, event.kind, event.key, outcome)
        reply(response, 202, { outcome })
      } catch (error: unknown) {
        if (error instanceof HttpError) {
          if (error.status === 401) ctx.logger.warn('rejected push: %s', error.message)
          reply(response, error.status, { error: error.message })
          return
        }
        ctx.logger.warn('ingest failed: %s', error instanceof Error ? error.message : String(error))
        reply(response, 503, { error: 'ingest unavailable' })
      }
    },
  }), `lsy-event-ingest: ${path}`)
}
