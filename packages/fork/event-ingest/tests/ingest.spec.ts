import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { BusEventInput } from '@deepseek-ai/dsh-event-bus'
import { afterEach, describe, expect, it } from 'vitest'
import * as Ingest from '../src/index.ts'

const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => await new Promise((resolve) => { server.close(resolve) })))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

type Route = { path: string; handler: (request: unknown, response: unknown) => Promise<void> }

async function mount(tokens: Record<string, string | undefined>, config: Ingest.Config = {
  sources: [{ id: 'kaorou', tokenEnv: 'KAOROU_TOKEN' }, { id: 'globe', tokenEnv: 'GLOBE_TOKEN' }],
}, sink?: { ingest: (event: BusEventInput) => Promise<string> }) {
  const ctx = new Context()
  contexts.push(ctx)
  const routes: Route[] = []
  const published: BusEventInput[] = []
  ctx.provide('webServer', { register: (route: Route) => { routes.push(route); return () => {} } } as never)
  ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(tokens[ref] === undefined ? undefined : { value: tokens[ref] }) } as never)
  ctx.provide('eventBus', { publish: (event: BusEventInput) => { published.push(event); return Promise.resolve('accepted') } } as never)
  if (sink !== undefined) ctx.provide('presence', sink as never)
  await ctx.plugin(Ingest, config)
  const route = routes[0]
  if (route === undefined) throw new Error('no route registered')
  const server = createServer((request, response) => { void route.handler(request, response) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${route.path}`
  const post = async (body: unknown, token?: string, init: RequestInit = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...token === undefined ? {} : { authorization: `Bearer ${token}` } },
      body: (typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
      ...init,
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { post, published, path: route.path, url, handler: route.handler }
}

const EVENT = { kind: 'kaorou.job.failed', key: 'job-91-attempt-3', subject: 'job 91', title: 'burn failed: ffmpeg exit 255', text: 'stderr tail', url: 'https://example.com/jobs/91', occurredAt: 1_761_000_000_000 }

describe('event-ingest', () => {
  it('publishes an event under the source its token belongs to', async () => {
    const { post, published, path } = await mount({ KAOROU_TOKEN: 'k-secret', GLOBE_TOKEN: 'g-secret' })
    expect(path).toBe('/hooks/events')
    expect(await post(EVENT, 'k-secret')).toEqual({ status: 202, body: { outcome: 'accepted' } })
    expect(published).toEqual([{ source: 'kaorou', ...EVENT }])
    expect(await post({ ...EVENT, kind: 'globe.fetch.failed' }, 'g-secret')).toMatchObject({ status: 202 })
    expect(published[1]?.source).toBe('globe')
  })

  it('rejects missing, unknown, and cross-source tokens', async () => {
    const { post, published } = await mount({ KAOROU_TOKEN: 'k-secret', GLOBE_TOKEN: 'g-secret' })
    expect((await post(EVENT)).status).toBe(401)
    expect((await post(EVENT, 'nope')).status).toBe(401)
    const crossed = await post(EVENT, 'g-secret')
    expect(crossed.status).toBe(400)
    expect(String(crossed.body['error'])).toContain('starting with "globe."')
    expect(published).toEqual([])
  })

  it('refuses a body that names its own source or breaks a field rule', async () => {
    const { post, published } = await mount({ KAOROU_TOKEN: 'k-secret' })
    const named = await post({ ...EVENT, source: 'github' }, 'k-secret')
    expect(named.status).toBe(400)
    expect(String(named.body['error'])).toContain('unknown field(s) source')
    expect((await post({ ...EVENT, kind: 'github.release' }, 'k-secret')).status).toBe(400)
    expect((await post({ ...EVENT, kind: 'kaorou' }, 'k-secret')).status).toBe(400)
    expect((await post({ ...EVENT, title: '' }, 'k-secret')).status).toBe(400)
    expect((await post({ ...EVENT, url: 'javascript:alert(1)' }, 'k-secret')).status).toBe(400)
    expect((await post({ ...EVENT, occurredAt: -1 }, 'k-secret')).status).toBe(400)
    expect((await post({ ...EVENT, text: 'x'.repeat(8001) }, 'k-secret')).status).toBe(400)
    expect((await post('not json', 'k-secret')).status).toBe(400)
    expect((await post([EVENT], 'k-secret')).status).toBe(400)
    expect(published).toEqual([])
  })

  it('collapses whitespace in one-line fields', async () => {
    const { post, published } = await mount({ KAOROU_TOKEN: 'k-secret' })
    await post({ ...EVENT, title: '  burn\nfailed  ' }, 'k-secret')
    expect(published[0]?.title).toBe('burn failed')
  })

  it('checks method, content type, and size', async () => {
    const { post } = await mount({ KAOROU_TOKEN: 'k-secret' }, { sources: [{ id: 'kaorou', tokenEnv: 'KAOROU_TOKEN' }], maxBodyBytes: 1024 })
    expect((await post(EVENT, 'k-secret', { method: 'PUT' })).status).toBe(405)
    expect((await post(EVENT, 'k-secret', { headers: { 'content-type': 'text/plain', authorization: 'Bearer k-secret' } })).status).toBe(415)
    expect((await post({ ...EVENT, text: 'x'.repeat(2000) }, 'k-secret')).status).toBe(413)
  })

  it('answers 503 while no token is configured', async () => {
    const { post } = await mount({})
    expect((await post(EVENT, 'anything')).status).toBe(503)
  })

  it('refuses reserved or duplicate source ids and paths outside /hooks/', async () => {
    await expect(mount({}, { sources: [{ id: 'github', tokenEnv: 'X' }] })).rejects.toThrow('source id')
    await expect(mount({}, { sources: [{ id: 'a', tokenEnv: 'X' }, { id: 'a', tokenEnv: 'Y' }] })).rejects.toThrow('source id')
    await expect(mount({}, { path: '/api/events', sources: [] })).rejects.toThrow('under /hooks/')
  })

  it('gives a sink source its events and never publishes them on the bus', async () => {
    const taken: BusEventInput[] = []
    const { post, published } = await mount({ PRESENCE_TOKEN: 'p-secret', KAOROU_TOKEN: 'k-secret' }, {
      sources: [{ id: 'presence', tokenEnv: 'PRESENCE_TOKEN', sink: 'presence' }, { id: 'kaorou', tokenEnv: 'KAOROU_TOKEN' }],
    }, { ingest: (event) => { taken.push(event); return Promise.resolve('applied') } })
    const event = { kind: 'presence.sleep.on', key: '2026-11-02T03:30:00Z', subject: 'owner', title: 'sleep focus on' }
    expect(await post(event, 'p-secret')).toEqual({ status: 202, body: { outcome: 'applied' } })
    expect(taken).toEqual([{ source: 'presence', ...event }])
    expect(published).toEqual([])
    // Other sources keep using the bus, and the token still decides the source.
    expect((await post(EVENT, 'k-secret')).status).toBe(202)
    expect(published).toHaveLength(1)
    expect((await post({ ...event, kind: 'kaorou.sleep.on' }, 'p-secret')).status).toBe(400)
  })

  it('answers 503 while the sink service is not mounted and 400 with the sink\'s own reason when it refuses', async () => {
    const config = { sources: [{ id: 'presence', tokenEnv: 'PRESENCE_TOKEN', sink: 'presence' }] }
    const event = { kind: 'presence.sleep.on', key: 'k', subject: 'owner', title: 't' }
    const unmounted = await mount({ PRESENCE_TOKEN: 'p-secret' }, config)
    expect(await unmounted.post(event, 'p-secret')).toEqual({ status: 503, body: { error: 'presence is not mounted' } })
    expect(unmounted.published).toEqual([])
    const refusing = await mount({ PRESENCE_TOKEN: 'p-secret' }, config, { ingest: () => Promise.reject(new Error('unknown presence kind')) })
    expect(await refusing.post(event, 'p-secret')).toEqual({ status: 400, body: { error: 'unknown presence kind' } })
    await expect(mount({}, { sources: [{ id: 'presence', tokenEnv: 'X', sink: 'not a service' }] })).rejects.toThrow('must be a service name')
  })

  it('refuses a key that is not a string', async () => {
    const { post, published } = await mount({ KAOROU_TOKEN: 'k-secret' })
    expect(await post({ ...EVENT, key: 5 }, 'k-secret')).toEqual({ status: 400, body: { error: 'key must be a string' } })
    expect(published).toEqual([])
  })

  it('applies its defaults when mounted without a path, sources, or body ceiling', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const routes: Route[] = []
    ctx.provide('webServer', { register: (route: Route) => { routes.push(route); return () => {} } } as never)
    ctx.provide('credentials', { resolve: () => Promise.resolve(undefined) } as never)
    ctx.provide('eventBus', { publish: () => Promise.resolve('accepted') } as never)
    Ingest.apply(ctx, {})
    expect(routes.map(route => route.path)).toEqual(['/hooks/events'])
  })

  it('answers 413 when a chunked body outgrows the ceiling without declaring its length', async () => {
    const { url } = await mount({ KAOROU_TOKEN: 'k-secret' }, { sources: [{ id: 'kaorou', tokenEnv: 'KAOROU_TOKEN' }], maxBodyBytes: 1024 })
    const reply = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const request = httpRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer k-secret', 'transfer-encoding': 'chunked' },
      }, (response) => {
        const parts: Buffer[] = []
        response.on('data', (part: Buffer) => { parts.push(part) })
        response.on('end', () => { resolve({ status: response.statusCode, body: Buffer.concat(parts).toString('utf8') }) })
      })
      request.on('error', reject)
      request.write('{"padding":"')
      request.write('x'.repeat(2000))
      request.end('"}')
    })
    expect(reply).toEqual({ status: 413, body: JSON.stringify({ error: 'body too large' }) })
  })

  it('reads a body delivered as strings', async () => {
    const { handler, published } = await mount({ KAOROU_TOKEN: 'k-secret' })
    const request = Object.assign(Readable.from([JSON.stringify(EVENT)]), {
      method: 'POST',
      headers: { authorization: 'Bearer k-secret', 'content-type': 'application/json' },
    })
    const sent: { status?: number; body?: string } = {}
    const response = {
      writeHead: (status: number) => { sent.status = status },
      end: (body: string) => { sent.body = body },
    }
    await handler(request, response)
    expect(sent).toEqual({ status: 202, body: JSON.stringify({ outcome: 'accepted' }) })
    expect(published).toEqual([{ source: 'kaorou', ...EVENT }])
  })

  it('answers 400 for a body that is not UTF-8', async () => {
    const { post } = await mount({ KAOROU_TOKEN: 'k-secret' })
    const result = await post(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), 'k-secret', {
      headers: { 'content-type': 'application/json', authorization: 'Bearer k-secret' },
    })
    expect(result).toEqual({ status: 400, body: { error: 'body is not UTF-8' } })
  })

  it('answers 415 when the request carries no content type', async () => {
    const { post } = await mount({ KAOROU_TOKEN: 'k-secret' })
    const result = await post(new Uint8Array([0x7b, 0x7d]), 'k-secret', { headers: { authorization: 'Bearer k-secret' } })
    expect(result).toEqual({ status: 415, body: { error: 'content type must be application/json' } })
  })

  it('answers 400 with a default reason when the sink rejects with a non-Error', async () => {
    const config = { sources: [{ id: 'presence', tokenEnv: 'PRESENCE_TOKEN', sink: 'presence' }] }
    const event = { kind: 'presence.sleep.on', key: 'k', subject: 'owner', title: 't' }
    const refusing = await mount({ PRESENCE_TOKEN: 'p-secret' }, config, { ingest: async () => { throw 'nope' } })
    expect(await refusing.post(event, 'p-secret')).toEqual({ status: 400, body: { error: 'event refused' } })
  })

  it('answers 503 and logs when the bus fails, whether it throws an Error or a bare value', async () => {
    for (const failure of [new Error('bus down'), 'bus down']) {
      const ctx = new Context()
      contexts.push(ctx)
      const routes: Route[] = []
      const warnings: string[] = []
      ctx.provide('webServer', { register: (route: Route) => { routes.push(route); return () => {} } } as never)
      ctx.provide('credentials', { resolve: () => Promise.resolve({ value: 'k-secret' }) } as never)
      ctx.provide('eventBus', { publish: async () => { throw failure } } as never)
      await ctx.plugin(Ingest, { sources: [{ id: 'kaorou', tokenEnv: 'KAOROU_TOKEN' }] })
      ctx.logger.warn = ((format: string, ...args: unknown[]) => { warnings.push([format, ...args].join(' ')) }) as never
      const route = routes[0]
      if (route === undefined) throw new Error('no route registered')
      const sent: { status?: number; body?: string } = {}
      const request = Object.assign(Readable.from([JSON.stringify(EVENT)]), {
        method: 'POST',
        headers: { authorization: 'Bearer k-secret', 'content-type': 'application/json' },
      })
      await route.handler(request, { writeHead: (status: number) => { sent.status = status }, end: (body: string) => { sent.body = body } })
      expect(sent).toEqual({ status: 503, body: JSON.stringify({ error: 'ingest unavailable' }) })
      expect(warnings).toEqual(['ingest failed: %s bus down'])
    }
  })
})
