import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, findCycle, flowResultKind, FlowError } from '../src/index.ts'
import type { OwnerNote, Subscription } from '../src/types.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { baseConfig, disposeAll, fakeRegistry, harness, release, sessionEvents, sessionConfig, withConfig } from './harness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-06T00:00:00.000Z'))
})

afterEach(async () => {
  await disposeAll()
  vi.useRealTimers()
})

const session = {
  workspacePath: '/work', agentPreset: 'unattended', permissionPreset: 'danger-full-access', instructions: 'Say what matters.',
  maxPromptEvents: 50, maxTextChars: 2000,
}

const ci: Subscription = {
  id: 'ci', sources: ['github'], kinds: ['github.release'], subjects: [], action: 'session', coalesceMs: 0, maxPerHour: 10, session,
}

const desk: Subscription = {
  id: 'desk', sources: ['host'], kinds: ['host.*'], subjects: [], action: 'session', coalesceMs: 0, maxPerHour: 10, session,
}

const config = withConfig(baseConfig, { subscriptions: [ci, desk] })

describe('Config', () => {
  it('takes where a configured route\'s answer goes, and refuses a place that does not exist', () => {
    const row = (result: string): never => ({ subscriptions: [{ id: 'a', action: 'session', session: { workspacePath: '/w', instructions: 'x', result } }] }) as never
    expect(Config(row('event')).subscriptions[0]?.session?.result).toBe('event')
    expect(() => Config(row('elsewhere'))).toThrow()
  })
})

describe('findCycle', () => {
  const chain = (id: string, kinds: string[]): Subscription => ({
    ...ci, id, sources: ['flow'], kinds, session: { ...session, result: 'event' },
  })

  it('finds a loop of answers and passes a chain', () => {
    expect(findCycle([chain('a', [flowResultKind('b')]), chain('b', [flowResultKind('a')])])).toEqual(['a', 'b', 'a'])
    expect(findCycle([chain('a', ['flow.other.result']), { ...chain('b', [flowResultKind('a')]), session }])).toBeUndefined()
  })
})

describe('editFlow', () => {
  it('changes a configuration route, and a new bus over the same storage keeps the change', async () => {
    const pool = new MemoryMediaPool()
    const { bus, ctx } = await harness({ config, pool })
    const { route, change } = await bus.editFlow({ op: 'set', id: 'ci', patch: { kinds: ['github.*'], session: { instructions: 'New.' } } }, { by: 's1', note: 'wider' })
    expect(route).toMatchObject({ origin: 'config', kinds: ['github.*'], changed: { by: 's1' }, session: { instructions: 'New.', agentPreset: 'unattended' } })
    expect(change).toMatchObject({ op: 'set', route: 'ci', by: 's1', note: 'wider' })
    expect(JSON.parse(change.before ?? '{}')).toMatchObject({ kinds: ['github.release'] })

    await ctx.fiber.dispose()
    const { bus: after } = await harness({ config, pool })
    expect(after.listSubscriptions().find(row => row.id === 'ci')?.kinds).toEqual(['github.*'])
    expect(await after.publish(release(9, { kind: 'github.tag', key: 'x' }))).toBe('accepted')
  })

  it('takes a configuration route out and puts it back as the deployment wrote it', async () => {
    const { bus } = await harness({ config })
    await bus.editFlow({ op: 'set', id: 'ci', patch: { kinds: ['github.tag'] } })
    await bus.editFlow({ op: 'remove', id: 'ci' })
    expect(bus.listSubscriptions().map(row => row.id)).toEqual(['desk'])
    expect(bus.flowRoutes().find(row => row.id === 'ci')?.removed).toBe(true)
    expect(await bus.publish(release(1))).toBe('unmatched')

    const { route } = await bus.editFlow({ op: 'reset', id: 'ci' })
    expect(route).toMatchObject({ kinds: ['github.release'] })
    expect(route?.changed).toBeUndefined()
    expect(await bus.publish(release(2))).toBe('accepted')
  })

  it('sums successive changes of a configuration route, field by field, across a restart', async () => {
    const pool = new MemoryMediaPool()
    const { bus, ctx } = await harness({ config, pool })
    await bus.editFlow({ op: 'set', id: 'ci', patch: { kinds: ['github.tag'] } })
    await bus.editFlow({ op: 'set', id: 'ci', patch: { maxPerHour: 3 } })
    await bus.editFlow({ op: 'set', id: 'ci', patch: { session: { instructions: 'Two.' } } })
    await bus.editFlow({ op: 'set', id: 'ci', patch: { coalesceMs: 5 } })
    await bus.editFlow({ op: 'set', id: 'ci', patch: { session: { maxPromptEvents: 7 } } })
    const expected = {
      kinds: ['github.tag'], maxPerHour: 3, coalesceMs: 5,
      session: { instructions: 'Two.', maxPromptEvents: 7, agentPreset: 'unattended', workspacePath: '/work' },
    }
    expect(bus.flowRoutes().find(row => row.id === 'ci')).toMatchObject(expected)
    await ctx.fiber.dispose()
    const { bus: again } = await harness({ config, pool })
    expect(again.flowRoutes().find(row => row.id === 'ci')).toMatchObject(expected)
  })

  it('pauses a configuration route so it takes no new events', async () => {
    const { bus } = await harness({ config })
    await bus.editFlow({ op: 'pause', id: 'ci' })
    expect(bus.flowRoutes().find(row => row.id === 'ci')?.paused).toBe(true)
    expect(await bus.publish(release(1))).toBe('unmatched')
    await bus.editFlow({ op: 'resume', id: 'ci' })
    expect(await bus.publish(release(2))).toBe('accepted')
  })

  it('creates, changes and removes a run-time route with the fields a watch cannot set', async () => {
    const pool = new MemoryMediaPool()
    const { bus, ctx } = await harness({ config, pool })
    await bus.editFlow({
      op: 'set',
      id: 'new-one',
      patch: {
        sources: ['host'], kinds: ['host.x'], action: 'session',
        session: { ...session, result: 'quiet', model: { provider: 'p', model: 'm' }, persistent: { enabled: true, key: 'subject', rolloverDays: 30, maxSeedChars: 100 } },
      },
    }, { by: 's1' })
    await bus.editFlow({ op: 'set', id: 'new-one', patch: { maxPerHour: 2 } })
    await ctx.fiber.dispose()
    const { bus: again } = await harness({ config, pool })
    expect(again.flowRoutes().find(row => row.id === 'new-one')).toMatchObject({
      origin: 'agent', createdBy: 's1', maxPerHour: 2, result: 'quiet', session: { model: { provider: 'p', model: 'm' }, persistent: { key: 'subject' } },
    })
    const { route } = await again.editFlow({ op: 'remove', id: 'new-one' })
    expect(route).toBeNull()
  })

  it('refuses a route that cannot run, takes everything, or does not exist', async () => {
    const { bus } = await harness({ config })
    const code = async (work: Promise<unknown>): Promise<string> => work.then(() => 'ok', (error: unknown) => (error as FlowError).code)
    expect(await code(bus.editFlow({ op: 'set', id: 'x', patch: { sources: ['host'], action: 'session', session: { instructions: 'x' } } }))).toBe('invalid_route')
    expect(await code(bus.editFlow({ op: 'set', id: 'x', patch: { action: 'notify' } }))).toBe('invalid_route')
    expect(await code(bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'nope' as 'quiet' } } }))).toBe('invalid_route')
    expect(await code(bus.editFlow({ op: 'remove', id: 'x' }))).toBe('not_found')
    expect(await code(bus.editFlow({ op: 'reset', id: 'x' }))).toBe('not_config')
    expect(bus.flowHistory()).toEqual([])
  })

  it('refuses a loop and leaves the routes as they were', async () => {
    const { bus } = await harness({ config })
    await bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'event' } } })
    await bus.editFlow({ op: 'set', id: 'desk', patch: { sources: ['host', 'flow'], kinds: ['host.*', flowResultKind('ci')], session: { result: 'event' } } })
    await expect(bus.editFlow({ op: 'set', id: 'ci', patch: { sources: ['github', 'flow'], kinds: ['github.release', flowResultKind('desk')] } }))
      .rejects.toThrow(FlowError)
    expect(bus.flowRoutes().find(row => row.id === 'ci')).toMatchObject({ kinds: ['github.release'], downstream: ['desk'] })
  })

  it('warns when nothing takes the answer yet', async () => {
    const { bus } = await harness({ config })
    const { warnings } = await bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'event' } } })
    expect(warnings.join()).toContain('flow.ci.result')
  })
})

describe('where an answer goes', () => {
  /** Mount the bus with a notifier whose main agent records what it is told. */
  async function mounted(tellMainAgent?: (message: { text: string }) => Promise<string>) {
    const told: Array<{ text: string }> = []
    const tell = tellMainAgent ?? (async (message: { text: string }) => { told.push(message); return 'chat' })
    const notes: OwnerNote[] = []
    const setup = await harness({ config, notifier: { send: async (note: OwnerNote) => { notes.push(note) }, tellMainAgent: tell } })
    return { ...setup, notes, told }
  }

  /** Run the next `ci` batch to its turn end with this answer. */
  async function answer(setup: Awaited<ReturnType<typeof harness>>, session: string, text: string, n = 1): Promise<void> {
    await setup.bus.publish(release(n))
    await vi.advanceTimersByTimeAsync(1)
    const delivery = setup.runtime.deliveries.at(-1)
    setup.emit(session, sessionEvents.webhook(String(delivery?.deliveryId), 'ci'))
    setup.emit(session, sessionEvents.assistant(text))
    setup.emit(session, sessionEvents.turnEnd())
    await vi.advanceTimersByTimeAsync(1)
  }

  it('sends to the notifier by default', async () => {
    const setup = await mounted()
    await answer(setup, 's1', 'Look at this.')
    expect(setup.notes.at(-1)?.body).toContain('Look at this.')
    expect(setup.notes.at(-1)?.urgent).toBeUndefined()
    expect(setup.bus.batches().at(-1)?.notSent).toBeUndefined()
  })

  it('marks an urgent route past the do-not-disturb hold', async () => {
    const setup = await mounted()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'urgent' } } })
    await answer(setup, 's1', 'Now.')
    expect(setup.notes.at(-1)?.urgent).toBe(true)
  })

  it('keeps a quiet route out of the owner count', async () => {
    const setup = await mounted()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'quiet' } } })
    await answer(setup, 's1', 'Kept.')
    expect(setup.notes).toHaveLength(0)
    expect(setup.bus.batches().at(-1)?.notSent).toBe(true)
  })

  it('gives the answer to the main agent', async () => {
    const setup = await mounted()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'main' } } })
    await answer(setup, 's1', 'For main.')
    expect(setup.told.at(-1)?.text).toBe('For main.')
    expect(setup.notes).toHaveLength(0)
    expect(setup.bus.batches().at(-1)?.notSent).toBe(true)
  })

  it('tells the owner when the main agent refuses', async () => {
    const setup = await mounted(async () => { throw new Error('busy') })
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'main' } } })
    await answer(setup, 's1', 'Still for you.')
    expect(setup.notes.at(-1)?.body).toContain('Still for you.')
  })

  it('passes the answer on to the next route, and a silent reply stops it', async () => {
    const setup = await mounted()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'event' } } })
    await setup.bus.editFlow({ op: 'set', id: 'desk', patch: { sources: ['host', 'flow'], kinds: ['host.*', flowResultKind('ci')] } })
    await answer(setup, 's1', 'First line\nmore')
    expect(setup.notes).toHaveLength(0)
    expect(setup.bus.events().at(-1)).toMatchObject({ source: 'flow', kind: 'flow.ci.result', title: 'First line', subscriptions: ['desk'] })
    expect(setup.bus.batches().find(batch => batch.subscription === 'ci')?.notSent).toBe(true)
    expect(setup.runtime.deliveries.at(-1)?.source).toBe('desk')

    await answer(setup, 's2', 'NO_REPLY', 2)
    expect(setup.bus.events().filter(row => row.source === 'flow')).toHaveLength(1)
  })

  it('tells the owner when nothing takes the answer, so it is not lost', async () => {
    const setup = await mounted()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'event' } } })
    await answer(setup, 's1', 'Nobody home.')
    expect(setup.notes.at(-1)?.body).toContain('Nobody home.')
    expect(setup.bus.batches().at(-1)?.notSent).toBeUndefined()
  })
})

const runtimeRoute = (id: string, extra: Partial<Subscription> = {}) => ({
  op: 'set' as const, id, patch: { sources: ['ops'], kinds: ['ops.x'], action: 'notify' as const, coalesceMs: 1_000, maxPerHour: 5, ...extra },
})

describe('route bookkeeping', () => {
  it('reports no answer destination for a notify route', async () => {
    const { bus } = await harness({ config: withConfig(config, { subscriptions: [ci, { ...desk, id: 'plain', action: 'notify' }] }) })
    const routes = bus.flowRoutes()
    expect(routes.find(row => row.id === 'ci')?.result).toBe('notify')
    expect(routes.find(row => row.id === 'plain')).not.toHaveProperty('result')
  })

  it('forgets a taken-out configuration route that a later configuration no longer has', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ config, pool })
    await first.bus.editFlow({ op: 'remove', id: 'ci' })
    expect(first.bus.flowRoutes().find(row => row.id === 'ci')?.removed).toBe(true)
    await first.ctx.fiber.dispose()
    const second = await harness({ config: withConfig(config, { subscriptions: [desk] }), pool })
    expect(second.bus.flowRoutes().map(row => row.id)).toEqual(['desk'])
  })

  it('keeps only the newest flowChangesKept entries of the change history', async () => {
    const { bus } = await harness({ config: withConfig(config, { flowChangesKept: 2 }) })
    for (const note of ['one', 'two', 'three', 'four']) {
      await bus.editFlow({ op: 'set', id: 'ci', patch: { maxPerHour: 5 } }, { note })
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(bus.flowHistory().map(change => change.note)).toEqual(['four', 'three'])
    expect(bus.flowHistory(Number.MAX_SAFE_INTEGER)).toHaveLength(2)
  })

  it('keeps every edit of one millisecond apart and in order once the history is full', async () => {
    const { bus } = await harness({ config: withConfig(config, { flowChangesKept: 2 }) })
    for (const note of ['one', 'two', 'three', 'four']) await bus.editFlow({ op: 'set', id: 'ci', patch: { maxPerHour: 5 } }, { note })
    expect(bus.flowHistory().map(change => change.note)).toEqual(['four', 'three'])
  })

  it('records a new run-time route without a creator when the change names none, and keeps the creator of an existing one', async () => {
    const { bus } = await harness({ config })
    await bus.editFlow(runtimeRoute('anon'))
    await bus.editFlow(runtimeRoute('mine'), { by: 's1' })
    await bus.editFlow({ op: 'set', id: 'mine', patch: { maxPerHour: 9 } }, { by: 's2' })
    const routes = bus.flowRoutes()
    expect(routes.find(row => row.id === 'anon')).not.toHaveProperty('createdBy')
    expect(routes.find(row => row.id === 'mine')).toMatchObject({ createdBy: 's1', maxPerHour: 9 })
  })

  it('keeps a session route\'s project when a run-time route is stored', async () => {
    const { bus } = await harness({ config })
    const { route } = await bus.editFlow({
      op: 'set',
      id: 'proj',
      patch: { sources: ['ops'], kinds: ['ops.x'], action: 'session', session: { ...sessionConfig.subscriptions[0]!.session!, project: '事件' } },
    })
    expect(route?.session).toMatchObject({ project: '事件' })
  })
})

describe('pausing and removing routes while events wait', () => {
  it('holds the events of a paused run-time route and flushes them after resume, keeping the pause through other edits', async () => {
    const { bus, notes } = await harness({ config })
    await bus.editFlow(runtimeRoute('held'))
    await bus.publish({ source: 'ops', kind: 'ops.x', key: 'k1', subject: 's', title: 'waiting' })
    await bus.editFlow({ op: 'pause', id: 'held' })
    await bus.editFlow({ op: 'set', id: 'held', patch: { maxPerHour: 6 } })
    expect(bus.flowRoutes().find(row => row.id === 'held')).toMatchObject({ paused: true, maxPerHour: 6 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(notes).toHaveLength(0)
    await bus.editFlow({ op: 'resume', id: 'held' })
    expect(bus.flowRoutes().find(row => row.id === 'held')).not.toHaveProperty('paused')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toContain('waiting')
  })

  it('does not flush a batch whose route was paused while its flush was already queued', async () => {
    const { bus, notes } = await harness({ config })
    await bus.editFlow(runtimeRoute('racing'))
    await bus.publish({ source: 'ops', kind: 'ops.x', key: 'k1', subject: 's', title: 'waiting' })
    // The pause takes its place in the storage chain first; the timer fires before the pause reaches the route.
    const pausing = bus.editFlow({ op: 'pause', id: 'racing' })
    vi.advanceTimersByTime(1_000)
    await pausing
    await vi.advanceTimersByTimeAsync(5_000)
    expect(notes).toHaveLength(0)
    expect(bus.batches()).toEqual([])
    expect(bus.flowRoutes().find(row => row.id === 'racing')?.status.pending).toBe(1)
  })

  it('drops the waiting events of a removed route and leaves the other routes\' events alone', async () => {
    const { bus, notes } = await harness({ config })
    await bus.editFlow(runtimeRoute('gone'))
    await bus.editFlow({ op: 'set', id: 'stays', patch: { sources: ['ops'], kinds: ['ops.y'], action: 'notify', coalesceMs: 1_000, maxPerHour: 5 } })
    await bus.publish({ source: 'ops', kind: 'ops.x', key: 'k1', subject: 's', title: 'for the removed route' })
    await bus.publish({ source: 'ops', kind: 'ops.y', key: 'k2', subject: 's', title: 'for the other route' })
    await bus.editFlow({ op: 'remove', id: 'gone' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toContain('for the other route')
    expect(notes[0]?.body).not.toContain('for the removed route')
  })

  it('resumes a configuration route that was taken out without bringing it back', async () => {
    const { bus } = await harness({ config })
    await bus.editFlow({ op: 'remove', id: 'ci' })
    const { route } = await bus.editFlow({ op: 'resume', id: 'ci' })
    expect(route).toMatchObject({ id: 'ci', removed: true })
    expect(await bus.publish(release(1))).toBe('unmatched')
  })

  it('tells setPaused to leave a subscription already in the requested state alone', async () => {
    const logs: string[] = []
    const { bus } = await harness({ logs })
    await bus.subscribe({ id: 'w', sources: ['github'], kinds: [], subjects: [], action: 'notify', coalesceMs: 1_000, maxPerHour: 1 })
    expect(await bus.setPaused('w', false)).toBe('ok')
    expect(await bus.setPaused('w', true)).toBe('ok')
    expect(await bus.setPaused('w', true)).toBe('ok')
    expect(await bus.setPaused('w', false)).toBe('ok')
    expect(logs.filter(line => line.includes('paused w') || line.includes('resumed w'))).toEqual([
      'info: event-bus: paused w', 'info: event-bus: resumed w',
    ])
  })
})

describe('what happens to a running batch', () => {
  /** Start the `ci` batch and attach Session `s1` to it; resolves with the mounted bus. */
  async function running(options: Parameters<typeof harness>[0] = {}) {
    const setup = await harness({ config, ...options })
    await setup.bus.publish(release(1))
    await vi.advanceTimersByTimeAsync(1)
    setup.emit('s1', sessionEvents.webhook(String(setup.runtime.deliveries.at(-1)?.deliveryId), 'ci'))
    return setup
  }

  it('still tells the owner the answer of a Session whose route was removed meanwhile', async () => {
    const setup = await running()
    await setup.bus.editFlow({ op: 'remove', id: 'ci' })
    setup.emit('s1', sessionEvents.assistant('Done anyway.'))
    setup.emit('s1', sessionEvents.turnEnd())
    await vi.advanceTimersByTimeAsync(1)
    expect(setup.notes.at(-1)?.body).toContain('Done anyway.')
  })

  it('passes an answer that has no text on under the batch title, and the route after it runs', async () => {
    const setup = await running()
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'event' } } })
    await setup.bus.editFlow({ op: 'set', id: 'desk', patch: { sources: ['flow'], kinds: [flowResultKind('ci')] } })
    setup.emit('s1', sessionEvents.turnEnd())
    await vi.advanceTimersByTimeAsync(1)
    const event = setup.bus.events().at(-1)
    expect(event).toMatchObject({ source: 'flow', kind: 'flow.ci.result', title: setup.bus.batches()[0]?.title, subscriptions: ['desk'] })
    expect(event?.text).toBe('')
    expect(setup.notes).toHaveLength(0)
  })

  it('falls back to the owner when the notifier has no main agent, and hands main an empty answer as an empty text', async () => {
    const plain = await running()
    await plain.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'main' } } })
    plain.emit('s1', sessionEvents.assistant('For main.'))
    plain.emit('s1', sessionEvents.turnEnd())
    await vi.advanceTimersByTimeAsync(1)
    expect(plain.notes.at(-1)?.body).toContain('For main.')

    const told: string[] = []
    const withMain = await running({ notifier: { send: async () => {}, tellMainAgent: async (message) => { told.push(message.text); return 'chat' } } })
    await withMain.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'main' } } })
    withMain.emit('s1', sessionEvents.turnEnd())
    await vi.advanceTimersByTimeAsync(1)
    expect(told).toEqual([''])
  })

  it('tells the owner when the main agent refuses with something that is not an Error', async () => {
    const logs: string[] = []
    const setup = await running({ logs, notifier: { send: async () => {}, tellMainAgent: async () => { throw 'busy' } } })
    await setup.bus.editFlow({ op: 'set', id: 'ci', patch: { session: { result: 'main' } } })
    setup.emit('s1', sessionEvents.assistant('Still for you.'))
    setup.emit('s1', sessionEvents.turnEnd())
    await vi.advanceTimersByTimeAsync(1)
    expect(logs.some(line => line.includes('main agent refused the answer') && line.endsWith('busy'))).toBe(true)
  })
})

describe('sessions of routes made at run time', () => {
  it('titles the Sessions of a per-subject route with the route id when it names no prefix', async () => {
    const { bus } = await harness({ config })
    const base = sessionConfig.subscriptions[0]!.session!
    await bus.editFlow({
      op: 'set',
      id: 'per-repo',
      patch: {
        sources: ['ops'], kinds: ['ops.x'], action: 'session', coalesceMs: 100, maxPerHour: 10,
        session: { ...base, persistent: { enabled: true, key: 'subject', rolloverDays: 30, maxSeedChars: 100 } },
      },
    })
    await bus.publish({ source: 'ops', kind: 'ops.x', key: 'a', subject: 'octo/one', title: 'one' })
    await bus.publish({ source: 'ops', kind: 'ops.x', key: 'b', subject: 'octo/two', title: 'two' })
    await vi.advanceTimersByTimeAsync(200)
    const titles = bus.batches().map(batch => batch.title)
    expect(titles).toHaveLength(2)
    for (const title of titles) expect(title.startsWith('per-repo')).toBe(true)
  })

  it('warns that a project could not be ensured and tries again on the next batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bus-project-'))
    try {
      const blocker = join(root, 'file')
      await writeFile(blocker, 'x')
      const logs: string[] = []
      const sub: Subscription = { ...ci, session: { ...session, workspacePath: join(blocker, 'sub'), project: '事件' } }
      const { bus } = await harness({ config: withConfig(config, { subscriptions: [sub] }), registry: fakeRegistry(), logs })
      const warned = (): number => logs.filter(line => line.startsWith('warn: event-bus: project "事件"') && line.includes('not ensured')).length
      await bus.publish(release(1))
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => { expect(warned()).toBe(1) })
      await bus.publish(release(2))
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => { expect(warned()).toBe(2) })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
