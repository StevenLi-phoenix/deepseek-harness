import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import type { BalanceRouteBody } from '../src/readings.ts'

interface Route {
  path: string
  methods: readonly string[]
  fetch: (request: Request) => Promise<Response>
}

const KEYS: Record<string, string> = { OPENROUTER_API_KEY: 'sk-or-secret', DEEPSEEK_API_KEY: 'sk-ds-secret' }

async function mount(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const routes: Route[] = []
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type} ${String(message.args[0])}`) } })
  ctx.provide('credentials', { resolve: vi.fn((ref: string) => Promise.resolve(KEYS[ref] === undefined ? undefined : { value: KEYS[ref], source: 'file' })) } as never)
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
  await ctx.plugin(plugin, plugin.Config(config as never))
  const get = async (query = ''): Promise<BalanceRouteBody> => {
    const route = routes.find(entry => entry.path === '/api/lsy.balance')
    if (route === undefined) throw new Error('route not registered')
    const response = await route.fetch(new Request(`http://127.0.0.1/api/lsy.balance${query}`))
    expect(response.headers.get('cache-control')).toBe('no-store')
    return await response.json() as BalanceRouteBody
  }
  return { ctx, routes, logs, get }
}

let upstream: ReturnType<typeof vi.fn>
let now = 1_000_000

beforeEach(() => {
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  upstream = vi.fn((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === 'https://openrouter.ai/api/v1/key') return Promise.resolve(Response.json({ data: { limit: 10, limit_remaining: 7.5, usage: 2.5 } }))
    if (url === 'https://api.deepseek.com/user/balance') return Promise.resolve(new Response('busy', { status: 503 }))
    return Promise.resolve(new Response('unexpected', { status: 500 }))
  })
  vi.stubGlobal('fetch', upstream)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('lsy-balance Host route', () => {
  it('reads every source whose key is set and skips the rest', async () => {
    const { get, logs } = await mount()
    expect(await get()).toEqual({ readings: [
      { source: 'openrouter', label: 'OpenRouter', status: 'ready', kind: 'credit', currency: 'USD', remaining: 7.5, limit: 10, used: 2.5 },
      { source: 'deepseek', label: 'DeepSeek API', status: 'failed', reason: 'HTTP 503' },
    ] })
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(logs).toContain('warn lsy-balance: DeepSeek API balance read failed: HTTP 503')
    expect(logs).toContain('info lsy-balance: OPENCODE_GO_API_KEY is not set; OpenCode Go is not shown')
    expect(logs.join('\n')).not.toMatch(/sk-(or|ds)-secret/)
  })

  it('answers from a fresh cache, refreshes at most every ten seconds on request, and shares requests in flight', async () => {
    const { get } = await mount({ cacheMs: 60_000 })
    await Promise.all([get(), get()])
    expect(upstream).toHaveBeenCalledTimes(2)
    now += 59_000
    await get()
    expect(upstream).toHaveBeenCalledTimes(2)
    await get('?fresh=1')
    expect(upstream).toHaveBeenCalledTimes(4)
    now += 5_000
    await get('?fresh=1')
    expect(upstream).toHaveBeenCalledTimes(4)
    now += 60_000
    await get()
    expect(upstream).toHaveBeenCalledTimes(6)
  })

  it('honors configured sources and their labels', async () => {
    const { get } = await mount({ sources: [{ kind: 'openrouter', keyRef: 'OPENROUTER_API_KEY', label: 'OR' }] })
    expect((await get()).readings.map(reading => reading.label)).toEqual(['OR'])
  })
})
