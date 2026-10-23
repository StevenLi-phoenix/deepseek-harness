import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import type { LsyEventInput } from '@deepseek-ai/dsh-lsy-event-bus'
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
}) {
  const ctx = new Context()
  contexts.push(ctx)
  const routes: Route[] = []
  const published: LsyEventInput[] = []
  ctx.provide('webServer', { register: (route: Route) => { routes.push(route); return () => {} } } as never)
  ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(tokens[ref] === undefined ? undefined : { value: tokens[ref] }) } as never)
  ctx.provide('lsyEventBus', { publish: (event: LsyEventInput) => { published.push(event); return Promise.resolve('accepted') } } as never)
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
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { post, published, path: route.path }
}

const EVENT = { kind: 'kaorou.job.failed', key: 'job-91-attempt-3', subject: 'job 91', title: 'burn failed: ffmpeg exit 255', text: 'stderr tail', url: 'https://example.com/jobs/91', occurredAt: 1_761_000_000_000 }

describe('lsy-event-ingest', () => {
  it('publishes an event under the source its token belongs to', async () => {
    const { post, published, path } = await mount({ KAOROU_TOKEN: 'k-secret', GLOBE_TOKEN: 'g-secret' })
    expect(path).toBe('/hooks/lsy')
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
    await expect(mount({}, { path: '/api/lsy', sources: [] })).rejects.toThrow('under /hooks/')
  })
})
