import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import type { SysmonSnapshot } from '../src/snapshot.ts'

interface Route {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

/** Mount the plugin with real probes, a macmon path that cannot exist, and one mount that does. */
async function mount(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const routes: Route[] = []
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(`${message.type} ${String(message.args[0])}`) } })
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
  await ctx.plugin(plugin, plugin.Config({
    macmonPath: '/nonexistent/lsy-sysmon-test/macmon',
    mounts: [{ mount: '/', label: 'Root' }, { mount: '/nonexistent/lsy-sysmon-test', label: 'Gone' }],
    ...config,
  } as never))
  const get = async (query = ''): Promise<SysmonSnapshot> => {
    const route = routes.find(entry => entry.path === '/api/lsy.sysmon')
    if (route === undefined) throw new Error('route not registered')
    const response = await route.fetch(new Request(`http://127.0.0.1/api/lsy.sysmon${query}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return await response.json() as SysmonSnapshot
  }
  return { ctx, routes, logs, get }
}

afterEach(() => { vi.restoreAllMocks() })

describe('lsy-sysmon Host route', () => {
  it('registers GET /api/lsy.sysmon on the connection, under the /api sign-in', async () => {
    const { routes } = await mount()
    expect(routes.map(route => [route.path, route.methods, route.requestBody])).toEqual([['/api/lsy.sysmon', ['GET'], 'buffered']])
  })

  it('answers the snapshot shape with null for what it could not read', async () => {
    const { get, logs } = await mount()
    const { sampledAt, uptime, cpu, memory, disks, ...rest } = await get()
    expect(rest).toEqual({
      power: null,
      temperature: null,
      skippedMounts: [{ mount: '/nonexistent/lsy-sysmon-test', label: 'Gone', reason: 'not found' }],
      sources: { macmon: 'missing' },
    })
    expect(Object.keys(cpu).sort()).toEqual(['cores', 'load', 'usage'])
    // Without macmon the first sample has no CPU window of its own.
    expect(cpu.usage).toBeNull()
    expect(cpu.cores).toBeGreaterThan(0)
    expect(cpu.load).toHaveLength(3)
    expect(memory).toMatchObject({ swapTotal: null, swapUsed: null, approximate: true })
    expect([sampledAt, uptime, ...cpu.load, memory.total, memory.used].every(Number.isFinite)).toBe(true)
    expect(disks.map(disk => [disk.mount, disk.label])).toEqual([['/', 'Root']])
    const [disk] = disks
    expect(disk!.total).toBeGreaterThan(0)
    expect(disk!.used + disk!.free).toBe(disk!.total)
    expect(logs).toContain('info lsy-sysmon: macmon not found at /nonexistent/lsy-sysmon-test/macmon; power and temperature are not shown (brew install macmon)')
    expect(logs).toContain('warn lsy-sysmon: /nonexistent/lsy-sysmon-test skipped (not found)')
  })

  it('serves the cache, and ?fresh=1 takes a new sample once the last is 2 s old', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { get } = await mount({ cacheMs: 60_000 })
    const [first, shared] = await Promise.all([get(), get()])
    expect(shared.sampledAt).toBe(first.sampledAt)
    now += 1_999
    expect((await get('?fresh=1')).sampledAt).toBe(first.sampledAt)
    now += 1
    expect((await get()).sampledAt).toBe(first.sampledAt)
    expect((await get('?fresh=1')).sampledAt).toBe(now)
  })

  it('refuses relative paths, which would be looked up on PATH', async () => {
    const ctx = new Context()
    ctx.provide('connection', { fetch: { register: () => () => Promise.resolve() } } as never)
    expect(() => { plugin.apply(ctx, plugin.Config({ macmonPath: 'macmon' } as never)) }).toThrow('macmonPath must be an absolute path')
    expect(() => { plugin.apply(ctx, plugin.Config({ mounts: [{ mount: 'Volumes/x', label: 'x' }] } as never)) }).toThrow('must be an absolute path')
  })

  it('defaults to the Mac mini volumes and a 2 s cache', () => {
    expect(plugin.Config({} as never)).toEqual({
      mounts: [{ mount: '/System/Volumes/Data', label: 'Internal' }, { mount: '/Volumes/MiniSSD', label: 'MiniSSD' }],
      cacheMs: 2000,
    })
  })
})
