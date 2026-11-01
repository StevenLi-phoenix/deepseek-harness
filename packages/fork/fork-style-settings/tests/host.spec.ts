import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { STYLE_COLLECT_PATH, STYLE_EDIT_PATH, STYLE_PATH, type StylePanel } from '../src/view.ts'

interface Route { path: string; methods: readonly string[]; requestBody: string; fetch: (request: Request) => Promise<Response> }

const PANEL: StylePanel = {
  enabled: true, review: 'optional', limits: { maxActive: 60, maxOwner: 20, maxChars: 60 }, samples: [], running: false, lastRun: null, nextRunAt: null, trend: [],
}

async function mount(style?: object) {
  const ctx = new Context()
  const routes: Route[] = []
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
  if (style !== undefined) ctx.provide('forkStyle', style as never)
  await ctx.plugin(plugin)
  const route = (path: string): Route => routes.find(candidate => candidate.path === path)!
  return { routes, route }
}

const post = (path: string, body?: string): Request => new Request(`http://h${path}`, { method: 'POST', ...body === undefined ? {} : { body } })

describe('fork-style-settings Host routes', () => {
  it('registers the panel, edit, and collect routes under /api', async () => {
    const { routes } = await mount()
    expect(routes.map(route => [route.path, route.methods, route.requestBody])).toEqual([
      [STYLE_PATH, ['GET'], 'buffered'], [STYLE_EDIT_PATH, ['POST'], 'buffered'], [STYLE_COLLECT_PATH, ['POST'], 'buffered'],
    ])
  })

  it('answers from ctx.forkStyle without caching, and passes edits through with a status per outcome', async () => {
    const edit = vi.fn((body: { op?: string }) => Promise.resolve(body.op === 'remove' ? { ok: false, error: 'not_found', panel: PANEL } : { ok: true, panel: PANEL }))
    const collect = vi.fn(() => Promise.resolve({ ...PANEL, running: true }))
    const { route } = await mount({ panel: () => Promise.resolve(PANEL), edit, collect })
    const read = await route(STYLE_PATH).fetch(new Request('http://h/api/fork.style'))
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

  it('answers 503 while fork-style is not mounted', async () => {
    const { route } = await mount()
    expect((await route(STYLE_PATH).fetch(new Request('http://h/api/fork.style'))).status).toBe(503)
    expect((await route(STYLE_EDIT_PATH).fetch(post(STYLE_EDIT_PATH, '{}'))).status).toBe(503)
    expect((await route(STYLE_COLLECT_PATH).fetch(post(STYLE_COLLECT_PATH))).status).toBe(503)
  })
})
