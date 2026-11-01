import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { STYLE_COLLECT_PATH, STYLE_EDIT_PATH, STYLE_PATH, type StylePanel } from '../src/view.ts'

interface Route { path: string; methods: readonly string[]; requestBody: string; fetch: (request: Request) => Promise<Response> }

const PANEL: StylePanel = {
  enabled: true, review: 'optional', limits: { maxActive: 60, maxOwner: 20, maxMemes: 40, maxTraits: 10, cardChars: 600 }, samples: [],
  parts: { tone: true, memes: true, traits: true, persona: true, miner: true },
  notes: [], hot: [], cards: [], running: false, lastRun: null, lastMine: null, nextRunAt: null, trend: [],
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
}

const GUEST: Principal = { kind: 'test-guest', guest: 'lsy-style' }

async function mount(style?: object) {
  const ctx = new Context()
  const routes: Route[] = []
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
  if (style !== undefined) ctx.provide('lsyStyle', style as never)
  await ctx.plugin(plugin)
  const route = (path: string): Route => routes.find(candidate => candidate.path === path)!
  return { routes, route }
}

const post = (path: string, body?: string): Request => new Request(`http://h${path}`, { method: 'POST', ...body === undefined ? {} : { body } })

describe('lsy-style-settings Host routes', () => {
  it('registers the panel, edit, and collect routes under /api', async () => {
    const { routes } = await mount()
    expect(routes.map(route => [route.path, route.methods, route.requestBody])).toEqual([
      [STYLE_PATH, ['GET'], 'buffered'], [STYLE_EDIT_PATH, ['POST'], 'buffered'], [STYLE_COLLECT_PATH, ['POST'], 'buffered'],
    ])
  })

  it('answers from ctx.lsyStyle without caching, and passes edits through with a status per outcome', async () => {
    const edit = vi.fn((body: { op?: string }) => Promise.resolve(body.op === 'remove' ? { ok: false, error: 'not_found', panel: PANEL } : { ok: true, panel: PANEL }))
    const collect = vi.fn(() => Promise.resolve({ ...PANEL, running: true }))
    const { route } = await mount({ panel: () => Promise.resolve(PANEL), edit, collect })
    const read = await route(STYLE_PATH).fetch(new Request('http://h/api/lsy.style'))
    expect(read.headers.get('cache-control')).toBe('no-store')
    expect(await read.json()).toEqual(PANEL)
    expect((await route(STYLE_EDIT_PATH).fetch(post(STYLE_EDIT_PATH, JSON.stringify({ op: 'add', reply: '会的' })))).status).toBe(200)
    expect(edit).toHaveBeenCalledWith({ op: 'add', reply: '会的' })
    expect((await route(STYLE_EDIT_PATH).fetch(post(STYLE_EDIT_PATH, JSON.stringify({ op: 'remove', id: 'x' })))).status).toBe(404)
    const bad = await route(STYLE_EDIT_PATH).fetch(post(STYLE_EDIT_PATH, '{not json'))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ ok: false, error: 'invalid_input', panel: PANEL })
    expect(await (await route(STYLE_COLLECT_PATH).fetch(post(STYLE_COLLECT_PATH))).json()).toMatchObject({ running: true })
  })

  it('answers 503 while lsy-style is not mounted', async () => {
    const { route } = await mount()
    expect((await route(STYLE_PATH).fetch(new Request('http://h/api/lsy.style'))).status).toBe(503)
    expect((await route(STYLE_EDIT_PATH).fetch(post(STYLE_EDIT_PATH, '{}'))).status).toBe(503)
    expect((await route(STYLE_COLLECT_PATH).fetch(post(STYLE_COLLECT_PATH))).status).toBe(503)
  })

  it('answers 403 to a Peer that is not the owner, through the real connection, and serves the owner', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((inner: Context) => { new HostConnectionService(inner, [], {} as BrowserAuth) })
    await fiber.await()
    ctx.provide('lsyStyle', { panel: () => Promise.resolve(PANEL), edit: vi.fn(), collect: vi.fn() } as never)
    await ctx.plugin(plugin)
    const connection = ctx.get('connection') as HostConnectionService
    const shared = connection.createSharedFetchHandler('/api')
    const guest = connection.createPeer({ principal: GUEST })
    for (const request of [new Request('http://host/api/lsy.style'), post(STYLE_EDIT_PATH, '{}'), post(STYLE_COLLECT_PATH)]) {
      expect((await shared.fetch(request, guest)).status).toBe(403)
    }
    expect((await shared.fetch(new Request('http://host/api/lsy.style'), connection.browserPeer)).status).toBe(200)
    await fiber.dispose()
  })
})
