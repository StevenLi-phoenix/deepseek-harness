import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeGitHub } from '../../fork-github-sensor/tests/fake-github.ts'
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
    await ctx.forkEventBus.publish({ source: 'host', kind: 'host.nobody', key: '1', subject: 'x', title: 't' })
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
    expect(ctx.forkEventBus.flowHistory()[0]).toMatchObject({ route: 'config-releases', note: 'tags too' })
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
    expect(ctx.forkEventBus.flowRoutes().find(route => route.id === 'config-releases')?.paused).toBe(true)
  })
})
