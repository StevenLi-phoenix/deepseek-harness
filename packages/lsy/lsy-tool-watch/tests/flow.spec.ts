import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeGitHub } from '../../lsy-github-sensor/tests/fake-github.ts'
import { NOTIFICATIONS, OCTO_RELEASES, disposeAll, harness } from './harness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-06T00:00:00.000Z'))
})

afterEach(async () => {
  await disposeAll()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount() {
  const gh = new FakeGitHub('https://api.github.test')
  gh.set(OCTO_RELEASES, [])
  gh.set(NOTIFICATIONS, [])
  return harness({ gh })
}

describe('flow_read', () => {
  it('lists deployment routes, event kinds no route takes, and changes', async () => {
    const { call, ctx } = await mount()
    await ctx.lsyEventBus.publish({ source: 'host', kind: 'host.nobody', key: '1', subject: 'x', title: 't' })
    const read = await call('flow_read', {}) as { value: { routes: { id: string; origin: string }[]; unrouted_kinds: unknown[] } }
    expect(read.value.routes.map(route => route.id)).toContain('config-releases')
    expect(read.value.unrouted_kinds).toEqual([{ kind: 'host.nobody', source: 'host', count: 1 }])
  })
})

describe('flow_edit', () => {
  it('rewires a deployment route and creates the route after it', async () => {
    const { call, ctx } = await mount()
    const created = await call('flow_edit', {
      op: 'set', id: 'desk', note: 'one desk', sources: ['flow'], kinds: ['flow.triage.result'], instructions: 'Sum up.', result: 'main', session_per: 'route',
    }) as { value: { route: Record<string, unknown> } }
    expect(created.value.route).toMatchObject({ origin: 'agent', action: 'session', result: 'main', session_per: 'route', agent_preset: 'unattended' })

    const triage = await call('flow_edit', { op: 'set', id: 'triage', note: 'through the desk', sources: ['github'], kinds: ['github.release'], instructions: 'Triage.', result: 'event' }) as
      { value: { route: Record<string, unknown>; warnings: string[] } }
    expect(triage.value).toMatchObject({ route: { downstream: ['desk'], result_kind: 'flow.triage.result' }, warnings: [] })

    const changed = await call('flow_edit', { op: 'set', id: 'config-releases', note: 'tags too', kinds: ['github.release', 'github.tag'] }) as { value: { route: Record<string, unknown> } }
    expect(changed.value.route).toMatchObject({ origin: 'config', kinds: ['github.release', 'github.tag'] })
    expect(ctx.lsyEventBus.flowHistory()[0]).toMatchObject({ route: 'config-releases', note: 'tags too' })
  })

  it('gives a new route the limits of the tool\'s configuration unless the call names its own', async () => {
    const { call } = await mount()
    const set = async (args: object): Promise<Record<string, unknown>> =>
      (await call('flow_edit', { op: 'set', note: 'n', sources: ['host'], ...args }) as { value: { route: Record<string, unknown> } }).value.route
    expect(await set({ id: 'plain' })).toMatchObject({ action: 'notify', coalesce_seconds: 60, max_per_hour: 12 })
    expect(await set({ id: 'agent', instructions: 'Look.' })).toMatchObject({ action: 'session', coalesce_seconds: 60, max_per_hour: 4 })
    expect(await set({ id: 'named', coalesce_seconds: 5, max_per_hour: 2 })).toMatchObject({ coalesce_seconds: 5, max_per_hour: 2 })
    expect(await set({ id: 'plain', sources: ['flow'] })).toMatchObject({ sources: ['flow'], coalesce_seconds: 60, max_per_hour: 12 })
  })

  it('refuses bad calls with a code the model can act on', async () => {
    const { call } = await mount()
    const code = async (args: unknown): Promise<unknown> => (await call('flow_edit', args) as { value: { code?: string } }).value.code
    expect(await code({ op: 'remove', id: 'Bad Id', note: 'x' })).toBe('invalid_arguments')
    expect(await code({ op: 'remove', id: 'ok', note: ' ' })).toBe('invalid_arguments')
    expect(await code({ op: 'remove', id: 'ok', note: 'x' })).toBe('not_found')
    expect(await code({ op: 'reset', id: 'ok', note: 'x' })).toBe('not_config')
    expect(await code({ op: 'set', id: 'ok', note: 'x', max_per_hour: 999 })).toBe('invalid_arguments')
    expect(await code({ op: 'set', id: 'ok', note: 'x' })).toBe('invalid_route')
  })

  it('tells the owner about a change from a Session that is not the chat, and not about the chat\'s own', async () => {
    const { call, callAs, notes, ctx, notifier } = await mount()
    notifier.ownsSession = sessionId => sessionId === 'chat'
    await callAs('chat', 'flow_edit', { op: 'pause', id: 'config-everything', note: 'owner asked' })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes).toHaveLength(0)
    await call('flow_edit', { op: 'pause', id: 'config-releases', note: 'too noisy' })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes.at(-1)).toMatchObject({ title: '通知流程改动：pause config-releases' })
    expect(notes.at(-1)?.body).toContain('too noisy')
    expect(ctx.lsyEventBus.flowRoutes().find(route => route.id === 'config-releases')?.paused).toBe(true)
  })
})

type ReadValue = {
  routes: Record<string, unknown>[]
  unrouted_kinds: { kind: string; source: string; count: number }[]
  history: Record<string, unknown>[]
}

describe('flow_read details', () => {
  it('shows paused, removed, and changed routes and who changed them, with the change history', async () => {
    const { call, callAs, ctx } = await mount()
    await callAs('desk-session', 'flow_edit', { op: 'pause', id: 'config-releases', note: 'quiet please' })
    await call('flow_edit', { op: 'remove', id: 'config-everything', note: 'unused' })
    await ctx.lsyEventBus.editFlow({ op: 'reset', id: 'config-everything' })
    await ctx.lsyEventBus.editFlow({ op: 'remove', id: 'config-everything' })
    const read = (await call('flow_read', {}) as { value: ReadValue }).value
    const releases = read.routes.find(route => route['id'] === 'config-releases')
    expect(releases).toMatchObject({ paused: true, changed_at: '2026-11-06T00:00:00.000Z' })
    expect(releases).not.toHaveProperty('removed')
    expect(read.routes.find(route => route['id'] === 'config-everything')).toMatchObject({ removed: true })
    expect(read.history.find(change => change['route'] === 'config-releases'))
      .toEqual({ at: '2026-11-06T00:00:00.000Z', op: 'pause', route: 'config-releases', by: 'desk-session', note: 'quiet please' })
    expect(read.history[0]).toEqual({ at: '2026-11-06T00:00:00.000Z', op: 'remove', route: 'config-everything' })
  })

  it('shows a session route with its model, preset, directory, and how its Sessions are kept', async () => {
    const { call } = await mount()
    const set = async (args: object): Promise<Record<string, unknown>> =>
      (await call('flow_edit', {
        op: 'set', note: 'n', sources: ['host'], instructions: 'Look.', agent_preset: 'reviewer', workspace_path: '/srv/work', ...args,
      }) as { value: { route: Record<string, unknown> } }).value.route
    expect(await set({ id: 'by-repo', session_per: 'subject', model: { provider: 'deepseek', model: 'flash' }, result: 'quiet' })).toMatchObject({
      action: 'session', instructions: 'Look.', agent_preset: 'reviewer', workspace_path: '/srv/work',
      model: { provider: 'deepseek', model: 'flash' }, session_per: 'subject', result: 'quiet',
    })
    expect(await set({ id: 'one-long', session_per: 'route', subjects: ['octo/*'] })).toMatchObject({ session_per: 'route', subjects: ['octo/*'] })
    const each = await set({ id: 'each', session_per: 'batch' })
    expect(each).toMatchObject({ session_per: 'batch' })
    expect(each).not.toHaveProperty('model')
  })

  it('shows the last batch of a route with its time and status', async () => {
    const { call, ctx } = await mount()
    await ctx.lsyEventBus.publish({ source: 'custom', kind: 'custom.ping', key: 'k1', subject: 's', title: 'ping' })
    await vi.advanceTimersByTimeAsync(61_000)
    const route = (await call('flow_read', {}) as { value: ReadValue }).value.routes.find(row => row['id'] === 'config-everything')
    expect(route).toMatchObject({ pending: 0, batches_last_hour: 1, last_batch: { at: '2026-11-06T00:01:00.000Z', status: 'delivered' } })
    expect(route!['last_batch']).not.toHaveProperty('silent')
    expect(route!['last_batch']).not.toHaveProperty('error')
  })

  it('marks a last batch that stayed silent or failed', async () => {
    const { call, ctx } = await mount()
    const real = ctx.lsyEventBus.flowRoutes()
    const createdAt = Date.parse('2026-11-05T12:00:00.000Z')
    vi.spyOn(ctx.lsyEventBus, 'flowRoutes').mockReturnValue(real.map((route, index) => ({
      ...route,
      status: {
        ...route.status,
        lastBatch: index === 0
          ? { id: 'b1', createdAt, eventCount: 1, status: 'completed', silent: true }
          : { id: 'b2', createdAt, eventCount: 2, status: 'failed', error: 'session crashed' },
      },
    })))
    const routes = (await call('flow_read', {}) as { value: ReadValue }).value.routes
    expect(routes[0]!['last_batch']).toEqual({ at: '2026-11-05T12:00:00.000Z', status: 'completed', silent: true })
    expect(routes[1]!['last_batch']).toEqual({ at: '2026-11-05T12:00:00.000Z', status: 'failed', error: 'session crashed' })
  })

  it('counts the unrouted kinds of the last day, most frequent first, and leaves out routed and older events', async () => {
    const { call, ctx } = await mount()
    const publish = async (kind: string, key: string) => await ctx.lsyEventBus.publish({ source: 'host', kind, key, subject: 's', title: 't' })
    await publish('host.old', 'old-1')
    vi.setSystemTime(new Date('2026-11-07T01:00:00.000Z'))
    await publish('host.rare', 'r1')
    await publish('host.common', 'c1')
    await publish('host.common', 'c2')
    await publish('custom.routed', 'x1')
    const read = (await call('flow_read', {}) as { value: ReadValue }).value
    expect(read.unrouted_kinds).toEqual([
      { kind: 'host.common', source: 'host', count: 2 },
      { kind: 'host.rare', source: 'host', count: 1 },
    ])
  })
})

describe('flow tools presentation and failures', () => {
  it('presents each call as a generic card', async () => {
    const { ctx } = await mount()
    expect(ctx.tools.get('flow_read')!.presentCall!({})).toEqual({ card: 'generic', title: 'Read the notification flow', kind: 'read' })
    expect(ctx.tools.get('flow_edit')!.presentCall!({ op: 'pause', id: 'desk', note: 'x' }))
      .toEqual({ card: 'generic', title: 'Change the notification flow', kind: 'other', rawInput: 'pause desk' })
  })

  it('refuses a coalesce window outside its bounds and a relative workspace path', async () => {
    const { call } = await mount()
    const message = async (args: object): Promise<unknown> =>
      (await call('flow_edit', { op: 'set', id: 'ok', note: 'x', ...args }) as { value: { code?: string; message?: string } }).value
    expect(await message({ coalesce_seconds: 86_401 })).toEqual({ code: 'invalid_arguments', message: 'coalesce_seconds must be a whole number from 0 to 86400.' })
    expect(await message({ coalesce_seconds: 1.5 })).toMatchObject({ code: 'invalid_arguments' })
    expect(await message({ workspace_path: 'relative/dir' })).toEqual({ code: 'invalid_arguments', message: 'workspace_path must be absolute.' })
  })

  it('answers a removed run-time route with no route', async () => {
    const { call } = await mount()
    await call('flow_edit', { op: 'set', id: 'temp', note: 'x', sources: ['host'] })
    expect((await call('flow_edit', { op: 'remove', id: 'temp', note: 'done' }) as { value: unknown }).value).toEqual({ route: null, warnings: [] })
  })

  it('reports an unexpected bus failure as an internal error and logs it, for an Error or a bare value', async () => {
    const { call, ctx } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const edit = vi.spyOn(ctx.lsyEventBus, 'editFlow')
    edit.mockRejectedValueOnce(new Error('storage down'))
    edit.mockRejectedValueOnce('disk full')
    const args = { op: 'pause', id: 'config-releases', note: 'x' }
    expect((await call('flow_edit', args) as { value: unknown }).value).toEqual({ code: 'internal_error', message: 'The flow change failed.' })
    expect((await call('flow_edit', args) as { value: unknown }).value).toEqual({ code: 'internal_error', message: 'The flow change failed.' })
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      'lsy-tool-watch: flow_edit config-releases failed: storage down',
      'lsy-tool-watch: flow_edit config-releases failed: disk full',
    ])
  })

  it('keeps a flow change successful when the audit note fails', async () => {
    const { call, ctx, notifier } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    notifier.send = async () => { throw new Error('wechat down') }
    expect((await call('flow_edit', { op: 'pause', id: 'config-releases', note: 'x' }) as { isError: boolean }).isError).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual(['lsy-tool-watch: audit note for config-releases failed: Error: wechat down'])
  })
})
